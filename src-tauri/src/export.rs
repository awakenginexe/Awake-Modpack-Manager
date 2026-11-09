//! Exporting a pack from the files on disk: finding the identical file on the other provider, and
//! writing an Instance zip. Nothing here changes the pack; mods stay the helper's to change.

use crate::desktop::is_uuid;
use crate::helper::manager_data_dir;
use crate::providers::{cf_post, err, hex, modrinth_post, HostResult, OverrideZip};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

/// What an Instance zip carries from the game folder. Worlds, logs and accounts live elsewhere.
const INCLUDED: [&str; 7] = ["mods", "config", "defaultconfigs", "kubejs", "scripts", "resourcepacks", "shaderpacks"];
const MATCH_MAX: usize = 5_000;

/// The game folder of a project, or of a Launcher instance managed here, as the helper recorded it.
fn game_folder(workspace: &str) -> HostResult<PathBuf> {
    if !is_uuid(workspace) {
        return err("invalid", "Unknown project.");
    }
    let core = manager_data_dir().or_else(|m| err("io", m))?.join("core");
    let text = fs::read_to_string(core.join("catalog").join(format!("{workspace}.json"))).or_else(|_| err("not-found", "This project's record could not be read."))?;
    let record: Value = serde_json::from_str(&text).or_else(|_| err("invalid", "This project's record is damaged."))?;
    game_folder_of(&core, workspace, &record["body"])
}

fn game_folder_of(core: &Path, workspace: &str, body: &Value) -> HostResult<PathBuf> {
    let Some(root) = body["sharedRoot"].as_str() else { return Ok(core.join("workspaces").join(workspace).join(".minecraft")) };
    match body["modsPath"].as_str().unwrap_or(".minecraft/mods") {
        ".minecraft/mods" => Ok(Path::new(root).join(".minecraft")),
        "minecraft/mods" => Ok(Path::new(root).join("minecraft")),
        _ => err("invalid", "This project's record is damaged."),
    }
}

/// A file directly in `mods`, by a name the page sent. It can never leave that folder.
fn mod_file(game: &Path, name: &str) -> HostResult<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name == ".." {
        return err("invalid", "That is not a mod file name.");
    }
    Ok(game.join("mods").join(name))
}

/// CurseForge's file fingerprint: MurmurHash2 with seed 1, ignoring whitespace bytes.
pub fn curseforge_fingerprint(bytes: &[u8]) -> u32 {
    const M: u32 = 0x5bd1_e995;
    let data: Vec<u8> = bytes.iter().copied().filter(|b| !matches!(b, 9 | 10 | 13 | 32)).collect();
    let mut h = 1u32 ^ data.len() as u32;
    let mut blocks = data.chunks_exact(4);
    for block in &mut blocks {
        let mut k = u32::from_le_bytes([block[0], block[1], block[2], block[3]]).wrapping_mul(M);
        k ^= k >> 24;
        h = h.wrapping_mul(M) ^ k.wrapping_mul(M);
    }
    let tail = blocks.remainder();
    if tail.len() == 3 {
        h ^= u32::from(tail[2]) << 16;
    }
    if tail.len() >= 2 {
        h ^= u32::from(tail[1]) << 8;
    }
    if let Some(first) = tail.first() {
        h = (h ^ u32::from(*first)).wrapping_mul(M);
    }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^ (h >> 15)
}

/// The same file, byte for byte, on another provider.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportMatch {
    file_name: String,
    project_id: String,
    version_id: String,
    version_name: String,
    remote_file_name: String,
    size: u64,
    sha1: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha512: Option<String>,
    url: String,
}

pub fn parse_modrinth_matches(reply: &Value, names: &HashMap<String, String>) -> Vec<ExportMatch> {
    let Some(found) = reply.as_object() else { return vec![] };
    found.iter().filter_map(|(hash, version)| {
        let name = names.get(hash)?;
        let file = version["files"].as_array()?.iter().find(|f| f["hashes"]["sha512"] == hash.as_str())?;
        Some(ExportMatch {
            file_name: name.clone(),
            project_id: version["project_id"].as_str()?.into(),
            version_id: version["id"].as_str()?.into(),
            version_name: version["version_number"].as_str().unwrap_or("").into(),
            remote_file_name: file["filename"].as_str()?.into(),
            size: file["size"].as_u64().unwrap_or(0),
            sha1: file["hashes"]["sha1"].as_str().unwrap_or("").into(),
            sha512: Some(hash.clone()),
            url: file["url"].as_str()?.into(),
        })
    }).collect()
}

