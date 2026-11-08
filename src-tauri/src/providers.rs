//! Direct provider reads the host makes for the Manager: the modpack catalogs of all five
//! providers, batched project metadata and batched mod update lookups.
//!
//! The CurseForge key stays in this process (and the helper's environment); the web view only ever
//! receives results. Everything here is a read or a download into the Manager's private temp folder.
//! Installing is the native helper's job: a fetched pack goes through its reviewed import.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

const USER_AGENT: &str = concat!("awakenginexe/Awake-Modpack-Manager/", env!("CARGO_PKG_VERSION"), " (github.com/awakenginexe/Awake-Modpack-Manager)");
const JSON_MAX: u64 = 64 << 20;
/// The helper's inbox accepts archives up to 1 GiB.
const ARCHIVE_MAX: u64 = 1 << 30;
const MODRINTH: &str = "https://api.modrinth.com/v2";
const CURSEFORGE: &str = "https://api.curseforge.com/v1";
const FTB: &str = "https://api.feed-the-beast.com/v1/modpacks/public";
const ATL: &str = "https://api.atlauncher.com/v1";
const ATL_CDN: &str = "https://download.nodecdn.net/containers/atl/";
const TECHNIC: &str = "https://api.technicpack.net";
const TECHNIC_BUILD: &str = "multimc";

#[derive(Serialize, Debug, Clone)]
pub struct HostError {
    pub code: &'static str,
    pub message: String,
}
pub type HostResult<T> = Result<T, HostError>;
pub fn err<T>(code: &'static str, message: impl Into<String>) -> HostResult<T> {
    Err(HostError { code, message: message.into() })
}

/// CurseForge access in this build. Debug builds may also read a key from the environment for local testing.
pub fn curseforge_key() -> Option<String> {
    let embedded = (option_env!("AWAKE_CORE_CURSEFORGE_AUTHORIZED") == Some("1")).then(|| option_env!("AWAKE_CORE_CURSEFORGE_API_KEY")).flatten().map(str::to_string);
    let local = || (cfg!(debug_assertions) && std::env::var("AWAKE_CORE_CURSEFORGE_AUTHORIZED").as_deref() == Ok("1")).then(|| std::env::var("AWAKE_CORE_CURSEFORGE_API_KEY").ok()).flatten();
    embedded.or_else(local).filter(|k| !k.trim().is_empty())
}

pub fn agent(timeout: u64) -> ureq::Agent {
    ureq::Agent::config_builder().tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).root_certs(ureq::tls::RootCerts::PlatformVerifier).build()).timeout_global(Some(Duration::from_secs(timeout))).max_redirects(6).http_status_as_error(false).user_agent(USER_AGENT).build().into()
}

fn status_error<T>(host: &str, status: u16) -> HostResult<T> {
    match status {
        429 => err("rate-limited", format!("{host} is rate limiting requests. Try again in a minute.")),
        401 | 403 | 451 => err("restricted", format!("{host} refused this request (HTTP {status}).")),
        404 => err("not-found", format!("{host} does not have this item any more.")),
        _ => err("network", format!("{host} request failed (HTTP {status}).")),
    }
}
fn host_of(url: &str) -> String {
    url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url).to_string()
}

fn read_json(url: &str, mut response: ureq::http::Response<ureq::Body>) -> HostResult<Value> {
    let status = response.status().as_u16();
    if status != 200 {
        return status_error(&host_of(url), status);
    }
    response.body_mut().with_config().limit(JSON_MAX).read_json().or_else(|e| err("network", format!("{} returned unreadable data: {e}", host_of(url))))
}

