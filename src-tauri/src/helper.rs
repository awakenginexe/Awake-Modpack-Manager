//! The Manager's bundled native helper (shared native core): find it, start it on demand, and
//! open its pipe only after proving the server is that exact executable.
//!
//! Lifetime: the helper decides when to exit (idle, no clients, no unsettled work). The Manager
//! never kills it: not on window close, pipe loss or a timeout, so accepted work always finishes
//! or is recovered by the helper itself on its next start.
//!
//! Contract: Awake Launcher docs/modpack-manager/core-protocol.md 2.0 (+ manager.v0.2.1) and handoff.md at b06c9a804 / 75b362c69. The helper is
//! started with `--profile <private absolute directory>`, publishes
//! `<profile>\integration\core-v2\endpoint.json` and serves `\\.\pipe\awake-core-v2-<session UUID>`.

use crate::pipe;
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
/// The pinned package's SHA256SUMS, embedded at build time (build.rs). Empty in stub/dev builds.
const PACKAGE_SUMS: &str = include_str!(concat!(env!("OUT_DIR"), "/helper-sums.txt"));
/// Files next to the helper that are not part of its package manifest.
const PACKAGE_EXTRA: [&str; 2] = ["SHA256SUMS", "HELPER-SOURCE.txt"];

/// Every file in the helper folder must be listed in `sums` with the same SHA-256, and nothing
/// else may be there (a planted DLL would be loaded by the helper). Empty `sums`: nothing to check.
pub fn verify_package(dir: &Path, sums: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if sums.trim().is_empty() {
        return Ok(());
    }
    let mut listed = std::collections::BTreeMap::new();
    for line in sums.lines().map(|l| l.trim_end_matches('\r')).filter(|l| !l.is_empty()) {
        let (hash, path) = line.split_once("  ").ok_or("The embedded helper manifest is malformed.")?;
        listed.insert(path.to_string(), hash.to_ascii_lowercase());
    }
    let mut present = Vec::new();
    fn walk(base: &Path, d: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
        for e in fs::read_dir(d)? {
            let e = e?;
            let t = e.file_type()?;
            if t.is_symlink() {
                return Err(std::io::Error::other(format!("link {}", e.path().display())));
            }
            if t.is_dir() {
                walk(base, &e.path(), out)?;
            } else {
                out.push(e.path().strip_prefix(base).unwrap_or(&e.path()).to_string_lossy().replace('\\', "/"));
            }
        }
        Ok(())
    }
    walk(dir, dir, &mut present).map_err(|e| format!("Cannot read the helper folder: {e}"))?;
    let damaged = |what: String| Err(format!("The Manager helper files are damaged or were replaced ({what}). Reinstall Awake Modpack Manager."));
    for rel in present.iter().filter(|p| !PACKAGE_EXTRA.contains(&p.as_str())) {
        let Some(want) = listed.get(rel) else { return damaged(format!("unexpected file {rel}")) };
        let bytes = fs::read(dir.join(rel)).map_err(|e| format!("Cannot read {rel}: {e}"))?;
        let got: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        if &got != want {
            return damaged(format!("{rel} changed"));
        }
    }
    if let Some(missing) = listed.keys().find(|p| !present.contains(p)) {
        return damaged(format!("{missing} is missing"));
    }
    Ok(())
}

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

const DESCRIPTOR_MAX: u64 = 16 * 1024;

