# Architecture

## Layout

```
src/
  backend/      ManagerBackend interface, PROVISIONAL contract types, MockBackend, LauncherClient stub
  domain/       Pure logic: filtering/sorting, selection, drafts/rebase, operation follower, storage
  state/        session.ts: one reactive store (connection, instances, inventory, drafts, review flow)
  views/        Library, Mods, Browse, Review & apply, Files, History, Export
  components/   VirtualList (fixed-height windowing)
  i18n/         en, th, zh-CN, zh-TW catalogs (typed; a missing key fails the typecheck)
  styles/       Awake design tokens + base components
  ui/           Enum → label helpers
tests/          Vitest (jsdom): domain, mock backend, session flows, i18n, components
```

No router and no state library: seven views and one store do not need them. The store is
provided with `provide/inject`, so tests mount views with their own session.

## Performance choices for 200–300+ mods

* The inventory is a `shallowRef`, so Vue does not deep-proxy every mod.
* Selection is an immutable `Set` swapped on change (one reactive update, not hundreds).
* Draft changes are indexed once per render (`Map` by mod key) so rows are O(1).
* The mod table is windowed (`VirtualList`, 44px rows): about 25 rows are in the DOM
  regardless of list size.
* Provider search is debounced and stale responses are dropped by request id.

The only measurement so far is a sanity test: 50 filter+sort passes over 300 mods average under
16ms each in jsdom. That is not a benchmark. Real profiling needs the desktop shell and real
inventories.

## Desktop shell decision

The frontend is shell-agnostic today and runs as a **frontend-only development build**
(`npm run dev`). No shell has been added yet, deliberately, because the right shell depends on
the coordinator's transport, which is not defined.

| | Tauri 2 + Vue | Qt WebEngine + Vue |
|---|---|---|
| Runtime | WebView2 (ships with Windows 11) | Bundled Chromium |
| Installer size | Small (~10 MB) | Large (~150 MB+ Qt + WebEngine) |
| Link to Launcher | Separate process; Rust talks to the coordinator over a named pipe/socket | Could reuse Launcher C++/Qt code (e.g. `QLocalSocket`, shared client lib) and the Launcher's QWebChannel bridge pattern |
| Toolchain | Rust + Node (both present) | Qt 6 + CMake + MSVC, same as Launcher |
| Lifecycle | Independent app, independent updates | Independent app, but Qt version coupling with the Launcher |
| Risk | A second native language in the family | Heavy build and download for a companion app |

**Recommendation:** Tauri 2, if the coordinator contract is a language-neutral local IPC
protocol (named pipe / socket with JSON messages). Choose Qt WebEngine instead only if Codex
ships the coordinator client as a C++/Qt library (or Qt Remote Objects) that would be costly to
re-implement. Either way only a new `ManagerBackend` implementation is needed.

A third option is hosting the Manager as a window inside the Launcher process. That removes IPC
entirely but contradicts the "separate application" vision and couples release cycles, so it is
not recommended unless cross-process locking proves too hard.

## Review → Apply flow

```
draft (Manager-local, baseRevision)
  └─ validate ──► ResolvedPlan {planId, planHash}         user reviews; destructive needs ack
        └─ prepare ──► same hash?  no ──► show new plan, require confirmation
                         yes ──► apply {planId, planHash, idempotencyKey}
                                   ├─ accepted ──► follow operation to a terminal state
                                   └─ reply lost ──► reconnect ──► find by idempotency key
                                                         ├─ found ──► follow it
                                                         └─ none  ──► "not received", re-review
```

Drafts changed after review mark the plan outdated and block Apply until it is checked again.
