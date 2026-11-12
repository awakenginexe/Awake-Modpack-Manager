//! Mods whose CurseForge author turned off third-party distribution. The helper may not download
//! them, so the user downloads each one in their browser and the Manager takes exactly that file
//! from the Downloads folder (or one they pick) into the project's `mods` folder.
//!
//! This is the one place the host puts a mod file in place itself: the helper has no way to accept
//! a local file. A file is taken only if its SHA-1 is the one CurseForge lists, and nothing in
//! `mods` is ever overwritten. The helper then lists it as a manually added file.

use crate::providers::{blocking, cf_get, cf_post, curseforge_key, encode, err, hex, s, HostResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::fs;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    project_id: String,
    #[serde(default)]
    version_id: Option<String>,
}

/// One file the user has to download by hand.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Wanted {
    project_id: String,
    name: String,
    file_name: String,
    sha1: String,
    size: u64,
    /// CurseForge's own download page for this file: it starts the download after a few seconds.
    url: String,
}

/// The newest file for this game version and loader, stable releases first.
pub fn newest_file(project: &Value, minecraft: &str, loader: i64) -> Option<i64> {
    project["latestFilesIndexes"].as_array()?.iter()
        .filter(|f| f["gameVersion"] == minecraft && (loader == 0 || f["modLoader"] == loader))
        .max_by_key(|f| (f["releaseType"] == 1, f["fileId"].as_i64().unwrap_or(0)))?["fileId"].as_i64()
}

/// A mod file name that can only ever name a jar directly inside `mods`.
fn jar_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && !name.starts_with(['.', ' ']) && name.to_ascii_lowercase().ends_with(".jar") && !name.chars().any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c))
}

pub fn wanted(project: &Value, file: &Value) -> Option<Wanted> {
    let page = s(&project["links"], "websiteUrl");
    let sha1 = file["hashes"].as_array()?.iter().find(|h| h["algo"] == 1).map(|h| s(h, "value").to_ascii_lowercase())?;
    let (id, file_name) = (file["id"].as_i64()?, s(file, "fileName"));
    // Without a checksum there is no telling which download is the right one, so it is not offered.
    (page.starts_with("https://www.curseforge.com/") && sha1.len() == 40 && jar_name(file_name)).then(|| Wanted {
        project_id: project["id"].as_i64().unwrap_or(0).to_string(),
        name: s(project, "name").into(),
        file_name: file_name.into(),
        sha1,
        size: file["fileLength"].as_u64().unwrap_or(0),
        url: format!("{}/download/{id}", page.trim_end_matches('/')),
    })
}

/// Which of these CurseForge projects must be downloaded by hand, and the exact file for each.
#[tauri::command]
pub async fn manual_sources(items: Vec<Item>, minecraft_version: String, loader: String) -> HostResult<Vec<Wanted>> {
    blocking(move || {
        if curseforge_key().is_none() {
            return Ok(vec![]);
        }
        let loader = match loader.as_str() { "forge" => 1, "fabric" => 4, "quilt" => 5, "neoforge" => 6, _ => 0 };
        let ids: Vec<i64> = items.iter().filter_map(|i| i.project_id.parse().ok()).collect();
        let mut out = vec![];
        for chunk in ids.chunks(500) {
            let page = cf_post("/mods", &json!({"modIds": chunk, "filterPcOnly": false}))?;
            for project in page["data"].as_array().into_iter().flatten().filter(|p| p["allowModDistribution"] == false) {
                let id = project["id"].as_i64().unwrap_or(0);
                let chosen = items.iter().find(|i| i.project_id == id.to_string()).and_then(|i| i.version_id.as_ref()?.parse::<i64>().ok());
                let Some(file_id) = chosen.or_else(|| newest_file(project, &minecraft_version, loader)) else { continue };
                let file = cf_get(&format!("/mods/{id}/files/{}", encode(&file_id.to_string())))?;
                out.extend(wanted(project, &file["data"]));
            }
        }
        Ok(out)
    })
    .await
}

fn sha1_of(path: &Path) -> Option<String> {
    let mut hash = Sha1::new();
    std::io::copy(&mut fs::File::open(path).ok()?, &mut hash).ok()?;
    Some(hex(&hash.finalize()))
}

/// Move each wanted file found among `candidates` into `mods`. Returns the project ids now in place.
pub fn claim(mods: &Path, wanted: &[Wanted], candidates: &[PathBuf]) -> HostResult<Vec<String>> {
    let mut done = vec![];
    for w in wanted.iter().filter(|w| jar_name(&w.file_name) && w.sha1.len() == 40) {
        let target = mods.join(&w.file_name);
        if fs::symlink_metadata(&target).is_ok() {
            // Already there from an earlier pass. A different file of the same name is left alone.
            if sha1_of(&target).as_deref() == Some(&w.sha1) {
                done.push(w.project_id.clone());
            }
            continue;
        }
        // Size first, so a folder full of other jars is not hashed on every pass. A download still
        // in progress has another name or another size, and never the right checksum.
        let found = candidates.iter().find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() == w.size) && sha1_of(p).as_deref() == Some(&w.sha1));
        let Some(source) = found else { continue };
        fs::create_dir_all(mods).or_else(|e| err("io", e.to_string()))?;
        if fs::rename(source, &target).is_err() {
            // Downloads on another drive: copy under a temporary name, then remove the download.
            let partial = mods.join(format!(".{}.{}.partial", w.file_name, std::process::id()));
            if let Err(e) = fs::copy(source, &partial).and_then(|_| fs::rename(&partial, &target)) {
                let _ = fs::remove_file(&partial);
                return err("io", format!("{}: {e}", w.file_name));
            }
            let _ = fs::remove_file(source);
        }
        done.push(w.project_id.clone());
    }
    Ok(done)
}

