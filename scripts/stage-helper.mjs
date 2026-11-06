// Stage the Manager's native helper into src-tauri/helper-stage/ for the installer.
//   node scripts/stage-helper.mjs --stub          build and stage the test stub (marked STUB)
//   node scripts/stage-helper.mjs --from <dir>    stage a real helper build folder
//   node scripts/stage-helper.mjs --ensure        stage the stub only if nothing is staged yet
// The folder is bundled as <install>\core-host\windows-x64\ (tauri.conf.json bundle.resources).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'src-tauri', 'helper-stage');
const EXE = 'awake-core-host.exe';
const [mode, from] = process.argv.slice(2);

function noLinks(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (lstatSync(p).isSymbolicLink()) throw new Error(`Refusing symbolic link ${p}`);
    if (e.isDirectory()) noLinks(p);
  }
}
function record(source) {
  const sha = createHash('sha256').update(readFileSync(join(stage, EXE))).digest('hex');
  writeFileSync(join(stage, 'HELPER-SOURCE.txt'), `source: ${source}\nsha256(${EXE}): ${sha}\nstaged: ${new Date().toISOString()}\n`);
  console.log(`staged ${source} -> ${stage} (${sha.slice(0, 12)})`);
}

if (mode === '--ensure' && existsSync(join(stage, EXE))) process.exit(0);
if (mode === '--stub' || mode === '--ensure') {
  const crate = join(root, 'tools', 'stub-helper');
  const target = join(root, 'src-tauri', 'target', 'stub');
  execFileSync('cargo', ['build', '--release', '--manifest-path', join(crate, 'Cargo.toml'), '--target-dir', target], { stdio: 'inherit' });
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(join(target, 'release', EXE), join(stage, EXE));
  writeFileSync(join(stage, 'STUB'), 'Test stub: answers hello only. Not the real Awake native core.\n');
  record('tools/stub-helper (test stub)');
} else if (mode === '--from' && from) {
  const src = resolve(from);
  if (!existsSync(join(src, EXE))) throw new Error(`${src} has no ${EXE}`);
  if (existsSync(join(src, 'STUB'))) throw new Error('That folder is a stub build.');
  noLinks(src);
  rmSync(stage, { recursive: true, force: true });
  cpSync(src, stage, { recursive: true });
  record(src);
} else {
  console.error('usage: stage-helper.mjs --stub | --ensure | --from <helper build folder>');
  process.exit(2);
}
