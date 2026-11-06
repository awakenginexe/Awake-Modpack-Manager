//! The Manager's bundled native helper (shared native core): find it, start it on demand, and
//! open its pipe only after proving the server is that exact executable.
//!
//! Lifetime: the helper decides when to exit (idle, no clients, no unsettled work). The Manager
//! never kills it: not on window close, pipe loss or a timeout, so accepted work always finishes
//! or is recovered by the helper itself on its next start.
//!
//! Provisional until the helper contract is committed (docs/LAUNCHER-REQUESTS.md H1-H4): the
//! `--dir <dataRoot>` argument, the `awake-core-v1-` pipe prefix and the descriptor location
//! `<dataRoot>\integration\v1\endpoint.json` (the same layout the Launcher publishes).

use crate::{discovery, pipe};
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

pub const HELPER_DIR: [&str; 2] = ["core-host", "windows-x64"];
pub const HELPER_EXE: &str = "awake-core-host.exe";
/// Present only next to the Manager's test stub, never next to the real core.
const STUB_MARKER: &str = "STUB";
const START_GRACE: Duration = Duration::from_secs(20);
const LOG_MAX: u64 = 1 << 20;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    /// not_installed | starting | ready | failed
    pub state: &'static str,
    pub descriptor: Option<Map<String, Value>>,
    pub stub: bool,
    pub data_root: Option<String>,
    pub message: Option<String>,
}

/// Last spawn: pid and when, so repeated ensure calls don't start a second helper.
#[derive(Default)]
pub struct Spawned(Mutex<Option<(u32, Instant)>>);

/// The Manager's own data folder. `AWAKE_MM_DATA_DIR` points tests at disposable data.
pub fn manager_data_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("AWAKE_MM_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("AwakeModpackManager")).ok_or_else(|| "LOCALAPPDATA is not set.".into())
}

/// The bundled helper inside the resource folder, as a regular file (no links), or None.
pub fn bundled_helper(resource_dir: &Path) -> Result<Option<PathBuf>, String> {
    let dir = HELPER_DIR.iter().fold(resource_dir.to_path_buf(), |p, c| p.join(c));
    let exe = dir.join(HELPER_EXE);
    let meta = match fs::symlink_metadata(&exe) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot inspect the helper: {e}")),
    };
    if !meta.is_file() {
        return Err("The bundled helper is not a regular file.".into());
    }
    // Canonical paths: the resolved helper must still be inside the resource folder (no junction escape).
    let root = fs::canonicalize(resource_dir).map_err(|e| format!("Cannot resolve the resource folder: {e}"))?;
    let real = fs::canonicalize(&exe).map_err(|e| format!("Cannot resolve the helper path: {e}"))?;
    if !real.starts_with(&root) {
        return Err("The bundled helper resolves outside the application folder.".into());
    }
    Ok(Some(real))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// A descriptor whose process is alive and is exactly our helper executable.
fn live_descriptor(data_root: &Path, exe: &Path) -> Result<Option<Map<String, Value>>, String> {
    let Some(d) = discovery::read_descriptor(data_root)? else { return Ok(None) };
    let Some(pid) = d.get("pid").and_then(Value::as_str).and_then(|p| p.parse::<u32>().ok()) else { return Ok(None) };
    if !d.get("serverName").and_then(Value::as_str).is_some_and(pipe::valid_helper_name) {
        return Err("The helper descriptor names a pipe outside the helper allowlist.".into());
    }
    Ok(match pipe::process_image(pid) {
        Some(image) if same_file(&image, exe) => Some(d),
        // Dead (crash, idle exit) or a reused pid belonging to another program: stale.
        _ => None,
    })
}

fn open_log(data_root: &Path) -> Option<fs::File> {
    let path = data_root.join("helper.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX) {
        let _ = fs::rename(&path, data_root.join("helper.log.1"));
    }
    fs::OpenOptions::new().create(true).append(true).open(path).ok()
}

#[cfg(windows)]
fn spawn(exe: &Path, data_root: &Path) -> std::io::Result<u32> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let run = |flags: u32| {
        let log = open_log(data_root);
        let mut cmd = Command::new(exe);
        cmd.arg("--dir").arg(data_root).current_dir(exe.parent().unwrap_or(data_root)).creation_flags(flags).stdin(Stdio::null()).stdout(Stdio::null());
        match log {
            Some(f) => cmd.stderr(f),
            None => cmd.stderr(Stdio::null()),
        };
        // Dropping the Child neither waits for nor kills the helper.
        cmd.spawn().map(|c| c.id())
    };
    // Leave the Manager's job (if any) so closing the window can't kill accepted work. A job that
    // forbids breakaway refuses with ACCESS_DENIED; then start inside it.
    run(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB).or_else(|e| if e.raw_os_error() == Some(5) { run(CREATE_NO_WINDOW) } else { Err(e) })
}

#[cfg(not(windows))]
fn spawn(_: &Path, _: &Path) -> std::io::Result<u32> {
    Err(std::io::Error::other("The Manager helper runs on Windows only."))
}