pub fn get_json(url: &str) -> HostResult<Value> {
    let response = agent(45).get(url).header("Accept", "application/json").call().or_else(|e| err("network", format!("{}: {e}", host_of(url))))?;
    read_json(url, response)
}
fn cf_key() -> HostResult<String> {
    curseforge_key().ok_or(HostError { code: "curseforge-disabled", message: "This build has no authorized CurseForge access.".into() })
}
fn cf_get(path: &str) -> HostResult<Value> {
    let url = format!("{CURSEFORGE}{path}");
    let response = agent(45).get(&url).header("x-api-key", &cf_key()?).header("Accept", "application/json").call().or_else(|e| err("network", format!("CurseForge: {e}")))?;
    read_json(&url, response)
}
fn cf_post(path: &str, body: &Value) -> HostResult<Value> {
    let url = format!("{CURSEFORGE}{path}");
    let response = agent(60).post(&url).header("x-api-key", &cf_key()?).header("Accept", "application/json").send_json(body).or_else(|e| err("network", format!("CurseForge: {e}")))?;
    read_json(&url, response)
}
fn encode(v: &str) -> String {
    v.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
/// A pack ID goes into a URL path: allow only what providers actually issue.
fn safe_id(id: &str) -> HostResult<&str> {
    if !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.+ ".contains(&b)) { Ok(id) } else { err("invalid", "This pack identifier is not valid.") }
}

/* ---------- catalog ---------- */

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PackHit {
    pub provider: String,
    pub pack_id: String,
    pub name: String,
    pub author: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minecraft_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader: Option<String>,
}
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PackVersion {
    pub id: String,
    pub name: String,
    pub minecraft_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
}
#[derive(Serialize, Debug)]
pub struct PackPage {
    hits: Vec<PackHit>,
    total: u64,
}

const LOADERS: [&str; 4] = ["fabric", "quilt", "neoforge", "forge"];
fn cf_loader(n: i64) -> Option<String> {
    match n {
        1 => Some("forge"),
        4 => Some("fabric"),
        5 => Some("quilt"),
        6 => Some("neoforge"),
        _ => None,
    }
    .map(str::to_string)
}
fn release_name(n: i64) -> Option<String> {
    match n {
        1 => Some("release"),
        2 => Some("beta"),
        3 => Some("alpha"),
        _ => None,
    }
    .map(str::to_string)
}

/// Catalogs without server search are read once per run.
#[derive(Default)]
pub struct CatalogCache {
    atl: Mutex<Option<Arc<Vec<Value>>>>,
    ftb: Mutex<HashMap<String, Value>>,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn modrinth_search(text: &str, offset: u32, limit: u32) -> HostResult<PackPage> {
    let index = if text.trim().is_empty() { "downloads" } else { "relevance" };
    let url = format!("{MODRINTH}/search?query={}&facets={}&index={index}&offset={offset}&limit={limit}", encode(text), encode(r#"[["project_type:modpack"]]"#));
    let page = get_json(&url)?;
    let hits = page["hits"].as_array().map_or(vec![], |list| {
        list.iter()
            .map(|h| PackHit {
                provider: "modrinth".into(),
                pack_id: s(h, "project_id").into(),
                name: s(h, "title").into(),
                author: s(h, "author").into(),
                summary: s(h, "description").into(),
                icon_url: h["icon_url"].as_str().filter(|u| !u.is_empty()).map(Into::into),
                downloads: h["downloads"].as_f64(),
                minecraft_version: h["versions"].as_array().and_then(|v| v.last()).and_then(Value::as_str).map(Into::into),
                loader: h["categories"].as_array().and_then(|c| LOADERS.iter().find(|l| c.iter().any(|x| x == *l))).map(|l| l.to_string()),
            })
            .collect()
    });
    Ok(PackPage { hits, total: page["total_hits"].as_u64().unwrap_or(0) })
}
fn modrinth_versions(id: &str) -> HostResult<Vec<PackVersion>> {
    let list = get_json(&format!("{MODRINTH}/project/{}/version", encode(id)))?;
    Ok(list.as_array().map_or(vec![], |all| {
        all.iter()
            .map(|v| PackVersion {
                id: s(v, "id").into(),
                name: v["version_number"].as_str().or(v["name"].as_str()).unwrap_or("").into(),
                minecraft_version: v["game_versions"].as_array().and_then(|g| g.first()).and_then(Value::as_str).unwrap_or("").into(),
                loader: v["loaders"].as_array().and_then(|c| LOADERS.iter().find(|l| c.iter().any(|x| x == *l))).map(|l| l.to_string()),
                release_type: v["version_type"].as_str().map(Into::into),
                published_at: v["date_published"].as_str().map(Into::into),
            })
            .collect()
    }))
}

fn curseforge_search(text: &str, offset: u32, limit: u32) -> HostResult<PackPage> {
    let limit = limit.min(50).min(10000u32.saturating_sub(offset)).max(1);
    let page = cf_get(&format!("/mods/search?gameId=432&classId=4471&sortField=2&sortOrder=desc&searchFilter={}&index={offset}&pageSize={limit}", encode(text)))?;
    let hits = page["data"].as_array().map_or(vec![], |list| {
        list.iter()
            .map(|h| {
                let latest = h["latestFilesIndexes"].as_array().and_then(|l| l.first());
                PackHit {
                    provider: "curseforge".into(),
                    pack_id: h["id"].as_i64().unwrap_or(0).to_string(),
                    name: s(h, "name").into(),
                    author: h["authors"][0]["name"].as_str().unwrap_or("").into(),
                    summary: s(h, "summary").into(),
                    icon_url: h["logo"]["thumbnailUrl"].as_str().filter(|u| !u.is_empty()).map(Into::into),
                    downloads: h["downloadCount"].as_f64(),
                    minecraft_version: latest.and_then(|l| l["gameVersion"].as_str()).map(Into::into),
                    loader: latest.and_then(|l| l["modLoader"].as_i64()).and_then(cf_loader),
                }
            })
            .collect()
    });
    Ok(PackPage { hits, total: page["pagination"]["totalCount"].as_u64().unwrap_or(0).min(10000) })
}
fn curseforge_versions(id: &str) -> HostResult<Vec<PackVersion>> {
    let mut out = vec![];
    let mut index = 0;
    loop {
        let page = cf_get(&format!("/mods/{}/files?index={index}&pageSize=50", encode(id)))?;
        let rows = page["data"].as_array().cloned().unwrap_or_default();
        for f in &rows {
            if f["isServerPack"].as_bool() == Some(true) {
                continue;
            }
            let tags: Vec<&str> = f["gameVersions"].as_array().map_or(vec![], |g| g.iter().filter_map(Value::as_str).collect());
            out.push(PackVersion {
                id: f["id"].as_i64().unwrap_or(0).to_string(),
                name: s(f, "displayName").into(),
                minecraft_version: tags.iter().find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit())).unwrap_or(&"").to_string(),
                loader: tags.iter().map(|t| t.to_ascii_lowercase()).find(|t| LOADERS.contains(&t.as_str())),
                release_type: f["releaseType"].as_i64().and_then(release_name),
                published_at: f["fileDate"].as_str().map(Into::into),
            });
        }
        index += rows.len();
        if rows.len() < 50 || index >= 200 {
            return Ok(out);
        }
    }
}

fn ftb_pack(cache: &CatalogCache, id: &str) -> HostResult<Value> {
    if let Some(v) = cache.ftb.lock().unwrap().get(id) {
        return Ok(v.clone());
    }
    let v = get_json(&format!("{FTB}/modpack/{}", encode(id)))?;
    if s(&v, "status") != "success" {
        return err("not-found", "FTB does not list this pack any more.");
    }
    cache.ftb.lock().unwrap().insert(id.to_string(), v.clone());
    Ok(v)
}
fn ftb_search(cache: &CatalogCache, text: &str, offset: u32, limit: u32) -> HostResult<PackPage> {
    let list = if text.trim().is_empty() { get_json(&format!("{FTB}/modpack/popular/installs/100")).or_else(|_| get_json(&format!("{FTB}/modpack/all")))? } else { get_json(&format!("{FTB}/modpack/search/100?term={}", encode(text.trim())))? };
    let ids: Vec<String> = list["packs"].as_array().map_or(vec![], |p| p.iter().filter_map(|v| v.as_i64().map(|n| n.to_string())).collect());
    let window: Vec<&String> = ids.iter().skip(offset as usize).take(limit as usize).collect();
    let packs: Vec<HostResult<Value>> = std::thread::scope(|scope| window.chunks(6).flat_map(|c| c.iter().map(|id| scope.spawn(move || ftb_pack(cache, id))).collect::<Vec<_>>().into_iter().map(|h| h.join().unwrap_or_else(|_| err("network", "FTB lookup failed."))).collect::<Vec<_>>()).collect());
    let hits = packs
        .into_iter()
        .flatten()
        .map(|p| {
            let newest = p["versions"].as_array().and_then(|v| v.last());
            let target = |kind: &str| newest.and_then(|n| n["targets"].as_array()).and_then(|t| t.iter().find(|x| s(x, "type") == kind).cloned());
            PackHit {
                provider: "ftb".into(),
                pack_id: p["id"].as_i64().unwrap_or(0).to_string(),
                name: s(&p, "name").into(),
                author: p["authors"][0]["name"].as_str().unwrap_or("FTB").into(),
                summary: s(&p, "synopsis").into(),
                icon_url: p["art"].as_array().and_then(|a| a.iter().find(|x| s(x, "type") == "square")).and_then(|x| x["url"].as_str()).map(Into::into),
                downloads: p["installs"].as_f64(),
                minecraft_version: target("game").map(|t| s(&t, "version").to_string()),
                loader: target("modloader").map(|t| s(&t, "name").to_string()),
            }
        })
        .collect();
    Ok(PackPage { hits, total: ids.len() as u64 })
}
fn ftb_versions(cache: &CatalogCache, id: &str) -> HostResult<Vec<PackVersion>> {
    let p = ftb_pack(cache, id)?;
    let mut out: Vec<PackVersion> = p["versions"].as_array().map_or(vec![], |all| {
        all.iter()
            .filter(|v| v["private"].as_bool() != Some(true))
            .map(|v| {
                let target = |kind: &str| v["targets"].as_array().and_then(|t| t.iter().find(|x| s(x, "type") == kind)).cloned();
                PackVersion {
                    id: v["id"].as_i64().unwrap_or(0).to_string(),
                    name: s(v, "name").into(),
                    minecraft_version: target("game").map_or(String::new(), |t| s(&t, "version").to_string()),
                    loader: target("modloader").map(|t| s(&t, "name").to_string()),
                    release_type: Some(match s(v, "type").to_ascii_lowercase().as_str() { "beta" => "beta".to_string(), "alpha" => "alpha".to_string(), _ => "release".to_string() }),
                    published_at: None,
                }
            })
            .collect()
    });
    out.reverse();
    Ok(out)
}

fn atl_catalog(cache: &CatalogCache) -> HostResult<Arc<Vec<Value>>> {
    if let Some(c) = cache.atl.lock().unwrap().clone() {
        return Ok(c);
    }
    let list = get_json(&format!("{ATL}/packs/full/public"))?;
    let all = Arc::new(list["data"].as_array().cloned().unwrap_or_default());
    *cache.atl.lock().unwrap() = Some(all.clone());
    Ok(all)
}
fn atl_search(cache: &CatalogCache, text: &str, offset: u32, limit: u32) -> HostResult<PackPage> {
    let all = atl_catalog(cache)?;
    let needle = text.trim().to_lowercase();
    let matched: Vec<&Value> = all.iter().filter(|p| needle.is_empty() || s(p, "name").to_lowercase().contains(&needle) || s(p, "description").to_lowercase().contains(&needle)).collect();
    let hits = matched
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|p| PackHit {
            provider: "atlauncher".into(),
            pack_id: s(p, "safeName").into(),
            name: s(p, "name").into(),
            author: String::new(),
            summary: s(p, "description").into(),
            icon_url: Some(format!("{ATL_CDN}images/{}.png", s(p, "safeName").to_lowercase())),
            downloads: None,
            minecraft_version: p["versions"][0]["minecraft"].as_str().map(Into::into),
            loader: None,
        })
        .collect();
    Ok(PackPage { hits, total: matched.len() as u64 })
}
fn atl_versions(cache: &CatalogCache, id: &str) -> HostResult<Vec<PackVersion>> {
    let all = atl_catalog(cache)?;
    let pack = all.iter().find(|p| s(p, "safeName") == id).ok_or(HostError { code: "not-found", message: "ATLauncher does not list this pack any more.".into() })?;
    Ok(pack["versions"].as_array().map_or(vec![], |v| v.iter().map(|x| PackVersion { id: s(x, "version").into(), name: s(x, "version").into(), minecraft_version: s(x, "minecraft").into(), release_type: Some("release".into()), ..Default::default() }).collect()))
}

fn technic_hit(slug: &str, fallback_name: &str, icon: Option<String>) -> PackHit {
    let detail = get_json(&format!("{TECHNIC}/modpack/{}?build={TECHNIC_BUILD}", encode(slug))).unwrap_or(Value::Null);
    PackHit {
        provider: "technic".into(),
        pack_id: slug.into(),
        name: detail["displayName"].as_str().unwrap_or(fallback_name).into(),
        author: s(&detail, "user").into(),
        summary: s(&detail, "description").chars().take(300).collect(),
        icon_url: detail["icon"]["url"].as_str().map(Into::into).or(icon),
        downloads: detail["installs"].as_f64(),
        minecraft_version: detail["minecraft"].as_str().map(Into::into),
        loader: None,
    }
}
fn technic_search(text: &str, offset: u32, limit: u32) -> HostResult<PackPage> {
    let url = if text.trim().is_empty() { format!("{TECHNIC}/trending?build={TECHNIC_BUILD}") } else { format!("{TECHNIC}/search?build={TECHNIC_BUILD}&q={}", encode(text.trim())) };
    let list = get_json(&url)?;
    let rows = list["modpacks"].as_array().cloned().unwrap_or_default();
    let window: Vec<&Value> = rows.iter().skip(offset as usize).take(limit as usize).collect();
    let hits = std::thread::scope(|scope| window.chunks(6).flat_map(|c| c.iter().map(|m| scope.spawn(move || technic_hit(s(m, "slug"), s(m, "name"), m["iconUrl"].as_str().map(Into::into)))).collect::<Vec<_>>().into_iter().filter_map(|h| h.join().ok()).collect::<Vec<_>>()).collect());
    Ok(PackPage { hits, total: rows.len() as u64 })
}
fn technic_versions(id: &str) -> HostResult<Vec<PackVersion>> {
    let d = get_json(&format!("{TECHNIC}/modpack/{}?build={TECHNIC_BUILD}", encode(id)))?;
    if let Some(solder) = d["solder"].as_str().filter(|u| u.starts_with("https://")) {
        let pack = get_json(&format!("{}/modpack/{}", solder.trim_end_matches('/'), encode(id)))?;
        let recommended = s(&pack, "recommended");
        let mut builds: Vec<String> = pack["builds"].as_array().map_or(vec![], |b| b.iter().filter_map(|x| x.as_str().map(String::from)).collect());
        builds.reverse();
        return Ok(builds.into_iter().map(|b| PackVersion { minecraft_version: s(&d, "minecraft").into(), release_type: Some(if b == recommended { "release".to_string() } else { "beta".to_string() }), id: b.clone(), name: b, ..Default::default() }).collect());
    }
    Ok(vec![PackVersion { id: s(&d, "version").into(), name: s(&d, "version").into(), minecraft_version: s(&d, "minecraft").into(), release_type: Some("release".into()), ..Default::default() }])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackProvider {
    id: &'static str,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<&'static str>,
}

#[tauri::command]
pub fn pack_providers() -> Vec<PackProvider> {
    let cf = curseforge_key().is_some();
    ["modrinth", "curseforge", "ftb", "atlauncher", "technic"].into_iter().map(|id| {
        let available = id != "curseforge" || cf;
        PackProvider { id, available, unavailable_reason: (!available).then_some("curseforge-unauthorized") }
    }).collect()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> HostResult<T> + Send + 'static) -> HostResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.unwrap_or_else(|e| err("internal", e.to_string()))
}

#[tauri::command]
pub async fn pack_search(cache: tauri::State<'_, Arc<CatalogCache>>, provider: String, text: String, offset: u32, limit: u32) -> HostResult<PackPage> {
    let cache = cache.inner().clone();
    let limit = limit.clamp(1, 60);
    blocking(move || match provider.as_str() {
        "modrinth" => modrinth_search(&text, offset, limit),
        "curseforge" => curseforge_search(&text, offset, limit),
        "ftb" => ftb_search(&cache, &text, offset, limit),
        "atlauncher" => atl_search(&cache, &text, offset, limit),
        "technic" => technic_search(&text, offset, limit),
        _ => err("invalid", "Unknown modpack provider."),
    })
    .await
}

#[tauri::command]
pub async fn pack_versions(cache: tauri::State<'_, Arc<CatalogCache>>, provider: String, pack_id: String) -> HostResult<Vec<PackVersion>> {
    let cache = cache.inner().clone();
    blocking(move || {
        let id = safe_id(&pack_id)?;
        match provider.as_str() {
            "modrinth" => modrinth_versions(id),
            "curseforge" => curseforge_versions(id),
            "ftb" => ftb_versions(&cache, id),
            "atlauncher" => atl_versions(&cache, id),
            "technic" => technic_versions(id),
            _ => err("invalid", "Unknown modpack provider."),
        }
    })
    .await
}

/* ---------- fetching a pack for the helper's import ---------- */

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPack {
    token: String,
    format: &'static str,
    size: u64,
    sha256: String,
    /// Things the user has to know about: files this provider will not let a launcher download, etc.
    notes: Vec<String>,
}

#[derive(Serialize, Clone)]
struct Progress {
    job: String,
    phase: &'static str,
    done: u64,
    total: u64,
}

struct Job {
    app: tauri::AppHandle,
    id: String,
    cancel: Arc<AtomicBool>,
}
impl Job {
    fn progress(&self, phase: &'static str, done: u64, total: u64) {
        let _ = self.app.emit("pack-progress", Progress { job: self.id.clone(), phase, done, total });
    }
    fn check(&self) -> HostResult<()> {
        if self.cancel.load(Ordering::Relaxed) { err("cancelled", "Cancelled.") } else { Ok(()) }
    }
}

fn pack_dir() -> HostResult<PathBuf> {
    let dir = crate::helper::manager_data_dir().or_else(|m| err("io", m))?.join("tmp").join("packs");
    fs::create_dir_all(&dir).or_else(|e| err("io", format!("Could not prepare the download folder: {e}")))?;
    Ok(dir)
}

/// Remove leftovers from an earlier run that closed in the middle of an install.
pub fn sweep_pack_dir() {
    if let Ok(dir) = pack_dir() {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > Duration::from_secs(6 * 3600));
            if old {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Download `url` to `to`, enforcing a size limit and cancellation.
fn download(job: Option<&Job>, url: &str, headers: &[(&str, String)], to: &Path, limit: u64, mut progress: impl FnMut(u64)) -> HostResult<()> {
    // Provider file URLs often contain raw spaces or brackets.
    let url = &url.replace(' ', "%20").replace('[', "%5B").replace(']', "%5D");
    let mut last = None;
    for attempt in 0..3u64 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(600 * attempt));
        }
        let mut request = agent(900).get(url);
        for (k, v) in headers {
            request = request.header(*k, v);
        }
        let mut response = match request.call() {
            Ok(r) => r,
            Err(e) => { last = Some(HostError { code: "network", message: format!("{}: {e}", host_of(url)) }); continue; }
        };
        let status = response.status().as_u16();
        if status != 200 {
            let failed = status_error::<()>(&host_of(url), status).unwrap_err();
            if status >= 500 || status == 429 { last = Some(failed); continue; }
            return Err(failed);
        }
        let mut reader = response.body_mut().with_config().limit(limit + 1).reader();
        let mut file = fs::File::create(to).or_else(|e| err("io", format!("Could not write the download: {e}")))?;
        let (mut buffer, mut total) = (vec![0u8; 256 * 1024], 0u64);
        let outcome = loop {
            if let Some(j) = job { j.check()?; }
            match reader.read(&mut buffer) {
                Ok(0) => break Ok(()),
                Ok(n) => {
                    total += n as u64;
                    if total > limit { return err("too-large", "This pack is larger than the 1 GiB the Manager can import."); }
                    file.write_all(&buffer[..n]).or_else(|e| err("io", format!("Could not write the download: {e}")))?;
                    progress(total);
                }
                Err(e) => break Err(HostError { code: "network", message: format!("Download interrupted: {e}") }),
            }
        };
        match outcome {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or(HostError { code: "network", message: "Download failed.".into() }))
}

fn finish(path: PathBuf, format: &'static str, notes: Vec<String>) -> HostResult<FetchedPack> {
    let mut file = fs::File::open(&path).or_else(|e| err("io", e.to_string()))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buffer).or_else(|e| err("io", e.to_string()))?;
        if n == 0 { break; }
        size += n as u64;
        hash.update(&buffer[..n]);
    }
    if size > ARCHIVE_MAX { let _ = fs::remove_file(&path); return err("too-large", "This pack is larger than the 1 GiB the Manager can import."); }
    Ok(FetchedPack { token: path.file_name().unwrap().to_string_lossy().into_owned(), format, size, sha256: hex(&hash.finalize()), notes })
}