/// `<profile>\integration\core-v2\endpoint.json`, checked against core.schema.json $defs/descriptor.
/// None when absent. The TypeScript client validates it again against the pinned schema.
pub fn read_descriptor(profile: &Path) -> Result<Option<Map<String, Value>>, String> {
    let path = profile.join("integration").join("core-v2").join("endpoint.json");
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot read the helper endpoint: {e}")),
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > DESCRIPTOR_MAX {
        return Err("The helper endpoint descriptor is not a small regular file.".into());
    }
    // The helper publishes atomically; a read can still briefly hit a sharing violation.
    let bytes = (0..3)
        .find_map(|i| {
            if i > 0 { std::thread::sleep(Duration::from_millis(60)); }
            fs::read(&path).ok()
        })
        .ok_or("The helper endpoint is being published. Retrying.")?;
    let Ok(Value::Object(d)) = serde_json::from_slice::<Value>(&bytes) else { return Err("The helper endpoint is not a JSON object.".into()) };
    let s = |k: &str| d.get(k).and_then(Value::as_str);
    let ok = d.len() == 6
        && d.get("protocol") == Some(&serde_json::json!({"major": 2, "minor": 0}))
        && s("role") == Some("modpack-core")
        && s("serverName").is_some_and(pipe::valid_helper_name)
        && s("pid").is_some_and(|p| !p.is_empty() && p.len() <= 20 && p.bytes().all(|b| b.is_ascii_digit()))
        && s("profileId").is_some_and(|p| !p.is_empty() && p.len() <= 256)
        && s("sessionId").is_some_and(|x| x.len() == 36);
    if !ok {
        return Err("The helper endpoint does not match protocol 2.0.".into());
    }
    Ok(Some(d))
}

/// A descriptor whose process is alive and is exactly our helper executable.
fn live_descriptor(data_root: &Path, exe: &Path) -> Result<Option<Map<String, Value>>, String> {
    let Some(d) = read_descriptor(data_root)? else { return Ok(None) };
    let Some(pid) = d.get("pid").and_then(Value::as_str).and_then(|p| p.parse::<u32>().ok()) else { return Ok(None) };
    Ok(match pipe::process_image(pid) {
        Some(image) if same_file(&image, exe) => Some(d),
        // Dead (crash, idle exit) or a reused pid belonging to another program: stale.
        _ => None,
    })
}

/// helper.log sits next to the profile, not inside it: the profile belongs to the helper.
fn log_path(data_root: &Path) -> PathBuf {
    data_root.parent().unwrap_or(data_root).join("helper.log")
}

fn open_log(data_root: &Path) -> Option<fs::File> {
    let path = log_path(data_root);
    if fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX) {
        let _ = fs::rename(&path, path.with_extension("log.1"));
    }
    fs::OpenOptions::new().create(true).append(true).open(path).ok()
}

