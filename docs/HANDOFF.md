# Development checkpoint — 2026-11-07

Development only; v0.2.0 remains unreleased. The owner stopped testing. Do not resume Minecraft, installer automation, helper mutations or the stopped lifecycle run without a new request.

## Resume from Git

- Launcher: clone `https://github.com/awakenginexe/Awake-Launcher`, branch `feat/native-core-manager-020`, delivery HEAD `9622abce7b5232f14e0a64a6a1997010b728de26`.
- Manager: clone `https://github.com/awakenginexe/Awake-Modpack-Manager`, branch `feat/v0.2.0-native-core`. Final integration is preserved at `dafe69a0557dcf602e4e593c5cb5190839761128`; this handoff and the reusable diagnostic test are in its checkpoint successor. Use the branch HEAD.
- Node >=22.19.0; `npm ci`. Windows desktop builds also require the Rust/Tauri toolchain. No helper binaries or private test inputs are committed here.
- Retrieve the [helper ZIP, source parts and join tool at the delivery commit](https://github.com/awakenginexe/Awake-Launcher/tree/9622abce7b5232f14e0a64a6a1997010b728de26/native-core/redistribution/b00caf709789). Verify the ZIP hash below; extract the complete `core-host/windows-x64` folder to an external staging directory. Then `node scripts/stage-helper.mjs --from <extracted/core-host/windows-x64> b00caf7097897ab60ad0aa247e4964ece667976c` and `node scripts/stage-helper.mjs --check`. These validate files without starting the helper. Source reconstruction/licensing instructions are in the linked delivery README and [LICENSING.md](LICENSING.md).

## Contract and package

Native implementation/contract pin: **`b00caf7097897ab60ad0aa247e4964ece667976c`**; implementation 0.2.0, protocol 2.0, explicit `manager.v0.2`.

Pinned upstream [schema](https://github.com/awakenginexe/Awake-Launcher/blob/b00caf7097897ab60ad0aa247e4964ece667976c/docs/modpack-manager/core.schema.json), [protocol](https://github.com/awakenginexe/Awake-Launcher/blob/b00caf7097897ab60ad0aa247e4964ece667976c/docs/modpack-manager/core-protocol.md), [examples](https://github.com/awakenginexe/Awake-Launcher/blob/b00caf7097897ab60ad0aa247e4964ece667976c/docs/modpack-manager/core.examples.jsonl). [Manager schema](../src/backend/core/core.schema.json) matches the upstream Git blob exactly. Integration details: [INTEGRATION-020.md](INTEGRATION-020.md); machine pins: [helper-pin.json](../scripts/helper-pin.json).

| Item | SHA-256 |
|---|---|
| Schema | `931f1115c3447737551dbec272d883cbdb9d04b3aaa98cbc9e61c8c82b5edbcb` |
| `awake-core-host.exe` | `b33f41c23c5ad7e3708dce7cb0b466311ce8ea526887cbfa3e110e44f58832e6` |
| Helper ZIP | `2286079e486b4f067b946121ce7b997a15e985e8ec9598082b13b4995af0b37c` |
| Internal helper `SHA256SUMS` | `1e7570229e7742995f2ee56afcdd35ce3cc17af234016657b15a2139160aac97` |
| Reconstructed source ZIP | `3352fe74952dba6dc37c6287df7c5f397312d9f39bae84c5a245aaa7561c64ad` |

Manager consumes extension echo, independent pin/exclusion/native-lock fields, plan-file kinds, project lookup and tracked-config outbox reads. Fresh checkpoint checks confirmed schema identity, ZIP/source-part hashes and all 199 staged helper manifest entries; `stage-helper --check` passed. Typecheck, diagnostic-test syntax and eight opt-in/profile guard checks passed; default collection skipped all 13 real-pack tests. Credential-pattern scans covered 76 changed historical file versions and the checkpoint files. No verification was disabled.

### Five delivery text-file discrepancies

The **outer redistribution `SHA256SUMS`** records CRLF text bytes. Git stores LF blobs for these five files under `native-core/redistribution/b00caf709789/`. Their Windows CRLF checkout matches the recorded values; LF downloads fail those five entries. Converting the checkout's CRLF to LF reproduces each Git hash exactly. This does **not** affect the helper ZIP, its internal manifest, executable or source ZIP parts. Do not claim every delivery-file checksum matches, normalize verifier input, or bypass verification. Resolve outer-manifest reproducibility before distribution.

| File | Recorded CRLF SHA-256 | Committed LF SHA-256 |
|---|---|---|
| `awake-core-manager-v0.2.0-windows-x64.zip.sha256` | `8b2b21024f7888b0a3319d38b48290cd2d7e0e1e6795f1c6f1cdb9a3f1c3d537` | `765c8b37ef3d3bb57427a698bd7fdd197899feca46ded448b56914c38c678602` |
| `awake-core-source-b00caf709789.zip.sha256` | `5c3305e3699098ba108790b1fe5e0da6c1765fce306063b50da3a90fc76ad69f` | `88cd6dd073fdd9bc2ecb3f9e9cf350295bc76b1c7c48ee45066ccbb1d8696e5c` |
| `delivery.json` | `121221af453861da728750d92d9e9e7f2df5ff2d899fb7f2df97788d15f71957` | `968beffa95c3bc059f4da03d1c1befdd9f5f680f6dceae44e5adb030f1d93aed` |
| `join_source.py` | `4ddb28b98e3ad2183cd9a597dd589793d596ef3f8186f3eb624d37ae7e431bda` | `675397fe8ba52ac8dfdbd9165210b663af935bec951c13727390f5f10a4434a0` |
| `README.md` | `be103584acb57416bd931a76f391cdf351e50acc94d6a70feb19cd9f001977fc` | `0fd8ba4d38247599de143d0ebac1704ed65d71342459d982e88841a0eb92832b` |

## Evidence and limits

Prior Claude runs, **not rerun for this checkpoint**: 133 unit tests, 16 Rust host tests, 7/7 available real-helper scenarios passed; the legacy 0.1.1 scenario was skipped. A Windows installer was built; upgrading installed v0.1.0 to v0.2.0 preserved the tested project. Native Save As remains unverified.

Real Revelations v1.4.2 inspection: 407 JARs (~1.30 GB), 399 Forge mods, 3 Fabric mods through Sinytra Connector, 2 libraries, 3 files without normal metadata; 406/406 indexed hashes matched. `fairplayfairrule` had no index entry; `curios` was duplicated. There were 307 exact Modrinth artifact matches and 100 files without a match. Metadata inspection does not establish runtime compatibility.

**The final 265-file lifecycle run was deliberately stopped: no final success result.** Real-pack policy/update/toggle/remove/export/re-import/restart/recovery acceptance and hundreds-of-rows UI performance remain unverified. Real Manager data was snapshotted before installation tests and has not been compared with that baseline.

GitHub contains source, fixture tests, opt-in real-helper harnesses, this sanitized evidence summary and Launcher delivery artifacts. Raw evidence stays local under `%USERPROFILE%/AwakeMM-validation/v020-final/`: `real020.log`, `real020-profile-evidence.json`, `realPack*.log`, `pack-profile*-pack-evidence.json`, `inspection/`, `installed-app/`, `source-baseline-{before,after}.json`, `real-manager-data-before.json`, helper profiles and installer. These can contain private paths, filenames and manifests; do not publish them. The stopped run's `realPack6.log` contains only its start banner; no completed evidence JSON exists for it. Unit/host pass counts are prior-session reports, not new CI results.

[realPack.test.ts](../tests/realHelper/realPack.test.ts) is a reusable, stateful diagnostic harness; it embeds no pack, manifest or private paths. It defaults to skipped. A future expressly authorized run requires Windows, `AWAKE_REAL_PACK_RUN=1`, `AWAKE_REAL_HELPER`, a **new absolute disposable** `AWAKE_REAL_PROFILE` in an existing parent outside the source pack, and `AWAKE_REAL_PACK` (Forge 1.20.1 instance with `minecraft/mods`, `mmc-pack.json`, `flame/manifest.json`, >200 distinct JAR hashes). Optional `AWAKE_REAL_PACK_SKIP` is a pipe-separated filename list. It reads source files, downloads public matches, mutates disposable workspaces and intentionally interrupts Apply; evidence remains local. Failed import stages invalidate dependent lifecycle results. Do not run it merely to validate this checkpoint.

## Open Native Core blockers and Manager UI issues

1. Two Modrinth Fabric-tagged files used through Sinytra Connector are rejected as loader conflicts.
2. Ten combined mod/datapack projects are misclassified as datapacks and rejected.
3. Four mods have conflicting library version pins: EasyMagic, LegendaryTooltips, GoetyRevelation and fdbosses.
4. SkeletonAIFix declares Forge Config API Port as required, with no compatible Forge 1.20.1 build.
5. Refined Storage add-ons (ExtraDisks, ExtraStorage, Cable Tiers, RS Requestify, RS Infinity Booster) request conflicting Refined Storage versions (`KDvYkUg3`).

The installed Manager rejected the 295-file import for the Puzzles Lib conflict. Its error displayed raw project ID `QAGBst4M` instead of **Puzzles Lib** and the requesting mod(s), including EasyMagic. Dependency failures do not identify the responsible files/mods. The 903-second UI wait waited for a review screen after an error: **not a valid preparation-time benchmark**. CurseForge authorization remains disabled; `PROVIDER_RESTRICTED` is expected, and no credentials belong in the repository.

This checkpoint changes no stable release, main branch, tag, visibility or permissions; no merge or release is authorized.
