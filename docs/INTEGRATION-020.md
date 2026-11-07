# Native Core 0.2.0 integration (Manager v0.2.0)

## Pins

| What | Value |
|---|---|
| Contract (schema, protocol doc) | Awake Launcher `3b279ff06668b17590892514f12ccbfdbc0a68c3`, branch `feat/native-core-manager-020` (docs handoff `4c9894a27941d9e8f21b7351801dfaf70dd2e561` changes only `handoff.md`) |
| `src/backend/core/core.schema.json` | byte-identical to `docs/modpack-manager/core.schema.json` at `3b279ff06` (line endings aside), SHA-256 `a5ae9849…0553222` |
| Helper executable | `awake-core-host.exe` 0.2.0, SHA-256 `23a9cea1cad321b1b9216375c962aca072a895e95aaf7b9f1515601cbdc63c43` |
| Helper package manifest (`SHA256SUMS`) | SHA-256 `6894b4c90f5dcb54ccffe26932e682ae4fa0b6f117cde148e62e6a98eb60b525` |
| Codex package ZIP | SHA-256 `48b0410646c4f0a25e27570551763499b46e57ecaec64b102efae1a2a918ca97` (6,048,986 bytes) |

`scripts/helper-pin.json` records these. `stage-helper.mjs --from` and `--check` refuse any package
whose executable, manifest, file set or `SOURCE.json` differs; the Rust host embeds the staged
`SHA256SUMS` at build time and refuses to start a helper folder with a changed, missing or extra file.

## Handshake and compatibility

* `hello` sends `extensions: ["manager.v0.2"]`. If the helper answers `INVALID_REQUEST` or
  `UNSUPPORTED_PROTOCOL` (an 0.1.x helper, whose schema forbids the field), the client opens a new
  connection and sends the 0.1 hello. `rpc.extensions()` then reports none.
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

The helper has no export (`outbox.read` unavailable). The Manager builds exports itself:
`snapshotWorkspace` reads the verified inventory and each installed version's provider record
(`providers.versions`, paged) into a Manager project; modified, manual or unknown files are listed
and left out. Override files cannot be read from a workspace; the export dialog can take them from a
pack archive the user picks (accounts, credentials, logs, saves and caches are always refused).

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
