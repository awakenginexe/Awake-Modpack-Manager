# Integration with Awake Launcher

**Status: read-only integration, protocol 1.0 (experimental), Windows x64 only.** The Manager
also implements the draft operation methods whose fields the contract fully defines. It sends
them only when the Launcher reports them enabled, which it doesn't yet. What the Manager still
needs from the Launcher is in [LAUNCHER-REQUESTS.md](LAUNCHER-REQUESTS.md).

Contract pin: Awake Launcher `d3e6731a8a3d9a668ad6509eb795eb73030c0823` (re-pinned from `058714ec7`: the reserved operation schema gained the nonterminal `rolling_back` state and an enforced terminal flag; 1.0 read payloads and framing are unchanged)
(branch `feat/modpack-manager-integration`), files `docs/modpack-manager/protocol.md`,
`wire.schema.json`, `requests.schema.json`. The Launcher handoff names the same pin. Later Launcher
commits that change only prose or tests don't change this contract. Re-pin explicitly when the
schemas change.

## Architecture

```
Vue views ─► state/session.ts ─► ManagerBackend
                                  ├─ MockBackend                  demo data and tests
                                  └─ launcher/LauncherClient.ts   protocol 1.0 (TypeScript)
                                        └─ PipeTransport
                                             ├─ host transport (Tauri, src-tauri/src/pipe.rs)  desktop app
                                             └─ FakeLauncher / Node pipe                       tests only
```

* **Desktop host (Rust, `src-tauri/`)** is deliberately thin.
  * `discover_profiles` finds Launcher data profiles.
  * `ipc_open` opens `\\.\pipe\<serverName>`. It accepts only `awake-manager-v1-*` names and
    verifies that the pipe server is the descriptor's process and runs as the same Windows user.
  * `ipc_request` writes and reads one 4-byte big-endian length-prefixed frame (at most 1 MiB)
    with a timeout. A timed-out or broken exchange drops that connection.
  * `ipc_close` closes the connection.
  * No fs, shell or HTTP plugins. The host never reads or writes instance files.
* **`LauncherClient` (TypeScript)** owns every protocol rule:
  * hello / version negotiation, and checking the hello IDs against the descriptor
  * the strict envelope and response validation
  * serialized requests (one in flight)
  * paging that echoes `instanceRevision` and restarts on `STALE_INSTANCE`
  * a silent re-hello after the 30-second idle close
  * a 20-second heartbeat
  * error mapping
* A plain browser can't open the pipe. There the Launcher backend reports "needs the desktop app"
  and Automatic mode uses demo data.

## Finding the Launcher

No disk scanning, and no global registry RPC. Candidates, in order:

1. The installer's `HKCU\Software\AwakeLauncher\InstallDir`, resolved like the Launcher:
   `UserData/`, then `portable.txt`, then `data-location.txt` (`normal` / `compact` /
   `custom` + absolute path), otherwise `%APPDATA%\AwakeLauncher`.
2. `AWAKELAUNCHER_DATA_DIR`.
3. The default `%APPDATA%\AwakeLauncher`.
4. Folders the user adds in Settings → Launcher connection: an installation folder (contains
   `awakelauncher.exe`) or a data folder. `--dir` profiles are added this way.

For the chosen profile the host reads `<dataRoot>\integration\v1\endpoint.json`. It refuses links,
files over 16 KiB and missing fields, and retries briefly while the file is being published. The
descriptor is only a hint: hello must return the same installation, profile and session IDs.
Instances are keyed `profileId|physicalId` (never folder ID or UUID alone).

## What is connected to real data

