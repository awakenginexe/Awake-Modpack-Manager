//! Finds Awake Launcher data profiles and their integration endpoint descriptors.
//!
//! Mirrors Launcher data-root resolution (launcher/Application.cpp + launcher/awake/DataLocation.h
//! at commit 058714ec7) for the places the protocol allows a client to look: the installer's
//! registry entry, AWAKELAUNCHER_DATA_DIR, the default %APPDATA%\AwakeLauncher, and folders the user
//! added. No disk scanning. `--dir` profiles are reached by adding that folder explicitly.

use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const DESCRIPTOR_MAX: u64 = 16 * 1024;
const DESCRIPTOR_FIELDS: [&str; 5] = ["serverName", "pid", "installationId", "profileId", "sessionId"];

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// registry | environment | default | added
    pub source: String,
    pub install_dir: Option<String>,
    pub data_root: String,
    /// How the data root was chosen (mirrors Launcher wording).
    pub resolved_by: String,
    pub exists: bool,
    /// fixed | removable | remote | other | unknown
    pub drive: String,
    pub endpoint: Option<Map<String, Value>>,
    pub endpoint_error: Option<String>,
}

fn default_data_root() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("AwakeLauncher"))
}

/// Same order as Application.cpp for an installed (non --dir) launch: UserData, portable.txt,
/// then data-location.txt (normal | compact | custom + absolute path), else the persistent path.
pub fn resolve_install_dir(install: &Path, normal: Option<PathBuf>) -> Result<(PathBuf, &'static str), String> {
    if install.join("UserData").is_dir() {
        return Ok((install.join("UserData"), "Portable user data path"));
    }
    if install.join("portable.txt").is_file() {
        return Ok((install.to_path_buf(), "Portable data path"));
    }
    let normal = normal.ok_or("APPDATA is not set")?;
    let config = install.join("data-location.txt");
    if !config.exists() {
        return Ok((normal, "Persistent data path"));
    }
    let text = fs::read_to_string(&config).map_err(|e| format!("Cannot read data-location.txt: {e}"))?;
    let mut lines = text.lines();
    match lines.next().unwrap_or("").trim_end_matches('\r') {
        "normal" => Ok((normal, "Persistent data path")),
        "compact" => Ok((install.join("AwakeLauncherData"), "Compact data path")),
        "custom" => {
            let path = PathBuf::from(lines.next().unwrap_or("").trim_end_matches('\r'));
            if path.is_absolute() { Ok((path, "Custom data path")) } else { Err("data-location.txt has an invalid custom path".into()) }
        }
        _ => Err("data-location.txt has an unknown mode".into()),
    }
}

#[cfg(windows)]
fn registry_install_dir() -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (key, value) = (wide(r"Software\AwakeLauncher"), wide("InstallDir"));
    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size) };
    if status != 0 {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1);
    Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}
#[cfg(not(windows))]
fn registry_install_dir() -> Option<PathBuf> { None }

#[cfg(windows)]
fn drive_type(path: &Path) -> String {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    let root: String = path.to_string_lossy().chars().take(3).collect();
    if root.len() < 3 || !root.ends_with(":\\") {
        return if path.to_string_lossy().starts_with(r"\\") { "remote".into() } else { "unknown".into() };
    }
    let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
    match unsafe { GetDriveTypeW(wide.as_ptr()) } {
        2 => "removable", 3 => "fixed", 4 => "remote", _ => "other",
    }.into()
}
#[cfg(not(windows))]
fn drive_type(_: &Path) -> String { "unknown".into() }

/// Reads `<dataRoot>\integration\v1\endpoint.json`. It is a hint, verified later by hello.
pub fn read_descriptor(data_root: &Path) -> Result<Option<Map<String, Value>>, String> {
    let path = data_root.join("integration").join("v1").join("endpoint.json");
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot read the endpoint descriptor: {e}")),
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("The endpoint descriptor is not a regular file.".into());
    }
    if meta.len() > DESCRIPTOR_MAX {
        return Err("The endpoint descriptor is too large.".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|_| "The endpoint descriptor is not valid JSON.".to_string())?;
    let Value::Object(map) = value else { return Err("The endpoint descriptor is not a JSON object.".into()) };
    for field in DESCRIPTOR_FIELDS {
        if !map.get(field).is_some_and(Value::is_string) {
            return Err(format!("The endpoint descriptor is missing {field}."));
        }
    }
    Ok(Some(map))
}