fn fetch_modrinth(job: &Job, version: &str, target: PathBuf) -> HostResult<FetchedPack> {
    let v = get_json(&format!("{MODRINTH}/version/{}", encode(version)))?;
    let files = v["files"].as_array().cloned().unwrap_or_default();
    let file = files.iter().find(|f| f["primary"] == true).or(files.first()).cloned().ok_or(HostError { code: "not-found", message: "This version has no pack file.".into() })?;
    let url = s(&file, "url");
    if host_of(url) != "cdn.modrinth.com" { return err("restricted", "This version's file is not hosted on Modrinth."); }
    let total = file["size"].as_u64().unwrap_or(0);
    download(Some(job), url, &[], &target, ARCHIVE_MAX, |n| job.progress("download", n, total))?;
    let mut hash = Sha512::new();
    let mut input = fs::File::open(&target).or_else(|e| err("io", e.to_string()))?;
    std::io::copy(&mut input, &mut hash).or_else(|e| err("io", e.to_string()))?;
    if hex(&hash.finalize()) != s(&file["hashes"], "sha512") { return err("integrity", "The downloaded pack does not match Modrinth's checksum."); }
    finish(target, "mrpack", vec![])
}

fn fetch_curseforge(job: &Job, pack: &str, version: &str, target: PathBuf) -> HostResult<FetchedPack> {
    let project = cf_get(&format!("/mods/{}", encode(pack)))?;
    let file = cf_get(&format!("/mods/{}/files/{}", encode(pack), encode(version)))?;
    let page = s(&project["data"]["links"], "websiteUrl");
    let url = file["data"]["downloadUrl"].as_str().unwrap_or("");
    let total = file["data"]["fileLength"].as_u64().unwrap_or(0);
    if url.is_empty() || project["data"]["allowModDistribution"] == false {
        return Err(HostError { code: "manual-download", message: page.to_string() });
    }
    if !["edge.forgecdn.net", "mediafilez.forgecdn.net"].contains(&host_of(url).as_str()) { return err("restricted", "CurseForge returned an unexpected download host."); }
    download(Some(job), url, &[], &target, ARCHIVE_MAX, |n| job.progress("download", n, total))?;
    let expected = file["data"]["hashes"].as_array().and_then(|h| h.iter().find(|x| x["algo"] == 1)).map(|x| s(x, "value").to_ascii_lowercase());
    if let Some(expected) = expected {
        let mut hash = Sha1::new();
        let mut input = fs::File::open(&target).or_else(|e| err("io", e.to_string()))?;
        std::io::copy(&mut input, &mut hash).or_else(|e| err("io", e.to_string()))?;
        if hex(&hash.finalize()) != expected { return err("integrity", "The downloaded pack does not match CurseForge's checksum."); }
    }
    finish(target, "curseforge", vec![])
}

