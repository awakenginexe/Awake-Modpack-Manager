//! Desktop integration: opening folders and links with the shell, and managing the non-mod content
//! (config, scripts, resource packs, shaders...) of a project or of a Launcher instance managed here.
//!
//! Mods are never touched here: they belong to the native helper's reviewed transactions. Everything
//! else stays inside one of the content folders below, never follows a link out of it, and is only
//! ever removed to the Recycle Bin.

use crate::helper::manager_data_dir;
use crate::providers::{err, HostResult};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

const AREAS: [&str; 6] = ["config", "defaultconfigs", "kubejs", "scripts", "resourcepacks", "shaderpacks"];
const LIST_MAX: usize = 20_000;
/// The largest text file the built-in editor opens or saves.
const TEXT_MAX: u64 = 2 << 20;

pub fn is_uuid(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}

/// The game folder of a project, or of a Launcher instance managed here.
fn game_dir(workspace: &str) -> HostResult<PathBuf> {
    crate::export::game_folder(workspace)
}

/// `area/relative/path` under the game folder, with no way out of it.
pub fn content_path(game: &Path, area: &str, relative: &str) -> HostResult<PathBuf> {
    if !AREAS.contains(&area) {
        return err("invalid", "That folder is not managed here.");
    }
    let relative = Path::new(relative);
    if !relative.components().all(|c| matches!(c, Component::Normal(_))) {
        return err("invalid", "That path is not inside the project.");
    }
    Ok(game.join(area).join(relative))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContentRow {
    path: String,
    kind: &'static str,
    size_bytes: Option<u64>,
    modified_ms: Option<u64>,
}

/// Like `content_path`, and no folder on the way down from the area is a link: a junction inside
/// `config` must never lead a read, a save or a removal somewhere else on the disk. The area folder
/// itself may be one, since sharing `resourcepacks` between instances that way is a common setup.
pub fn checked_path(game: &Path, area: &str, relative: &str) -> HostResult<PathBuf> {
    let path = content_path(game, area, relative)?;
    let mut at = game.join(area);
    for part in Path::new(relative).components() {
        at.push(part);
        if fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return err("invalid", "Links to other folders are not opened here.");
        }
    }
    Ok(path)
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64)
}

/// What is directly inside `dir`, folders first. Paths are relative to `root`, the area folder.
pub fn list_folder(root: &Path, dir: &Path) -> Vec<ContentRow> {
    let mut out = vec![];
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        if out.len() >= LIST_MAX {
            break;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let path = entry.path().strip_prefix(root).unwrap_or(&entry.path()).to_string_lossy().replace('\\', "/");
        let (kind, size_bytes) = if meta.is_dir() { ("directory", None) } else { ("file", Some(meta.len())) };
        out.push(ContentRow { path, kind, size_bytes, modified_ms: modified_ms(&meta) });
    }
    out.sort_by_key(|row| (row.kind == "file", row.path.to_lowercase()));
    out
}

#[tauri::command]
pub async fn workspace_list(workspace: String, area: String, folder: Option<String>) -> HostResult<Vec<ContentRow>> {
    tauri::async_runtime::spawn_blocking(move || {
        let game = game_dir(&workspace)?;
        Ok(list_folder(&content_path(&game, &area, "")?, &checked_path(&game, &area, folder.as_deref().unwrap_or(""))?))
    })
    .await
    .unwrap_or_else(|e| err("internal", e.to_string()))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    text: String,
    modified_ms: u64,
}

fn regular_file(path: &Path) -> HostResult<fs::Metadata> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(meta),
        Ok(_) => err("invalid", "That is not a file."),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => err("not-found", "This file is not there any more."),
        Err(e) => err("io", e.to_string()),
    }
}

/// A file as text for the editor. Binary files and very large ones are refused, never shown mangled.
pub fn read_text(path: &Path) -> HostResult<TextFile> {
    let meta = regular_file(path)?;
    if meta.len() > TEXT_MAX {
        return err("too-large", "This file is too large to edit here (2 MB at most). Open its folder to edit it in another program.");
    }
    let bytes = fs::read(path).or_else(|e| err("io", e.to_string()))?;
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => Ok(TextFile { text, modified_ms: modified_ms(&meta).unwrap_or(0) }),
        _ => err("not-text", "This is not a text file, so it cannot be edited here."),
    }
}

