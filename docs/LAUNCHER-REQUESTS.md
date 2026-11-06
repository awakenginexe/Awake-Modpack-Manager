# Launcher contract requests from the Manager

For Codex (Awake Launcher). Status as of Manager `HEAD`, against Launcher contract pin
`058714ec72ce2db19913f8540b6c4784a9d6ccd2` (protocol 1.0). Nothing here is a competing protocol.
Each item is either "enable what the draft already defines" or "the draft names a method but
leaves its result as `type: object`, so the Manager cannot use it without guessing".

The Manager sends a draft method only when `hello.capabilities[method] === true`. When a schema
lands, tell us the commit and the Manager re-pins to it.

**Last checked: Launcher `6ea0bbe99` (2026-11-06).** `requests.schema.json` and `wire.schema.json`
are unchanged since the pin, and `protocol.md` changed only in prose, so the pin stays. Internal
foundations (operation store, recovery storage, physical lease, transaction executor, game
ownership) exist but aren't advertised, so nothing below is unblocked yet.

**Standalone Manager:** see [ARCHITECTURE-STANDALONE.md](ARCHITECTURE-STANDALONE.md). If option 2
is approved, the Manager writes only its own project workspaces, never Launcher instances. R13 is
then the one new request it creates.

## Already implemented in the Manager (needs only the Launcher side)

These draft methods have fully defined request and reply fields. The Manager client implements
them and fixture tests cover them (`tests/launcherClient.test.ts`, "draft operations"). Turning on
the capability is enough.

| Method | Manager workflow | Notes |
|---|---|---|
| `operations.get {operationId}` | Progress, final result, reconnect, History | Required before anything else is enabled: the Manager maps no write capability without it |
| `operations.cancel {operationId}` | Cancel button on running operations | The reply is treated as an acknowledgement only; state comes from `operations.get` |
| `launch.request {idempotencyKey,physicalId}` | Library → Play | Success = `completed` (process-started). `INTERACTION_REQUIRED` is shown as "finish the step in Awake Launcher" |
| `instances.create {idempotencyKey,name,minecraftVersion}` | Library → Create instance (vanilla only, see R2) | The new instance is found by re-listing; see R2 for a direct result |
| `transactions.apply {idempotencyKey,operationId,planDigest,instanceRevision}` | Review → Apply | Unreachable until `plans.prepare` has a result schema (R4) |

Client behaviour the Launcher can rely on:
* One request in flight per connection. Every side-effect request has a fresh UUID `idempotencyKey`.
* A lost reply is recovered by **resending the identical request with the same key** (the
  protocol has no lookup by key). A different body under the same key is never sent on purpose.
* Operation records are validated strictly: unknown fields, an unknown state, or a `terminal`
  flag that doesn't match the state count as a protocol violation.
* Following stops at a terminal state or `recovery_required`. Accepted is never shown as success.

## Requests

### R0. Operation state enum (seen in Launcher `f59f2ba6e`, still open at `6ea0bbe99`)
`launcher/awake/integration/OperationStore.cpp` (internal, not advertised) uses a state
`rolling_back` that isn't in `requests.schema.json` `$defs/operation`. The Manager validates
states strictly against the schema, so a record in that state would be rejected as a protocol
violation. Please either add `rolling_back` (nonterminal) to the schema when the store is exposed,
and the Manager will add it in the same re-pin, or map it to a schema state on the wire.
`createdAt`, which the store already keeps, would also cover part of R7.

### R1. Instance details in `instances.list`
* **Workflow:** Library cards, Browse compatibility filters, dependency checks, export metadata.
* **Fields per instance:** `minecraftVersion` (string), `loader` (`{uid, version}` from the native
  PackProfile component, or null for vanilla), optionally `javaVersion`.
* **Why:** 1.0 has none of these. The Library shows "Version unknown", and Browse cannot filter by
  game version or loader, so the Manager cannot avoid offering incompatible mods.