/// A published pack path, relative to the game folder, that cannot escape it.
fn clean_game_path(dir: &str, name: &str) -> Option<String> {
    let joined = format!("{}/{}", dir.trim_start_matches("./").trim_matches('/'), name).replace('\\', "/");
    let path = joined.trim_start_matches('/').to_string();
    (!path.is_empty() && !name.is_empty() && !path.split('/').any(|c| c.is_empty() || c == "." || c == "..") && !path.contains(':')).then_some(path)
}

/// FTB publishes full hashes for every file, so a pack becomes a standard .mrpack manifest and the
/// helper downloads and verifies the files itself.
fn ftb_manifest(version: &Value, name: &str) -> HostResult<(Value, Vec<String>)> {
    let targets = version["targets"].as_array().cloned().unwrap_or_default();
    let mut dependencies = serde_json::Map::new();
    for t in &targets {
        match (s(t, "type"), s(t, "name")) {
            ("game", _) => { dependencies.insert("minecraft".into(), json!(s(t, "version"))); }
            ("modloader", "fabric") => { dependencies.insert("fabric-loader".into(), json!(s(t, "version"))); }
            ("modloader", "quilt") => { dependencies.insert("quilt-loader".into(), json!(s(t, "version"))); }
            ("modloader", "forge") => { dependencies.insert("forge".into(), json!(s(t, "version"))); }
            ("modloader", "neoforge") => { dependencies.insert("neoforge".into(), json!(s(t, "version"))); }
            _ => {}
        }
    }
    if !dependencies.contains_key("minecraft") { return err("unsupported", "FTB does not state this version's Minecraft version."); }
    let (mut files, mut notes) = (vec![], vec![]);
    for f in version["files"].as_array().cloned().unwrap_or_default() {
        if f["serveronly"] == true { continue; }
        let Some(path) = clean_game_path(s(&f, "path"), s(&f, "name")) else { notes.push(format!("Skipped an unsafe path: {}", s(&f, "name"))); continue };
        let (sha1, sha512) = (s(&f["hashes"], "sha1"), s(&f["hashes"], "sha512"));
        if sha1.len() != 40 || sha512.len() != 128 { notes.push(format!("Skipped {path}: FTB lists no complete hashes.")); continue; }
        let mut urls = vec![];
        for u in std::iter::once(f["url"].clone()).chain(f["mirrors"].as_array().cloned().unwrap_or_default()) {
            if let Some(u) = u.as_str().filter(|u| u.starts_with("https://")) { urls.push(u.to_string()); }
        }
        // The helper takes the first allowed URL; prefer FTB's own mirror.
        urls.sort_by_key(|u| !u.contains("feed-the-beast.com"));
        if urls.is_empty() { notes.push(format!("Skipped {path}: no download link.")); continue; }
        let env = if f["optional"] == true { json!({"client": "optional", "server": "optional"}) } else { json!({"client": "required", "server": "required"}) };
        files.push(json!({"path": path, "hashes": {"sha1": sha1, "sha512": sha512}, "env": env, "downloads": urls, "fileSize": f["size"]}));
    }
    Ok((json!({"formatVersion": 1, "game": "minecraft", "versionId": s(version, "name"), "name": name, "files": files, "dependencies": dependencies}), notes))
}

fn zip_options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(false)
}

fn fetch_ftb(job: &Job, cache: &CatalogCache, pack: &str, version: &str, target: PathBuf) -> HostResult<FetchedPack> {
    let p = ftb_pack(cache, pack)?;
    let v = get_json(&format!("{FTB}/modpack/{}/{}", encode(pack), encode(version)))?;
    let (manifest, notes) = ftb_manifest(&v, s(&p, "name"))?;
    job.progress("download", 1, 1);
    let file = fs::File::create(&target).or_else(|e| err("io", e.to_string()))?;
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("modrinth.index.json", zip_options()).or_else(|e| err("io", e.to_string()))?;
    zip.write_all(manifest.to_string().as_bytes()).or_else(|e| err("io", e.to_string()))?;
    zip.finish().or_else(|e| err("io", e.to_string()))?;
    finish(target, "mrpack", notes)
}

