//! Self-update from the project's official GitHub releases.
//!
//! The Manager's installer is not code-signed, so this does not use an updater signature. It reads
//! only `awakenginexe/Awake-Modpack-Manager` releases over HTTPS and checks the installer against the
//! SHA-256 published with that same release before running it. A portable copy is sent to the release
//! page: replacing a running portable folder is not something an installer can do for it.

use crate::providers::{agent, err, get_json, HostError, HostResult};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::Emitter;

const REPOSITORY: &str = "awakenginexe/Awake-Modpack-Manager";
const INSTALLER_MAX: u64 = 512 << 20;

/// `major.minor.patch[-pre.n]`, ordered by semantic versioning. None when it is not a version.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Version {
    core: [u64; 3],
    pre: Vec<String>,
}

pub fn parse_version(text: &str) -> Option<Version> {
    let text = text.trim().trim_start_matches('v');
    let (core, pre) = text.split_once('-').map_or((text, None), |(a, b)| (a, Some(b)));
    let mut parts = core.split('.').map(|p| p.parse::<u64>());
    let version = [parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?];
    if parts.next().is_some() {
        return None;
    }
    Some(Version { core: version, pre: pre.map_or(vec![], |p| p.split('.').map(str::to_string).collect()) })
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.core.cmp(&other.core).then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                for (a, b) in self.pre.iter().zip(&other.pre) {
                    let ord = match (a.parse::<u64>(), b.parse::<u64>()) {
                        (Ok(x), Ok(y)) => x.cmp(&y),
                        (Ok(_), Err(_)) => Ordering::Less,
                        (Err(_), Ok(_)) => Ordering::Greater,
                        _ => a.cmp(b),
                    };
                    if ord != Ordering::Equal {
                        return ord;
                    }
                }
                self.pre.len().cmp(&other.pre.len())
            }
        })
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    tag: String,
    version: String,
    name: String,
    notes: String,
    url: String,
    published_at: String,
    prerelease: bool,
    /// Size of this release's Windows installer, when it has one.
    installer_size: Option<u64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    latest: Option<Release>,
    update_available: bool,
    /// A setup can replace this copy; a portable one is updated from the release page.
    can_install: bool,
}

fn installer_asset(release: &Value) -> Option<&Value> {
    let tag = release["tag_name"].as_str()?;
    let name = format!("Awake-Modpack-Manager-{tag}-Windows-x64-Setup.exe");
    release["assets"].as_array()?.iter().find(|a| a["name"] == name.as_str())
}

/// The newest published release this copy should move to, if any.
pub fn select_release<'a>(releases: &'a [Value], current: &Version, include_prereleases: bool) -> Option<(&'a Value, Version)> {
    releases
        .iter()
        .filter(|r| r["draft"] != true && (include_prereleases || r["prerelease"] != true))
        .filter_map(|r| Some((r, parse_version(r["tag_name"].as_str()?)?)))
        .filter(|(_, v)| v > current)
        .max_by(|a, b| a.1.cmp(&b.1))
}

fn releases() -> HostResult<Vec<Value>> {
    Ok(get_json(&format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=30"))?.as_array().cloned().unwrap_or_default())
}

fn describe(r: &Value) -> Release {
    let text = |k: &str| r[k].as_str().unwrap_or("").to_string();
    Release {
        tag: text("tag_name"),
        version: text("tag_name").trim_start_matches('v').to_string(),
        name: text("name"),
        notes: text("body").chars().take(20_000).collect(),
        url: text("html_url"),
        published_at: text("published_at"),
        prerelease: r["prerelease"] == true,
        installer_size: installer_asset(r).and_then(|a| a["size"].as_u64()),
    }
}

/// An NSIS install keeps its uninstaller next to the program.
fn is_installed() -> bool {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("uninstall.exe").is_file())).unwrap_or(false)
}

#[tauri::command]
pub async fn update_check(include_prereleases: bool) -> HostResult<UpdateInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = env!("CARGO_PKG_VERSION");
        let parsed = parse_version(current).ok_or(HostError { code: "internal", message: "This build has an invalid version.".into() })?;
        let list = releases()?;
        // Someone already on a beta keeps receiving betas until a final release passes them.
        let chosen = select_release(&list, &parsed, include_prereleases || !parsed.pre.is_empty());
        Ok(UpdateInfo { current: current.to_string(), update_available: chosen.is_some(), latest: chosen.map(|(r, _)| describe(r)), can_install: is_installed() })
    })
    .await
    .unwrap_or_else(|e| err("internal", e.to_string()))
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    done: u64,
    total: u64,
}

/// `SHA256SUMS.txt` or a `.sha256` sidecar: the hash recorded for `name`.
pub fn expected_hash(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let file = parts.next().map(|f| f.trim_start_matches('*'));
        (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && file == Some(name)).then(|| hash.to_ascii_lowercase())
    })
}

fn download_text(url: &str) -> HostResult<String> {
    let mut response = agent(45).get(url).call().or_else(|e| err("network", format!("GitHub: {e}")))?;
    if response.status() != 200 {
        return err("network", format!("GitHub returned HTTP {}.", response.status().as_u16()));
    }
    response.body_mut().read_to_string().or_else(|e| err("network", e.to_string()))
}

