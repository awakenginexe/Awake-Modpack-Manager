# Integration with the Awake Launcher coordinator

**Status: provisional.** No live integration exists. The Manager runs against `MockBackend`.
`LauncherClient` refuses every call until the real contract lands. Codex owns that contract
on `feat/modpack-manager-integration`. When it arrives, the Manager adapts to it. These types
are not a competing proposal.

## Boundary

```
Vue views ──► state/session.ts ──► ManagerBackend (interface)
                                     ├─ MockBackend     (fixtures, in-memory, tests)
                                     └─ LauncherClient  (BLOCKED: real coordinator)
```

* Components never see transport details (framing, sockets, QWebChannel, Tauri `invoke`).
* Everything the Manager needs is in `src/backend/ManagerBackend.ts`; the data shapes are in
  `src/backend/contract.ts` and marked `PROVISIONAL`.
* Swapping the shell (Tauri or Qt WebEngine) only means writing a new `ManagerBackend`
  implementation. No view changes.

## What the Manager owns vs. what it needs

| Manager (this repo) | Coordinator (Launcher) |
|---|---|
| UI, workflows, drafts, pins, review | Instance discovery and metadata |
| Export include-lists, preferences | All mod/config file mutations |
| Operation history display | Transactions, backup, recovery, locking |
| | Provider queries, dependency resolution, launching |

The Manager **never** writes `instance.cfg`, `mmc-pack.json`, `mods/*.jar`, `mods/.index` or
config/content files. When a capability is missing, the feature is disabled and the UI shows
"Awake Launcher does not support this yet". There is no filesystem fallback.

Manager-local storage (`localStorage`, key prefix `awake-mm:`): drafts per instance, pins per
instance, export include-lists, locale, reduced-motion, the pending-apply idempotency key.

## Capabilities the Manager negotiates

Sent by the coordinator in the handshake (`Handshake.capabilities`). Each gates a feature:

| Capability | Used for |
|---|---|
| `installations.discover` | Find Awake Launcher installations (portable and installed) |
| `instances.list` | Instance Library |
| `instances.create` | "Create instance" (the coordinator creates it; it appears in both apps) |
| `mods.inventory` | Mods screen: per-mod source, versions, dependency state, `revision` |
| `providers.search` | Browse (per-provider availability in `Handshake.providers`) |
| `plan.validate` | Resolve a draft into a plan (dependencies, conflicts, pins) |
| `plan.prepare` | Re-resolve under the instance gate right before apply |
| `plan.apply` | Start the transaction |
| `operations.watch` | Progress events and `getOperation` |
| `operations.cancel` | Cancel while `cancellable` |
| `operations.reconnect` | `findOperationByIdempotencyKey` after a lost reply |
| `recovery.status` | Backups and pending recovery |
| `files.read` | Read-only listing of config/kubejs/etc. |
| `export.mrpack`, `export.curseforge` | Distribution check and export job |
| `launch.request` | "Open in Awake Launcher" |
| `packs.search` | "Get modpack": search packs and list versions (`Handshake.packProviders`) |
| `packs.install` | Install a pack version as a new instance; `result.instanceId` names it |

## Modpack sources and provider API keys

"Get modpack" covers the same sources as the Launcher's existing pack catalog
(`launcher/awake/web/AwakePackCatalog.cpp`): **Modrinth, CurseForge, FTB, ATLauncher, Technic**.
The Launcher's local imports (FTB App, legacy FTB, zip/URL) are not exposed yet.

The Manager **holds no provider API keys**. Search, versions, download and install all run in
the Launcher. Its CurseForge key is already injected at build time from the GitHub secret
`AWAKE_CURSEFORGE_API_KEY` (`.github/workflows/awake-build.yml` → `-DLauncher_CURSEFORGE_API_KEY`
→ `BuildConfig.FLAME_API_KEY`). So the key exists only as that secret and in the Launcher's
compiled binary, never in this repo or the Manager's JavaScript bundle. An unkeyed Launcher
build reports CurseForge as `available: false, unavailableReason: 'curseforge-unauthorized'`,
and the Manager shows "CurseForge needs to be set up in Awake Launcher".

Installed instances carry `InstanceSummary.pack` (provider, pack id, version), which is what a
future "update from upstream pack" plan will diff against.

To test CurseForge locally, build the Launcher with the test key (`-DLauncher_CURSEFORGE_API_KEY=…`
or its Settings → Services field). The Manager needs no change.

## Safety assumptions the coordinator must uphold

These are what the Manager's flow depends on. Each needs confirming against the real contract.

1. **Revisions.** Every instance has an opaque `revision` that changes on any content change.
   A draft records `baseRevision`. Validation rejects a stale base (`stale-revision`).
2. **Plan identity.** `validateDraft` returns `planId` and `planHash`. `applyPlan` must carry
   both, and the coordinator refuses a hash it did not produce for that plan.
3. **Prepare can change the plan.** `preparePlan` re-resolves (e.g. under the exclusive instance
   gate). If the hash changes, the Manager stops and shows the new plan for confirmation.
4. **Baseline re-check.** Before mutating, the coordinator re-validates the baseline under its
   exclusive gate. The Manager cannot do this and does not try.
5. **Accepted ≠ succeeded.** `applyPlan` returns an `operationId`. The Manager follows it to a
   terminal state (`completed`, `cancelled`, `rolled_back`, `needs_attention`).
6. **Idempotency.** Mutating requests carry a client `idempotencyKey`. If the reply is lost, the
   Manager asks `findOperationByIdempotencyKey` after reconnecting. It does not resend Apply.
   If no operation exists, the user is told and must re-review.
7. **Events may be lost.** The Manager polls `getOperation` as a safety net and re-reads on
   reconnect, ignoring out-of-order events by `updatedAt`.
8. **Unknown files are kept.** Files without provider metadata stay visible and are never removed
   unless the user removes them explicitly (marked destructive, requires acknowledgement).
9. **Pins are Manager policy.** The Manager sends `pinnedKeys` with every validation. The
   resolver must not update pinned mods.

## Proposed operation states

`preparing → waiting → applying → verifying → completed`, with `cancelled`, `recovering →
rolled_back`, and `needs_attention` as other outcomes. These are proposals, not proof of what
the Launcher supports.

## Open questions for the contract (decisions needed)

* Transport and framing (named pipe / local socket / Qt Remote Objects / other), and auth
  between two local processes.
* How the Manager discovers installations (portable installs, multiple installs).
* Whether provider search/resolution runs in the coordinator (assumed, so there is no second
  provider engine in the Manager).
* CurseForge API authorization: who holds the key, and how availability is reported.
* Export: does the coordinator write the archive (assumed), and where?
* Whether `files.read` will grow a safe write/override API, and with what transaction semantics.
* Upstream modpack updates: how local customisations are diffed and presented as a plan.
* Event delivery guarantees and operation retention (how long `findOperationByIdempotencyKey`
  can find an old operation).

## Mock scenarios (dev only)

Open the dev build with `?mock=` and comma-separated flags:

* `drift`: the plan changes during prepare, so you can see the renewed-confirmation flow
* `fail`: apply fails during verification and rolls back
* `cf`: CurseForge is reported as available