/// Writes a CurseForge-format archive whose whole content is overrides, for providers that only
/// publish loose files. Those files are shown as local files in the Manager.
struct OverrideZip {
    zip: zip::ZipWriter<fs::File>,
    written: std::collections::HashSet<String>,
    bytes: u64,
}
impl OverrideZip {
    fn new(target: &Path, minecraft: &str, loader: &str, name: &str, version: &str) -> HostResult<Self> {
        let file = fs::File::create(target).or_else(|e| err("io", e.to_string()))?;
        let mut zip = zip::ZipWriter::new(file);
        let manifest = json!({"manifestType": "minecraftModpack", "manifestVersion": 1, "name": name, "version": version, "author": "", "minecraft": {"version": minecraft, "modLoaders": [{"id": loader, "primary": true}]}, "files": [], "overrides": "overrides"});
        zip.start_file("manifest.json", zip_options()).or_else(|e| err("io", e.to_string()))?;
        zip.write_all(manifest.to_string().as_bytes()).or_else(|e| err("io", e.to_string()))?;
        Ok(Self { zip, written: Default::default(), bytes: 0 })
    }
    fn add(&mut self, path: &str, data: &mut impl Read, size: u64) -> HostResult<()> {
        if !self.written.insert(path.to_lowercase()) { return Ok(()); }
        self.bytes += size;
        if self.bytes > ARCHIVE_MAX - (64 << 20) { return err("too-large", "This pack is larger than the 1 GiB the Manager can import."); }
        self.zip.start_file(format!("overrides/{path}"), zip_options()).or_else(|e| err("io", e.to_string()))?;
        std::io::copy(data, &mut self.zip).or_else(|e| err("io", e.to_string()))?;
        Ok(())
    }
    /// Merge a zip's files under `prefix`, skipping `skip` entries.
    fn merge(&mut self, source: &Path, prefix: &str, skip: impl Fn(&str) -> bool) -> HostResult<()> {
        let mut archive = zip::ZipArchive::new(fs::File::open(source).or_else(|e| err("io", e.to_string()))?).or_else(|e| err("invalid", format!("A pack archive is damaged: {e}")))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).or_else(|e| err("invalid", e.to_string()))?;
            if entry.is_dir() { continue; }
            let Some(name) = entry.enclosed_name().map(|p| p.to_string_lossy().replace('\\', "/")) else { continue };
            if skip(&name) { continue; }
            let path = format!("{prefix}{name}");
            let size = entry.size();
            self.add(&path, &mut entry, size)?;
        }
        Ok(())
    }
    /// Merge only the files under `from`, placing them under `to`.
    fn merge_folder(&mut self, source: &Path, from: &str, to: &str) -> HostResult<()> {
        let mut archive = zip::ZipArchive::new(fs::File::open(source).or_else(|e| err("io", e.to_string()))?).or_else(|e| err("invalid", format!("A pack archive is damaged: {e}")))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).or_else(|e| err("invalid", e.to_string()))?;
            if entry.is_dir() { continue; }
            let Some(name) = entry.enclosed_name().map(|p| p.to_string_lossy().replace('\\', "/")) else { continue };
            let Some(rest) = name.strip_prefix(from).map(str::to_string) else { continue };
            if rest.starts_with("META-INF/") { continue; }
            let size = entry.size();
            self.add(&format!("{to}{rest}"), &mut entry, size)?;
        }
        Ok(())
    }
    fn close(self) -> HostResult<()> {
        self.zip.finish().map(|_| ()).or_else(|e| err("io", e.to_string()))
    }
}

/// Forge or a loader version from a Minecraft launcher `version.json`.
fn loader_from_version_json(v: &Value, minecraft: &str) -> Option<String> {
    for lib in v["libraries"].as_array()? {
        let name = s(lib, "name");
        let mut parts = name.split(':');
        let (group, artifact, version) = (parts.next()?, parts.next()?, parts.next().unwrap_or(""));
        if group == "net.minecraftforge" && (artifact == "forge" || artifact == "minecraftforge") {
            let plain = version.trim_start_matches(&format!("{minecraft}-")).trim_end_matches(&format!("-{minecraft}"));
            return Some(format!("forge-{plain}"));
        }
        if group == "net.neoforged" && artifact == "neoforge" { return Some(format!("neoforge-{version}")); }
        if group == "net.fabricmc" && artifact == "fabric-loader" { return Some(format!("fabric-{version}")); }
    }
    None
}

fn read_zip_text(source: &Path, name: &str) -> Option<String> {
    let mut archive = zip::ZipArchive::new(fs::File::open(source).ok()?).ok()?;
    let mut entry = archive.by_name(name).ok()?;
    let mut out = String::new();
    entry.read_to_string(&mut out).ok()?;
    Some(out)
}

fn fetch_technic(job: &Job, slug: &str, version: &str, target: PathBuf) -> HostResult<FetchedPack> {
    let d = get_json(&format!("{TECHNIC}/modpack/{}?build={TECHNIC_BUILD}", encode(slug)))?;
    let name = d["displayName"].as_str().unwrap_or(slug).to_string();
    let minecraft = s(&d, "minecraft").to_string();
    let work = target.with_extension("work");
    fs::create_dir_all(&work).or_else(|e| err("io", e.to_string()))?;
    let _cleanup = RemoveDir(work.clone());
    // Direct packs are one ZIP; Solder packs are one ZIP per mod, all extracted over the game folder.
    let mut parts: Vec<(String, String)> = vec![];
    if let Some(solder) = d["solder"].as_str().filter(|u| u.starts_with("https://")) {
        let build = get_json(&format!("{}/modpack/{}/{}?include=mods", solder.trim_end_matches('/'), encode(slug), encode(version)))?;
        for m in build["mods"].as_array().cloned().unwrap_or_default() {
            if let Some(u) = m["url"].as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://")) { parts.push((u.to_string(), s(&m, "md5").to_ascii_lowercase())); }
        }
    } else if let Some(u) = d["url"].as_str().filter(|u| !u.is_empty()) {
        parts.push((u.to_string(), String::new()));
    }
    if parts.is_empty() { return err("unsupported", "Technic does not publish a downloadable file for this pack. Its author may only allow it through the Technic Launcher."); }
    let total = parts.len() as u64;
    let mut local = vec![];
    for (i, (url, md5)) in parts.iter().enumerate() {
        job.check()?;
        job.progress("download", i as u64, total);
        let path = work.join(format!("{i}.zip"));
        download(Some(job), url, &[], &path, ARCHIVE_MAX, |_| {})?;
        if !md5.is_empty() {
            use md5::Digest as _;
            let mut hash = md5::Md5::new();
            let mut input = fs::File::open(&path).or_else(|e| err("io", e.to_string()))?;
            std::io::copy(&mut input, &mut hash).or_else(|e| err("io", e.to_string()))?;
            if hex(&hash.finalize()) != *md5 { return err("integrity", "A file of this pack does not match its published checksum."); }
        }
        local.push(path);
    }
    // bin/ holds launcher data: read the loader from it, but it is never a game file.
    let mut loader = None;
    for path in &local {
        let version_json = read_zip_text(path, "bin/version.json").or_else(|| {
            let mut archive = zip::ZipArchive::new(fs::File::open(path).ok()?).ok()?;
            let mut jar = archive.by_name("bin/modpack.jar").ok()?;
            let mut bytes = vec![];
            jar.read_to_end(&mut bytes).ok()?;
            let mut inner = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
            let mut entry = inner.by_name("version.json").ok()?;
            let mut out = String::new();
            entry.read_to_string(&mut out).ok()?;
            Some(out)
        });
        if let Some(found) = version_json.and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| loader_from_version_json(&v, &minecraft)) { loader = Some(found); break; }
    }
    let Some(loader) = loader else { return err("unsupported", "This Technic pack patches the Minecraft JAR directly (a legacy format), which Manager projects cannot represent. Install it with Awake Launcher instead."); };
    job.progress("download", total, total);
    let mut out = OverrideZip::new(&target, &minecraft, &loader, &name, version)?;
    for path in &local {
        job.check()?;
        out.merge(path, "", |n| n.starts_with("bin/") || n.starts_with("META-INF/"))?;
    }
    out.close()?;
    finish(target, "curseforge", vec!["Technic files are imported as local files; update them by installing a newer build.".into()])
}

