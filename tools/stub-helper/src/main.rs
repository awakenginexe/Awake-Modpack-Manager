//! awake-core-host (TEST STUB). Usage: `awake-core-host --profile <dir> [--idle-secs N]`
//!
//! Stands in for the real native helper (core-protocol.md 2.0, role `modpack-core`) so the
//! Manager's start-on-demand, identity check, reconnect, idle exit, crash handling and installer
//! can be tested before the real build exists. It answers hello, core.info and an empty
//! workspaces.list; every capability that changes anything is false, and those methods return
//! UNSUPPORTED_CAPABILITY, so nothing it says can be shown as a real project or installation.

use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_FRAME: usize = 1 << 20;

fn random_hex() -> String {
    let mut h = RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    h.write_u32(std::process::id());
    format!("{:016x}", h.finish())
}

fn read_frame(r: &mut impl Read) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).ok()?;
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return None;
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).ok()?;
    Some(body)
}

fn write_frame(w: &mut impl Write, v: &Value) -> bool {
    let body = v.to_string().into_bytes();
    let mut out = (body.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(&body);
    w.write_all(&out).and_then(|_| w.flush()).is_ok()
}

struct Ids { session: String, root: String }

fn uuid() -> String {
    let h = format!("{}{}", random_hex(), random_hex());
    format!("{}-{}-4{}-8{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

const METHODS: [&str; 24] = [
    "hello", "core.info", "core.shutdown", "catalog.versions", "workspaces.create", "workspaces.list", "providers.search", "providers.versions",
    "plans.prepare", "plans.get", "transactions.apply", "mods.list", "updates.check", "operations.get", "operations.list", "operations.cancel",
    "events.poll", "recovery.list", "recovery.run", "inbox.begin", "inbox.write", "inbox.commit", "inbox.status", "outbox.read",
];
const STUB_METHODS: [&str; 3] = ["hello", "core.info", "workspaces.list"];

fn reply(req: &Value, hello_done: &mut bool, ids: &Ids) -> Value {
    let p = json!({"major":2,"minor":0});
    let id = req.get("requestId").cloned().unwrap_or(Value::Null);
    let err = |code: &str, msg: &str| json!({"protocol":p,"requestId":id,"error":{"code":code,"message":msg,"retryable":false}});
    if req.get("protocol") != Some(&p) {
        return err("UNSUPPORTED_PROTOCOL", "Only protocol 2.0 is supported.");
    }
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    if method != "hello" && !*hello_done {
        return err("HANDSHAKE_REQUIRED", "Send hello first.");
    }
    let ok = |result: Value| json!({"protocol":p,"requestId":id,"result":result});
    match method {
        "hello" => {
            let offered = req.pointer("/params/versions").and_then(Value::as_array).is_some_and(|v| v.contains(&p));
            if !offered {
                return err("UNSUPPORTED_PROTOCOL", "Only protocol 2.0 is supported.");
            }
            *hello_done = true;
            let caps: serde_json::Map<String, Value> = METHODS.iter().map(|m| (m.to_string(), Value::Bool(STUB_METHODS.contains(m)))).collect();
            ok(json!({
                "protocol": p, "role": "modpack-core", "coreVersion": "0.0.0-stub", "storageVersion": 1,
                "profileId": "manager", "sessionId": ids.session, "capabilities": caps,
                "limits": {"frameBytes": MAX_FRAME, "clients": 8, "pageItems": 200}
            }))
        }
        "core.info" => ok(json!({"role":"modpack-core","coreVersion":"0.0.0-stub","profileId":"manager","dataRoot":ids.root,"workspaceRoot":ids.root,"state":"ready","supportedLoaders":["vanilla"]})),
        "workspaces.list" => ok(json!({"workspaces":[],"total":0,"nextOffset":null})),
        _ => err("UNSUPPORTED_CAPABILITY", "The test helper does not implement this."),
    }
}

fn publish(dir: &Path, descriptor: &Value) -> std::io::Result<PathBuf> {
    let d = dir.join("integration").join("core-v2");
    fs::create_dir_all(&d)?;
    let tmp = d.join(".endpoint.json.partial");
    fs::write(&tmp, descriptor.to_string())?;
    let path = d.join("endpoint.json");
    fs::rename(&tmp, &path)?;
    Ok(path)
}

#[cfg(windows)]
mod pipe {
    use std::fs::File;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT};

    /// One server instance of `\\.\pipe\<name>`, blocking until a client connects.
    pub fn accept(name: &str) -> std::io::Result<File> {
        let wide: Vec<u16> = format!(r"\\.\pipe\{name}").encode_utf16().chain(Some(0)).collect();
        let h = unsafe {
            CreateNamedPipeW(wide.as_ptr(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, std::ptr::null())
        };
        if h == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_handle(h as _) };
        // 535 = ERROR_PIPE_CONNECTED: the client connected before we started waiting.
        if unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) } == 0 && unsafe { GetLastError() } != 535 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(file)
    }
}