| Screen | Real data | Notes |
|---|---|---|
| Instances | `instances.list` (all pages) + per-instance `mods.list limit=1` count | name, path, identity status, native activity → Ready / Running / Busy / Status unknown; collisions ("Shared folder"), unloaded entries (listing only), Launcher discovery warnings |
| Mods | `mods.list` (all pages, progress shown) | file name, enabled/disabled, size, modified time, provider + project/version from the native index, metadata conflict, folder/linked entries, update lock. Search, filters, sort, selection, virtual list and drawer are unchanged |
| Settings → Launcher connection | `hello` + `launcher.info` | status, executable, protocol, profiles with running state, data source choice |

Not reported by protocol 1.0, so shown as unknown, never invented: Minecraft version, loader,
dependencies, available updates and release type. "Dependency issues" counts only missing or
conflicting dependencies; unknown isn't an issue.

## Draft operation methods (implemented, off until the Launcher enables them)

`operations.get`, `operations.cancel`, `launch.request`, `instances.create` (vanilla) and
`transactions.apply` are implemented exactly as protocol.md's "Reserved operation contract"
defines them. The client maps a capability only when hello reports the method `true`, and
`operations.get` is required first. Operation states are the contract's own values (`queued` …
`completed`, `cancelled`, `failed`, `rolled_back`, nonterminal `recovery_required`). A lost reply is
recovered by resending the identical request with its original `idempotencyKey`. Following polls
`operations.get`, because `events.subscribe` is unavailable. These are tested only against the
fixture Launcher; the real Launcher returns `false` for all of them at the pin.

`plans.prepare`, `plans.evaluate`, `providers.*` and `recovery.*` are not implemented: the draft
leaves their results untyped. See LAUNCHER-REQUESTS.md R3, R4 and R8.

## Starting the Launcher

While waiting for the Launcher, the Library offers **Start Awake Launcher** if discovery knows the
profile's installation (registry `InstallDir` or an added installation folder). The host's
`start_launcher` re-runs discovery and starts only `<installDir>\awakelauncher.exe` for the
installation that resolves to the selected data root. It passes no arguments and acts only on that
click. The Launcher starts normally, and its window may appear. If no endpoint appears within 45 s,
the Manager says the Launcher may be waiting on a dialog, or may be a version without the
integration.

## What stays unavailable (and how it shows)

The Launcher refuses these with `UNSUPPORTED_CAPABILITY`. The client doesn't even send them: it
rejects locally with `unsupported`, and the UI is gated by the negotiated capabilities.

* Create instance, Install modpack, Browse/provider search: disabled, "not supported yet".
* Install / update / remove / enable / disable mods: allowed **only into the local draft**. The
  Mods screen says "Read-only: Awake Launcher can't change mods through the Manager yet". Review
  can't check or apply a plan.
* Apply, operations, cancellation, history events, recovery, files/overrides, export, launch
  requests: disabled.
* The Manager never starts the Launcher on its own, only on the Start button above.

Capabilities the client doesn't implement stay off, even if a future Launcher advertises them.

## Connection states the user sees

| Situation | UI |
|---|---|
| Launcher not running for the profile | "Waiting for Awake Launcher" (amber); checks again every 5 s; connects on its own |
| Launcher exits while connected | "Connection lost. Reconnecting…"; the Mods screen keeps the last inventory labelled "last snapshot from \<time\>, may be out of date" |
| Launcher restarts (new session) | reconnects with hello automatically; data refreshed |
| Profile on a removable/network drive | "This Launcher profile can't be shared" |
| Pipe owner or hello IDs don't match | "Couldn't verify Awake Launcher" |
| Malformed reply / version mismatch | "Awake Launcher sent an unexpected reply" |
| Plain browser | "Live data needs the desktop app"; Automatic uses demo data |

Demo data always shows the banner "You are viewing built-in demo data, not your real instances".

## Data source selection

Settings → Launcher connection → Data source (applies after a restart):

* **Automatic** (default): Launcher in the desktop app, demo data in a browser.
* **Awake Launcher**: always real instances (desktop only).
* **Demo data**: the built-in sample backend (also `?mock=…` in development).

## Testing