### R2. `instances.create` loader shape, version catalog, created-instance identity
* **Workflow:** Create instance dialog (version and loader pickers), then open the new instance.
* **Needed:**
  * The exact `loader` request shape (the draft only says "native component UID/version").
  * A read method listing installable Minecraft versions (id, type release/snapshot, releaseTime)
    and loader versions per Minecraft version (uid, version, recommended). Suggested
    `versions.list {kind:"minecraft"|"loader", loaderUid?, minecraftVersion?, offset?, limit?}`.
  * The `physicalId` of the created instance in the completed operation's `result`.
* **Why:** without a version list the dialog would have to hard-code versions. Without the new
  `physicalId`, the Manager has to diff two listings to find the instance it just created.

### R3. `providers.search` and `providers.versions` result schemas
* **Workflow:** Browse (search, filters, details), the version picker, update checks, dependency resolution.
* **Search hit fields:** `provider`, `projectId`, `slug`, `title`, `summary`, `author`, `iconUrl`
  (or null), `downloads`, `categories[]`, `loaders[]`, `gameVersions[]`, `clientSide`/`serverSide`,
  `distributionAllowed` (CurseForge), and `total`/`nextOffset` paging.
* **Version fields:** `versionId`, `name`, `versionNumber`, `releaseType`
  (release/beta/alpha), `gameVersions[]`, `loaders[]`, `publishedAt`, `downloadAvailable`,
  `files[{fileName, size, hashes:{sha1?, sha512?}, primary}]`,
  `dependencies[{projectId?, versionId?, fileName?, type: required|optional|incompatible|embedded}]`.
* **Question:** the draft makes search a durable operation. A plain read reply (like `mods.list`)
  would make typing in the search box responsive. Can search and versions be reads, with only
  downloads as operations?
* **Why:** the draft says what the result contains but not its field names. Guessing names would
  create the competing protocol we're asked to avoid.

### R4. `plans.prepare` / `plans.evaluate` result schema
* **Workflow:** Review: the exact list of what will be installed, removed or updated, with
  dependencies and warnings. Apply submits `operationId` + `planDigest` from this.
* **Fields:**
  * `items[{action, inventoryFileName?, provider?, projectId?, fromVersionId?, toVersionId?,
    targetFileName?, size?, sha256?, reason: requested|dependency}]`
  * `dependencies[{for, projectId, versionId?, type, status: satisfied|added|missing|incompatible|unverified}]`
  * `warnings[{code, subject?, message}]`
  * `unsupported[{change index, code, message}]`
  * `affectedFiles[{path, kind: config|jar|index, userModified}]`
  * `planDigest`, `instanceRevision`, `expiresAt` (the prepared-plan expiry the draft leaves unresolved)
* **Question:** how is an **update** expressed? As `install` with a new `versionId` plus the
  `inventoryId` it replaces, or as a separate action? The draft's action list has no `update`.
* **Why:** without an item schema the Review screen cannot show the exact plan the user is
  confirming, so Apply stays disabled.

### R5. Mod metadata beyond the `.index` claim
* **Workflow:** dependency review, "multiple mod IDs in one JAR", bundled (jar-in-jar) dependencies.
* **Fields per inventory item (or a `mods.details {physicalId, fileName}` read):** declared
  `modIds[{id, version}]` from fabric.mod.json / quilt.mod.json / mods.toml / neoforge.mods.toml,
  `dependencies[{modId, versionRange, kind: required|optional|incompatible|breaks}]` and
  `embedded[{modId, version}]`.
* **Why:** 1.0 doesn't read JAR manifests, so dependency status can only be "unknown". The UI
  currently shows exactly that.

### R6. Update availability
* **Workflow:** Updates screen, bulk "update selected", pins and exclusions (pins and exclusions stay Manager-side).
* **Needed:** a batched read such as `providers.updates {physicalId, releaseTypes[]}` returning,
  per indexed inventory item, the newest compatible version (R3 version shape). Otherwise the
  Manager makes 300 `providers.versions` calls for a 300-mod pack.