/// Save an edited file over the one that was opened. Refused if it changed on disk in the meantime,
/// so a config the game rewrote while the editor was open is never silently overwritten.
pub fn write_text(path: &Path, text: &str, expected_modified_ms: u64) -> HostResult<u64> {
    if text.len() as u64 > TEXT_MAX || text.contains('\0') {
        return err("too-large", "This text is too large to save here (2 MB at most).");
    }
    let meta = regular_file(path)?;
    if modified_ms(&meta).unwrap_or(0) != expected_modified_ms {
        return err("conflict", "This file changed on disk after you opened it. Open it again to see the new version.");
    }
    // A text box only has plain line breaks; keep Windows line endings if the file had them.
    let had_crlf = fs::read(path).is_ok_and(|old| old.windows(2).any(|w| w == b"\r\n"));
    let plain = text.replace("\r\n", "\n");
    let out = if had_crlf { plain.replace('\n', "\r\n") } else { plain };
    crate::files::write_atomic(path, out.as_bytes(), false).or_else(|m| err("io", m))?;
    Ok(fs::metadata(path).ok().as_ref().and_then(modified_ms).unwrap_or(0))
}

#[tauri::command]
pub async fn workspace_read_text(workspace: String, area: String, path: String) -> HostResult<TextFile> {
    tauri::async_runtime::spawn_blocking(move || read_text(&checked_path(&game_dir(&workspace)?, &area, &path)?))
        .await
        .unwrap_or_else(|e| err("internal", e.to_string()))
}

#[tauri::command]
pub async fn workspace_write_text(workspace: String, area: String, path: String, text: String, expected_modified_ms: u64) -> HostResult<u64> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.is_empty() {
            return err("invalid", "That is not a file.");
        }
        write_text(&checked_path(&game_dir(&workspace)?, &area, &path)?, &text, expected_modified_ms)
    })
    .await
    .unwrap_or_else(|e| err("internal", e.to_string()))
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct AddedFiles {
    added: Vec<String>,
    /// Already there under the same name; nothing is ever overwritten by adding.
    skipped: Vec<String>,
}

/// Copy files the user picked into a content folder. A copy lands under a temporary name first, so
/// a failed one never leaves half a file where the game would read it.
pub fn add_files(dir: &Path, sources: &[PathBuf]) -> HostResult<AddedFiles> {
    fs::create_dir_all(dir).or_else(|e| err("io", e.to_string()))?;
    let mut out = AddedFiles::default();
    for source in sources {
        let Some(name) = source.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        if !fs::metadata(source).is_ok_and(|m| m.is_file()) {
            return err("invalid", format!("{name} is not a file."));
        }
        let target = dir.join(&name);
        if fs::symlink_metadata(&target).is_ok() {
            out.skipped.push(name);
            continue;
        }
        let partial = dir.join(format!(".{name}.{}.partial", std::process::id()));
        if let Err(e) = fs::copy(source, &partial).and_then(|_| fs::rename(&partial, &target)) {
            let _ = fs::remove_file(&partial);
            return err("io", format!("{name}: {e}"));
        }
        out.added.push(name);
    }
    Ok(out)
}

/// Ask which files to add to a content folder, then copy them in. None when the user cancels.
#[tauri::command]
pub async fn workspace_add_files(app: tauri::AppHandle, workspace: String, area: String, folder: String) -> HostResult<Option<AddedFiles>> {
    let dir = checked_path(&game_dir(&workspace)?, &area, &folder)?;
    if !folder.is_empty() && !dir.is_dir() {
        return err("not-found", "This folder is not there any more.");
    }
    let packs = area == "resourcepacks" || area == "shaderpacks";
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        if packs { dialog.add_filter("Zip", &["zip"]) } else { dialog }.blocking_pick_files()
    })
    .await
    .or_else(|e| err("internal", e.to_string()))?;
    let Some(picked) = picked else { return Ok(None) };
    let sources = picked.into_iter().map(|p| p.into_path().or_else(|e| err("io", e.to_string()))).collect::<HostResult<Vec<PathBuf>>>()?;
    tauri::async_runtime::spawn_blocking(move || add_files(&dir, &sources).map(Some)).await.unwrap_or_else(|e| err("internal", e.to_string()))
}

#[cfg(windows)]
fn recycle(path: &Path) -> HostResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    // A double-NUL-terminated list of one absolute path, with no \\?\ prefix.
    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    from.extend([0, 0]);
    let mut op = SHFILEOPSTRUCTW { hwnd: std::ptr::null_mut(), wFunc: FO_DELETE, pFrom: from.as_ptr(), pTo: std::ptr::null(), fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16, fAnyOperationsAborted: 0, hNameMappings: std::ptr::null_mut(), lpszProgressTitle: std::ptr::null() };
    match unsafe { SHFileOperationW(&mut op) } {
        0 if op.fAnyOperationsAborted == 0 => Ok(()),
        code => err("io", format!("Windows could not move this to the Recycle Bin (code {code}). Is it open in another program?")),
    }
}
#[cfg(not(windows))]
fn recycle(_: &Path) -> HostResult<()> {
    err("unsupported", "The Recycle Bin is only available on Windows.")
}