/// Download the release's installer, verify it, and start it. On success the window should close.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, tag: String) -> HostResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_installed() {
            return err("portable", "This is a portable copy. Download the new version from the release page.");
        }
        // The tag only selects among official releases; every URL comes from GitHub's reply.
        let list = releases()?;
        let release = list.iter().find(|r| r["tag_name"] == tag.as_str() && r["draft"] != true).ok_or(HostError { code: "not-found", message: "That release is no longer published.".into() })?;
        let asset = installer_asset(release).ok_or(HostError { code: "not-found", message: "That release has no Windows installer.".into() })?;
        let name = asset["name"].as_str().unwrap_or_default().to_string();
        let url = asset["browser_download_url"].as_str().unwrap_or_default().to_string();
        let prefix = format!("https://github.com/{REPOSITORY}/releases/download/");
        if !url.starts_with(&prefix) {
            return err("restricted", "The installer is not hosted by the official repository.");
        }
        let assets = release["assets"].as_array().cloned().unwrap_or_default();
        let sums_url = assets.iter().find(|a| a["name"] == "SHA256SUMS.txt").or_else(|| assets.iter().find(|a| a["name"] == format!("{name}.sha256").as_str())).and_then(|a| a["browser_download_url"].as_str()).ok_or(HostError { code: "integrity", message: "That release has no published checksum, so it will not be installed automatically.".into() })?;
        let expected = expected_hash(&download_text(sums_url)?, &name).ok_or(HostError { code: "integrity", message: "The release's checksum list does not include its installer.".into() })?;

        let dir: PathBuf = crate::helper::manager_data_dir().or_else(|m| err("io", m))?.join("tmp").join("update");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).or_else(|e| err("io", e.to_string()))?;
        let target = dir.join(&name);
        let total = asset["size"].as_u64().unwrap_or(0);
        let mut response = agent(1800).get(&url).call().or_else(|e| err("network", format!("GitHub: {e}")))?;
        if response.status() != 200 {
            return err("network", format!("GitHub returned HTTP {}.", response.status().as_u16()));
        }
        let mut reader = response.body_mut().with_config().limit(INSTALLER_MAX).reader();
        let mut file = fs::File::create(&target).or_else(|e| err("io", e.to_string()))?;
        let (mut hash, mut buffer, mut done) = (Sha256::new(), vec![0u8; 256 * 1024], 0u64);
        loop {
            let n = reader.read(&mut buffer).or_else(|e| err("network", format!("Download interrupted: {e}")))?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
            file.write_all(&buffer[..n]).or_else(|e| err("io", e.to_string()))?;
            done += n as u64;
            let _ = app.emit("update-progress", DownloadProgress { done, total });
        }
        file.sync_all().or_else(|e| err("io", e.to_string()))?;
        drop(file);
        let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if got != expected {
            let _ = fs::remove_file(&target);
            return err("integrity", "The downloaded installer does not match the release checksum. Nothing was changed.");
        }
        // /P shows progress without asking questions; the installer relaunches the Manager when done.
        std::process::Command::new(&target).args(["/P", "/UPDATE", "/R"]).spawn().or_else(|e| err("io", format!("Could not start the installer: {e}")))?;
        Ok(())
    })
    .await
    .unwrap_or_else(|e| err("internal", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(s: &str) -> Version {
        parse_version(s).unwrap()
    }

    #[test]
    fn versions_follow_semver_order() {
        assert!(v("0.3.0") > v("0.2.0-beta.2"));
        assert!(v("0.3.0") > v("0.3.0-rc.1"));
        assert!(v("0.3.0-beta.10") > v("0.3.0-beta.2"));
        assert!(v("0.3.0-rc.1") > v("0.3.0-beta.9"));
        assert!(v("v1.0.0") == v("1.0.0"));
        assert!(parse_version("nightly").is_none());
        assert!(parse_version("1.2").is_none());
    }

    #[test]
    fn stable_copies_ignore_prereleases_and_drafts() {
        let list = vec![
            json!({"tag_name": "v0.4.0-beta.1", "prerelease": true, "draft": false}),
            json!({"tag_name": "v0.3.1", "prerelease": false, "draft": false}),
            json!({"tag_name": "v9.0.0", "prerelease": false, "draft": true}),
            json!({"tag_name": "not-a-version", "prerelease": false, "draft": false}),
        ];
        assert_eq!(select_release(&list, &v("0.3.0"), false).unwrap().1, v("0.3.1"));
        assert_eq!(select_release(&list, &v("0.3.0"), true).unwrap().1, v("0.4.0-beta.1"));
        assert!(select_release(&list, &v("0.3.1"), false).is_none());
    }

    #[test]
    fn checksums_are_matched_by_exact_file_name() {
        let hash = "a".repeat(64);
        let text = format!("{}  other.exe\r\n{hash} *Setup.exe\n", "b".repeat(64));
        assert_eq!(expected_hash(&text, "Setup.exe"), Some(hash));
        assert_eq!(expected_hash(&text, "Missing.exe"), None);
        assert_eq!(expected_hash("short  Setup.exe", "Setup.exe"), None);
    }

    #[test]
    fn only_the_named_installer_counts() {
        let r = json!({"tag_name": "v0.3.0", "assets": [{"name": "Awake-Modpack-Manager-v0.3.0-Windows-x64.zip"}, {"name": "Awake-Modpack-Manager-v0.3.0-Windows-x64-Setup.exe", "size": 5}]});
        assert_eq!(installer_asset(&r).unwrap()["size"], 5);
        assert!(installer_asset(&json!({"tag_name": "v1.0.0", "assets": []})).is_none());
    }
}
