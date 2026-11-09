# Development checkpoint: Manager 1.1.1 and Native Core 0.4.1

Unreleased until the owner approves the pull request and tags `v1.1.1`.

## Where things are

- Manager: branch `release/1.1.1`. `npm ci`, then `npm test`, `npm run typecheck`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`.
- Native Core: Awake Launcher branch `release/3.2.1`. `.github/workflows/native-core-package.yml` builds it with the recorded toolchain and commits a delivery under `native-core/redistribution/<commit12>/`. `scripts/helper-pin.json` pins that delivery.
- Release: pushing a version tag runs `.github/workflows/awake-beta.yml`, which builds, verifies, assembles every asset and publishes the release. `SHA256SUMS.txt` is required by in-app updates.

## Architecture added in 0.3.0

- `src-tauri/src/providers.rs`: five modpack catalogs, pack downloads, batched project metadata and update lookups. The CurseForge key stays in the host and the helper's environment.
- `src-tauri/src/updater.rs`: GitHub release check and checksum-verified installer run.
- `src-tauri/src/desktop.rs`: project content listing and Recycle Bin, shell open. Mods are never touched here.
- `HelperClient.installPack`: one local operation over fetch, upload, create, prepare and apply. A failure removes the created project.
- FTB versions become a generated `.mrpack` manifest; ATLauncher and Technic become a CurseForge-format archive of overrides.
- Native Core: `workspaces.delete`, `workspaces.rename`, `imports.prepare` with `packAuthoritative`, `removeInventoryIds` and `allowLoaderUpdate`, a helper-only hash cache, batched provider reads and parallel downloads.

## Testing locally

GitHub release assets were failing with HTTP 504 on the development machine, so Native Core was built there against dependencies compiled from the recorded source tarballs, with official Qt 6.11.2. That build was for testing only; the shipped helper comes from the workflow. The app can be driven over CDP by setting `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` and `AWAKE_MM_DATA_DIR` to a disposable folder.