pub fn parse_curseforge_matches(reply: &Value, names: &HashMap<u32, String>) -> Vec<ExportMatch> {
    let Some(found) = reply["data"]["exactMatches"].as_array() else { return vec![] };
    found.iter().filter_map(|m| {
        let file = &m["file"];
        let name = names.get(&u32::try_from(file["fileFingerprint"].as_u64()?).ok()?)?;
        Some(ExportMatch {
            file_name: name.clone(),
            project_id: m["id"].as_i64()?.to_string(),
            version_id: file["id"].as_i64()?.to_string(),
            version_name: file["displayName"].as_str().unwrap_or("").into(),
            remote_file_name: file["fileName"].as_str().unwrap_or("").into(),
            size: file["fileLength"].as_u64().unwrap_or(0),
            sha1: file["hashes"].as_array().and_then(|h| h.iter().find(|x| x["algo"] == 1)).and_then(|x| x["value"].as_str()).unwrap_or("").into(),
            sha512: None,
            // A CurseForge pack names project and file IDs; it never needs this link.
            url: file["downloadUrl"].as_str().unwrap_or("").into(),
        })
    }).collect()
}

fn read_mod(game: &Path, name: &str) -> HostResult<Vec<u8>> {
    let path = mod_file(game, name)?;
    let meta = fs::symlink_metadata(&path).or_else(|e| err("io", format!("{name}: {e}")))?;
    if !meta.is_file() {
        return err("invalid", format!("{name} is not a regular file."));
    }
    fs::read(path).or_else(|e| err("io", format!("{name}: {e}")))
}

#[tauri::command]
pub async fn export_match(workspace: String, target: String, file_names: Vec<String>) -> HostResult<Vec<ExportMatch>> {
    tauri::async_runtime::spawn_blocking(move || {
        if file_names.len() > MATCH_MAX {
            return err("invalid", "Too many files to check at once.");
        }
        let game = game_folder(&workspace)?;
        let mut out = vec![];
        match target.as_str() {
            "modrinth" => {
                let mut names = HashMap::new();
                for name in &file_names {
                    names.insert(hex(&Sha512::digest(read_mod(&game, name)?)), name.clone());
                }
                let hashes: Vec<&String> = names.keys().collect();
                for chunk in hashes.chunks(500) {
                    out.extend(parse_modrinth_matches(&modrinth_post("/version_files", &json!({"hashes": chunk, "algorithm": "sha512"}))?, &names));
                }
            }
            "curseforge" => {
                let mut names = HashMap::new();
                for name in &file_names {
                    names.insert(curseforge_fingerprint(&read_mod(&game, name)?), name.clone());
                }
                let prints: Vec<u32> = names.keys().copied().collect();
                for chunk in prints.chunks(1000) {
                    out.extend(parse_curseforge_matches(&cf_post("/fingerprints/432", &json!({"fingerprints": chunk}))?, &names));
                }
            }
            _ => return err("invalid", "Unknown provider."),
        }
        Ok(out)
    })
    .await
    .unwrap_or_else(|e| err("internal", e.to_string()))
}

/// Accounts, tokens and keys never leave with a pack, wherever a mod's config put them.
pub fn is_private(relative: &str) -> bool {
    let lower = relative.to_lowercase();
    if lower.starts_with("mods/") {
        return false;
    }
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    if name == ".env" || [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"].iter().any(|e| name.ends_with(e)) {
        return true;
    }
    if name.ends_with(".json") && (name.starts_with("launcher_accounts") || ["accounts.json", "usercache.json", "usernamecache.json", "launcher_profiles.json", "realms_persistence.json"].contains(&name)) {
        return true;
    }
    name.split(['.', '_', '-']).any(|part| ["token", "secret", "password", "credential", "credentials"].contains(&part))
}

