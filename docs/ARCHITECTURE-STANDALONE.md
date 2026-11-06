# Standalone Manager architecture: recommendation

**Status: proposal awaiting approval.** No migration has been implemented. What exists today is
listed in "Built so far, safe under any option" at the end.

## The requirement

| Scenario | What must work | Who writes playable instance files |
|---|---|---|
| Launcher only | Play Minecraft; no measurable cost from the integration | Launcher |
| Manager only | Create, plan, import, export and maintain modpacks; install and update mods | **Decision D1** |
| Both | Shared instances, Launcher profiles, coordinated changes, launch through the Launcher | Launcher only |

The hard rule is that two uncoordinated writers never modify the same live instance.

## What the Launcher already has (read from its worktree, commit `6ea0bbe99`, not exposed over IPC)

* Internal foundations: a durable idempotent operation store, private recovery storage, strong
  volume/file identities, a **cross-process physical lease**, a recoverable multi-file executor,
  game-process ownership that survives a Launcher exit, and ResourceAPI provider callbacks.
* All of it is C++/Qt inside the GPL-3.0 Launcher, and none of it is a public capability yet.
* The IPC contract is still the read-only protocol 1.0, pin `058714ec7`.

## Options compared

1. **Shared native core.** Extract the Launcher's transaction, lease and provider code into a
   library that both apps ship.
2. **Split ownership.** The Manager owns its own *project workspaces*, which are never Launcher
   instances. Launcher-managed instances are changed only through Launcher IPC.
3. **Manager is IPC-only.** A headless Launcher backend does all writes, including for Manager-only users.

