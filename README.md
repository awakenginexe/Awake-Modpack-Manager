# Awake Modpack Manager

A Windows desktop app for building and maintaining large Minecraft modpacks (200-300+ mods).
It works on its own, and alongside Awake Launcher when that is installed.

> **Status (Windows x64): local MVP.** Standalone Fabric/vanilla projects with real Modrinth mods.
>
> * **Standalone (no Launcher):** the Manager bundles Awake's native helper
>   (`awake-core-host.exe` 0.1.1, protocol 2.0, built from Launcher commit `299c140bd`) and
>   starts it on demand. The helper owns:
>   * workspaces (new vanilla/Fabric projects with exact versions);
>   * Modrinth search, versions and verified downloads (size, SHA-512, SHA-1);
>   * required-dependency resolution;
>   * reviewed prepare/apply, updates, enable/disable/remove;
>   * durable operations and recovery.
>
>   Not available yet: CurseForge, import/export through the helper, adopting existing Launcher
>   instances, loader changes after creation, mod display titles.
> * **Real-backend tests:** `tests/realHelper` (opt-in) drives the TypeScript client against the
>   packaged helper and live Modrinth; the Rust host has an opt-in real-helper identity test.
> * **Projects:** drafts with `.mrpack`/CurseForge ZIP import preview and verified export.
>   * Exports use the native Save As dialog.
>   * Drafts are saved in a versioned file under `%LOCALAPPDATA%\AwakeModpackManager\projects`.
> * **With Awake Launcher:** a read-only view of real Launcher instances (protocol 1.0).

## Run

Requires Node 22.19+ and, for the desktop app, Rust (MSVC toolchain) and WebView2.

```bash
npm install
npm run desktop:dev     # desktop app (Tauri), real Launcher data
npm run dev             # browser preview at http://127.0.0.1:5173, demo data only
npm test                # Vitest: unit, component and fixture-IPC tests
npm run test:host       # Rust host tests
npm run build           # typecheck + web bundle in dist/
node scripts/stage-helper.mjs --from <helper package folder> <source commit>   # stage the real helper (whole folder)
npm run desktop:build   # Windows release build (NSIS installer); refuses a missing, stub or modified helper stage
npm run helper:stub     # stage the test stub helper (tests only; desktop:build refuses it)
```

Real-backend tests (disposable profile, live Modrinth):

```bash
AWAKE_REAL_HELPER=src-tauri/helper-stage/awake-core-host.exe AWAKE_REAL_PROFILE=<new empty folder> npx vitest run tests/realHelper
```

Testing with disposable data: set `AWAKE_MM_DATA_DIR` to a scratch folder before starting the
app. Projects and helper data then go there instead of `%LOCALAPPDATA%\AwakeModpackManager`.
Uninstalling never deletes that folder.

Awake Launcher is optional. To see its instances, it must be running for the selected profile. If yours uses a portable or `--dir`
folder, add it in Settings → Launcher connection.

Dev scenarios: `?mock=drift`, `?mock=fail`, `?mock=cf` (see INTEGRATION.md).

## Screens

* **Instances**: Launcher instances with version, loader, mod count, status, location and
  whether they can be managed now; create an instance; open it in Awake Launcher.
* **Get modpack**: search Modrinth, CurseForge, FTB, ATLauncher and Technic, pick a version
  and install it as a new instance in one step, then go straight to managing it. Provider calls
  and the CurseForge API key stay in Awake Launcher; this app ships no keys.
* **Mods**: a windowed table for hundreds of mods with search, status/source filters, sorting,
  multi-select (shift-range, Ctrl+A), bulk update/enable/disable/remove/pin, and a details panel
  with dependencies. Unknown/manual files stay visible.
* **Browse**: provider search (Modrinth; CurseForge when authorized) filtered by version,
  loader, release type and compatibility; multi-select into the draft.
* **Review & apply**: draft → resolved plan (install/update/remove, required and optional
  dependencies, conflicts, pins, unknown files, destructive changes) → prepare → apply →
  live progress until a confirmed result.
* **Files**: read-only view of configs, defaultconfigs, kubejs, scripts, resource packs and
  shader packs, with a Manager-side "include in export" list.
* **History**: operations with all proposed states, errors, rollback/recovery info, cancel.
* **Export**: `.mrpack` / CurseForge ZIP with a distribution-permission review.

Languages: English, ไทย, 简体中文, 繁體中文 (same codes as the Launcher).

## Docs

* [Architecture and desktop-shell decision](docs/ARCHITECTURE.md)
* [Integration assumptions and required Launcher capabilities](docs/INTEGRATION.md)
* [Licensing notes](docs/LICENSING.md)
