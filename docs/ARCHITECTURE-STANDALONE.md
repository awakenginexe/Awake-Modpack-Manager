# Standalone Manager architecture

**Status: review of Codex's shared-core feasibility results. Nothing is implemented yet.** This
document replaces the earlier "option 2, split ownership" recommendation. That option kept
standalone mode to drafts and a second provider engine; both are now ruled out by the owner's
decisions D1, D3 and D6.

* Reviewed: Awake Launcher `feat/modpack-manager-integration` at
  `91d348625d9d0ff431ecf98092678f7efe0bb597`, specifically `docs/modpack-manager/handoff.md`,
  "Shared-core feasibility" and "Proposed Tauri host interface".
* Compared with: Manager `e571545`.
* The IPC contract pin is still `d3e6731a8`. The new commits change no schema.

## 1. Assessment

**I agree with the shared native core, delivered to the Manager as an on-demand helper process
over IPC.** The feasibility evidence answers the main objections I raised against option 1:

| Earlier objection | Evidence at `91d348625` | Remaining gap |
|---|---|---|
| Qt in the Tauri process; C++ FFI | Not needed. The core runs as a separate `QCoreApplication` helper. The Rust host talks to it over the same pipe framing the Manager already uses. A separate Rust caller verified this. | Not yet tested from the real Tauri app or its installer. |
| Size (I estimated 25-40 MB) | Measured subset: 0.28 MiB executable, 12.24 MiB unpacked, 4.67 MiB zipped. Startup median 148 ms (5 runs). About 3 MiB private memory in one idle sample. | Excludes provider, catalog, archive and creation services, and the MSVC runtime. It is a lower bound. |
| Two transaction engines | One: the Launcher's `TransactionEngine`, `OperationStore` and lease, compiled unchanged. | Expected post-plan revision bug (handoff step 1) must be fixed before Apply. |
| Licence | Not resolved. The helper is GPL-3.0-only code. See section 5. | Owner and legal decision. |

What the evidence does **not** establish, so the Manager treats none of it as available:

* **Ownership authority is broken across registries.** Two callers that pick different
  registries can both hold a lease on one physical instance. Codex reproduced this
  (non-writing). Until one per-user namespace is enforced, no Manager write can be enabled.
* **No real provider files were installed.** Staging was tested only against a loopback artifact.
* **No production enrollment, native quiescence or startup recovery.** Native model quiescence
  and recovery-before-startup aren't integrated.
* **No creation, import or export service.** These are still tied to `Application` and the GUI
  models (handoff service-boundary table).
* **The helper was not run under Tauri's process model, NSIS installer or upgrade path.**

Conclusion: the direction is sound, and **none of the helper's capabilities are ready to
enable.** The Manager can prepare without waiting (see milestone M0 in section 6). It should not
build anything that duplicates the core.

## 2. Compatibility of the helper with Tauri 2

