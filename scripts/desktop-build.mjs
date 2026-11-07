// Release build: check the staged helper, then `tauri build` with local paths removed from the
// binary (Rust embeds source paths such as C:\Users\<name>\.cargo\registry\... in panic messages).
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [join(root, 'scripts', 'stage-helper.mjs'), '--check'], { stdio: 'inherit' });

const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');
const rustupHome = process.env.RUSTUP_HOME ?? join(homedir(), '.rustup');
const remap = [[cargoHome, '/cargo'], [rustupHome, '/rustup'], [root, '/awake-modpack-manager'], [homedir(), '/home']]
  .map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
// CARGO_ENCODED_RUSTFLAGS separates flags with 0x1f, so paths with spaces stay intact.
const flags = [process.env.CARGO_ENCODED_RUSTFLAGS, ...remap].filter(Boolean).join('\x1f');
const tauri = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
execFileSync(process.execPath, [tauri, 'build', ...process.argv.slice(2)], { stdio: 'inherit', cwd: root, env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags } });
