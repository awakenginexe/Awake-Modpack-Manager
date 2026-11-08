# Awake Modpack Manager

A Windows desktop app for building and maintaining Minecraft modpacks. It creates its own modpack
projects and installs real mods from Modrinth, with every change reviewed before it is applied.
Awake Launcher is not required.

> **What's new in 1.1.0:** see [docs/releases/v1.1.0.md](docs/releases/v1.1.0.md).

**Version 1.1.0 · Windows x64 · English, ไทย, 简体中文, 繁體中文 · GPL-3.0-only**

## Install

1. Download `Awake-Modpack-Manager-v1.1.0-Windows-x64-Setup.exe` from the
   [latest release](https://github.com/awakenginexe/Awake-Modpack-Manager/releases/latest).
2. Optional: check it against `SHA256SUMS.txt` from the same release
   (`Get-FileHash .\Awake-Modpack-Manager-v1.1.0-Windows-x64-Setup.exe`).
3. Run the installer. It installs for your Windows user only (no administrator rights) into
   `%LOCALAPPDATA%\Awake Modpack Manager`.
   The installer is **not code-signed** yet, so Windows SmartScreen may warn that it is from an
   unknown publisher: choose **More info → Run anyway** if the checksum matches.
4. Start **Awake Modpack Manager** from the Start menu. Requires Windows 10/11 x64 with Microsoft
   Edge WebView2 (preinstalled on current Windows; the installer fetches it if missing).

Your projects are stored in `%LOCALAPPDATA%\AwakeModpackManager`. Uninstalling or upgrading never
deletes that folder.

## What works in 0.1.0

* **Install whole modpacks** from Modrinth, CurseForge, FTB, ATLauncher and Technic, and update them later.
* **Standalone modpack projects:** create a project with an exact Minecraft version and mod loader
  (vanilla or Fabric) and loader version, chosen from live version lists.
* **Modrinth:** search compatible mods, pick an exact version, see release type, size and required
  dependencies.
* **Real installation:** the bundled native helper downloads every file, checks its size, SHA-512
  and SHA-1 against Modrinth, and installs it into the project's `mods` folder.
* **Required dependencies** are added automatically and shown in the review; optional ones are
  listed, never downloaded silently. Changes that would break a declared dependency are refused.
* **Maintain:** update to newer stable versions, disable, enable and remove mods, one at a time or
  in bulk, each through **Review & apply**.
* **Safety:** every change is prepared and verified before Apply; Apply is refused if the
  project's files changed since the review; interrupted changes are rolled back or completed when
  the helper restarts, and History shows each operation, its errors and any recovery needed.
  Files the Manager does not know are never deleted.
* **Projects page:** `.mrpack` and CurseForge ZIP import preview and verified export of Manager
  drafts (Save As), as before.
* **Awake Launcher (optional):** if Awake Launcher with its integration endpoint is running, its
  instances can be viewed read-only.

## Known limitations

* **CurseForge files whose authors disallow third-party downloads** are listed for you to download by hand.
* **Awake Launcher's own instances are read-only here.** Manager projects can be opened and played in Awake Launcher.
* **The Manager does not launch Minecraft.** Use Awake Launcher or another launcher to play.
* **Loaders:** Fabric, Quilt, Forge, NeoForge and vanilla. A project keeps its loader; a pack update may move to a newer build of it.
* **ATLauncher and Technic packs** install as local files; packs that patch the Minecraft JAR are refused with that reason.
* Dependency checks use the metadata mod authors publish on Modrinth; they are not a guarantee that
  every combination runs in game. Not every Minecraft version or loader is supported.
* The installer is unsigned.

## How it works

The Manager (Tauri 2, Rust and Vue 3) owns the interface. All file changes are made by the bundled
**Awake Native Core** helper (`core-host/windows-x64/awake-core-host.exe`, version 0.3.0), a
separate program built from [Awake Launcher](https://github.com/awakenginexe/Awake-Launcher)
`native-core` at commit `b06c9a804503545207bacfa3bfdf8bfe23604e07` (v0.1.0 shipped 0.1.1 from `299c140bd`). The Manager starts it on
demand with a private profile, checks it is the bundled executable (pipe server PID, Windows user
and image path), and talks to it over a local named pipe using the pinned protocol 2.0 schema. The
helper exits by itself about a minute after it becomes idle; the installer waits for it instead of
killing it.

## Licence and source code

Awake Modpack Manager is free software under the **GNU General Public License v3.0 only**
([LICENSE](LICENSE)).

* Manager source: this repository; each release is tagged (`v0.1.0`).
* Native helper source (GPL-3.0-only): `Awake-Native-Core-299c140bd-Source.zip`, published with
  [Awake Launcher v3.0.0](https://github.com/awakenginexe/Awake-Launcher/releases/tag/v3.0.0) and
  attached to the Manager release (SHA-256
  `bc63fe1e8702bf10894e5a156f40da58c55e2efaa24fb7d2477dde49e66059fc`).
* Qt 6.11.2 (LGPL-3.0, dynamically linked, replaceable DLLs), the Microsoft Visual C++ runtime and
  all other components: [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt),
  [licenses/](licenses) and [docs/LICENSING.md](docs/LICENSING.md). These files are also
  installed with the app.

## Build from source

Requires Node 22.19+, Rust (MSVC toolchain) and WebView2.

```bash
npm ci
npm test                # Vitest: unit, component and protocol-fixture tests
npm run test:host       # Rust host tests
npm run build           # typecheck + web bundle
node scripts/stage-helper.mjs --from <helper package folder> <source commit>   # stage the native helper (whole folder)
npm run desktop:build   # Windows installer; refuses a missing, stub or modified helper
```

The helper package is built from the Native Core source above (`native-core/deploy.ps1`).
`HELPER-SOURCE.txt` in the staged folder records the SHA-256 of every helper file.

Development: `npm run dev` (browser preview with demo data), `npm run desktop:dev` (desktop app).
Set `AWAKE_MM_DATA_DIR` to a scratch folder to keep test projects separate. Opt-in real-backend
test (disposable profile, live Modrinth):

```bash
AWAKE_REAL_HELPER=src-tauri/helper-stage/awake-core-host.exe AWAKE_REAL_PROFILE=<new empty folder> npx vitest run tests/realHelper
```

## Docs

* [Licensing](docs/LICENSING.md)
* [Standalone architecture](docs/ARCHITECTURE-STANDALONE.md)
* [Requests to Awake Launcher / Native Core](docs/LAUNCHER-REQUESTS.md)