#[cfg(not(windows))]
mod pipe {
    pub fn accept(_: &str) -> std::io::Result<std::fs::File> {
        Err(std::io::Error::other("Windows only"))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let Some(dir) = arg("--profile").map(PathBuf::from) else {
        eprintln!("usage: awake-core-host --profile <dir> [--idle-secs N]");
        std::process::exit(2);
    };
    let idle = Duration::from_secs(arg("--idle-secs").and_then(|s| s.parse().ok()).unwrap_or(120));
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("cannot create {}: {e}", dir.display());
        std::process::exit(1);
    }
    // One helper per data root: a second start exits quietly and the client uses the first.
    #[cfg(windows)]
    let _lock = {
        use std::os::windows::fs::OpenOptionsExt;
        match fs::OpenOptions::new().write(true).create(true).truncate(false).share_mode(0).open(dir.join("core-host.lock")) {
            Ok(f) => f,
            Err(_) => {
                eprintln!("another helper owns {}", dir.display());
                return;
            }
        }
    };
    let ids = Arc::new(Ids { session: uuid(), root: dir.display().to_string() });
    let server = format!("awake-core-v2-{}", ids.session);
    let descriptor = json!({"protocol":{"major":2,"minor":0},"role":"modpack-core","serverName":server,"pid":std::process::id().to_string(),"profileId":"manager","sessionId":ids.session});

    let clients = Arc::new(AtomicUsize::new(0));
    let last = Arc::new(Mutex::new(Instant::now()));
    // Accept on a thread; the main thread publishes once listening and watches for idleness.
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    {
        let (server, ids, clients, last) = (server.clone(), ids.clone(), clients.clone(), last.clone());
        std::thread::spawn(move || {
            let mut first = Some(tx);
            loop {
                // Create the instance first, then signal: the descriptor is published only when a client can connect.
                let pending = std::thread::spawn({
                    let server = server.clone();
                    move || pipe::accept(&server)
                });
                if let Some(t) = first.take() {
                    std::thread::sleep(Duration::from_millis(50));
                    let _ = t.send(());
                }
                let Ok(Ok(mut f)) = pending.join() else { std::thread::sleep(Duration::from_millis(200)); continue };
                clients.fetch_add(1, Ordering::SeqCst);
                let (ids, clients, last) = (ids.clone(), clients.clone(), last.clone());
                std::thread::spawn(move || {
                    let mut hello = false;
                    while let Some(body) = read_frame(&mut f) {
                        *last.lock().unwrap() = Instant::now();
                        let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        if !write_frame(&mut f, &reply(&req, &mut hello, &ids)) {
                            break;
                        }
                    }
                    *last.lock().unwrap() = Instant::now();
                    clients.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
    }
    let _ = rx.recv_timeout(Duration::from_secs(5));
    let path = match publish(&dir, &descriptor) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("cannot publish the endpoint: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("stub helper ready: pid {} pipe {server}", std::process::id());
    loop {
        std::thread::sleep(Duration::from_millis(500));
        if clients.load(Ordering::SeqCst) == 0 && last.lock().unwrap().elapsed() > idle {
            // Remove the descriptor only if it is still ours.
            if fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).is_some_and(|d| d["sessionId"] == descriptor["sessionId"]) {
                let _ = fs::remove_file(&path);
            }
            eprintln!("stub helper idle for {}s; exiting", idle.as_secs());
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_first_then_empty_list_and_nothing_else() {
        let ids = Ids { session: uuid(), root: "C:\\x".into() };
        let mut hello = false;
        let p = json!({"major":2,"minor":0});
        let r = reply(&json!({"protocol":p,"requestId":"a","method":"workspaces.list","params":{}}), &mut hello, &ids);
        assert_eq!(r["error"]["code"], "HANDSHAKE_REQUIRED");
        let r = reply(&json!({"protocol":p,"requestId":"b","method":"hello","params":{"versions":[p]}}), &mut hello, &ids);
        assert_eq!(r["result"]["role"], "modpack-core");
        assert_eq!(r["result"]["capabilities"].as_object().unwrap().len(), 24);
        assert_eq!(r["result"]["capabilities"]["transactions.apply"], false);
        assert_eq!(r["result"]["sessionId"].as_str().unwrap().len(), 36);
        let r = reply(&json!({"protocol":p,"requestId":"c","method":"workspaces.list","params":{}}), &mut hello, &ids);
        assert_eq!(r["result"]["total"], 0);
        for m in ["transactions.apply", "workspaces.create", "operations.get", "providers.search"] {
            let r = reply(&json!({"protocol":p,"requestId":"d","method":m,"params":{}}), &mut hello, &ids);
            assert_eq!(r["error"]["code"], "UNSUPPORTED_CAPABILITY");
        }
    }
}
