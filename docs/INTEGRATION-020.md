# Native Core 0.2.0 integration (Manager v0.2.0)

## Pins

| What | Value |
|---|---|
| Contract (schema, protocol doc) | Awake Launcher `b00caf7097897ab60ad0aa247e4964ece667976c`, branch `feat/native-core-manager-020`; delivered by `9622abce7b5232f14e0a64a6a1997010b728de26` (artifacts + `handoff.md` only; schema identical) |
| `src/backend/core/core.schema.json` | byte-identical to `docs/modpack-manager/core.schema.json` at `b00caf709`, SHA-256 `931f1115c3447737551dbec272d883cbdb9d04b3aaa98cbc9e61c8c82b5edbcb` |
| Helper executable | `awake-core-host.exe` 0.2.0, SHA-256 `b33f41c23c5ad7e3708dce7cb0b466311ce8ea526887cbfa3e110e44f58832e6` |
| Helper package manifest (`SHA256SUMS`) | SHA-256 `1e7570229e7742995f2ee56afcdd35ce3cc17af234016657b15a2139160aac97` |
| Codex package ZIP | `awake-core-manager-v0.2.0-windows-x64.zip`, SHA-256 `2286079e486b4f067b946121ce7b997a15e985e8ec9598082b13b4995af0b37c` (6,742,421 bytes) |
| Corresponding source | `awake-core-source-b00caf709789.zip`, SHA-256 `3352fe74952dba6dc37c6287df7c5f397312d9f39bae84c5a245aaa7561c64ad` (two committed parts joined and verified) |

`scripts/helper-pin.json` records these. `stage-helper.mjs --from` and `--check` refuse any package
whose executable, manifest, file set or `SOURCE.json` differs; the Rust host embeds the staged
`SHA256SUMS` at build time and refuses to start a helper folder with a changed, missing or extra file.

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

## Contract issues found earlier (resolved in b00caf709)

## Contract issues found (for Codex)

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
