//! The host's only file writes, both outside any game instance:
//! * an export the user saves through the native Save As dialog;
//! * the Manager's own project store, `<data>\projects\projects.json`.
//!
//! Both write a temporary file next to the target and rename it over the target, so a crash
//! leaves either the old file or the new one, never a partial file. The project store also keeps
//! the previous version as `projects.json.bak`.

use crate::helper::manager_data_dir;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

const EXPORT_MAX: usize = 256 << 20;
const STORE_MAX: usize = 64 << 20;

/// Write `bytes` to `target` via a sibling temp file and an atomic replace.
pub fn write_atomic(target: &Path, bytes: &[u8], backup: bool) -> Result<(), String> {
    let dir = target.parent().ok_or("The target has no folder.")?;
    let name = target.file_name().ok_or("The target has no file name.")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.partial", std::process::id()));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        if backup && target.is_file() {
            fs::copy(target, target.with_extension("json.bak"))?;
        }
        fs::rename(&tmp, target)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not save {}: {e}", target.display()));
    }
    Ok(())
}

/// A file name the dialog may suggest: no folders, no reserved characters, sensible length.
pub fn safe_file_name(name: &str, ext: &str) -> String {
    let stem: String = name
        .trim_end_matches(&format!(".{ext}"))
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .take(120)
        .collect();
    let stem = stem.trim().trim_end_matches(['.', ' ']);
    format!("{}.{ext}", if stem.is_empty() { "modpack" } else { stem })
}

/// Ask where to save an export, then write it. Returns the chosen path, or None if cancelled.
#[tauri::command]
pub async fn save_export(app: tauri::AppHandle, file_name: String, format: String, bytes: Vec<u8>) -> Result<Option<String>, String> {
    let (ext, label) = match format.as_str() {
        "mrpack" => ("mrpack", "Modrinth modpack"),
        "curseforge" => ("zip", "CurseForge modpack"),
        _ => return Err("Unknown export format.".into()),
    };
    if bytes.is_empty() || bytes.len() > EXPORT_MAX {
        return Err("The export is empty or too large.".into());
    }
    let suggested = safe_file_name(&file_name, ext);
    // The dialog blocks until the user answers; keep it off the async runtime threads.
    let chosen = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_file_name(suggested).add_filter(label, &[ext]).blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(chosen) = chosen else { return Ok(None) };
    let mut path: PathBuf = chosen.into_path().map_err(|e| e.to_string())?;
    if path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() != Some(ext) {
        path.set_extension(ext);
    }
    tauri::async_runtime::spawn_blocking(move || write_atomic(&path, &bytes, false).map(|_| Some(path.display().to_string())))
        .await
        .map_err(|e| e.to_string())?
}

fn store_path() -> Result<PathBuf, String> {
    Ok(manager_data_dir()?.join("projects").join("projects.json"))
}

/// The saved project store as text, or None if nothing was saved yet.
#[tauri::command]
pub fn projects_read() -> Result<Option<String>, String> {
    let path = store_path()?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

#[tauri::command]
pub fn projects_write(json: String) -> Result<(), String> {
    if json.len() > STORE_MAX {
        return Err("The project store is too large.".into());
    }
    // Only well-formed JSON objects reach disk; the format itself is versioned by the frontend.
    if !serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?.is_object() {
        return Err("The project store must be a JSON object.".into());
    }
    let path = store_path()?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("Could not create {}: {e}", path.display()))?;
    write_atomic(&path, json.as_bytes(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_sanitized() {
        assert_eq!(safe_file_name(r"..\..\evil", "mrpack"), ".._.._evil.mrpack");
        assert_eq!(safe_file_name("My Pack", "mrpack"), "My Pack.mrpack");
        assert_eq!(safe_file_name("My Pack.mrpack", "mrpack"), "My Pack.mrpack");
        assert_eq!(safe_file_name("a:b*c?", "zip"), "a_b_c_.zip");
        assert_eq!(safe_file_name("  . ", "zip"), "modpack.zip");
        assert!(!safe_file_name(r"C:\Windows\x", "zip").contains('\\'));
    }

    #[test]
    fn atomic_write_replaces_and_backs_up() {
        let dir = std::env::temp_dir().join(format!("awake-mm-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("projects.json");
        write_atomic(&target, b"{\"v\":1}", true).unwrap();
        write_atomic(&target, b"{\"v\":2}", true).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "{\"v\":2}");
        assert_eq!(fs::read_to_string(dir.join("projects.json.bak")).unwrap(), "{\"v\":1}");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "no temp file left behind");
        let _ = fs::remove_dir_all(&dir);
    }
}