fn profile(source: &str, install: Option<PathBuf>, root: Result<(PathBuf, &str), String>) -> Option<Profile> {
    let (data_root, resolved_by) = match root {
        Ok(r) => r,
        Err(e) => {
            let at = install.clone().unwrap_or_default();
            return Some(Profile { source: source.into(), install_dir: install.map(|p| p.display().to_string()), data_root: at.display().to_string(), resolved_by: String::new(), exists: false, drive: drive_type(&at), endpoint: None, endpoint_error: Some(e) });
        }
    };
    let exists = data_root.is_dir();
    let (endpoint, endpoint_error) = if exists { match read_descriptor(&data_root) { Ok(e) => (e, None), Err(e) => (None, Some(e)) } } else { (None, None) };
    Some(Profile {
        source: source.into(),
        install_dir: install.map(|p| p.display().to_string()),
        drive: drive_type(&data_root),
        data_root: data_root.display().to_string(),
        resolved_by: resolved_by.into(),
        exists,
        endpoint,
        endpoint_error,
    })
}

/// `added` are folders the user chose: an installation (contains awakelauncher.exe) or a data root.
pub fn discover(added: &[String]) -> Vec<Profile> {
    let normal = default_data_root();
    let mut out = Vec::new();
    if let Some(dir) = registry_install_dir() {
        out.extend(profile("registry", Some(dir.clone()), resolve_install_dir(&dir, normal.clone())));
    }
    if let Some(env) = std::env::var_os("AWAKELAUNCHER_DATA_DIR").filter(|v| !v.is_empty()) {
        out.extend(profile("environment", None, Ok((PathBuf::from(env), "System environment"))));
    }
    if let Some(n) = normal.clone() {
        out.extend(profile("default", None, Ok((n, "Persistent data path"))));
    }
    for folder in added {
        let path = PathBuf::from(folder);
        if path.join("awakelauncher.exe").is_file() {
            out.extend(profile("added", Some(path.clone()), resolve_install_dir(&path, normal.clone())));
        } else {
            out.extend(profile("added", None, Ok((path, "Chosen folder"))));
        }
    }
    let mut seen = HashSet::new();
    out.retain(|p| seen.insert(p.data_root.to_lowercase().trim_end_matches(['\\', '/']).to_string()));
    out
}

#[tauri::command]
pub fn discover_profiles(added: Vec<String>) -> Vec<Profile> {
    discover(&added)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("awake-mm-discovery-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn resolves_install_dir_like_the_launcher() {
        let normal = Some(PathBuf::from(r"C:\Normal"));
        let a = temp("normal");
        assert_eq!(resolve_install_dir(&a, normal.clone()).unwrap().0, PathBuf::from(r"C:\Normal"));
        fs::write(a.join("data-location.txt"), "compact\n").unwrap();
        assert_eq!(resolve_install_dir(&a, normal.clone()).unwrap().0, a.join("AwakeLauncherData"));
        fs::write(a.join("data-location.txt"), "custom\r\nD:\\Games\\Awake\r\n").unwrap();
        assert_eq!(resolve_install_dir(&a, normal.clone()).unwrap().0, PathBuf::from(r"D:\Games\Awake"));
        fs::write(a.join("data-location.txt"), "custom\nrelative\n").unwrap();
        assert!(resolve_install_dir(&a, normal.clone()).is_err());
        fs::write(a.join("portable.txt"), "").unwrap();
        assert_eq!(resolve_install_dir(&a, normal.clone()).unwrap().0, a);
        fs::create_dir(a.join("UserData")).unwrap();
        assert_eq!(resolve_install_dir(&a, normal).unwrap().0, a.join("UserData"));
        fs::remove_dir_all(a).unwrap();
    }

    #[test]
    fn reads_and_validates_descriptors() {
        let root = temp("descriptor");
        assert_eq!(read_descriptor(&root).unwrap(), None);
        let dir = root.join("integration").join("v1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("endpoint.json"), r#"{"serverName":"awake-manager-v1-a","pid":"1","installationId":"i","profileId":"p"}"#).unwrap();
        assert!(read_descriptor(&root).unwrap_err().contains("sessionId"));
        fs::write(dir.join("endpoint.json"), r#"{"protocol":{"major":1,"minor":0},"serverName":"awake-manager-v1-a","pid":"1","installationId":"i","profileId":"p","sessionId":"s"}"#).unwrap();
        assert_eq!(read_descriptor(&root).unwrap().unwrap()["sessionId"], "s");
        fs::write(dir.join("endpoint.json"), "not json").unwrap();
        assert!(read_descriptor(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn added_folders_are_deduplicated() {
        let root = temp("dedupe");
        let s = root.display().to_string();
        let found = discover(&[s.clone(), s.to_uppercase()]);
        assert_eq!(found.iter().filter(|p| p.source == "added").count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