fn jars_in(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("jar"))).collect()
}

/// Look for the wanted files in Downloads, or (`pick`) in files the user chooses, and move the ones
/// found into the project's `mods` folder. None when the user cancels the file dialog.
#[tauri::command]
pub async fn manual_claim(app: tauri::AppHandle, workspace: String, wanted: Vec<Wanted>, pick: bool) -> HostResult<Option<Vec<String>>> {
    blocking(move || {
        let mods = crate::export::game_folder(&workspace)?.join("mods");
        let candidates = if pick {
            let Some(picked) = app.dialog().file().add_filter("Jar", &["jar"]).blocking_pick_files() else { return Ok(None) };
            picked.into_iter().filter_map(|p| p.into_path().ok()).collect()
        } else {
            // shortcut: assumes Downloads is %USERPROFILE%\Downloads; a moved Downloads folder or another
            // browser folder goes through the file dialog. Upgrade to SHGetKnownFolderPath if that bites.
            std::env::var_os("USERPROFILE").map_or(vec![], |home| jars_in(&Path::new(&home).join("Downloads")))
        };
        claim(&mods, &wanted, &candidates).map(Some)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exact_file_is_named_with_its_download_page() {
        let project = json!({"id": 7, "name": "LuckPerms GUI", "allowModDistribution": false, "links": {"websiteUrl": "https://www.curseforge.com/minecraft/mc-mods/luckperms-gui"},
            "latestFilesIndexes": [{"gameVersion": "1.20.1", "modLoader": 1, "releaseType": 2, "fileId": 30}, {"gameVersion": "1.20.1", "modLoader": 1, "releaseType": 1, "fileId": 20}, {"gameVersion": "1.20.1", "modLoader": 4, "releaseType": 1, "fileId": 40}, {"gameVersion": "1.21", "modLoader": 1, "releaseType": 1, "fileId": 50}]});
        assert_eq!(newest_file(&project, "1.20.1", 1), Some(20), "a release beats a newer beta");
        assert_eq!(newest_file(&project, "1.19", 1), None);
        let file = json!({"id": 20, "fileName": "lpgui-1.0.jar", "fileLength": 3, "hashes": [{"algo": 2, "value": "x"}, {"algo": 1, "value": "A9993E364706816ABA3E25717850C26C9CD0D89D"}]});
        let w = wanted(&project, &file).unwrap();
        assert_eq!(w, Wanted { project_id: "7".into(), name: "LuckPerms GUI".into(), file_name: "lpgui-1.0.jar".into(), sha1: "a9993e364706816aba3e25717850c26c9cd0d89d".into(), size: 3, url: "https://www.curseforge.com/minecraft/mc-mods/luckperms-gui/download/20".into() });
        assert_eq!(wanted(&project, &json!({"id": 20, "fileName": "../evil.jar", "hashes": file["hashes"]})), None);
        assert_eq!(wanted(&project, &json!({"id": 20, "fileName": "a.jar", "hashes": []})), None, "no checksum, no offer");
    }

    #[test]
    fn only_the_file_with_the_listed_checksum_is_moved_and_nothing_is_overwritten() {
        let root = std::env::temp_dir().join(format!("awake-mm-manual-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (downloads, mods) = (root.join("dl"), root.join("mods"));
        fs::create_dir_all(&downloads).unwrap();
        // sha1("abc"); the browser renamed the download, and a same-size impostor sits next to it.
        let w = |id: &str, name: &str| Wanted { project_id: id.into(), name: id.into(), file_name: name.into(), sha1: "a9993e364706816aba3e25717850c26c9cd0d89d".into(), size: 3, url: String::new() };
        fs::write(downloads.join("mod (1).jar"), "abc").unwrap();
        fs::write(downloads.join("other.jar"), "xyz").unwrap();
        fs::write(downloads.join("notes.txt"), "abc").unwrap();
        assert_eq!(jars_in(&downloads).len(), 2);
        assert!(claim(&mods, &[w("1", "mod.jar")], &[downloads.join("other.jar")]).unwrap().is_empty());
        assert_eq!(claim(&mods, &[w("1", "mod.jar"), w("2", "..\\up.jar")], &jars_in(&downloads)).unwrap(), ["1"]);
        assert_eq!(fs::read_to_string(mods.join("mod.jar")).unwrap(), "abc");
        assert!(!downloads.join("mod (1).jar").exists() && downloads.join("other.jar").exists());
        assert_eq!(claim(&mods, &[w("1", "mod.jar")], &[]).unwrap(), ["1"], "already in place");
        // A different file already has the name: it stays, and the download is not taken.
        fs::write(mods.join("taken.jar"), "old").unwrap();
        fs::write(downloads.join("taken.jar"), "abc").unwrap();
        assert!(claim(&mods, &[w("3", "taken.jar")], &jars_in(&downloads)).unwrap().is_empty());
        assert_eq!(fs::read_to_string(mods.join("taken.jar")).unwrap(), "old");
        fs::remove_dir_all(&root).unwrap();
    }
}