fn configure_curseforge(command: &mut std::process::Command, authorized: Option<&str>, api_key: Option<&str>) {
    if let (Some("1"), Some(key)) = (authorized, api_key.filter(|key| !key.trim().is_empty())) {
        command.env("AWAKE_CORE_CURSEFORGE_AUTHORIZED", "1").env("AWAKE_CORE_CURSEFORGE_API_KEY", key);
    }
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
        cmd.arg("--profile").arg(data_root).current_dir(exe.parent().unwrap_or(data_root)).creation_flags(flags).stdin(Stdio::null()).stdout(Stdio::null());
        configure_curseforge(&mut cmd, option_env!("AWAKE_CORE_CURSEFORGE_AUTHORIZED"), option_env!("AWAKE_CORE_CURSEFORGE_API_KEY"));
        match log {
            Some(f) => cmd.stderr(f),
            None => cmd.stderr(Stdio::null()),
        };
        // Dropping the Child neither waits for nor kills the helper.
        cmd.spawn().map(|c| c.id())
    };
    // Leave the Manager's job (if any) so closing the window can't kill accepted work. A job that
    // forbids breakaway refuses with ACCESS_DENIED; starting inside it is acceptable only when that
    // job does not kill its members on close.
    run(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB).or_else(|e| match e.raw_os_error() {
        Some(5) if pipe::in_kill_on_close_job() => Err(std::io::Error::other("Windows would stop the helper when the Manager closes (kill-on-close job without breakaway), which could interrupt accepted work. Start Awake Modpack Manager normally from the Start menu.")),
        Some(5) => run(CREATE_NO_WINDOW),
        _ => Err(e),
    })
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
    // A new profile gets a protected user/SYSTEM/Administrators ACL. An existing one is left as it
    // is: the helper refuses a permissive profile rather than silently changing user data.
    if !data_root.exists() {
        let made = data_root.parent().map_or(Ok(()), fs::create_dir_all).and_then(|_| pipe::create_private_dir(data_root));
        if let Err(e) = made {
            return status("failed", None, stub, Some(format!("Cannot create the private helper data folder: {e}")));
        }
    }
    match live_descriptor(data_root, &exe) {
        Ok(Some(d)) => return status("ready", Some(d), stub, None),
        Ok(None) => {}
        Err(e) => return status("failed", None, stub, Some(e)),
    }
    let mut last = spawned.0.lock().unwrap();
    if let Some((pid, at)) = *last {
        // Still starting: startup recovery can take longer than any fixed timeout, and the helper
        // is never killed for being slow.
        if pipe::process_image(pid).is_some() {
            return status("starting", None, stub, None);
        }
        if at.elapsed() < START_GRACE {
            *last = None;
            return status("failed", None, stub, Some(format!("The Manager helper exited during startup. Details: {}", log_path(data_root).display())));
        }
    }
    // Only the pinned, complete package may start (the running one was checked when it started).
    if let Err(e) = verify_package(exe.parent().unwrap_or(resource_dir), PACKAGE_SUMS) {
        return status("failed", None, stub, Some(e));
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

    #[test]
    fn curseforge_release_configuration_requires_authorization_and_a_key() {
        use std::process::Command;
        for (authorized,key) in [(None,None),(Some("0"),Some("fixture-api-key")),(Some("1"),None),(Some("1"),Some(" "))] {
            let mut command=Command::new("helper.exe");
            configure_curseforge(&mut command,authorized,key);
            assert_eq!(command.get_envs().count(),0);
        }
        let mut command=Command::new("helper.exe");
        configure_curseforge(&mut command,Some("1"),Some("fixture-api-key"));
        let env: std::collections::BTreeMap<_,_>=command.get_envs().map(|(k,v)|(k.to_string_lossy().into_owned(),v.unwrap().to_string_lossy().into_owned())).collect();
        assert_eq!(env.get("AWAKE_CORE_CURSEFORGE_AUTHORIZED").map(String::as_str),Some("1"));
        assert_eq!(env.get("AWAKE_CORE_CURSEFORGE_API_KEY").map(String::as_str),Some("fixture-api-key"));
    }

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
        let d = root.join("integration").join("core-v2");
        fs::create_dir_all(&d).unwrap();
        let sid = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
        fs::write(d.join("endpoint.json"), format!(r#"{{"protocol":{{"major":2,"minor":0}},"role":"modpack-core","serverName":"awake-core-v2-{sid}","pid":"4294967290","profileId":"p","sessionId":"{sid}"}}"#)).unwrap();
        assert!(read_descriptor(&root).unwrap().is_some());
        assert!(live_descriptor(&root, Path::new("C:\\nope.exe")).unwrap().is_none(), "dead pid: stale");
        // A Launcher pipe, a 1.0 protocol, a wrong role or an extra field is refused outright.
        for bad in [
            format!(r#"{{"protocol":{{"major":2,"minor":0}},"role":"modpack-core","serverName":"awake-manager-v1-{sid}","pid":"1","profileId":"p","sessionId":"{sid}"}}"#),
            format!(r#"{{"protocol":{{"major":1,"minor":0}},"role":"modpack-core","serverName":"awake-core-v2-{sid}","pid":"1","profileId":"p","sessionId":"{sid}"}}"#),
            format!(r#"{{"protocol":{{"major":2,"minor":0}},"role":"launcher","serverName":"awake-core-v2-{sid}","pid":"1","profileId":"p","sessionId":"{sid}"}}"#),
            format!(r#"{{"protocol":{{"major":2,"minor":0}},"role":"modpack-core","serverName":"awake-core-v2-{sid}","pid":"1","profileId":"p","sessionId":"{sid}","x":1}}"#),
        ] {
            fs::write(d.join("endpoint.json"), bad).unwrap();
            assert!(read_descriptor(&root).is_err());
        }
    }

    /// REAL helper, opt-in: AWAKE_REAL_HELPER_DIR=<packaged core-host folder>. Copies it into a fake
    /// resource folder, then runs the host's own path: private profile, spawn, descriptor, pipe
    /// PID/SID/image identity. The helper exits by itself after its idle timeout.
    #[test]
    fn real_helper_starts_in_a_private_profile_and_proves_its_identity() {
        let Some(src) = std::env::var_os("AWAKE_REAL_HELPER_DIR") else { return };
        let res = temp("real");
        let dir = HELPER_DIR.iter().fold(res.clone(), |p, c| p.join(c));
        fs::create_dir_all(&dir).unwrap();
        fn copy(from: &Path, to: &Path) {
            for e in fs::read_dir(from).unwrap().flatten() {
                let t = to.join(e.file_name());
                if e.file_type().unwrap().is_dir() { fs::create_dir_all(&t).unwrap(); copy(&e.path(), &t); } else { fs::copy(e.path(), t).unwrap(); }
            }
        }
        copy(Path::new(&src), &dir);
        let profile = res.join("data").join("core");
        let spawned = Spawned::default();
        let t0 = Instant::now();
        let d = loop {
            let s = ensure(&res, &profile, &spawned);
            assert!(s.state == "starting" || s.state == "ready", "{:?}", s);
            assert!(!s.stub);
            if let Some(d) = s.descriptor { break d; }
            assert!(t0.elapsed() < Duration::from_secs(60), "no endpoint");
            std::thread::sleep(Duration::from_millis(200));
        };
        let name = d["serverName"].as_str().unwrap();
        let pid: u32 = d["pid"].as_str().unwrap().parse().unwrap();
        pipe::connect(name, pid).expect("pipe server PID and user SID");
        let exe = bundled_helper(&res).unwrap().unwrap();
        assert!(same_file(&pipe::process_image(pid).unwrap(), &exe), "image is the bundled helper");
        assert!(pipe::connect(name, pid + 1).is_err(), "a wrong advertised PID is refused");
        assert!(log_path(&profile).starts_with(res.join("data")));
    }

    #[test]
    fn helper_package_must_match_its_pinned_manifest_exactly() {
        let dir = temp("pkg");
        fs::create_dir_all(dir.join("tls")).unwrap();
        fs::write(dir.join(HELPER_EXE), b"MZ").unwrap();
        fs::write(dir.join("tls").join("a.dll"), b"tls").unwrap();
        fs::write(dir.join("HELPER-SOURCE.txt"), b"record").unwrap();
        let sums = "6cdb5c3a1cc0cfd5ea8ff2d8b9b7a7a8bc9d6f0d6f3c09b0a4c7df8d0c1b8bc8  awake-core-host.exe\r\n";
        // Real hashes for the two files:
        use sha2::{Digest, Sha256};
        let h = |b: &[u8]| Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect::<String>();
        let good = format!("{}  {HELPER_EXE}\r\n{}  tls/a.dll\r\n", h(b"MZ"), h(b"tls"));
        assert!(verify_package(&dir, &good).is_ok());
        assert!(verify_package(&dir, "").is_ok(), "stub/dev builds embed nothing");
        assert!(verify_package(&dir, sums).unwrap_err().contains("awake-core-host.exe changed"));
        fs::write(dir.join("version.dll"), b"evil").unwrap();
        assert!(verify_package(&dir, &good).unwrap_err().contains("unexpected file version.dll"));
        fs::remove_file(dir.join("version.dll")).unwrap();
        fs::remove_file(dir.join("tls").join("a.dll")).unwrap();
        assert!(verify_package(&dir, &good).unwrap_err().contains("tls/a.dll is missing"));
    }

    #[test]
    fn helper_and_launcher_prefixes_are_disjoint() {
        assert!(pipe::valid_helper_name("awake-core-v2-0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"));
        assert!(!pipe::valid_helper_name("awake-core-v2-0a1b"));
        assert!(!pipe::valid_helper_name("awake-manager-v1-0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"));
        assert!(!pipe::valid_server_name("awake-core-v2-0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"));
        assert!(!pipe::valid_helper_name("awake-core-v2-..\\x"));
    }
}