/// Move content to the Recycle Bin, so a mistake can be undone from Windows.
#[tauri::command]
pub async fn workspace_recycle(workspace: String, area: String, paths: Vec<String>) -> HostResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let game = game_dir(&workspace)?;
        for relative in &paths {
            if relative.is_empty() {
                return err("invalid", "A whole folder cannot be removed here.");
            }
            let path = checked_path(&game, &area, relative)?;
            if path.exists() {
                recycle(&path)?;
            }
        }
        Ok(())
    })
    .await
    .unwrap_or_else(|e| err("internal", e.to_string()))
}

/// Forget mods the helper still tracks whose file is gone: it refuses every plan while one is listed.
/// Only the record changes, after a copy to `backup`; no mod file is touched. Returns the names forgotten.
pub fn forget_missing(game: &Path, backup: &Path) -> HostResult<Vec<String>> {
    let path = game.parent().unwrap_or(game).join(".awake-integration").join("policies.json");
    fn io<T>(e: std::io::Error) -> HostResult<T> {
        err("io", e.to_string())
    }
    let mut doc: Value = serde_json::from_str(&fs::read_to_string(&path).or_else(io)?).or_else(|_| err("invalid", "This project's mod records are damaged."))?;
    // An unreadable mods folder must fail here, never read as "every mod is missing".
    let on_disk: HashSet<String> = fs::read_dir(game.join("mods")).or_else(io)?.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase().trim_end_matches(".disabled").to_string()).collect();
    let Some(projects) = doc["projects"].as_object_mut() else { return err("invalid", "This project's mod records are damaged.") };
    let mut gone = vec![];
    projects.retain(|_, entry| {
        let name = entry["fileName"].as_str().unwrap_or_default();
        let keep = name.is_empty() || on_disk.contains(&name.to_lowercase());
        if !keep {
            gone.push(name.to_string());
        }
        keep
    });
    if !gone.is_empty() {
        fs::create_dir_all(backup.parent().unwrap_or(backup)).or_else(io)?;
        fs::copy(&path, backup).or_else(io)?;
        crate::files::write_atomic(&path, doc.to_string().as_bytes(), false).or_else(|m| err("io", m))?;
    }
    Ok(gone)
}

#[tauri::command]
pub async fn workspace_forget_missing(workspace: String) -> HostResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let game = crate::export::game_folder(&workspace)?;
        let backup = manager_data_dir().or_else(|m| err("io", m))?.join("policy-backups").join(format!("{workspace}.json"));
        forget_missing(&game, &backup)
    })
    .await
    .unwrap_or_else(|e| err("internal", e.to_string()))
}

#[cfg(windows)]
fn shell_open(target: &str) -> HostResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| std::ffi::OsStr::new(s).encode_wide().chain([0]).collect::<Vec<u16>>();
    let (verb, file) = (wide("open"), wide(target));
    let code = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
    if code as isize > 32 { Ok(()) } else { err("io", "Windows could not open this.") }
}
#[cfg(not(windows))]
fn shell_open(_: &str) -> HostResult<()> {
    err("unsupported", "Opening is only available on Windows.")
}

/// Open a project's game folder, or one of its content folders, in File Explorer.
#[tauri::command]
pub fn workspace_open(workspace: String, area: Option<String>, folder: Option<String>) -> HostResult<()> {
    let game = game_dir(&workspace)?;
    let inner = folder.as_deref().unwrap_or("");
    let path = match area.as_deref() {
        Some(a) if !a.is_empty() => checked_path(&game, a, inner)?,
        _ => game,
    };
    if !path.is_dir() {
        // Only a content folder that does not exist yet is created; a missing subfolder is an error.
        if !inner.is_empty() {
            return err("not-found", "This folder is not there any more.");
        }
        fs::create_dir_all(&path).or_else(|e| err("io", e.to_string()))?;
    }
    shell_open(&path.to_string_lossy())
}

