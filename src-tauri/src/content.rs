//! Resource packs and shader packs from Modrinth and CurseForge: search, versions, and installing
//! one into a project's `resourcepacks` or `shaderpacks` folder.
//!
//! Unlike mods these are plain zip files the game only reads, with no loader or dependencies to
//! resolve, so they do not go through the helper's reviewed plans. An install is one verified
//! download from the provider's own CDN, written under a temporary name and renamed into place.

use crate::providers::{blocking, cf_get, download, encode, err, get_json, hex, host_of, release_name, s, safe_id, HostError, HostResult};
use serde::Serialize;
use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha512};
use std::fs;
use std::path::Path;
use tauri::Emitter;

const MODRINTH: &str = "https://api.modrinth.com/v2";
const DOWNLOAD_MAX: u64 = 1 << 30;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    ResourcePack,
    Shader,
}
impl Kind {
    pub fn parse(kind: &str) -> HostResult<Self> {
        match kind {
            "resourcepack" => Ok(Self::ResourcePack),
            "shader" => Ok(Self::Shader),
            _ => err("invalid", "Unknown content type."),
        }
    }
    /// Modrinth's project type, which is also the path segment of its project pages.
    fn modrinth(self) -> &'static str {
        if self == Self::ResourcePack { "resourcepack" } else { "shader" }
    }
    /// CurseForge's class for Minecraft (game 432): 12 is Resource Packs, 6552 is Shaders.
    fn curseforge_class(self) -> u32 {
        if self == Self::ResourcePack { 12 } else { 6552 }
    }
    fn folder(self) -> &'static str {
        if self == Self::ResourcePack { "resourcepacks" } else { "shaderpacks" }
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    provider: &'static str,
    project_id: String,
    name: String,
    author: String,
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloads: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_url: Option<String>,
}
#[derive(Serialize, Debug)]
pub struct ContentPage {
    hits: Vec<ContentHit>,
    total: u64,
}
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContentVersion {
    id: String,
    name: String,
    version_number: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    release_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_at: Option<String>,
    file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<u64>,
    game_versions: Vec<String>,
    /// What can load it, as the provider tags it (Iris, OptiFine...). Empty for resource packs.
    loaders: Vec<String>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map_or(vec![], |a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
}
fn web_url(v: &Value) -> Option<String> {
    v.as_str().filter(|u| u.starts_with("https://")).map(Into::into)
}

pub fn modrinth_search_url(kind: Kind, text: &str, minecraft: &str, offset: u32, limit: u32) -> String {
    let mut facets = format!(r#"[["project_type:{}"]"#, kind.modrinth());
    if !minecraft.is_empty() {
        facets.push_str(&format!(r#",["versions:{minecraft}"]"#));
    }
    facets.push(']');
    let index = if text.trim().is_empty() { "downloads" } else { "relevance" };
    format!("{MODRINTH}/search?query={}&facets={}&index={index}&offset={offset}&limit={limit}", encode(text), encode(&facets))
}
pub fn parse_modrinth_hits(kind: Kind, page: &Value) -> Vec<ContentHit> {
    page["hits"].as_array().map_or(vec![], |list| {
        list.iter()
            .map(|h| ContentHit {
                provider: "modrinth",
                project_id: s(h, "project_id").into(),
                name: s(h, "title").into(),
                author: s(h, "author").into(),
                summary: s(h, "description").into(),
                icon_url: web_url(&h["icon_url"]),
                downloads: h["downloads"].as_f64(),
                page_url: Some(format!("https://modrinth.com/{}/{}", kind.modrinth(), s(h, "slug"))).filter(|_| !s(h, "slug").is_empty()),
            })
            .collect()
    })
}

pub fn curseforge_search_path(kind: Kind, text: &str, minecraft: &str, offset: u32, limit: u32) -> String {
    let limit = limit.min(50).min(10000u32.saturating_sub(offset)).max(1);
    let version = if minecraft.is_empty() { String::new() } else { format!("&gameVersion={}", encode(minecraft)) };
    format!("/mods/search?gameId=432&classId={}&sortField=2&sortOrder=desc&searchFilter={}{version}&index={offset}&pageSize={limit}", kind.curseforge_class(), encode(text))
}
pub fn parse_curseforge_hits(page: &Value) -> Vec<ContentHit> {
    page["data"].as_array().map_or(vec![], |list| {
        list.iter()
            .map(|h| ContentHit {
                provider: "curseforge",
                project_id: h["id"].as_i64().unwrap_or(0).to_string(),
                name: s(h, "name").into(),
                author: h["authors"][0]["name"].as_str().unwrap_or("").into(),
                summary: s(h, "summary").into(),
                icon_url: web_url(&h["logo"]["thumbnailUrl"]),
                downloads: h["downloadCount"].as_f64(),
                page_url: web_url(&h["links"]["websiteUrl"]),
            })
            .collect()
    })
}

#[tauri::command]
pub async fn content_search(provider: String, kind: String, text: String, minecraft_version: String, offset: u32, limit: u32) -> HostResult<ContentPage> {
    blocking(move || {
        let kind = Kind::parse(&kind)?;
        let minecraft = if minecraft_version.is_empty() { "" } else { safe_id(&minecraft_version)? };
        let limit = limit.clamp(1, 60);
        match provider.as_str() {
            "modrinth" => {
                let page = get_json(&modrinth_search_url(kind, &text, minecraft, offset, limit))?;
                Ok(ContentPage { hits: parse_modrinth_hits(kind, &page), total: page["total_hits"].as_u64().unwrap_or(0) })
            }
            "curseforge" => {
                let page = cf_get(&curseforge_search_path(kind, &text, minecraft, offset, limit))?;
                Ok(ContentPage { hits: parse_curseforge_hits(&page), total: page["pagination"]["totalCount"].as_u64().unwrap_or(0).min(10000) })
            }
            _ => err("invalid", "Unknown provider."),
        }
    })
    .await
}

fn modrinth_file(version: &Value) -> Option<&Value> {
    let files = version["files"].as_array()?;
    files.iter().find(|f| f["primary"] == true).or(files.first())
}
pub fn parse_modrinth_versions(list: &Value) -> Vec<ContentVersion> {
    list.as_array().map_or(vec![], |all| {
        all.iter()
            .filter_map(|v| {
                let file = modrinth_file(v)?;
                Some(ContentVersion {
                    id: s(v, "id").into(),
                    name: s(v, "name").into(),
                    version_number: s(v, "version_number").into(),
                    release_type: v["version_type"].as_str().map(Into::into),
                    published_at: v["date_published"].as_str().map(Into::into),
                    file_name: s(file, "filename").into(),
                    size_bytes: file["size"].as_u64(),
                    game_versions: strings(&v["game_versions"]),
                    // "minecraft" only says it is a resource pack.
                    loaders: strings(&v["loaders"]).into_iter().filter(|l| l != "minecraft").collect(),
                })
            })
            .collect()
    })
}
pub fn parse_curseforge_versions(page: &Value) -> Vec<ContentVersion> {
    page["data"].as_array().map_or(vec![], |all| {
        all.iter()
            .map(|f| {
                let (game_versions, loaders): (Vec<String>, Vec<String>) = strings(&f["gameVersions"]).into_iter().partition(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()));
                ContentVersion {
                    id: f["id"].as_i64().unwrap_or(0).to_string(),
                    name: s(f, "displayName").into(),
                    version_number: s(f, "displayName").into(),
                    release_type: f["releaseType"].as_i64().and_then(release_name),
                    published_at: f["fileDate"].as_str().map(Into::into),
                    file_name: s(f, "fileName").into(),
                    size_bytes: f["fileLength"].as_u64(),
                    game_versions,
                    loaders,
                }
            })
            .collect()
    })
}

/// Versions of a project, newest first; only those for `minecraft_version` when one is given.
#[tauri::command]
pub async fn content_versions(provider: String, project_id: String, minecraft_version: String) -> HostResult<Vec<ContentVersion>> {
    blocking(move || {
        let id = safe_id(&project_id)?;
        let minecraft = if minecraft_version.is_empty() { "" } else { safe_id(&minecraft_version)? };
        match provider.as_str() {
            "modrinth" => {
                let filter = if minecraft.is_empty() { String::new() } else { format!("?game_versions={}", encode(&format!(r#"["{minecraft}"]"#))) };
                Ok(parse_modrinth_versions(&get_json(&format!("{MODRINTH}/project/{}/version{filter}", encode(id)))?))
            }
            "curseforge" => {
                let filter = if minecraft.is_empty() { String::new() } else { format!("&gameVersion={}", encode(minecraft)) };
                Ok(parse_curseforge_versions(&cf_get(&format!("/mods/{}/files?index=0&pageSize=50{filter}", encode(id)))?))
            }
            _ => err("invalid", "Unknown provider."),
        }
    })
    .await
}

/// A provider's file name as it may be written into a pack folder: one plain `.zip` name.
pub fn pack_file_name(name: &str) -> HostResult<&str> {
    const RESERVED: [&str; 22] = ["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];
    let lower = name.to_ascii_lowercase();
    let plain = !name.is_empty() && name.len() <= 200 && !name.starts_with(['.', ' ']) && !name.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c));
    if plain && lower.ends_with(".zip") && !RESERVED.contains(&lower.split('.').next().unwrap_or("")) {
        Ok(name)
    } else {
        err("restricted", format!("The provider lists \"{name}\" for this version, which is not a pack zip the Manager can install."))
    }
}

/// What to download for one version: (url, file name, size, sha512 or sha1).
type Source = (String, String, u64, Checksum);
#[derive(Debug, PartialEq)]
pub enum Checksum {
    Sha512(String),
    Sha1(String),
    None,
}

pub fn modrinth_source(version: &Value, project_id: &str) -> HostResult<Source> {
    if s(version, "project_id") != project_id {
        return err("invalid", "That version belongs to another project.");
    }
    let file = modrinth_file(version).ok_or(HostError { code: "not-found", message: "This version has no file.".into() })?;
    let url = s(file, "url");
    if host_of(url) != "cdn.modrinth.com" || !url.starts_with("https://") {
        return err("restricted", "This version's file is not hosted on Modrinth.");
    }
    let sha512 = s(&file["hashes"], "sha512").to_ascii_lowercase();
    if sha512.len() != 128 {
        return err("restricted", "Modrinth lists no checksum for this file.");
    }
    Ok((url.into(), pack_file_name(s(file, "filename"))?.into(), file["size"].as_u64().unwrap_or(0), Checksum::Sha512(sha512)))
}

pub fn curseforge_source(kind: Kind, project: &Value, file: &Value) -> HostResult<Source> {
    if project["classId"].as_u64() != Some(u64::from(kind.curseforge_class())) {
        return err("invalid", "That CurseForge project is a different kind of content.");
    }
    let url = file["downloadUrl"].as_str().unwrap_or("");
    if url.is_empty() || project["allowModDistribution"] == false {
        let page = web_url(&project["links"]["websiteUrl"]).unwrap_or_default();
        return err("manual-download", format!("Its author only allows downloads from the CurseForge website. Download it there, then use \"Add files\" on the Files page. {page}").trim().to_string());
    }
    if !url.starts_with("https://") || !["edge.forgecdn.net", "mediafilez.forgecdn.net"].contains(&host_of(url).as_str()) {
        return err("restricted", "CurseForge returned an unexpected download host.");
    }
    let sha1 = file["hashes"].as_array().and_then(|h| h.iter().find(|x| x["algo"] == 1)).map(|x| s(x, "value").to_ascii_lowercase()).filter(|h| h.len() == 40);
    Ok((url.into(), pack_file_name(s(file, "fileName"))?.into(), file["fileLength"].as_u64().unwrap_or(0), sha1.map_or(Checksum::None, Checksum::Sha1)))
}

fn digest<D: Digest + std::io::Write>(path: &Path) -> HostResult<String> {
    let mut hash = D::new();
    let mut input = fs::File::open(path).or_else(|e| err("io", e.to_string()))?;
    std::io::copy(&mut input, &mut hash).or_else(|e| err("io", e.to_string()))?;
    Ok(hex(&hash.finalize()))
}

/// Put a downloaded, verified file in place. Returns whether it replaced a file of the same name.
pub fn place(partial: &Path, target: &Path, checksum: &Checksum) -> HostResult<bool> {
    let matches = match checksum {
        Checksum::Sha512(expected) => digest::<Sha512>(partial)? == *expected,
        Checksum::Sha1(expected) => digest::<Sha1>(partial)? == *expected,
        Checksum::None => true,
    };
    if !matches {
        return err("integrity", "The download does not match the provider's checksum, so it was not installed.");
    }
    let replaced = match fs::symlink_metadata(target) {
        Ok(meta) if meta.is_file() => true,
        Ok(_) => return err("invalid", "Something that is not a file already has this name."),
        Err(_) => false,
    };
    fs::rename(partial, target).or_else(|e| err("io", format!("Could not put the file in place: {e}")))?;
    Ok(replaced)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    file_name: String,
    replaced: bool,
}
#[derive(Serialize, Clone)]
struct InstallProgress {
    job: String,
    done: u64,
    total: u64,
}

/// Download one version's file into `dir` and put it in place once it is verified. A failure
/// leaves the folder as it was.
pub fn install_into(dir: &Path, (url, file_name, _, checksum): &Source, progress: impl FnMut(u64)) -> HostResult<bool> {
    fs::create_dir_all(dir).or_else(|e| err("io", format!("Could not prepare {}: {e}", dir.display())))?;
    let partial = dir.join(format!(".{file_name}.{}.partial", std::process::id()));
    let result = download(None, url, &[], &partial, DOWNLOAD_MAX, progress).and_then(|_| place(&partial, &dir.join(file_name), checksum));
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

#[tauri::command]
pub async fn content_install(app: tauri::AppHandle, workspace: String, provider: String, kind: String, project_id: String, version_id: String, job: String) -> HostResult<Installed> {
    blocking(move || {
        let kind = Kind::parse(&kind)?;
        let (project_id, version_id) = (safe_id(&project_id)?, safe_id(&version_id)?);
        let source = match provider.as_str() {
            "modrinth" => modrinth_source(&get_json(&format!("{MODRINTH}/version/{}", encode(version_id)))?, project_id)?,
            "curseforge" => {
                let project = cf_get(&format!("/mods/{}", encode(project_id)))?;
                let file = cf_get(&format!("/mods/{}/files/{}", encode(project_id), encode(version_id)))?;
                curseforge_source(kind, &project["data"], &file["data"])?
            }
            _ => return err("invalid", "Unknown provider."),
        };
        let dir = crate::export::game_folder(&workspace)?.join(kind.folder());
        let total = source.2;
        let replaced = install_into(&dir, &source, |done| {
            let _ = app.emit("content-progress", InstallProgress { job: job.clone(), done, total });
        })?;
        Ok(Installed { file_name: source.1, replaced })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Real Modrinth, through this host's own requests. `cargo test -- --ignored live_`.
    #[test]
    #[ignore]
    fn live_modrinth_lists_resource_packs_and_shaders() {
        for kind in [Kind::ResourcePack, Kind::Shader] {
            let page = get_json(&modrinth_search_url(kind, "", "1.20.1", 0, 10)).expect("search");
            let hits = parse_modrinth_hits(kind, &page);
            assert_eq!(hits.len(), 10, "{kind:?}");
            assert!(page["hits"].as_array().unwrap().iter().all(|h| h["project_type"] == kind.modrinth()));
            let versions = parse_modrinth_versions(&get_json(&format!("{MODRINTH}/project/{}/version?game_versions={}", hits[0].project_id, encode(r#"["1.20.1"]"#))).expect("versions"));
            assert!(!versions.is_empty() && pack_file_name(&versions[0].file_name).is_ok(), "{kind:?}: {:?}", versions.first());
            let version = get_json(&format!("{MODRINTH}/version/{}", versions[0].id)).expect("version");
            assert!(modrinth_source(&version, &hits[0].project_id).is_ok());
        }
    }

    /// A real download from Modrinth's CDN into a scratch folder, checked and put in place.
    #[test]
    #[ignore]
    fn live_modrinth_installs_a_verified_pack() {
        let page = get_json(&modrinth_search_url(Kind::Shader, "", "1.20.1", 0, 20)).expect("search");
        // The smallest of a few popular shaders keeps this quick.
        let (project, version) = parse_modrinth_hits(Kind::Shader, &page).into_iter().take(6).filter_map(|hit| {
            let versions = parse_modrinth_versions(&get_json(&format!("{MODRINTH}/project/{}/version?game_versions={}", hit.project_id, encode(r#"["1.20.1"]"#))).ok()?);
            Some((hit.project_id, versions.into_iter().next()?))
        }).min_by_key(|(_, v)| v.size_bytes.unwrap_or(u64::MAX)).expect("a shader with a version");
        let source = modrinth_source(&get_json(&format!("{MODRINTH}/version/{}", version.id)).expect("version"), &project).expect("source");
        let dir = std::env::temp_dir().join(format!("awake-mm-live-install-{}", std::process::id())).join("shaderpacks");
        let mut seen = 0;
        assert!(!install_into(&dir, &source, |done| seen = done).expect("install"));
        let placed = fs::metadata(dir.join(&source.1)).expect("the pack is in the folder");
        assert_eq!((placed.len(), seen), (source.2, source.2), "{}", source.1);
        assert!(zip::ZipArchive::new(fs::File::open(dir.join(&source.1)).unwrap()).is_ok(), "a readable zip");
        assert!(install_into(&dir, &source, |_| {}).expect("again"), "the same version replaces its file");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "no temp file left behind");
        // A wrong checksum installs nothing and leaves nothing behind.
        let other = dir.with_file_name("refused");
        let bad = (source.0.clone(), source.1.clone(), source.2, Checksum::Sha512("0".repeat(128)));
        assert_eq!(install_into(&other, &bad, |_| {}).unwrap_err().code, "integrity");
        assert_eq!(fs::read_dir(&other).unwrap().count(), 0);
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    /// Real CurseForge. Needs the key from GitHub Actions; a build without one skips it.
    #[test]
    #[ignore]
    fn curseforge_live_resource_packs_and_shaders() {
        if crate::providers::curseforge_key().is_none() {
            return;
        }
        for kind in [Kind::ResourcePack, Kind::Shader] {
            let page = cf_get(&curseforge_search_path(kind, "", "1.20.1", 0, 10)).expect("search");
            let hits = parse_curseforge_hits(&page);
            assert!(!hits.is_empty(), "{kind:?}");
            assert!(page["data"].as_array().unwrap().iter().all(|h| h["classId"] == kind.curseforge_class()), "{kind:?}");
            let versions = parse_curseforge_versions(&cf_get(&format!("/mods/{}/files?index=0&pageSize=50&gameVersion=1.20.1", hits[0].project_id)).expect("files"));
            assert!(!versions.is_empty() && versions[0].file_name.to_lowercase().ends_with(".zip"), "{kind:?}: {:?}", versions.first());
        }
    }

    #[test]
    fn searches_ask_each_provider_for_the_right_kind() {
        let m = modrinth_search_url(Kind::Shader, "bsl shaders", "1.20.1", 30, 30);
        assert!(m.contains(&encode(r#"[["project_type:shader"],["versions:1.20.1"]]"#)) && m.contains("index=relevance&offset=30&limit=30") && m.contains("query=bsl%20shaders"));
        let all = modrinth_search_url(Kind::ResourcePack, "", "", 0, 30);
        assert!(all.contains(&encode(r#"[["project_type:resourcepack"]]"#)) && all.contains("index=downloads"));
        assert!(curseforge_search_path(Kind::ResourcePack, "", "1.20.1", 0, 30).contains("classId=12&") && curseforge_search_path(Kind::ResourcePack, "", "1.20.1", 0, 30).contains("&gameVersion=1.20.1"));
        let cf = curseforge_search_path(Kind::Shader, "a&b", "", 9990, 30);
        assert!(cf.contains("classId=6552&") && cf.contains("searchFilter=a%26b") && cf.ends_with("&index=9990&pageSize=10") && !cf.contains("gameVersion"));
    }

    #[test]
    fn hits_and_versions_are_read_from_both_providers() {
        let page = json!({"hits": [{"project_id": "HVnmMxH1", "slug": "complementary-reimagined", "title": "Complementary", "author": "EminGT", "description": "Shaders", "downloads": 7.0, "icon_url": "https://cdn.modrinth.com/i.webp"}], "total_hits": 1});
        let hit = &parse_modrinth_hits(Kind::Shader, &page)[0];
        assert_eq!((hit.project_id.as_str(), hit.page_url.as_deref(), hit.icon_url.as_deref()), ("HVnmMxH1", Some("https://modrinth.com/shader/complementary-reimagined"), Some("https://cdn.modrinth.com/i.webp")));
        let versions = parse_modrinth_versions(&json!([
            {"id": "v2", "name": "r5.9", "version_number": "r5.9", "version_type": "release", "date_published": "2026-09-15T06:35:41Z", "game_versions": ["1.20.1"], "loaders": ["iris", "optifine"],
             "files": [{"filename": "extra.txt", "primary": false}, {"filename": "Complementary_r5.9.zip", "primary": true, "size": 600}]},
            {"id": "v1", "name": "Faithful", "version_number": "1.20", "game_versions": ["1.20.1"], "loaders": ["minecraft"], "files": [{"filename": "Faithful.zip"}]},
            {"id": "v0", "files": []}]));
        assert_eq!(versions.len(), 2);
        assert_eq!((versions[0].file_name.as_str(), versions[0].size_bytes, versions[0].loaders.len()), ("Complementary_r5.9.zip", Some(600), 2));
        assert!(versions[1].loaders.is_empty());

        let cf = json!({"data": [{"id": 9, "name": "BSL", "summary": "s", "authors": [{"name": "capt"}], "logo": {"thumbnailUrl": "https://media.forgecdn.net/a.png"}, "downloadCount": 3.0, "links": {"websiteUrl": "https://www.curseforge.com/minecraft/shaders/bsl"}}, {"id": 10, "name": "No logo", "logo": null, "links": {"websiteUrl": "javascript:alert(1)"}}]});
        let hits = parse_curseforge_hits(&cf);
        assert_eq!((hits[0].project_id.as_str(), hits[0].author.as_str(), hits[0].page_url.is_some()), ("9", "capt", true));
        assert_eq!((hits[1].icon_url.as_ref(), hits[1].page_url.as_ref()), (None, None));
        let files = parse_curseforge_versions(&json!({"data": [{"id": 77, "displayName": "BSL v8", "fileName": "BSL_v8.zip", "fileLength": 5, "releaseType": 2, "fileDate": "2026-01-01T00:00:00Z", "gameVersions": ["1.20.1", "Iris", "1.19.4", "OptiFine"]}]}));
        assert_eq!((files[0].id.as_str(), files[0].release_type.as_deref(), &files[0].game_versions, &files[0].loaders), ("77", Some("beta"), &vec!["1.20.1".to_string(), "1.19.4".to_string()], &vec!["Iris".to_string(), "OptiFine".to_string()]));
    }

    #[test]
    fn only_a_plain_zip_name_is_written_into_a_pack_folder() {
        for fine in ["Faithful 32x - 1.20.1.zip", "§6Fancy!§r.ZIP", "Complementary_r5.9.3.zip"] {
            assert!(pack_file_name(fine).is_ok(), "{fine}");
        }
        for bad in ["", "evil.jar", "pack.zip.exe", "../pack.zip", "a/b.zip", "a\\b.zip", "C:pack.zip", ".hidden.zip", "con.zip", "pack\n.zip", "what?.zip"] {
            assert_eq!(pack_file_name(bad).unwrap_err().code, "restricted", "{bad}");
        }
    }

    #[test]
    fn a_download_comes_only_from_the_providers_own_cdn_with_a_checksum() {
        let sha = "ab".repeat(64);
        let file = |url: &str| json!({"project_id": "proj", "files": [{"url": url, "filename": "p.zip", "size": 9, "primary": true, "hashes": {"sha512": sha}}]});
        assert_eq!(modrinth_source(&file("https://cdn.modrinth.com/data/x/p.zip"), "proj").unwrap(), ("https://cdn.modrinth.com/data/x/p.zip".to_string(), "p.zip".to_string(), 9, Checksum::Sha512(sha.clone())));
        assert_eq!(modrinth_source(&file("https://cdn.modrinth.com/data/x/p.zip"), "other").unwrap_err().code, "invalid");
        assert_eq!(modrinth_source(&file("https://evil.example/p.zip"), "proj").unwrap_err().code, "restricted");
        assert_eq!(modrinth_source(&file("http://cdn.modrinth.com/p.zip"), "proj").unwrap_err().code, "restricted");
        assert_eq!(modrinth_source(&json!({"project_id": "proj", "files": [{"url": "https://cdn.modrinth.com/p.zip", "filename": "p.zip", "hashes": {}}]}), "proj").unwrap_err().code, "restricted");

        let project = json!({"classId": 6552, "allowModDistribution": true, "links": {"websiteUrl": "https://www.curseforge.com/minecraft/shaders/bsl"}});
        let cf_file = json!({"downloadUrl": "https://edge.forgecdn.net/files/1/2/BSL.zip", "fileName": "BSL.zip", "fileLength": 4, "hashes": [{"algo": 2, "value": "md5"}, {"algo": 1, "value": "C".repeat(40)}]});
        assert_eq!(curseforge_source(Kind::Shader, &project, &cf_file).unwrap().3, Checksum::Sha1("c".repeat(40)));
        assert_eq!(curseforge_source(Kind::ResourcePack, &project, &cf_file).unwrap_err().code, "invalid", "a shader is not a resource pack");
        assert_eq!(curseforge_source(Kind::Shader, &json!({"classId": 6552, "allowModDistribution": false}), &cf_file).unwrap_err().code, "manual-download");
        assert_eq!(curseforge_source(Kind::Shader, &project, &json!({"downloadUrl": null, "fileName": "BSL.zip"})).unwrap_err().code, "manual-download");
        assert_eq!(curseforge_source(Kind::Shader, &project, &json!({"downloadUrl": "https://evil.example/BSL.zip", "fileName": "BSL.zip"})).unwrap_err().code, "restricted");
        assert_eq!(curseforge_source(Kind::Shader, &project, &json!({"downloadUrl": "https://edge.forgecdn.net/x", "fileName": "BSL.jar"})).unwrap_err().code, "restricted");
    }

    #[test]
    fn a_download_is_only_put_in_place_when_its_checksum_matches() {
        let dir = std::env::temp_dir().join(format!("awake-mm-content-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (partial, target) = (dir.join(".p.zip.partial"), dir.join("p.zip"));
        fs::write(&partial, "pack").unwrap();
        assert_eq!(place(&partial, &target, &Checksum::Sha1("0".repeat(40))).unwrap_err().code, "integrity");
        assert!(!target.exists());
        let sha1 = hex(&Sha1::digest(b"pack"));
        assert!(!place(&partial, &target, &Checksum::Sha1(sha1)).unwrap());
        assert_eq!(fs::read_to_string(&target).unwrap(), "pack");
        // The same file name again replaces it, and says so.
        fs::write(&partial, "pack 2").unwrap();
        assert!(place(&partial, &target, &Checksum::Sha512(hex(&Sha512::digest(b"pack 2")))).unwrap());
        assert_eq!(fs::read_to_string(&target).unwrap(), "pack 2");
        fs::remove_dir_all(&dir).unwrap();
    }
}
