fn main() {
    // rc.exe mis-escapes apostrophes in paths ("Awake's Modpack Manager"), so give it a copy of the
    // window icon from a path without one. shortcut: path workaround, remove if the folder is renamed.
    let src = std::path::Path::new("icons").join("icon.ico");
    println!("cargo:rerun-if-changed={}", src.display());
    let icon = std::env::temp_dir().join("awake-modpack-manager-build-icon.ico");
    std::fs::copy(&src, &icon).expect("copy window icon");
    let windows = tauri_build::WindowsAttributes::new().window_icon_path(&icon);
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri build");
}