/// Only web links: a local path or a custom protocol must never arrive here from page data.
pub fn is_web_url(url: &str) -> bool {
    url.len() < 2048 && url.starts_with("https://") && url["https://".len()..].split('/').next().is_some_and(|h| !h.is_empty() && !h.contains('@') && !h.contains('\\')) && !url.chars().any(char::is_control)
}

#[tauri::command]
pub fn open_url(url: String) -> HostResult<()> {
    if !is_web_url(&url) {
        return err("invalid", "Only https links can be opened.");
    }
    shell_open(&url)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: &'static str,
    curseforge: bool,
    installed: bool,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    let installed = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("uninstall.exe").is_file())).unwrap_or(false);
    AppInfo { version: env!("CARGO_PKG_VERSION"), curseforge: crate::providers::curseforge_key().is_some(), installed }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_paths_cannot_leave_their_area() {
        let game = Path::new("C:\\w\\.minecraft");
        assert!(content_path(game, "resourcepacks", "a/b.zip").unwrap().ends_with("resourcepacks\\a\\b.zip"));
        for bad in ["../mods/a.jar", "a/../../b", "C:\\Windows\\x", "\\\\server\\x"] {
            assert!(content_path(game, "config", bad).is_err(), "{bad}");
        }
        assert!(content_path(game, "mods", "a.jar").is_err(), "mods belong to the helper");
        assert!(content_path(game, "saves", "w").is_err());
    }

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("awake-mm-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_folder_lists_only_what_is_directly_inside_it_folders_first() {
        let game = scratch("list");
        for file in ["config/b.toml", "config/A.toml", "config/jei/jei.toml", "config/jei/deep/x.cfg"] {
            fs::create_dir_all(game.join(file).parent().unwrap()).unwrap();
            fs::write(game.join(file), "x = 1").unwrap();
        }
        let root = content_path(&game, "config", "").unwrap();
        let top: Vec<(String, &str)> = list_folder(&root, &root).into_iter().map(|r| (r.path, r.kind)).collect();
        assert_eq!(top, [("jei".to_string(), "directory"), ("A.toml".to_string(), "file"), ("b.toml".to_string(), "file")]);
        let inner: Vec<String> = list_folder(&root, &checked_path(&game, "config", "jei").unwrap()).into_iter().map(|r| r.path).collect();
        assert_eq!(inner, ["jei/deep", "jei/jei.toml"]);
        assert!(list_folder(&root, &game.join("config").join("missing")).is_empty());
        fs::remove_dir_all(&game).unwrap();
    }

    #[test]
    fn text_files_round_trip_and_keep_their_line_endings() {
        let game = scratch("text");
        fs::create_dir_all(game.join("config")).unwrap();
        let path = checked_path(&game, "config", "a.toml").unwrap();
        fs::write(&path, "a = 1\r\nb = 2\r\n").unwrap();
        let opened = read_text(&path).unwrap();
        assert_eq!(opened.text, "a = 1\r\nb = 2\r\n");
        // The editor hands back plain line breaks.
        write_text(&path, "a = 1\nb = 3\n", opened.modified_ms).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "a = 1\r\nb = 3\r\n");
        assert_eq!(fs::read_dir(game.join("config")).unwrap().count(), 1, "no temp file left behind");
        // A stale editor cannot overwrite a newer file.
        let now = read_text(&path).unwrap().modified_ms;
        assert_eq!(write_text(&path, "old", now.wrapping_add(5000)).unwrap_err().code, "conflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), "a = 1\r\nb = 3\r\n");
        let plain = game.join("config").join("plain.txt");
        fs::write(&plain, "x\ny\n").unwrap();
        write_text(&plain, "x\nz\n", read_text(&plain).unwrap().modified_ms).unwrap();
        assert_eq!(fs::read_to_string(&plain).unwrap(), "x\nz\n");
        fs::remove_dir_all(&game).unwrap();
    }

    #[test]
    fn the_editor_refuses_what_is_not_an_editable_text_file() {
        let game = scratch("refuse");
        let config = game.join("config");
        fs::create_dir_all(config.join("sub")).unwrap();
        fs::write(config.join("data.bin"), [0xffu8, 0xfe, 0x00, 0x41]).unwrap();
        fs::write(config.join("zero-byte.txt"), b"a\0b").unwrap();
        fs::write(config.join("big.txt"), vec![b'a'; TEXT_MAX as usize + 1]).unwrap();
        assert_eq!(read_text(&config.join("data.bin")).unwrap_err().code, "not-text");
        assert_eq!(read_text(&config.join("zero-byte.txt")).unwrap_err().code, "not-text");
        assert_eq!(read_text(&config.join("big.txt")).unwrap_err().code, "too-large");
        assert_eq!(read_text(&config.join("sub")).unwrap_err().code, "invalid");
        assert_eq!(read_text(&config.join("gone.txt")).unwrap_err().code, "not-found");
        // Saving never creates a file or replaces a folder.
        assert_eq!(write_text(&config.join("gone.txt"), "x", 0).unwrap_err().code, "not-found");
        assert_eq!(write_text(&config.join("sub"), "x", 0).unwrap_err().code, "invalid");
        assert!(!config.join("gone.txt").exists());
        fs::remove_dir_all(&game).unwrap();
    }

    #[test]
    fn adding_files_never_overwrites() {
        let root = scratch("add");
        let (from, dir) = (root.join("from"), root.join("game").join("resourcepacks"));
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("a.zip"), "new a").unwrap();
        fs::write(from.join("b.zip"), "new b").unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.zip"), "old a").unwrap();
        let result = add_files(&dir, &[from.join("a.zip"), from.join("b.zip")]).unwrap();
        assert_eq!(result, AddedFiles { added: vec!["b.zip".into()], skipped: vec!["a.zip".into()] });
        assert_eq!(fs::read_to_string(dir.join("a.zip")).unwrap(), "old a");
        assert_eq!(fs::read_to_string(dir.join("b.zip")).unwrap(), "new b");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "no temp file left behind");
        assert!(add_files(&dir, std::slice::from_ref(&from)).is_err(), "a folder is not a file");
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn links_below_a_content_folder_are_not_followed() {
        let game = scratch("links");
        let outside = scratch("links-outside");
        fs::create_dir_all(game.join("config").join("real")).unwrap();
        fs::write(outside.join("secret.txt"), "s").unwrap();
        let link = game.join("config").join("out");
        // A junction needs no special privilege, unlike a symbolic link.
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&outside).output().is_ok_and(|o| o.status.success());
        assert!(made, "could not create a junction to test with");
        assert!(checked_path(&game, "config", "out/secret.txt").is_err());
        assert!(checked_path(&game, "config", "out").is_err());
        let root = game.join("config");
        assert_eq!(list_folder(&root, &root).into_iter().map(|r| r.path).collect::<Vec<_>>(), ["real"]);
        fs::remove_dir(&link).unwrap();
        assert!(checked_path(&game, "config", "real/x.toml").is_ok());
        assert!(checked_path(&game, "config", "../mods/a.jar").is_err());
        fs::remove_dir_all(&game).unwrap();
        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn forgetting_missing_mods_drops_only_records_without_a_file() {
        let root = std::env::temp_dir().join(format!("awake-mm-forget-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (game, policies, backup) = (root.join("minecraft"), root.join(".awake-integration").join("policies.json"), root.join("backups").join("b.json"));
        fs::create_dir_all(policies.parent().unwrap()).unwrap();
        let before = r#"{"format":1,"projects":{"a":{"fileName":"A.jar"},"b":{"fileName":"b.jar"},"c":{"fileName":"c.jar"}}}"#;
        fs::write(&policies, before).unwrap();
        assert!(forget_missing(&game, &backup).is_err(), "no mods folder");
        assert_eq!(fs::read_to_string(&policies).unwrap(), before);
        fs::create_dir_all(game.join("mods")).unwrap();
        fs::write(game.join("mods").join("a.jar"), "").unwrap();
        fs::write(game.join("mods").join("b.jar.disabled"), "").unwrap();
        assert_eq!(forget_missing(&game, &backup).unwrap(), ["c.jar"]);
        let after: Value = serde_json::from_str(&fs::read_to_string(&policies).unwrap()).unwrap();
        assert_eq!(after, serde_json::json!({"format": 1, "projects": {"a": {"fileName": "A.jar"}, "b": {"fileName": "b.jar"}}}));
        assert_eq!(fs::read_to_string(&backup).unwrap(), before);
        assert!(forget_missing(&game, &backup).unwrap().is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn workspaces_are_named_by_uuid_only() {
        assert!(is_uuid("0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"));
        assert!(!is_uuid("../../../../Windows"));
        assert!(game_dir("..").is_err());
    }

    #[test]
    fn only_plain_https_links_open() {
        assert!(is_web_url("https://www.curseforge.com/minecraft/modpacks/x"));
        for bad in ["http://x.com", "file:///C:/x", "C:\\Windows\\calc.exe", "https://", "https://a@b/c", "calc", "https://x.com/\nfoo"] {
            assert!(!is_web_url(bad), "{bad}");
        }
    }
}
