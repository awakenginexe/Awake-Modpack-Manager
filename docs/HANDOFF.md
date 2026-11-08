# Development checkpoint (2026-11-08): Native Core 0.2.1 and reviewed dependency conflicts

Development only. Manager v0.2.0 remains **unreleased**: no tag, release, merge or stable-branch change was made. The previous checkpoint (Native Core 0.2.0, `7f6d869`) is superseded. Its evidence notes are kept in Git history.

## Resume from Git

- Launcher: `https://github.com/awakenginexe/Awake-Launcher`, branch `feat/native-core-manager-020`, delivery HEAD `75b362c6958fe9a5829faf4371146f9132b7ebc2`. Executable/source pin `b06c9a804503545207bacfa3bfdf8bfe23604e07`; contract (schema) unchanged since `31d0611a9de0409560f0b62282de078e5970a396`. Read `docs/modpack-manager/handoff.md` (top section).
- Manager: this branch `feat/v0.2.0-native-core`. Node ≥ 22.19, `npm ci`. Windows desktop builds also need the Rust/Tauri toolchain.
- Stage the helper: extract `native-core/redistribution/b06c9a804503/awake-core-manager-v0.2.1-windows-x64.zip` (verify its SHA-256 first) outside the repository. Then run `node scripts/stage-helper.mjs --from <extracted>/core-host/windows-x64 b06c9a804503545207bacfa3bfdf8bfe23604e07` and `node scripts/stage-helper.mjs --check`. Build with `node scripts/desktop-build.mjs`.

| Item | SHA-256 |
|---|---|
| `src/backend/core/core.schema.json` (= Launcher Git blob at `31d0611a9`) | `26539795e4da1929fd6977032da25798de6f0274c8af7375740c5b403ba0e3e7` |
| `awake-core-host.exe` 0.2.1 | `a71b35e946ffef00bed4b1200c4796e7d16001dac8089481d0192035ae64124b` |
| Helper ZIP (6,814,993 bytes) | `0aea4ce7f3adcd7fd920d55c4b751623c5846be24331b2846e9624b026bc6792` |
| Helper `SHA256SUMS` | `aacd3d97188c45aa63b1f9a290d0c1d39a531c74e1126e7ef044e8c81116f752` |
| `awake-core-source-b06c9a804503.zip` (107,287,939 bytes) | `543dcc404bdb9bb6f319dceb6e860b1040a7c55611fba5443d934444237503ee` |

`scripts/helper-pin.json` records these. Integration details: [INTEGRATION-020.md](INTEGRATION-020.md).

## What changed

**Native Core 0.2.1** addresses the five blockers from the real Revelations v1.4.2 import:

| Blocker | Cause found | Fix |
|---|---|---|
| Connector Fabric files rejected | Version tagged only `fabric` | Admitted in imports by exact hash, only while Sinytra Connector is enabled. Fabric API maps to Forgified Fabric API; no other dependency is auto-installed. Removing Connector is a conflict. |
| 10 mod+datapack projects rejected | The shared parser classifies any project whose loaders include `datapack` as a datapack | Accepted as mods when `project_type` is `mod` with a real loader. The version must list Forge and ship a JAR. |
| EasyMagic / LegendaryTooltips / GoetyRevelation / fdbosses pins | Provider pins are upload-time snapshots. EasyMagic Forge pins Puzzles Lib 8.0.15 but its `mods.toml` requires `[8.0.0,)` | `version_pin` conflict with loader-metadata evidence; reviewed `use_version` is accepted unless the metadata rejects it |
| SkeletonAIFix → Forge Config API Port | Its provider record requires FCAP, which has only Fabric builds for 1.20.1; its Forge `mods.toml` does not declare it | `missing_dependency` with `not_declared` evidence; reviewed `proceed_without` is accepted. A declared requirement is never skippable. |
| Refined Storage add-ons | Older add-on builds pin RS 1.12.3; e.g. RSInfinityBooster declares `refinedstorage [1.12.3,)` | `version_pin` listing every requester. Candidates include compatible pinned versions when the pack did not select RS itself. |

All problems are reported together **before anything is downloaded or staged**, with project titles. Installed dependencies follow a requester's pin only to a newer-published build; downgrades always need review. New opt-in extension `manager.v0.2.1`; older clients see byte-identical replies.

**Manager:**

