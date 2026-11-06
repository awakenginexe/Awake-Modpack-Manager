# Licensing notes

* **Awake Launcher is GPL-3.0** (`LICENSE` in that repository). No Launcher source files were
  copied into this project. The Manager's tokens (`src/styles/tokens.css`) and components were
  written for the Manager, following the Launcher's visual identity (palette, glass surfaces,
  radii, spacing, motion timings, button styles). If you later want to share actual Launcher
  source (components, CSS files, the i18n catalog), the Manager must be GPL-3.0-compatible.
  That is a product/licensing decision for the project owner.
* **K2D font** (`src/assets/fonts/`): SIL Open Font License 1.1, copied with `OFL.txt`, the
  same files the Launcher bundles. The OFL allows bundling; the font must not be sold by itself.
* **Awake logo** (`src/assets/brand/awake.png`): the Launcher's
  `program_info/io.github.awakenginexe.AwakeLauncher_256.png`, supplied by the Awake maintainer
  and licensed CC BY-SA 4.0 (licence text alongside it). Used unmodified, with attribution.
* **Provider logos** (`src/assets/providers/`): Modrinth, CurseForge, FTB, ATLauncher and Technic
  SVGs copied from the Launcher's `launcher/awake-web/src/assets/icons/`. They are trademarks of
  their owners, used only to show where a mod or pack comes from, which does not imply
  endorsement. The ATLauncher mark's dark grey faces were lightened so it is visible on the dark
  theme. Because these files come from the GPL-3.0 Launcher repository, either keep the Manager
  GPL-compatible or swap them for each provider's official brand-kit assets before a non-GPL
  release.
* **Runtime dependencies:** Vue 3.5.43 (MIT), @lucide/vue 1.59.0 icons (ISC) and @tauri-apps/api
  2.12.4 (MIT/Apache-2.0). See `THIRD-PARTY-NOTICES.txt`.
* **Desktop host (Rust):** tauri 2.12.5, serde/serde_json and windows-sys 0.61, all MIT or
  Apache-2.0, plus their transitive crates (pinned in `src-tauri/Cargo.lock`). Before a public
  release, generate the full crate notice list (e.g. with cargo-about) and ship it with the
  installer.
* **Project licence:** none chosen yet (`"private": true`). Needs an owner decision before any
  public release.
* **Mod redistribution:** Export never assumes a mod can be redistributed. Provider-hosted files
  are referenced, not bundled. Manual and cross-provider files need explicit opt-in plus a
  permission confirmation. Files whose authors disallow distribution are always left out. The
  real permission data must come from the coordinator/provider APIs.