/// Skips links and hidden folders, except the mod metadata that keeps update checks working.
fn collect(game: &Path, dir: &Path, out: &mut Vec<(PathBuf, String, u64)>) -> HostResult<()> {
    for entry in fs::read_dir(dir).or_else(|e| err("io", format!("{}: {e}", dir.display())))?.flatten() {
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let relative = entry.path().strip_prefix(game).unwrap_or(&entry.path()).to_string_lossy().replace('\\', "/");
        if meta.is_dir() {
            if !entry.file_name().to_string_lossy().starts_with('.') || relative == "mods/.index" {
                collect(game, &entry.path(), out)?;
            }
        } else if !is_private(&relative) {
            out.push((entry.path(), relative, meta.len()));
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceExport {
    path: String,
    files: usize,
    bytes: u64,
}

#[derive(Serialize, Clone)]
struct ExportProgress {
    done: u64,
    total: u64,
}

fn write_instance(game: &Path, target: &Path, meta: [&str; 4], mut progress: impl FnMut(u64, u64)) -> HostResult<InstanceExport> {
    let mut files = vec![];
    for folder in INCLUDED {
        let path = game.join(folder);
        if path.is_dir() {
            collect(game, &path, &mut files)?;
        }
    }
    let total: u64 = files.iter().map(|(_, _, size)| size).sum();
    let [minecraft, loader, name, version] = meta;
    let mut zip = OverrideZip::unlimited(target, minecraft, loader, name, version)?;
    let mut done = 0;
    for (path, relative, size) in &files {
        let mut input = fs::File::open(path).or_else(|e| err("io", format!("{relative}: {e}")))?;
        zip.add(relative, &mut input, *size)?;
        done += size;
        progress(done, total);
    }
    zip.close()?;
    Ok(InstanceExport { path: String::new(), files: files.len(), bytes: total })
}

/// Save the whole pack, mod files included, where the user chooses. None when they cancel.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_instance(app: tauri::AppHandle, workspace: String, file_name: String, name: String, version: String, minecraft: String, loader: String) -> HostResult<Option<InstanceExport>> {
    let suggested: String = file_name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let dialog = app.clone();
    let chosen = tauri::async_runtime::spawn_blocking(move || dialog.dialog().file().set_file_name(suggested).add_filter("Instance zip", &["zip"]).blocking_save_file()).await.or_else(|e| err("internal", e.to_string()))?;
    let Some(chosen) = chosen else { return Ok(None) };
    let mut path = chosen.into_path().or_else(|e| err("io", e.to_string()))?;
    if path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() != Some("zip") {
        path.set_extension("zip");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let game = game_folder(&workspace)?;
        let part = path.with_extension("zip.part");
        let written = write_instance(&game, &part, [&minecraft, &loader, &name, &version], |done, total| { let _ = app.emit("export-progress", ExportProgress { done, total }); }).and_then(|summary| {
            fs::rename(&part, &path).or_else(|e| err("io", e.to_string()))?;
            Ok(summary)
        });
        if written.is_err() {
            let _ = fs::remove_file(&part);
        }
        written.map(|summary| Some(InstanceExport { path: path.display().to_string(), ..summary }))
    })
    .await
    .unwrap_or_else(|e| err("internal", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_match_murmur2_with_seed_one_and_ignore_whitespace() {
        assert_eq!(curseforge_fingerprint(b""), curseforge_fingerprint(b" \t\r\n"));
        assert_eq!(curseforge_fingerprint(b"ab c\nd"), curseforge_fingerprint(b"abcd"));
        assert_eq!(curseforge_fingerprint(b"abcd"), 0xc93f_7a16);
        assert_eq!(curseforge_fingerprint(b"abcde"), 0xcec8_5d7e);
        assert_eq!(curseforge_fingerprint(b"abcdefg"), 0x0afa_6525);
    }

    #[test]
    fn an_instance_zip_is_a_curseforge_pack_whose_files_are_all_inside_it() {
        let root = std::env::temp_dir().join(format!("awake-mm-instance-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let game = root.join(".minecraft");
        for (path, data) in [("mods/a.jar", "jar"), ("mods/b.jar.disabled", "off"), ("mods/.index/a.pw.toml", "meta"), ("mods/.connector/cache.bin", "cache"), ("config/x.toml", "cfg"), ("config/api-token.txt", "private"), ("saves/w/level.dat", "world"), ("logs/latest.log", "log")] {
            let file = game.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, data).unwrap();
        }
        let target = root.join("pack.zip");
        let mut last = (0, 0);
        let summary = write_instance(&game, &target, ["1.20.1", "forge-47.4.20", "Pack", "1.0.0"], |d, t| last = (d, t)).unwrap();
        let mut archive = zip::ZipArchive::new(fs::File::open(&target).unwrap()).unwrap();
        let mut names: Vec<String> = archive.file_names().map(str::to_string).collect();
        names.sort();
        assert_eq!(names, ["manifest.json", "overrides/config/x.toml", "overrides/mods/.index/a.pw.toml", "overrides/mods/a.jar", "overrides/mods/b.jar.disabled"]);
        let manifest: Value = serde_json::from_reader(archive.by_name("manifest.json").unwrap()).unwrap();
        assert_eq!(manifest["files"], json!([]));
        assert_eq!(manifest["overrides"], "overrides");
        assert_eq!(manifest["minecraft"]["modLoaders"][0]["id"], "forge-47.4.20");
        assert_eq!((summary.files, last.0 == last.1), (4, true));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mod_files_cannot_leave_the_mods_folder() {
        let game = Path::new("C:\\w\\.minecraft");
        assert!(mod_file(game, "a.jar").unwrap().ends_with("mods\\a.jar"));
        for bad in ["..", "../a.jar", "a/b.jar", "a\\b.jar", "C:\\x.jar", ""] {
            assert!(mod_file(game, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_managed_launcher_instance_exports_from_its_own_folder() {
        let core = Path::new("C:\\core");
        let shared = json!({"sharedRoot": "E:/Launcher/instances/Pack", "modsPath": "minecraft/mods"});
        assert!(game_folder_of(core, "id", &shared).unwrap().ends_with("Pack\\minecraft"));
        assert!(game_folder_of(core, "id", &json!({})).unwrap().ends_with("workspaces\\id\\.minecraft"));
        assert!(game_folder_of(core, "id", &json!({"sharedRoot": "E:/x", "modsPath": "../../mods"})).is_err());
    }

    #[test]
    fn private_files_stay_out_but_oddly_named_mods_stay_in() {
        for private in ["config/launcher_accounts.json", "config/api-token.txt", "config/x/secret.toml", "kubejs/server.pem", "config/.env", "config/usercache.json"] {
            assert!(is_private(private), "{private}");
        }
        for fine in ["mods/secret-rooms-1.0.jar", "config/jei/jei.toml", "config/tokenizer.json", "resourcepacks/pack.zip"] {
            assert!(!is_private(fine), "{fine}");
        }
    }

    #[test]
    fn matches_are_paired_with_the_local_file_by_exact_hash() {
        let names = HashMap::from([("aa".to_string(), "local.jar".to_string())]);
        let reply = json!({"aa": {"id": "ver", "project_id": "proj", "version_number": "1.2", "files": [
            {"filename": "other.jar", "url": "https://cdn.modrinth.com/o", "size": 9, "hashes": {"sha512": "bb", "sha1": "x"}},
            {"filename": "same.jar", "url": "https://cdn.modrinth.com/s", "size": 7, "hashes": {"sha512": "aa", "sha1": "y"}}]},
            "unknown": {"id": "v", "project_id": "p", "files": []}});
        let found = parse_modrinth_matches(&reply, &names);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].file_name.as_str(), found[0].remote_file_name.as_str(), found[0].size, found[0].sha1.as_str()), ("local.jar", "same.jar", 7, "y"));

        let prints = HashMap::from([(42u32, "local.jar".to_string())]);
        let cf = json!({"data": {"exactMatches": [{"id": 12, "file": {"id": 34, "fileFingerprint": 42, "fileName": "f.jar", "displayName": "F 1", "fileLength": 5, "hashes": [{"algo": 2, "value": "md5"}, {"algo": 1, "value": "sha"}], "downloadUrl": null}},
            {"id": 13, "file": {"id": 35, "fileFingerprint": 43}}]}});
        let found = parse_curseforge_matches(&cf, &prints);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].project_id.as_str(), found[0].version_id.as_str(), found[0].sha1.as_str(), found[0].url.as_str()), ("12", "34", "sha", ""));
    }
}