| Level | What | Result |
|---|---|---|
| Real IPC (host) | `cargo test live_ -- --ignored` with `AWAKE_MM_LIVE_PROFILE` | discovery, identity check (wrong PID refused), hello, info, list; apply and launch.request refused; no draft method advertised true |
| Real IPC (client) | `tests/live/launcherLive.test.ts` with `AWAKE_MM_LIVE_PROFILE` (Node pipe transport) | 3 fixture instances, 322-entry inventory, 4-page paging, idle-timeout re-hello; no draft capability mapped, none sent |
| Real desktop runtime | Release exe against the feature build, inspected through WebView2 CDP | library, 322-mod Mods view (21 DOM rows), Play gated, Launcher exit → waiting on the same profile → restart → auto-reconnect, Start button with a stale descriptor, Thai layout without clipping |
| Installer | NSIS per-user build, silent install, first launch, uninstall | see "Packaging" below |
| Fixture IPC | `tests/launcherClient.test.ts` (FakeLauncher enforces the schema rules) | 26 tests, incl. the draft operation methods |
| Rust unit | framing (incl. fragmented reads), pipe-name allow-list, data-root resolution (incl. the installer's UTF-16 data-location.txt), descriptor validation, Start target | 8 tests |

Live runs used a temporary profile created under the user folder (the integration rejects folders
writable by other principals, such as the agent sandbox's temp directory). The profile was removed
afterwards. In the latest run, 541 of the 547 instance files were byte-identical afterwards. The
other six were `instance.cfg` and `mmc-pack.json`, which the Launcher rewrote on its own first load
of the hand-written fixtures. Its log shows the INI save 0.4 s after its start, before any Manager
connection, and the scheduled component-list save. The Manager host has no file-write command.

## Packaging

`npm run desktop:build` produces `src-tauri/target/release/bundle/nsis/Awake Modpack Manager_<v>_x64-setup.exe`
(about 1.5 MB). Tauri downloads NSIS and `nsis_tauri_utils` from the tauri-apps GitHub releases on
the first build and verifies their hashes. Checked on Windows 11 x64:

* Per-user install to `%LOCALAPPDATA%\Awake Modpack Manager` (exe and uninstaller), with a Start Menu
  shortcut, an HKCU uninstall entry, publisher "Awake Modpack Manager Contributors", and the app icon.
* WebView2 runtime: the installer downloads the bootstrapper if WebView2 is missing (Windows 11
  already has it).
* First launch opens the Library. With no running Launcher it shows "Waiting for Awake Launcher".
* Uninstall removes the program files, the shortcut and the uninstall entry. A silent uninstall
  keeps the WebView data in `%LOCALAPPDATA%\io.github.awakenginexe.AwakeModpackManager` (local
  drafts and settings). The interactive uninstaller offers to delete it.
* The build is **not code-signed**, so SmartScreen will warn. Signing needs a certificate and is
  a release decision.

To run the live tests yourself:

1. Start the feature-branch Launcher with a test profile:
   `awakelauncher.exe --dir C:\Users\<you>\SomeTestProfile`. The folder must be yours and not
   writable by others; Qt's `bin` must be on PATH for a local CMake build.
2. Run the two live test commands from the table above with
   `AWAKE_MM_LIVE_PROFILE=C:\Users\<you>\SomeTestProfile`.
3. Run `npm run desktop:dev` with `AWAKELAUNCHER_DATA_DIR` set to that folder (or add the folder
   in Settings).

## Next phase (blocked on the Launcher)

The Launcher's reserved operations (`providers.*`, `instances.create`, `plans.prepare/evaluate`,
`transactions.apply`, `operations.*`, `events.subscribe`, `launch.request`, `recovery.*`) are
documented in protocol.md but not enabled. They need the cross-process instance gate, enrollment,
staging, backups and recovery first (see the Launcher handoff). The Manager's existing draft,
review, history and recovery screens are built for that flow and are capability-gated today.
