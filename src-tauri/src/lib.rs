//! Desktop host for Awake Modpack Manager (Windows x64).
//!
//! The host is deliberately thin: it discovers Launcher data profiles, opens the Launcher's
//! integration named pipe, verifies who owns it, and moves length-prefixed frames. All protocol
//! semantics (hello, negotiation, pagination, errors) live in TypeScript (`src/backend/launcher`).
//! It never reads or writes instance files.

mod discovery;
mod pipe;

/// Live test against a running Awake Launcher. Skipped unless AWAKE_MM_LIVE_PROFILE names the
/// Launcher data folder: `AWAKE_MM_LIVE_PROFILE=C:\path cargo test -- --ignored live_`.
#[cfg(test)]
mod live {
    use crate::{discovery, pipe};
    use serde_json::{json, Value};
    use std::io::Write;

    fn exchange(file: &mut std::fs::File, body: Value) -> Value {
        file.write_all(&pipe::encode_frame(body.to_string().as_bytes()).unwrap()).unwrap();
        serde_json::from_slice(&pipe::read_frame(file).unwrap()).unwrap()
    }

    #[test]
    #[ignore]
    fn live_host_pipe_handshake_and_reads() {
        let Ok(root) = std::env::var("AWAKE_MM_LIVE_PROFILE") else { return };
        let d = discovery::read_descriptor(std::path::Path::new(&root)).unwrap().expect("no endpoint.json: is the Launcher running?");
        let (name, pid) = (d["serverName"].as_str().unwrap(), d["pid"].as_str().unwrap().parse::<u32>().unwrap());
        // Wrong pid must be refused by the server-process check.
        assert_eq!(pipe::open_pipe(name, pid.wrapping_add(1)).unwrap_err().code, "identity");
        let mut f = pipe::open_pipe(name, pid).expect("verified open");
        let p = json!({"major":1,"minor":0});
        let hello = exchange(&mut f, json!({"protocol":p,"requestId":"h1","method":"hello","params":{"versions":[p],"client":{"name":"Awake Modpack Manager","version":"live-test"}}}));
        assert_eq!(hello["result"]["sessionId"], d["sessionId"]);
        assert_eq!(hello["result"]["capabilities"]["mods.list"], true);
        let info = exchange(&mut f, json!({"protocol":p,"requestId":"i1","method":"launcher.info","params":{}}));
        assert_eq!(info["result"]["launcherState"], "ready");
        let list = exchange(&mut f, json!({"protocol":p,"requestId":"l1","method":"instances.list","params":{"limit":500}}));
        assert!(list["result"]["instances"].as_array().unwrap().len() >= 1);
        let denied = exchange(&mut f, json!({"protocol":p,"requestId":"w1","method":"transactions.apply","params":{}}));
        assert_eq!(denied["error"]["code"], "UNSUPPORTED_CAPABILITY");
        // Draft operation methods stay off at the pin: not advertised true, refused if sent raw.
        for m in ["operations.get", "launch.request", "instances.create", "transactions.apply"] {
            assert_ne!(hello["result"]["capabilities"][m], true, "{m} unexpectedly enabled");
        }
        let launch = exchange(&mut f, json!({"protocol":p,"requestId":"w2","method":"launch.request","params":{}}));
        assert_eq!(launch["error"]["code"], "UNSUPPORTED_CAPABILITY");
        eprintln!("live host OK: {} instances, session {}", list["result"]["total"], d["sessionId"]);
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(pipe::Connections::default())
        .invoke_handler(tauri::generate_handler![
            discovery::discover_profiles,
            discovery::start_launcher,
            pipe::ipc_open,
            pipe::ipc_request,
            pipe::ipc_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Awake Modpack Manager");
}
