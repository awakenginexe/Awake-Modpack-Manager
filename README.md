# Awake Modpack Manager

A Windows desktop app for building and maintaining large Minecraft modpacks (200-300+ mods).
It works on its own, and alongside Awake Launcher when that is installed.

> **Status (Windows x64):** the Manager side of standalone mode is done; real installs are waiting on
> Codex's helper build.
>
> * **Standalone (no Launcher):** the Manager talks to its bundled native helper
>   (`awake-core-host.exe`, protocol 2.0, pinned to Launcher commit `861cebc1a`). It starts the
>   helper on demand. The helper owns:
>   * workspaces;
>   * Modrinth search and downloads;
>   * dependency resolution;
>   * reviewed prepare/apply;
>   * recovery.
>
>   The Manager implements the whole client against that contract. It is tested against a
>   protocol fixture, not a real helper.
> * **This build's helper:** it bundles a **test stub** (`tools/stub-helper`). The app labels it,
>   and it can't create, download or install anything. Stage Codex's real helper build with
>   `node scripts/stage-helper.mjs --from <build folder>` once it's committed.
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
npm run desktop:build   # Windows release build (NSIS installer; stages the stub helper if none is staged)
npm run helper:stub     # build and stage the test stub helper
node scripts/stage-helper.mjs --from <dir>   # stage a real helper build instead
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
