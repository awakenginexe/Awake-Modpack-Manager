//! Desktop host for Awake Modpack Manager (Windows x64).
//!
//! The host is deliberately thin: it discovers Launcher data profiles, opens the Launcher's
//! integration named pipe, verifies who owns it, and moves length-prefixed frames. All protocol
//! semantics (hello, negotiation, pagination, errors) live in TypeScript (`src/backend/launcher`).
//! It never reads or writes instance files.

mod discovery;
mod pipe;

pub fn run() {
    tauri::Builder::default()
        .manage(pipe::Connections::default())
        .invoke_handler(tauri::generate_handler![
            discovery::discover_profiles,
            pipe::ipc_open,
            pipe::ipc_request,
            pipe::ipc_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Awake Modpack Manager");
}