- Negotiates `manager.v0.2.1` → `manager.v0.2` → none.
- Maps structured conflicts to `BackendError('dependency-conflict')` (never by parsing the message).
- New `DependencyConflicts.vue` panel, in the import dialog and on Review. It shows each library by name, the requesting mods and their versions, requested vs. selected version, an explanation, what each mod's own metadata says, the affected files, and only the actions the helper accepts. Nothing is preselected. The retry is enabled only when every problem has an explicit decision.
- An import keeps its upload and workspace for the retry, so there's no second upload.
- Reviewed decisions appear on Review.
- Mods loaded through Connector show a "via Sinytra Connector" badge.
- The opt-in real-pack harness now imports every Modrinth-matched file, Connector and mod+datapack files included. `AWAKE_REAL_PACK_REVIEW=accept-evidence` lets it act as the reviewer for reviewable conflicts only, recording every decision.

**Reproducibility:** outer delivery checksums now hash the exact committed (LF, `-text`) bytes. The `b00caf709789` manifest was corrected. Both deliveries verify 8/8 from a fresh `core.autocrlf=true` clone of GitHub. Source archives no longer nest earlier deliveries (`export-ignore`).

## Tests actually run in this session (Windows 11, this machine)

- Native: baseline CTest 10/10 before changes; final pin CTest **11/11** (419 s), with the new `DependencyResolutionTest` (12 cases); contract validator 220 checks.
- Packaged helper IPC harness on the final package: **28/28**. It includes 301-mod crash recovery, `manager.v0.2` replies validated against the previous `b00caf709` schema, legacy replies against the Manager v0.1 schema, live Fabric/Forge workflows, and a **live five-blocker pack from public Modrinth files**. That pack reported every conflict at once in 15.5 s with names and evidence, then imported 9 verified, hash-identical files after the reviewed decisions (17.2 s).
- Manager: `vitest` **142 passed / 25 skipped** (133 before; +9 error-to-UI tests: domain model, client mapping, older-helper fallback, upload retention, panel, import dialog flow). `vue-tsc` clean. Rust host tests **16 passed, 1 ignored**, with the real staged helper. `stage-helper --check` passed for 200 files.
- Windows installer built with the staged helper. Location and SHA-256 are in the final report and the commit message.

Not run here: the owner's real 407-JAR pack (its files are not on this machine), the installed-app upgrade from v0.1.0, Native Save As, Minecraft gameplay, live authorized CurseForge, large-collection UI performance, and the stopped 265-file lifecycle run (still **no success result**). Comparison of the owner's real Manager data with its saved baseline was not done either. The earlier 903-second figure was a wait after an import failure, not a Prepare benchmark.

## Real-pack acceptance on the owner's PC

Use a **new disposable profile**. The source instance is only read. Run from a checkout of this commit after `npm ci` and staging the helper:

```powershell
$env:AWAKE_REAL_PACK_RUN = '1'
$env:AWAKE_REAL_HELPER   = (Resolve-Path 'src-tauri\helper-stage\awake-core-host.exe').Path
$env:AWAKE_REAL_PROFILE  = "$env:USERPROFILE\AwakeMM-validation\v021-$(Get-Date -Format yyyyMMdd-HHmm)"   # must not exist; parent must
$env:AWAKE_REAL_PACK     = '<Revelations instance folder containing minecraft\mods, mmc-pack.json, flame\manifest.json>'
$env:AWAKE_REAL_PACK_REVIEW = 'accept-evidence'   # omit to stop at the first conflict report, as a person would see it
npx vitest run tests/realHelper/realPack.test.ts
```

Expected: the isolation stages record the Connector-only subset as a `loader_bridge` conflict (Connector itself is not in that subset) and the mod+datapack subset as importable. The main import first records the conflict list in `<profile>-pack-evidence.json` (`import.conflicts`) and the decisions taken (`import.decisions`). Every installed JAR must then be hash-identical to the owner's file, followed by inventory, policy, update, toggle, remove, export/re-import, restart and interrupted-Apply recovery stages.

Check that no conflict has an empty `resolutions` list; such a conflict is a real incompatibility that needs the owner's decision. Also check the imported Connector files and that the `curios` duplicate and `fairplayfairrule` (not on Modrinth) are reported, not silently changed. The evidence file can contain private file names: keep it local. Then install the built installer over v0.1.0/v0.2.0 on a copy of the real Manager data, compare against `real-manager-data-before.json`, and test Native Save As and an in-game launch through Awake Launcher.

## Remaining release blockers

1. Owner real-pack acceptance (above), including the 100 files that have no Modrinth match (manual/CurseForge files are not imported) and runtime behaviour of the Connector-loaded mods.
2. Installed-app upgrade and real Manager data comparison, Native Save As, large-list UI performance.
3. CurseForge stays disabled without separately authorized API access. No credential is embedded.
4. Attach the helper ZIP, `awake-core-source-b06c9a804503.zip` and both `.sha256` files to any release. Re-pin again if the helper changes.
5. Builds are not reproducible. A release needs owner approval; none was created.
