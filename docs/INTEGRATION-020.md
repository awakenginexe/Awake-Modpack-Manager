# Native Core 0.2.x integration (Manager v0.2.0; helper 0.2.1)

## Pins

| What | Value |
|---|---|
| Contract (schema, protocol doc) | Awake Launcher `31d0611a9de0409560f0b62282de078e5970a396` (branch `feat/native-core-manager-020`); unchanged through the executable pin `b06c9a804503545207bacfa3bfdf8bfe23604e07`; delivered by `75b362c6958fe9a5829faf4371146f9132b7ebc2` |
| `src/backend/core/core.schema.json` | byte-identical to the Git blob `docs/modpack-manager/core.schema.json` at `31d0611a9`, SHA-256 `26539795e4da1929fd6977032da25798de6f0274c8af7375740c5b403ba0e3e7` |
| Helper executable | `awake-core-host.exe` 0.2.1, SHA-256 `a71b35e946ffef00bed4b1200c4796e7d16001dac8089481d0192035ae64124b` |
| Helper package manifest (`SHA256SUMS`) | SHA-256 `aacd3d97188c45aa63b1f9a290d0c1d39a531c74e1126e7ef044e8c81116f752` |
| Helper package ZIP | `awake-core-manager-v0.2.1-windows-x64.zip`, SHA-256 `0aea4ce7f3adcd7fd920d55c4b751623c5846be24331b2846e9624b026bc6792` (6,814,993 bytes) |
| Corresponding source | `awake-core-source-b06c9a804503.zip`, SHA-256 `543dcc404bdb9bb6f319dceb6e860b1040a7c55611fba5443d934444237503ee` (107,287,939 bytes; two committed parts joined and verified) |

`scripts/helper-pin.json` records these. `stage-helper.mjs --from` and `--check` refuse any package
whose executable, manifest, file set or `SOURCE.json` differs; the Rust host embeds the staged
`SHA256SUMS` at build time and refuses to start a helper folder with a changed, missing or extra file.

## Native Core 0.2.1: reviewed dependency conflicts (`manager.v0.2.1`)

* `hello` offers `manager.v0.2.1` first, then `manager.v0.2`, then nothing, each alone on a fresh connection
  (`coordinator/rpc.ts`). A 0.2.0 helper rejects the newer offer with INVALID_REQUEST and keeps working at
  the 0.2 level. `manager.v0.2.1` implies every 0.2 feature (`ext()` accepts either).
* With `dependencies.resolutions.v1`, a failed `plans.prepare` / `imports.prepare` operation carries
  `error.details.conflicts[]` (only in `operations.get`). `HelperClient` maps them, never the message text, to
  `BackendError('dependency-conflict', …, conflicts)`. `domain/conflicts.ts` turns each conflict into what the
  UI shows: friendly project name, requesting mods and their versions, requested and selected versions, what
  the mods' own loader metadata says (`satisfied`, `violated`, `not_declared`, `unknown`), affected files and
  only the actions the helper accepts.
* `components/DependencyConflicts.vue` appears in place, in the import dialog and on Review, as soon as the
  helper reports conflicts. That happens before anything is downloaded or staged. No choice is preselected. The retry is enabled only when every
  problem has an explicit decision and none is blocked. The import dialog keeps the upload and the new
  workspace for the retry (`session.prepareImport(..., resolutions, keepUploadOnFailure)`) and discards the
  upload when the dialog is cancelled. Decisions accumulate across rounds (`mergeResolutions`).
* Retries send `dependencyResolutions` (`{projectId, provider?, versionId | null}`). The helper re-checks the
  evidence and binds accepted decisions into `planDigest`. Review lists each one (`dependency-reviewed`).
* Mods loaded through Sinytra Connector show a "via Sinytra Connector" badge (`mods.list.loaderBridge`).
* A helper without the extension still fails with DEPENDENCY_CONFLICT: the panel then says the details are
  unavailable, and the client never sends decisions to it.

## Handshake and compatibility

* `hello` sends `extensions: ["manager.v0.2"]`. The extension counts as accepted only when the result
  echoes it in `extensions`; a helper that does not echo (the pre-final `3b279ff06` build) is treated as
  legacy. If the helper answers `INVALID_REQUEST` or `UNSUPPORTED_PROTOCOL` (an 0.1.x helper, whose schema
  forbids the field), the client opens a new connection and sends the 0.1 hello. `rpc.extensions()` then
  reports none.
* Every 0.2 feature needs **both** the accepted extension and its capability flag:

| Manager capability / behaviour | Helper requirement |
|---|---|
| Forge / NeoForge / Quilt in create, catalog, search, versions | `loaders.forge.v1` / `loaders.neoforge.v1` / `loaders.quilt.v1` and listed in `core.info.supportedLoaders` |
| `mods.policies` (pins, update exclusions as reviewed `policy` changes) | `policies.v1` + `plans.prepare` + `transactions.apply` |
| `packs.import` (native .mrpack / CurseForge ZIP import) | `imports.inspect`, `imports.prepare`, `inbox.begin/write/commit`, `inbox.discard` |
| CurseForge search, versions, install, update | `providers.curseforge.v1` (false in the shipped helper) |

* Without the extension the client never sends `inbox.*`, `imports.*`, `policy` changes, a non-Modrinth
  `provider`, or a loader other than vanilla/Fabric; requests stay byte-for-byte the 0.1 shapes
  (`provider` is omitted for Modrinth installs).
