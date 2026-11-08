//! Desktop integration: opening folders and links with the shell, and reading or recycling the
//! non-mod content of a Manager workspace (config, resource packs, shaders...).
//!
//! Mods are never touched here: they belong to the native helper's reviewed transactions.

use crate::helper::manager_data_dir;
use crate::providers::{err, HostResult};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

const AREAS: [&str; 6] = ["config", "defaultconfigs", "kubejs", "scripts", "resourcepacks", "shaderpacks"];
const LIST_MAX: usize = 20_000;

fn is_uuid(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| if [8, 13, 18, 23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}

fn game_dir(workspace: &str) -> HostResult<PathBuf> {
    if !is_uuid(workspace) {
        return err("invalid", "Unknown project.");
    }
    Ok(manager_data_dir().or_else(|m| err("io", m))?.join("core").join("workspaces").join(workspace).join(".minecraft"))
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

fn walk(root: &Path, dir: &Path, out: &mut Vec<ContentRow>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= LIST_MAX {
            return;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let path = entry.path().strip_prefix(root).unwrap_or(&entry.path()).to_string_lossy().replace('\\', "/");
        let modified_ms = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
        if meta.is_dir() {
            out.push(ContentRow { path, kind: "directory", size_bytes: None, modified_ms });
            walk(root, &entry.path(), out);
        } else {
            out.push(ContentRow { path, kind: "file", size_bytes: Some(meta.len()), modified_ms });
        }
    }
}

#[tauri::command]
pub async fn workspace_list(workspace: String, area: String) -> HostResult<Vec<ContentRow>> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = content_path(&game_dir(&workspace)?, &area, "")?;
        let mut out = vec![];
        walk(&root, &root, &mut out);
        out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
        Ok(out)
    })
    .await
    .unwrap_or_else(|e| err("internal", e.to_string()))
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
            let path = content_path(&game, &area, relative)?;
            if path.exists() {
                recycle(&path)?;
            }
        }
        Ok(())
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
pub fn workspace_open(workspace: String, area: Option<String>) -> HostResult<()> {
    let game = game_dir(&workspace)?;
    let path = match area.as_deref() {
        Some(a) if !a.is_empty() => content_path(&game, a, "")?,
        _ => game,
    };
    if !path.is_dir() {
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