| Area | Fit | What has to change in the Manager |
|---|---|---|
| Framing | Same 4-byte BE length + JSON ≤ 1 MiB, one request in flight. `pipe.rs` `encode_frame` and the read loop reuse unchanged. | None. |
| Server identity | `pipe.rs::verify_server` already checks pipe server PID == descriptor PID and same user SID. | For the helper, also require PID == the child the host spawned (or the helper's descriptor) **and** that the server image path is the bundled helper (`QueryFullProcessImageNameW`). A same-user process then can't pose as the helper. |
| Pipe-name allowlist | `valid_server_name` accepts only `awake-manager-v1-<hex/->`. | Add a second, explicit prefix **only once Codex commits it in the schema**. Keep the allowlist so the web view can't open arbitrary pipes. |
| Role and hello | `LauncherClient` checks `installationId/profileId/sessionId` against the Launcher descriptor. A core host "must not impersonate Launcher". | A role-aware hello, from the negotiated extension (role, core/storage compatibility, instance authority, ownership generation). The new client shares the operation code with `LauncherClient` rather than copying it. |
| Operations | The Manager already has the operation flow the core uses: idempotency keys, resending an identical request after a lost reply, strict `parseOperation` with `rolling_back`, following to `isSettled`, and `recovery_required`. | Reused as-is. It's driven by the helper's capabilities instead of the Launcher's. |
| Spawning | The host already spawns a process narrowly (`start_launcher`: a discovered exe, no args, no shell). | New `ensure_backend` / `probe_backend` commands (Codex's proposal). See below. |
| Packaging | Tauri `bundle.resources` can carry a folder (`core-host/windows-x64/` with the exe, Qt DLLs, plugins and `qt.conf`). | Use **resources plus `std::process::Command`, not `externalBin` with the shell plugin.** `externalBin` wants a single target-suffixed binary, not a folder with DLLs. The shell plugin doesn't expose Windows creation flags (breakaway from job), and it kills children spawned from JavaScript when the app exits, which breaks "never kill accepted work on UI exit". |
| Large payloads | 1 MiB frames can't carry a 300-mod pack or override folder. | Import: the user picks a file in a native dialog. Rust copies it into a helper-owned inbox (size-capped, SHA-256) and passes a source token. Export: the helper writes to its outbox, and Rust moves the result to the native Save As target (D7). Neither direction passes a caller path, matching Codex's "staged upload/source tokens". |

**Rust command sketch.** This is Codex's proposal; the final shapes come from the committed schema.

* `ensure_backend({profileToken}) -> {state, descriptor?, message?}`
  * `state` is one of: not_installed, starting, ready, incompatible, recovery_required,
    interaction_required.
  * `profileToken` maps to a profile the host has already validated. It is never a path.
* The host resolves `<resource_dir>/core-host/windows-x64/<helper>.exe` and refuses symlinks and
  anything outside the resource dir.
* It starts the helper with:
  * `CREATE_NO_WINDOW`, and `CREATE_BREAKAWAY_FROM_JOB` where the job allows it, so a parent job
    with kill-on-close can't take accepted work down with the UI;
  * stdin closed and logs going to a private file. Codex saw a hang when stdout was captured.
* Readiness comes from the descriptor plus hello, never from stdout.
* A second Manager window or a racing call relies on the helper's own single-owner lock and then
  connects to the existing helper.

**Lifecycle (proposal, needs D-H1):**

* The helper owns its lifetime. It exits on its own after an idle period with no client and no
  unsettled operation.
* The Manager never kills it: not on window close, pipe loss or a frontend timeout.
* A crash shows up as `recovery_required` on the next `ensure_backend`, and the helper runs
  recovery before serving anything.

## 3. Changes required in the Manager

**Backend (TypeScript):**

* Pull the operation code out of `LauncherClient.ts` into a shared module: submit/read, the
  known-operation list, resend, error map. Then add a `CoreHostClient` that implements
  `ManagerBackend` against the helper.
* **Route by instance authority.** Each instance and workspace carries an authority from the
  negotiated extension: the Launcher (models loaded), the helper, or unavailable. The UI sends a
  request only to the current authority. A lost connection never changes the authority.
* **Projects become helper-owned workspaces.** `src/state/projects.ts` keeps the UI state, while
  the data, files and history come from the helper. Local drafts get a one-time, user-started,
  non-destructive migration: create a workspace from the draft, then resolve and download. The
  localStorage copy is kept until the user confirms.
* **The core is authoritative for import and export.** `zip.ts` and `packFormats.ts` stay as a
  UI-side preview only until the helper exposes an import preview, then they are deleted. Two
  parsers that drift apart would let a preview disagree with what gets installed. `buildExport`
  is replaced by the helper's export, which has the override contents, hashes and distribution
  rules.

**Host (Rust):**

* `ensure_backend`/`probe_backend`, plus helper-identity checks, an allowlist entry and
  inbox/outbox token commands.
* A native Save As dialog for exports (D7). It needs `tauri-plugin-dialog`, and the move from the
  outbox is the host's one write path, limited to the chosen file.

**Packaging:**

* Add the helper folder to `bundle.resources`.
* Ship the Qt and third-party notices, an SBOM and the source offer.
* Ship the MSVC runtime in a form that works with the current **per-user** NSIS install (D-H2).
* Have the installer stop or wait for a running helper before replacing its DLLs. Windows locks
  loaded DLLs, and a mixed old/new helper must never serve.
* Code-sign both executables before any public build. An unsigned helper started in the
  background is a likely SmartScreen or antivirus trigger.

**No change:**

* the Launcher 1.0 read client;
* discovery;
* `Start Awake Launcher`;
* the mock/demo backend;
* the UI separation of projects, Launcher instances and demo data.

## 4. Shared ownership and recovery concerns

1. **One authority, independent of start order.** The per-user ownership namespace must be
   **outside both products' data roots and installation folders**. Otherwise the Manager's
   helper and the Launcher can each pick "their" registry, which is the counterexample Codex
   found.
   * Its location and format are Codex's to define.
   * Its compatibility version is checked by both products. A newer storage format makes an
     older core read-only (`incompatible`), never writable.
2. **Mixed versions.** The Manager and the Launcher will ship different core builds. Each request
   needs a core/storage compatibility handshake, and each enrolled instance needs an ownership
   generation. Downgrading or unenrolling is blocked while a game or recovery record is
   unresolved (handoff milestone 4).
3. **Detached Minecraft.** A game launched by the Launcher can outlive it. The Manager helper must
   honour the keeper certificate. If the evidence is missing or unknown, the answer is "blocked",
   never "writable".
4. **Crashes and disconnects.** These never transfer ownership. A helper crash mid-Apply leaves a
   recovery record, and the next start rolls back or completes before anything is served. The
   Manager shows `recovery_required` and offers only the actions the record allows (R8).
5. **User-selected storage (D2).** If a user picks a folder that is, or sits inside, a Launcher
   instance or data root, it must go through enrollment, or be refused. The Manager must not
   decide this by path matching alone; the core's physical identity (volume + file id, junctions
   resolved) decides.
6. **Manager-side pins and exclusions.** These are intent. The authority persists them and
   reconciles them with native locks (Codex's R5-R6 note). The Manager never writes them into
   instance metadata itself.

## 5. Licensing and distribution concerns

* **The helper is GPL-3.0-only.** It is compiled from Launcher sources.
  * Shipping it inside the Manager installer means meeting GPL-3.0 for the helper: source for
    that exact build, licence text and build instructions.
  * Whether the Manager UI is a separate work ("mere aggregation") or a combined work isn't
    settled by using IPC. The helper is purpose-built for the Manager and exchanges
    Manager-specific structures (GNU FAQ, cited in the handoff).
  * The simplest safe route is **licensing the Manager GPL-3.0** (D-L1). That also settles the
    GPL provider logos in `docs/LICENSING.md`. Otherwise this needs legal review before any
    public build.
* **Qt (LGPLv3 modules, dynamically linked):**
  * ship the licence and notices;
  * keep the Qt DLLs replaceable (app-local, not static);
  * provide a source path.
* **MSVC runtime.** Only redistributable files, from the official redistributable, may ship. The
  per-user installer can't run `vc_redist.x64.exe` without elevation. See D-H2.
* **CurseForge.** If provider services move into the helper, so does the API key: a build-time
  secret injected into the helper build, never in source and never sent over IPC.
  * An independently distributed Manager needs its own CurseForge permission to use the key and
    download files.
  * Each file's distribution permission must still be honoured; files whose authors disallow
    distribution are never exported.
  * This is unverified (D-L2).

## 6. Staged Manager plan, aligned to Codex's milestones

| Manager stage | Runs alongside Codex | Manager work | Exit evidence |
|---|---|---|---|
| **M0** (no dependency on Codex) | Codex milestone 1 | <ul><li>Native Save As export (D7).</li><li>Pull the operation code out of `LauncherClient` into a shared module.</li><li>Add `schemaVersion` to drafts.</li><li>Packaging spike with a **Manager-written stub** helper (not Codex probe code): resources folder layout, per-user NSIS install, `CREATE_NO_WINDOW` + breakaway, survives UI exit, upgrade while running, uninstall.</li></ul> | Unit and Rust tests; installed-build checks on a disposable profile. Nothing writes instance data. |
| **M1** | Codex milestones 1-2 (kernel authority, service contexts) | <ul><li>Review the namespace and compatibility design.</li><li>Contribute cross-product test cases (start orders, crash, missing records, mixed versions).</li><li>No client code against uncommitted APIs.</li></ul> | Agreed scenario list in both repos. |
| **M2** | Codex milestone 3 (standalone materialized packs) | Against a **committed, pinned** helper contract: <ul><li>`ensure_backend`/`probe_backend`</li><li>`CoreHostClient`</li><li>workspaces (create, import by token, provider search, install, update, remove, pins, overrides, export via outbox)</li><li>draft migration</li><li>recovery UI</li></ul> | Real 300-mod create/install/update/export on private profiles with the Launcher **absent**; fault injection during apply. |
| **M3** | Codex milestone 4 (host/Launcher/Tauri coordination) | <ul><li>Authority routing.</li><li>Helper identity checks.</li><li>Ownership transfer and enrollment UI.</li><li>R13 handoff.</li><li>Reconnect after UI exit.</li><li>Installer with the helper, runtime and notices.</li></ul> | All three scenarios (Launcher only, Manager only, both) on separate private profiles, using an agreed pin, profile and shutdown owner. |
| **M4** | Codex milestone 5 (joint acceptance) | <ul><li>Measured Manager-only budgets: installer size, first-search latency, idle memory, helper startup in the real app.</li><li>Clean-machine install.</li></ul> | Measured numbers only. Features stay opt-in until accepted. |

Each stage keeps writes off until its capability is advertised. Rolling a stage back means turning
off the capability, never deleting journals.

## 7. Decisions needing approval

Owner decisions D1-D7 from the latest brief are taken as given. These are new or narrower:

* **D-W1. What a workspace is on disk.** I recommend the **native instance layout written by the
  shared serializers** (instance.cfg, mmc-pack.json, `mods/` with `.index`), plus a versioned
  Manager project sidecar.
  * A workspace is then a real playable instance that can be enrolled into the Launcher in place.
  * The alternative is a separate Manager-only source format, which always needs a copy to play.
* **D-W2. R13 meaning.** With D-W1, R13 becomes "enroll an existing workspace into the Launcher by
  physical identity". Copy-import from `.mrpack` is a fallback for a different machine or
  profile. Codex already notes that R13 copy-import must not be the required path for sharing.
* **D-H1. Helper lifetime.**
  * The helper decides when to exit: idle with no client and no unsettled operation.
  * The Manager never kills it.
  * The installer waits for or stops it, and refuses to overwrite a running helper.
* **D-H2. MSVC runtime with a per-user install.** Choose one:
  * ship the redistributable runtime DLLs app-local, next to the helper and the Manager (no
    elevation; recommended);
  * bootstrap `vc_redist` (needs admin);
  * switch to a per-machine installer.
* **D-H3. Where Manager-only data lives.**
  * Helper data root: proposed `%LOCALAPPDATA%\AwakeModpackManager\core`.
  * Default workspace root: proposed `%LOCALAPPDATA%\AwakeModpackManager\projects`, with
    user-selected folders (D2).
  * The shared ownership namespace is defined by Codex, outside both products.
* **D-L1. Manager licence.** GPL-3.0 (recommended with a bundled GPL helper), or another licence
  after legal review of aggregation.
* **D-L2. CurseForge.** Confirm the key and download terms for an independently distributed
  Manager, and that the key is injected only into the helper build from the GitHub secret.
* **D-R1. Retiring TypeScript import/export.** Approve deleting `zip.ts`/`packFormats.ts`/
  `buildExport` once the helper's preview and export are pinned, so there is one parser.

## What exists today (unchanged by this review)

* Launcher 1.0 read client; discovery; `Start Awake Launcher`; draft-method adapters, all off
  until advertised.
* Local project drafts, safe ZIP reading, `.mrpack`/CurseForge import preview, verified-data
  export (`src/domain/{zip,packFormats,project}.ts`, `src/state/projects.ts`,
  `src/views/ProjectsView.vue`).
  * These are transitional: they don't install anything, and they are superseded by the helper
    under D-R1.
