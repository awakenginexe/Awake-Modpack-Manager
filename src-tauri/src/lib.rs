//! Desktop host for Awake Modpack Manager (Windows x64).
//!
//! The host is deliberately thin: it discovers Launcher data profiles, opens the Launcher's
//! integration named pipe, starts and verifies the Manager's own native helper, and moves
//! length-prefixed frames. All protocol semantics live in TypeScript (`src/backend`). It never reads
//! or writes instance files: its only writes are a user-chosen export file and the Manager's
//! project store (`files.rs`). The one change to a Launcher folder is its Windows permissions, when
//! the user confirms it (`profile_access.rs`).

mod desktop;
mod discovery;
mod files;
mod helper;
mod pipe;
mod profile_access;
mod providers;
mod updater;

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

use tauri::Manager;

pub fn run() {
    providers::sweep_pack_dir();
    tauri::Builder::default()
        // One window per user: a second launch brings the running one forward.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(std::sync::Arc::new(providers::CatalogCache::default()))
        .manage(pipe::Connections::default())
        .manage(helper::Spawned::default())
        .invoke_handler(tauri::generate_handler![
            discovery::discover_profiles,
            discovery::start_launcher,
            discovery::make_profile_private,
            pipe::ipc_open,
            pipe::ipc_request,
            pipe::ipc_close,
            helper::helper_ensure,
            helper::helper_open,
            files::save_export,
            files::projects_read,
            files::projects_write,
            providers::pack_providers,
            providers::pack_search,
            providers::pack_versions,
            providers::pack_fetch,
            providers::pack_cancel,
            providers::pack_read,
            providers::pack_discard,
            providers::project_meta,
            providers::project_detail,
            providers::mod_updates,
            updater::update_check,
            updater::update_install,
            desktop::workspace_list,
            desktop::workspace_recycle,
            desktop::workspace_open,
            desktop::open_url,
            desktop::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Awake Modpack Manager");
}