| | 1. Shared native core | 2. Split ownership (recommended) | 3. IPC-only |
|---|---|---|---|
| Windows packaging | Manager ships Qt 6 runtime (~25-40 MB) plus a C++ library built with the Launcher's CMake/MSVC toolchain inside the Tauri build | Unchanged: Tauri + Rust host, about 1.5 MB installer | Manager-only users must install a Launcher backend anyway, which breaks scenario 2 |
| Licence | Linking GPL-3.0 Launcher code makes the Manager GPL-3.0 | Independent. The Manager can choose any licence | Independent |
| Instance ownership | Both apps can write the same instance, coordinated by the shared lease. Correct only while both run the same core version | Disjoint by construction. Manager workspaces are not instances, and Launcher instances are written only by the Launcher | Single writer |
| Filesystem transactions | One implementation (the Launcher's executor) | Two implementations, on disjoint data. The Manager's is simpler: workspaces are not played, so there is no game process, no PackProfile timer and no legacy writers | One |
| Recovery | Shared journal format, which both apps must understand at startup | Each app recovers only its own data. Workspace recovery is a small journal of staged downloads | One |
| Provider integration | Shared ResourceAPI (Qt network stack) | The Manager needs its own provider client for standalone mode (**D3**). With the Launcher present, provider calls can go through IPC | Launcher only |
| Performance (Launcher-only users) | Risk: a shared core changes Launcher internals both apps depend on | No effect: the Launcher is unchanged when the Manager is absent | Background service cost |
| Cross-process locking | Shared OS lease on the same instance | The Manager takes an exclusive OS file lock on its own workspace. It refuses workspace paths inside any discovered Launcher instance root, and the Launcher never scans workspaces | Lease inside the Launcher |
| Fit with current code | Large migration: new native build, FFI, and Qt in the Tauri process | Small: keeps `ManagerBackend`, LauncherClient and the Rust host; adds a workspace store | Needs a no-window Launcher mode, which Codex marks unsupported |

**Recommendation: option 2, split ownership.**

* It meets "never two uncoordinated writers" by **partitioning data, not by sharing locks**. A
  Manager workspace is a modpack *source*: manifest, plan, pins, overrides and a download cache.
  It isn't a playable instance.
* Playing a Manager project goes through the Launcher. The Manager hands it a verified
  `.mrpack`, or asks over IPC to create or update an instance from it, and the Launcher stays its
  only writer. Without the Launcher, the user exports the `.mrpack` and imports it into any launcher.
* It adds nothing to Launcher-only installs, keeps the Manager's 1.5 MB footprint and licence
  freedom, and reuses every adapter that exists today.

**What option 2 costs:**

* A second (Rust) provider client and a small workspace transaction layer for Manager-owned files.
* A defined handoff from workspace to Launcher instance (request R13). Until that exists, "play
  this project" means export then import.

## Workspace design (option 2)

* **Location:** `%LOCALAPPDATA%\AwakeModpackManager\projects\<id>\` by default, or a folder the user
  chooses. The Manager refuses folders inside a discovered Launcher instance root or data root.
* **Contents:**
  * `project.json`: the Manager project model (`src/domain/project.ts`)
  * `overrides\`: config and other override files
  * `cache\`: hash-verified provider downloads
  * `.journal`
* **Locking:** an exclusive Windows file handle on `<workspace>\.lock` while the Manager has the
  project open. A second Manager window opens the project read-only.
* **Transactions:** stage in `<workspace>\.staging`, verify the hashes, rename into place, and journal
  the intent first. It only touches workspace files, never `instance.cfg`, `mmc-pack.json` or mods
  in a Launcher instance.
* **Import:** a `.mrpack` or CurseForge ZIP becomes a workspace. Overrides are copied into
  `overrides\` after the path checks below. Mods are recorded by provider ID and hash, then
  downloaded into `cache\`.
* **Export:** `.mrpack` and CurseForge manifest ZIP files are built from verified project data.
  Provider-hosted files are referenced, never bundled.

## Decisions that need your approval

* **D1. Ownership model.** Adopt option 2: Manager-owned workspaces, and Launcher instances changed
  only through the Launcher.
* **D2. Workspace format and location.** The Manager's own `project.json` with
  `overrides\`/`cache\`, under `%LOCALAPPDATA%\AwakeModpackManager\projects`. The alternative is
  packwiz (`pack.toml`), which interoperates with other tools but costs more to map.
* **D3. Standalone provider client.** The Manager calls the Modrinth and CurseForge APIs directly
  when the Launcher isn't connected. The CurseForge key stays a build-time GitHub secret, as you
  specified earlier. With the Launcher connected, should provider calls go through the Launcher
  (R3) or always through the Manager? Recommended: always through the Manager, so search behaves the
  same in both scenarios. Downloads into a *Launcher* instance always go through the Launcher.
* **D4. Play handoff (R13).** Ask Codex for an IPC method that creates or updates a Launcher
  instance from a Manager-produced `.mrpack` (Launcher-side validation; no caller paths into
  instance roots).
* **D5. Licence.** Option 2 keeps the Manager independent of GPL-3.0. Choose the Manager's licence,
  noting the GPL provider logos in `docs/LICENSING.md`.
* **D6. Manager-only "install into a playable instance".** Under option 2, a Manager-only user
  installs by exporting to a launcher. If you want the Manager to produce its own playable
  instance without any launcher, that is a third writer category and reopens option 1. Not
  recommended.

* **D7. Export save location.** Today an export downloads through WebView2 straight into
  `Downloads`, with no dialog (verified in the desktop build). A native Save As dialog needs the Tauri
  dialog plugin plus one narrowly scoped host command that writes the chosen output file. That
  file is not instance data, but it is the host's first write path, so it needs your approval.

## Built so far, safe under any option

* Manager project model and local draft persistence (`src/domain/project.ts`,
  `src/state/projects.ts`). The data is Manager-local; nothing is written to disk outside the
  app's storage.
* Safe ZIP reading (`src/domain/zip.ts`):
  * entry-count, size and ratio limits
  * no ZIP64, encrypted or unknown methods
  * rejects traversal, absolute paths, drive letters, alternate data streams, reserved Windows
    names, trailing dots/spaces, case-insensitive duplicates and control characters
  * CRC and size verification after inflating
* `.mrpack` and CurseForge manifest parsing into a non-destructive import preview
  (`src/domain/packFormats.ts`).
* Export planning that lists every blocker. A `.mrpack` or CurseForge manifest ZIP is produced
  only when every included mod has verified provider data (hashes, size and download URL for
  `.mrpack`; project and file IDs for CurseForge). Override *contents* aren't stored yet (they need
  the workspace in D2), so exports omit them and say so.