* Operation IDs, idempotency keys, plan digests and instance revisions are used exactly as before;
  import plans are applied with the unchanged `transactions.apply` authorization.

## Import sequence (Manager)

1. Local read-only preview (`domain/packFormats.ts`) of the chosen archive.
2. `inbox.begin` (random idempotency key, size, SHA-256) → `inbox.write` chunks of ≤ 262,144 bytes
   from the helper's `received` offset → `inbox.commit`. Tokens are remembered per helper profile until
   discarded; tokens left by a closed or crashed Manager are discarded at the next connect.
3. `imports.inspect` decides the exact Minecraft and loader versions.
4. `workspaces.create` with those versions (or an existing workspace with exactly the same versions).
5. `imports.prepare` against the workspace's current revision (`mods.list` first page), then every
   `plans.get` page. The upload is discarded once the plan is staged (or on any failure).
6. Review lists mods, every override file (add/replace, replace = destructive) and bookkeeping files,
   then `transactions.apply`.

## Export

The helper has no archive export. The Manager builds exports itself: `snapshotWorkspace` reads the
verified inventory and each installed version's provider record (`providers.versions`, paged) into a
Manager project; modified, manual or unknown files are listed and left out. With `outbox.list`,
`outbox.read` and `outbox.configs.v1` it also reads every unchanged, policy-tracked `config/` override
at one instance revision (≤ 262,144-byte chunks, SHA-256 checked against the listing) and attaches them
to the project's next export (in memory). Other files (scripts, changed or untracked configs) can still
come from a pack archive the user picks; accounts, credentials, logs, saves and caches are always refused.

## Final contract (b00caf709): what the Manager consumes

* `x-methods` holds every method; the `$defs` fallback is gone.
* `mods.list` `policy {pinnedVersion, excluded}` and `nativeLock` are read separately; `updateLocked` is
  never shown as a pin. A policy change keeps the other setting (and an existing pin's version). A native
  lock is shown as "Locked by the pack" and is not offered for clearing.
* `plans.get` `files[].kind` classifies review items; path rules remain for replies without `kind`.
* `providers.project` names provider-identified files (imports) once, cached; time-boxed per load.

## Historical contract issues (resolved in b00caf709)

The list below describes the pre-final helper. Current open blockers and test limits are in [HANDOFF.md](HANDOFF.md).

1. **`x-methods` is missing the three new methods.** `imports.inspect`, `imports.prepare` and
   `inbox.discard` exist in `$defs` and in the `request.method` enum, but not in `x-methods`, which is
   the method table clients (and the handoff) use. The Manager falls back to `$defs[method]`.
   Fix: add the three entries to `x-methods`.
2. **Accepted extensions are not echoed.** `hello.result` has no `extensions` field, so a client can only
   infer acceptance from "hello with the field did not fail". An additive `extensions` array in the
   result would make negotiation explicit and future extensions safe to add.
3. **Pin, exclusion and native lock are not distinguishable.** Observed with the real 0.2.0 helper:
   after a reviewed `policy` change with `pinnedVersion: null, excluded: true`, `policies.json` stores
   exactly that, but `mods.list` reports `updateLocked: true`. So `updateLocked` is the OR of a pin, an
   exclusion and native Packwiz `update=false`, and exclusion itself is visible only via `updates.check`.
   A client cannot read back whether an excluded mod is also pinned, nor whether a lock is native (which a
   policy change cannot clear). The Manager therefore shows an excluded mod as excluded only, and
   re-including it is reviewed with `pinnedVersion: null` (visible in the plan). Fix: an additive
   `policy: {pinnedVersion, excluded}` and `nativeLock` on `installed`.
4. **No project lookup by ID.** Display titles/icons are not extracted from JARs and there is no
   `providers.projects` read, so imported mods show file names until the user meets them in search.
5. **No export of managed overrides.** Exports cannot include a workspace's config files without
   `outbox.read` (or an export method returning managed override bytes/hashes).
6. **`plans.get` files have no kind.** The client classifies overrides vs bookkeeping
   (`.awake-integration/`, `.index/`, `instance.cfg`, `mmc-pack.json`) by path; an additive `kind`
   would avoid guessing.

## Shared-workspace beta

Manager **0.2.0-beta.1** pairs with Launcher **3.1.0-beta.1** and the existing pinned Native Core **0.2.1**. A Manager library card's **Open in Awake Launcher** action links/selects its original workspace. It does not export, import, copy, or start Minecraft. Finish Manager changes, then choose an account and press Play in Launcher. Close the game before changing mods.

If no compatible Launcher installation is found, add its installation folder under Settings → Launcher connection, or use **Link Existing Manager Workspace** in Launcher with the path shown on the Manager card. The host checks the installed executable's supported command-line option before sending a link request. Launcher 3.0.0 lacks it. Both apps must use the same Windows account and a fixed local disk. The current beta does not move workspaces.

Launcher stores its preferences separately and uses the original `.minecraft` directory. Existing Native Core locks block concurrent operations and game-time mod writes; unknown/recovery states remain blocked. Detailed behavior: [Launcher shared-workspace guide](https://github.com/awakenginexe/Awake-Launcher/blob/feat/native-core-manager-020/docs/modpack-manager/shared-workspaces.md).

Prior real-pack defects remain out of scope: export omitted Frights and Foliage; inventory took about seven minutes; preparation took 11–13 minutes; a normal inventory request returned BUSY after 30.24 seconds; BetterEnd prevented full original-pack acceptance. Preserve existing private diagnostic evidence; do not bundle it in beta artifacts.