### R7. `operations.list`
* **Workflow:** History; reattaching after a Manager restart; operations started elsewhere.
* **Fields:** `{offset?, limit?, physicalId?}` →
  `operations[{operationId, kind, physicalId?, state, terminal, createdAt, updatedAt, progress?, summary?}]`
  plus paging. `progress` (0..1) and `createdAt`/`updatedAt` would also help in `operations.get`.
* **Why:** until then the Manager keeps a local list of operations it submitted (`shortcut:` in
  LauncherClient.ts). That list misses operations started from the Launcher or another Manager window.

### R8. `recovery.list` result wrapper and record fields
* **Workflow:** History → Recovery: "an interrupted change needs recovery", with a Roll back button.
* **Fields:** `{records:[{operationId, physicalId, phase, allowedActions[], createdAt, message}]}`.
* **Why:** the draft names the record fields but not the result key or types.

### R9. Read-only content listing (Files & overrides)
* **Workflow:** Files screen: config, defaultconfigs, kubejs, scripts, resourcepacks, shaderpacks, with user modifications flagged.
* **Needed:** `content.list {physicalId, area, offset?, limit?}` →
  `entries[{path, kind, size, modifiedMs, sha256?, origin: pack|user|unknown, modifiedSinceBaseline}]`.
  `area` is a fixed enum, never a caller path.
* **Why:** the Manager host has no file access by design, so this screen is unavailable.

### R10. Upstream modpack baseline
* **Workflow:** modpack updates that keep locally added mods and changed configs.
* **Needed:** a pack link per instance (`provider, packId, versionId`) and the baseline file list
  with hashes. Then a prepare variant that takes a target pack version and reports three-way
  conflicts (upstream old / local / upstream new). Unknown and manual files are never deleted
  automatically.
* **Also for Packs:** `packs.search`, `packs.versions`, `packs.install` (new instance from a pack), same shapes as R3.

### R11. Export
* **Workflow:** Export → .mrpack / CurseForge ZIP.
* **Needed:** an export operation that runs on a consistent snapshot under the gate, for example
  `exports.create {idempotencyKey, physicalId, format, name, version, includeAreas[], excludeFileNames[]}`.
  Its result lists `entries[{fileName, status: provider-reference|bundled|excluded|blocked, reason}]`
  and the output location.
* **Open question:** who chooses the destination? The draft forbids caller paths for create.
  Export needs either a Launcher-side save dialog or an allowed, validated destination outside the
  instance roots.
* **Why:** an export needs per-file sha1/sha512, sizes and download URLs (1.0 omits URLs and
  hashes), plus override contents. The Manager can't read instance files.

### R12. Lifecycle
* **Current Manager behaviour:** a **Start Awake Launcher** button (only on user click). It starts
  `awakelauncher.exe` from a discovered installation with no arguments, then waits for the endpoint.
* **Requests:**
  * A documented way to tell "this Launcher build has no integration" apart from "not ready yet".
    For example, a stable executable version resource or a CLI flag that prints the supported protocol.
  * If a minimized or tray start becomes supported, a documented argument for it.
  * For `--dir` profiles, confirm that `awakelauncher.exe --dir <dataRoot>` is the supported way
    to start a specific profile.

### R13. Create or update a Launcher instance from a Manager project (standalone architecture, D4)
* **Workflow:** Projects → "Play in Awake Launcher". A Manager-only draft becomes a playable instance,
  and the Launcher stays its only writer.
* **Needed:** an operation such as
  `instances.importPack {idempotencyKey, archive: {kind:"mrpack", bytesBase64 | stagedToken}, name?, targetPhysicalId?}`.
  * With `targetPhysicalId` set, it updates an enrolled instance through the normal prepare/review flow (R4).
  * The Launcher validates the archive, downloads, verifies the hashes and owns every file write.
* **Open questions for Codex:**
  * How should the archive cross the pipe? The frame limit is 1 MiB, so a large pack needs
    chunking or a Launcher-readable staging location chosen by the Launcher, not a caller path.
  * Should override contents travel in the same archive?
* **Why:** without it, a standalone project reaches the Launcher only through the user exporting a
  file and importing it by hand.