struct RemoveDir(PathBuf);
impl Drop for RemoveDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fetch_atlauncher(job: &Job, pack: &str, version: &str, target: PathBuf) -> HostResult<FetchedPack> {
    let base = format!("{ATL_CDN}packs/{pack}/versions/{}/", encode(version));
    let config = get_json(&format!("{base}Configs.json"))?;
    let minecraft = s(&config, "minecraft").to_string();
    let loader_kind = format!("{} {}", s(&config["loader"], "type"), s(&config["loader"], "className")).to_ascii_lowercase();
    let meta = &config["loader"]["metadata"];
    // Older packs list Forge among their mods instead of naming a loader.
    let listed_forge = config["mods"].as_array().and_then(|m| m.iter().find(|x| s(x, "type").eq_ignore_ascii_case("forge")).cloned());
    let loader_kind = if config["loader"].is_object() { loader_kind } else if listed_forge.is_some() { "forge".to_string() } else { loader_kind };
    let loader_version = meta["version"].as_str().or(meta["loader"].as_str()).or(meta["loader"]["version"].as_str()).or(listed_forge.as_ref().and_then(|m| m["version"].as_str())).unwrap_or("");
    let loader = if loader_kind.contains("neoforge") { format!("neoforge-{loader_version}") } else if loader_kind.contains("forge") { format!("forge-{loader_version}") } else if loader_kind.contains("fabric") { format!("fabric-{loader_version}") } else if loader_kind.contains("quilt") { format!("quilt-{loader_version}") } else { String::new() };
    if loader.is_empty() || loader_version.is_empty() || loader_version.eq_ignore_ascii_case("recommended") || loader_version.eq_ignore_ascii_case("latest") {
        return err("unsupported", "This ATLauncher version does not name an exact loader version, which Manager projects need. Install it with Awake Launcher instead.");
    }
    let work = target.with_extension("work");
    fs::create_dir_all(&work).or_else(|e| err("io", e.to_string()))?;
    let _cleanup = RemoveDir(work.clone());
    let mut out = OverrideZip::new(&target, &minecraft, &loader, pack, version)?;
    let mut notes = vec![];
    if config["noConfigs"] != true {
        let configs = work.join("configs.zip");
        download(Some(job), &format!("{base}Configs.zip"), &[], &configs, ARCHIVE_MAX, |_| {})?;
        out.merge(&configs, "", |_| false)?;
    }
    let mods: Vec<Value> = config["mods"].as_array().cloned().unwrap_or_default().into_iter().filter(|m| m["client"] != false && (m["optional"] != true || m["recommended"] != false && m["selected"] == true)).collect();
    let total = mods.len() as u64;
    for (i, m) in mods.iter().enumerate() {
        job.check()?;
        job.progress("download", i as u64, total);
        let folder = match s(m, "type").to_ascii_lowercase().as_str() {
            "forge" => continue, // installed as the project's loader
            "mods" | "fabric" | "dependency" | "depandency" => "mods",
            "resourcepack" | "texturepack" => "resourcepacks",
            "shaderpack" => "shaderpacks",
            "flan" => "Flan",
            "plugins" => "plugins",
            "coremods" => "coremods",
            "extract" => "",
            "jar" | "ic2lib" | "denlib" | "millenaire" | "decomp" | "natives" | "bin" | "root" => { return err("unsupported", format!("This pack needs \"{}\" installed in a way Manager projects cannot represent. Install it with Awake Launcher instead.", s(m, "name"))); }
            _ => "mods",
        };
        let url = match s(m, "download") {
            "server" => format!("{ATL_CDN}{}", s(m, "url")),
            "direct" => s(m, "url").to_string(),
            _ => { notes.push(format!("Manual download required: {} ({})", s(m, "name"), s(m, "url"))); continue; }
        };
        let path = work.join(format!("m{i}"));
        download(Some(job), &url, &[], &path, ARCHIVE_MAX, |_| {})?;
        let expected = s(m, "md5").to_ascii_lowercase();
        if !expected.is_empty() {
            use md5::Digest as _;
            let mut hash = md5::Md5::new();
            let mut input = fs::File::open(&path).or_else(|e| err("io", e.to_string()))?;
            std::io::copy(&mut input, &mut hash).or_else(|e| err("io", e.to_string()))?;
            if hex(&hash.finalize()) != expected { return err("integrity", format!("{} does not match its published checksum.", s(m, "name"))); }
        }
        if s(m, "type").eq_ignore_ascii_case("extract") {
            // A ZIP unpacked into the game folder, optionally only one folder of it.
            let target = match s(m, "extractTo").to_ascii_lowercase().as_str() {
                "root" | "" => String::new(),
                "mods" => "mods/".to_string(),
                "coremods" => "coremods/".to_string(),
                "config" | "configs" => "config/".to_string(),
                "resourcepack" | "resourcepacks" | "texturepack" | "texturepacks" => "resourcepacks/".to_string(),
                other => return err("unsupported", format!("This pack unpacks \"{}\" into {other}, which Manager projects cannot represent. Install it with Awake Launcher instead.", s(m, "name"))),
            };
            let inner = s(m, "extractFolder").trim_matches('/').to_string();
            let inner_prefix = if inner.is_empty() { String::new() } else { format!("{inner}/") };
            out.merge_folder(&path, &inner_prefix, &target)?;
            let _ = fs::remove_file(&path);
            continue;
        }
        let Some(game) = clean_game_path(folder, s(m, "file")) else { continue };
        let size = fs::metadata(&path).map_or(0, |x| x.len());
        out.add(&game, &mut fs::File::open(&path).or_else(|e| err("io", e.to_string()))?, size)?;
        let _ = fs::remove_file(&path);
    }
    out.close()?;
    job.progress("download", total, total);
    notes.push("ATLauncher files are imported as local files; update them by installing a newer version.".into());
    finish(target, "curseforge", notes)
}

#[tauri::command]
pub async fn pack_fetch(app: tauri::AppHandle, cache: tauri::State<'_, Arc<CatalogCache>>, provider: String, pack_id: String, version_id: String, job: String) -> HostResult<FetchedPack> {
    let cache = cache.inner().clone();
    let cancel = Arc::new(AtomicBool::new(false));
    cache.jobs.lock().unwrap().insert(job.clone(), cancel.clone());
    let jobs = cache.clone();
    let key = job.clone();
    let result = blocking(move || {
        safe_id(&pack_id)?;
        safe_id(&version_id)?;
        let target = pack_dir()?.join(format!("{}.pack", uuid_like()));
        let job = Job { app, id: job, cancel };
        let result = match provider.as_str() {
            "modrinth" => fetch_modrinth(&job, &version_id, target.clone()),
            "curseforge" => fetch_curseforge(&job, &pack_id, &version_id, target.clone()),
            "ftb" => fetch_ftb(&job, &cache, &pack_id, &version_id, target.clone()),
            "technic" => fetch_technic(&job, &pack_id, &version_id, target.clone()),
            "atlauncher" => fetch_atlauncher(&job, &pack_id, &version_id, target.clone()),
            _ => err("invalid", "Unknown modpack provider."),
        };
        if result.is_err() {
            let _ = fs::remove_file(&target);
        }
        result
    })
    .await;
    jobs.jobs.lock().unwrap().remove(&key);
    result
}

#[tauri::command]
pub fn pack_cancel(cache: tauri::State<'_, Arc<CatalogCache>>, job: String) {
    if let Some(c) = cache.jobs.lock().unwrap().get(&job) {
        c.store(true, Ordering::Relaxed);
    }
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    format!("{:x}-{:x}", SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos()), std::process::id())
}
fn ticket_path(token: &str) -> HostResult<PathBuf> {
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.') || token.contains("..") { return err("invalid", "Invalid pack ticket."); }
    Ok(pack_dir()?.join(token))
}

/// One chunk of a fetched pack, as raw bytes, for the helper's upload.
#[tauri::command]
pub async fn pack_read(token: String, offset: u64, length: u32) -> HostResult<tauri::ipc::Response> {
    blocking(move || {
        let mut file = fs::File::open(ticket_path(&token)?).or_else(|e| err("io", e.to_string()))?;
        file.seek(std::io::SeekFrom::Start(offset)).or_else(|e| err("io", e.to_string()))?;
        let mut buffer = vec![0u8; length.min(1 << 20) as usize];
        let mut filled = 0;
        while filled < buffer.len() {
            let n = file.read(&mut buffer[filled..]).or_else(|e| err("io", e.to_string()))?;
            if n == 0 { break; }
            filled += n;
        }
        buffer.truncate(filled);
        Ok(tauri::ipc::Response::new(buffer))
    })
    .await
}