pub fn ensure(resource_dir: &Path, data_root: &Path, spawned: &Spawned) -> HelperStatus {
    let status = |state, descriptor, stub, message: Option<String>| HelperStatus { state, descriptor, stub, data_root: Some(data_root.display().to_string()), message };
    let exe = match bundled_helper(resource_dir) {
        Ok(Some(exe)) => exe,
        Ok(None) => return status("not_installed", None, false, Some("The Manager helper is not part of this installation.".into())),
        Err(e) => return status("failed", None, false, Some(e)),
    };
    let stub = exe.with_file_name(STUB_MARKER).is_file();
    if let Err(e) = fs::create_dir_all(data_root) {
        return status("failed", None, stub, Some(format!("Cannot create the helper data folder: {e}")));
    }
    match live_descriptor(data_root, &exe) {
        Ok(Some(d)) => return status("ready", Some(d), stub, None),
        Ok(None) => {}
        Err(e) => return status("failed", None, stub, Some(e)),
    }
    let mut last = spawned.0.lock().unwrap();
    if let Some((pid, at)) = *last {
        if at.elapsed() < START_GRACE {
            if pipe::process_image(pid).is_some() {
                return status("starting", None, stub, None);
            }
            *last = None;
            return status("failed", None, stub, Some(format!("The Manager helper exited during startup. Details: {}", data_root.join("helper.log").display())));
        }
        if pipe::process_image(pid).is_some() {
            return status("failed", None, stub, Some("The Manager helper is running but did not publish its endpoint.".into()));
        }
    }
    match spawn(&exe, data_root) {
        Ok(pid) => {
            *last = Some((pid, Instant::now()));
            status("starting", None, stub, None)
        }
        Err(e) => status("failed", None, stub, Some(format!("Could not start the Manager helper: {e}"))),
    }
}

fn resource_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().resource_dir().map_err(|e| format!("No resource folder: {e}"))
}

#[tauri::command]
pub fn helper_ensure(app: tauri::AppHandle, spawned: tauri::State<'_, Spawned>) -> Result<HelperStatus, String> {
    let data_root = manager_data_dir()?.join("core");
    Ok(ensure(&resource_dir(&app)?, &data_root, &spawned))
}

#[tauri::command]
pub fn helper_open(app: tauri::AppHandle, state: tauri::State<'_, pipe::Connections>, server_name: String, pid: String) -> Result<u32, pipe::IpcError> {
    let err = |code, m: String| pipe::IpcError { code, message: m };
    if !pipe::valid_helper_name(&server_name) {
        return Err(err("invalid", "Not a Manager helper endpoint.".into()));
    }
    let pid: u32 = pid.parse().map_err(|_| err("invalid", "Descriptor pid is not a number.".into()))?;
    let exe = bundled_helper(&resource_dir(&app).map_err(|m| err("io", m))?).map_err(|m| err("io", m))?.ok_or_else(|| err("not-running", "The Manager helper is not installed.".into()))?;
    let file = pipe::connect(&server_name, pid)?;
    // PID and user alone don't tell the helper apart from any same-user process (H2).
    match pipe::process_image(pid) {
        Some(image) if same_file(&image, &exe) => Ok(pipe::register(&state, file)),
        _ => Err(err("identity", "The helper pipe is not served by the bundled Manager helper.".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("awake-mm-helper-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_helper_is_not_installed() {
        let res = temp("missing");
        let s = ensure(&res, &res.join("data"), &Spawned::default());
        assert_eq!(s.state, "not_installed");
    }

    #[test]
    fn helper_must_be_a_regular_file_inside_resources() {
        let res = temp("dir");
        let dir = HELPER_DIR.iter().fold(res.clone(), |p, c| p.join(c));
        fs::create_dir_all(dir.join(HELPER_EXE)).unwrap(); // a directory, not a file
        assert!(bundled_helper(&res).is_err());
        fs::remove_dir_all(dir.join(HELPER_EXE)).unwrap();
        fs::write(dir.join(HELPER_EXE), b"MZ").unwrap();
        assert!(bundled_helper(&res).unwrap().unwrap().ends_with(HELPER_EXE));
    }

    #[test]
    fn stale_descriptor_of_a_dead_process_is_ignored() {
        let res = temp("stale");
        let root = res.join("data");
        let d = root.join("integration").join("v1");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("endpoint.json"), r#"{"protocol":{"major":1,"minor":0},"serverName":"awake-core-v1-ab","pid":"4294967290","installationId":"i","profileId":"p","sessionId":"s"}"#).unwrap();
        assert!(live_descriptor(&root, Path::new("C:\\nope.exe")).unwrap().is_none());
        // A descriptor naming a Launcher pipe is refused outright.
        fs::write(d.join("endpoint.json"), r#"{"protocol":{"major":1,"minor":0},"serverName":"awake-manager-v1-ab","pid":"1","installationId":"i","profileId":"p","sessionId":"s"}"#).unwrap();
        assert!(live_descriptor(&root, Path::new("C:\\nope.exe")).is_err());
    }

    #[test]
    fn helper_and_launcher_prefixes_are_disjoint() {
        assert!(pipe::valid_helper_name("awake-core-v1-0a1b"));
        assert!(!pipe::valid_helper_name("awake-manager-v1-0a1b"));
        assert!(!pipe::valid_server_name("awake-core-v1-0a1b"));
        assert!(!pipe::valid_helper_name("awake-core-v1-..\\x"));
    }
}
