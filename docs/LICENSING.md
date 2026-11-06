# Licensing notes

* **Awake Launcher is GPL-3.0** (`LICENSE` in that repository). No Launcher source files were
  copied into this project. The Manager's tokens (`src/styles/tokens.css`) and components were
  written for the Manager, following the Launcher's visual identity (palette, glass surfaces,
  radii, spacing, motion timings, button styles). If you later want to share actual Launcher
  source (components, CSS files, the i18n catalog), the Manager must be GPL-3.0-compatible.
  That is a product/licensing decision for the project owner.
* **K2D font** (`src/assets/fonts/`): SIL Open Font License 1.1, copied with `OFL.txt`, the
  same files the Launcher bundles. The OFL allows bundling; the font must not be sold by itself.
* **Branded assets:** no Launcher icons, logos or pack artwork were copied. The sidebar mark is
  a plain "A" placeholder until the owner supplies a Manager icon.
* **Runtime dependency:** Vue 3.5.43 (MIT). See `THIRD-PARTY-NOTICES.txt`.
* **Project licence:** none chosen yet (`"private": true`). Needs an owner decision before any
  public release.
* **Mod redistribution:** Export never assumes a mod can be redistributed. Provider-hosted files
  are referenced, not bundled. Manual and cross-provider files need explicit opt-in plus a
  permission confirmation. Files whose authors disallow distribution are always left out. The
  real permission data must come from the coordinator/provider APIs.