#[tauri::command]
pub fn pack_discard(token: String) -> HostResult<()> {
    let _ = fs::remove_file(ticket_path(&token)?);
    Ok(())
}

/* ---------- batched project names, icons and update lookups ---------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    provider: String,
    project_id: String,
    #[serde(default)]
    version_id: Option<String>,
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    provider: String,
    project_id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_url: Option<String>,
}

pub fn parse_modrinth_projects(list: &Value) -> Vec<ProjectMeta> {
    list.as_array().map_or(vec![], |a| a.iter().map(|p| ProjectMeta { provider: "modrinth".into(), project_id: s(p, "id").into(), name: s(p, "title").into(), icon_url: p["icon_url"].as_str().filter(|u| !u.is_empty()).map(Into::into) }).collect())
}
pub fn parse_curseforge_projects(page: &Value) -> Vec<ProjectMeta> {
    page["data"].as_array().map_or(vec![], |a| a.iter().map(|p| ProjectMeta { provider: "curseforge".into(), project_id: p["id"].as_i64().unwrap_or(0).to_string(), name: s(p, "name").into(), icon_url: p["logo"]["thumbnailUrl"].as_str().filter(|u| !u.is_empty()).map(Into::into) }).collect())
}

#[tauri::command]
pub async fn project_meta(items: Vec<ProjectRef>) -> HostResult<Vec<ProjectMeta>> {
    blocking(move || {
        let ids = |provider: &str| items.iter().filter(|i| i.provider == provider).map(|i| i.project_id.clone()).collect::<Vec<_>>();
        let mut out = vec![];
        for chunk in ids("modrinth").chunks(200) {
            out.extend(parse_modrinth_projects(&get_json(&format!("{MODRINTH}/projects?ids={}", encode(&serde_json::to_string(chunk).unwrap())))?));
        }
        if curseforge_key().is_some() {
            for chunk in ids("curseforge").chunks(500) {
                let numbers: Vec<i64> = chunk.iter().filter_map(|i| i.parse().ok()).collect();
                out.extend(parse_curseforge_projects(&cf_post("/mods", &json!({"modIds": numbers, "filterPcOnly": false}))?));
            }
        }
        Ok(out)
    })
    .await
}

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    author: String,
    summary: String,
    downloads: Option<f64>,
    updated_at: Option<String>,
    license: Option<String>,
    categories: Vec<String>,
    page_url: Option<String>,
}

pub fn parse_modrinth_detail(p: &Value, members: &Value) -> ProjectDetail {
    let owner = members.as_array().and_then(|m| m.iter().find(|x| x["role"] == "Owner").or(m.first())).map_or("", |x| x["user"]["username"].as_str().unwrap_or(""));
    ProjectDetail {
        author: owner.into(),
        summary: s(p, "description").into(),
        downloads: p["downloads"].as_f64(),
        updated_at: p["updated"].as_str().map(Into::into),
        license: p["license"]["id"].as_str().filter(|l| !l.is_empty()).map(Into::into),
        categories: p["categories"].as_array().map_or(vec![], |c| c.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        page_url: Some(format!("https://modrinth.com/mod/{}", s(p, "slug"))),
    }
}
pub fn parse_curseforge_detail(p: &Value) -> ProjectDetail {
    ProjectDetail {
        author: p["authors"][0]["name"].as_str().unwrap_or("").into(),
        summary: s(p, "summary").into(),
        downloads: p["downloadCount"].as_f64(),
        updated_at: p["dateModified"].as_str().map(Into::into),
        license: None,
        categories: p["categories"].as_array().map_or(vec![], |c| c.iter().filter_map(|x| x["name"].as_str().map(String::from)).collect()),
        page_url: p["links"]["websiteUrl"].as_str().filter(|u| u.starts_with("https://")).map(Into::into),
    }
}

#[tauri::command]
pub async fn project_detail(provider: String, project_id: String) -> HostResult<ProjectDetail> {
    blocking(move || {
        let id = safe_id(&project_id)?;
        match provider.as_str() {
            "modrinth" => {
                let project = get_json(&format!("{MODRINTH}/project/{}", encode(id)))?;
                let members = get_json(&format!("{MODRINTH}/project/{}/members", encode(id))).unwrap_or(Value::Null);
                Ok(parse_modrinth_detail(&project, &members))
            }
            "curseforge" => Ok(parse_curseforge_detail(&cf_get(&format!("/mods/{}", encode(id)))?["data"])),
            _ => err("invalid", "Unknown mod provider."),
        }
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCandidate {
    id: String,
    name: String,
    release_type: String,
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    provider: String,
    project_id: String,
    installed_version_id: String,
    candidate: Option<UpdateCandidate>,
}

/// CurseForge: newest stable file for this game version and loader, if newer than the installed one.
pub fn curseforge_candidate(project: &Value, installed: i64, minecraft: &str, loader: i64) -> Option<UpdateCandidate> {
    let best = project["latestFilesIndexes"].as_array()?.iter().filter(|f| f["gameVersion"] == minecraft && f["modLoader"] == loader && f["releaseType"] == 1).max_by_key(|f| f["fileId"].as_i64().unwrap_or(0))?;
    let id = best["fileId"].as_i64()?;
    (id > installed).then(|| UpdateCandidate { id: id.to_string(), name: s(best, "filename").trim_end_matches(".jar").to_string(), release_type: "release".into() })
}

#[tauri::command]
pub async fn mod_updates(items: Vec<ProjectRef>, minecraft_version: String, loader: String) -> HostResult<Vec<UpdateResult>> {
    blocking(move || {
        let mut out = vec![];
        let installed: BTreeMap<String, String> = items.iter().filter(|i| i.provider == "modrinth").filter_map(|i| Some((i.version_id.clone()?, i.project_id.clone()))).collect();
        let version_ids: Vec<String> = installed.keys().cloned().collect();
        for chunk in version_ids.chunks(200) {
            let versions = get_json(&format!("{MODRINTH}/versions?ids={}", encode(&serde_json::to_string(chunk).unwrap())))?;
            let mut by_hash: BTreeMap<String, (String, String)> = BTreeMap::new(); // sha512 -> (project, version)
            for v in versions.as_array().cloned().unwrap_or_default() {
                let files = v["files"].as_array().cloned().unwrap_or_default();
                if let Some(f) = files.iter().find(|f| f["primary"] == true).or(files.first()) {
                    by_hash.insert(s(&f["hashes"], "sha512").to_string(), (s(&v, "project_id").to_string(), s(&v, "id").to_string()));
                }
            }
            let response = agent(60).post(format!("{MODRINTH}/version_files/update")).header("Accept", "application/json").send_json(json!({"hashes": by_hash.keys().collect::<Vec<_>>(), "algorithm": "sha512", "loaders": [loader], "game_versions": [minecraft_version], "version_types": ["release"]})).or_else(|e| err("network", format!("Modrinth: {e}")))?;
            let updates = read_json("https://api.modrinth.com", response)?;
            for (hash, (project, current)) in by_hash {
                let latest = &updates[hash.as_str()];
                let candidate = latest["id"].as_str().filter(|id| *id != current).map(|id| UpdateCandidate { id: id.to_string(), name: s(latest, "version_number").to_string(), release_type: latest["version_type"].as_str().unwrap_or("release").to_string() });
                out.push(UpdateResult { provider: "modrinth".into(), project_id: project, installed_version_id: current, candidate });
            }
        }
        if curseforge_key().is_some() {
            let loader_id = match loader.as_str() { "forge" => 1, "fabric" => 4, "quilt" => 5, "neoforge" => 6, _ => 0 };
            let files: BTreeMap<i64, i64> = items.iter().filter(|i| i.provider == "curseforge").filter_map(|i| Some((i.project_id.parse().ok()?, i.version_id.as_ref()?.parse().ok()?))).collect();
            let projects: Vec<i64> = files.keys().copied().collect();
            for chunk in projects.chunks(500) {
                let page = cf_post("/mods", &json!({"modIds": chunk, "filterPcOnly": false}))?;
                for p in page["data"].as_array().cloned().unwrap_or_default() {
                    let id = p["id"].as_i64().unwrap_or(0);
                    if let Some(current) = files.get(&id) {
                        out.push(UpdateResult { provider: "curseforge".into(), project_id: id.to_string(), installed_version_id: current.to_string(), candidate: curseforge_candidate(&p, *current, &minecraft_version, loader_id) });
                    }
                }
            }
        }
        Ok(out)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real CurseForge through this host's own code path. Needs the key from GitHub Actions.
    #[test]
    #[ignore]
    fn curseforge_live_catalog_and_batch_reads() {
        if curseforge_key().is_none() { return; }
        let packs = curseforge_search("", 0, 10).expect("modpack search");
        assert!(packs.total > 100 && !packs.hits.is_empty());
        assert!(packs.hits.iter().filter(|h| h.icon_url.is_some()).count() >= 5, "modpack logos");
        let versions = curseforge_versions(&packs.hits[0].pack_id).expect("versions");
        assert!(!versions.is_empty() && !versions[0].minecraft_version.is_empty());
        // The same mod search Native Core sends: popular first, with logos on the media host.
        let mods = cf_get("/mods/search?gameId=432&classId=6&searchFilter=Create&gameVersion=1.20.1&modLoaderType=1&sortField=2&sortOrder=desc&index=0&pageSize=20").expect("mod search");
        let rows = mods["data"].as_array().expect("rows");
        assert!(rows.iter().take(5).any(|m| s(m, "name").starts_with("Create")), "popular-first order");
        assert!(rows.iter().filter(|m| m["logo"]["thumbnailUrl"].as_str().is_some_and(|u| u.starts_with("https://media.forgecdn.net/"))).count() > rows.len() / 2, "logo host");
        let meta = parse_curseforge_projects(&cf_post("/mods", &json!({"modIds": [238222], "filterPcOnly": false})).expect("batch"));
        assert!(meta[0].icon_url.as_deref().is_some_and(|u| u.starts_with("https://media.forgecdn.net/")), "project logo");
    }

    #[test]
    fn curseforge_logos_and_names_are_read_from_a_batch() {
        let page = json!({"data": [{"id": 238222, "name": "JEI", "logo": {"thumbnailUrl": "https://media.forgecdn.net/avatars/thumbnails/1/2/64/64/x.png"}}, {"id": 5, "name": "No logo", "logo": null}]});
        let list = parse_curseforge_projects(&page);
        assert_eq!(list[0], ProjectMeta { provider: "curseforge".into(), project_id: "238222".into(), name: "JEI".into(), icon_url: Some("https://media.forgecdn.net/avatars/thumbnails/1/2/64/64/x.png".into()) });
        assert_eq!(list[1].icon_url, None);
    }

    #[test]
    fn project_details_read_both_providers() {
        let m = parse_modrinth_detail(&json!({"slug": "sodium", "description": "Fast", "downloads": 5.0, "updated": "2026-01-01T00:00:00Z", "license": {"id": "LGPL-3.0"}, "categories": ["optimization"]}), &json!([{"role": "Member", "user": {"username": "b"}}, {"role": "Owner", "user": {"username": "jelly"}}]));
        assert_eq!((m.author.as_str(), m.license.as_deref(), m.page_url.as_deref()), ("jelly", Some("LGPL-3.0"), Some("https://modrinth.com/mod/sodium")));
        let c = parse_curseforge_detail(&json!({"authors": [{"name": "mezz"}], "summary": "Items", "downloadCount": 9.0, "categories": [{"name": "API"}], "links": {"websiteUrl": "https://www.curseforge.com/minecraft/mc-mods/jei"}}));
        assert_eq!((c.author.as_str(), c.categories.len(), c.downloads), ("mezz", 1, Some(9.0)));
    }

    #[test]
    fn curseforge_update_needs_a_newer_stable_file_for_this_game_and_loader() {
        let p = json!({"latestFilesIndexes": [
            {"gameVersion": "1.20.1", "modLoader": 1, "releaseType": 1, "fileId": 200, "filename": "a-2.jar"},
            {"gameVersion": "1.20.1", "modLoader": 1, "releaseType": 2, "fileId": 300, "filename": "a-3-beta.jar"},
            {"gameVersion": "1.20.1", "modLoader": 4, "releaseType": 1, "fileId": 400, "filename": "a-fabric.jar"},
            {"gameVersion": "1.19.2", "modLoader": 1, "releaseType": 1, "fileId": 500, "filename": "a-old.jar"}]});
        assert_eq!(curseforge_candidate(&p, 100, "1.20.1", 1).unwrap().id, "200");
        assert_eq!(curseforge_candidate(&p, 100, "1.20.1", 1).unwrap().name, "a-2");
        assert_eq!(curseforge_candidate(&p, 200, "1.20.1", 1), None);
        assert_eq!(curseforge_candidate(&p, 100, "1.18.2", 1), None);
    }

    #[test]
    fn pack_paths_stay_inside_the_game_folder() {
        assert_eq!(clean_game_path("./mods", "a.jar").as_deref(), Some("mods/a.jar"));
        assert_eq!(clean_game_path("./config/x/", "b.json").as_deref(), Some("config/x/b.json"));
        assert_eq!(clean_game_path("./", "options.txt").as_deref(), Some("options.txt"));
        for bad in [("./../..", "a.jar"), ("./mods", ".."), ("C:/x", "a.jar"), ("./mods", "")] {
            assert_eq!(clean_game_path(bad.0, bad.1), None, "{bad:?}");
        }
    }

    #[test]
    fn ftb_versions_become_a_standard_manifest() {
        let sha1 = "a".repeat(40);
        let sha512 = "b".repeat(128);
        let v = json!({"name": "1.0", "targets": [{"type": "game", "name": "minecraft", "version": "1.20.1"}, {"type": "modloader", "name": "forge", "version": "47.2.0"}, {"type": "runtime", "name": "java", "version": "17"}],
            "files": [
                {"path": "./mods", "name": "a.jar", "url": "https://edge.forgecdn.net/a.jar", "mirrors": ["https://files.feed-the-beast.com/blob/a.jar"], "hashes": {"sha1": sha1, "sha512": sha512}, "size": 10},
                {"path": "./mods", "name": "server.jar", "serveronly": true, "url": "https://files.feed-the-beast.com/s.jar", "hashes": {"sha1": sha1, "sha512": sha512}, "size": 10},
                {"path": "./../x", "name": "evil", "url": "https://files.feed-the-beast.com/e", "hashes": {"sha1": sha1, "sha512": sha512}, "size": 1}]});
        let (m, notes) = ftb_manifest(&v, "Pack").unwrap();
        assert_eq!(m["dependencies"], json!({"minecraft": "1.20.1", "forge": "47.2.0"}));
        assert_eq!(m["files"].as_array().unwrap().len(), 1);
        assert_eq!(m["files"][0]["downloads"][0], "https://files.feed-the-beast.com/blob/a.jar");
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn loaders_come_from_launcher_version_files() {
        let forge = json!({"libraries": [{"name": "com.x:y:1"}, {"name": "net.minecraftforge:forge:1.12.2-14.23.5.2860"}]});
        assert_eq!(loader_from_version_json(&forge, "1.12.2").as_deref(), Some("forge-14.23.5.2860"));
        let legacy = json!({"libraries": [{"name": "net.minecraftforge:minecraftforge:10.13.4.1614-1.7.10"}]});
        assert_eq!(loader_from_version_json(&legacy, "1.7.10").as_deref(), Some("forge-10.13.4.1614"));
        assert_eq!(loader_from_version_json(&json!({"libraries": []}), "1.7.10"), None);
    }

    #[test]
    fn identifiers_cannot_alter_a_url_path() {
        assert!(safe_id("1.2.3-alpha_1").is_ok());
        for bad in ["", "../x", "a/b", "a?b", "a#b"] {
            assert!(safe_id(bad).is_err(), "{bad}");
        }
        assert!(ticket_path("../evil").is_err());
    }
}
