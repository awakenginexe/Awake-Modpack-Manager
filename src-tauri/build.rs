fn main() {
    for name in ["AWAKE_CORE_CURSEFORGE_AUTHORIZED", "AWAKE_CORE_CURSEFORGE_API_KEY"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    if std::env::var("AWAKE_CORE_CURSEFORGE_AUTHORIZED").as_deref() == Ok("1")
        && std::env::var("AWAKE_CORE_CURSEFORGE_API_KEY").map_or(true, |key| key.trim().is_empty()) {
        panic!("Authorized CurseForge builds require AWAKE_CORE_CURSEFORGE_API_KEY.");
    }
    // rc.exe mis-escapes apostrophes in paths ("Awake's Modpack Manager"), so give it a copy of the
    // window icon from a path without one. shortcut: path workaround, remove if the folder is renamed.
    let src = std::path::Path::new("icons").join("icon.ico");
    println!("cargo:rerun-if-changed={}", src.display());
    let icon = std::env::temp_dir().join("awake-modpack-manager-build-icon.ico");
    std::fs::copy(&src, &icon).expect("copy window icon");
    // The staged helper package's own manifest becomes part of the host binary, so an installed
    // helper folder with a substituted, corrupt, missing or extra file is refused before it runs.
    // Stub/dev stages embed nothing; `stage-helper.mjs --check` refuses those for release builds.
    let sums = std::path::Path::new("helper-stage").join("SHA256SUMS");
    let stub = std::path::Path::new("helper-stage").join("STUB");
    println!("cargo:rerun-if-changed={}", sums.display());
    println!("cargo:rerun-if-changed={}", stub.display());
    let embedded = if stub.exists() { String::new() } else { std::fs::read_to_string(&sums).unwrap_or_default() };
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("helper-sums.txt");
    std::fs::write(out, embedded).expect("write helper-sums.txt");
    let windows = tauri_build::WindowsAttributes::new().window_icon_path(&icon);
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri build");
}
