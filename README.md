# Awake Modpack Manager

A desktop companion to Awake Launcher for building and maintaining large Minecraft modpacks
(200–300+ mods) on the **same instances** the Launcher plays.

> **Status: frontend-only development build.** There is no live Launcher integration yet. The app
> runs on a built-in mock backend with sample data. All live changes go through the Awake
> Launcher coordinator, whose contract is still being defined. See
> [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Run

Requires Node 22.19+.

```bash
npm install
npm run dev        # http://127.0.0.1:5173, mock backend
npm test           # Vitest (jsdom)
npm run build      # typecheck + production bundle in dist/
```

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
