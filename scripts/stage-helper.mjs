// Stage the Manager's native helper into src-tauri/helper-stage/ for the installer.
//   node scripts/stage-helper.mjs --from <dir> [commit]   stage a real helper package (the whole folder)
//   node scripts/stage-helper.mjs --check                 fail unless a real, unmodified helper is staged
//   node scripts/stage-helper.mjs --stub                  build and stage the test stub (marked STUB; tests only)
// The folder is bundled as <install>\core-host\windows-x64\ (tauri.conf.json bundle.resources).
// HELPER-SOURCE.txt records the source and a SHA-256 of every staged file, so a build can be
// reproduced and checked.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'src-tauri', 'helper-stage');
const EXE = 'awake-core-host.exe';
const SOURCE = 'HELPER-SOURCE.txt';
const [mode, from, commit] = process.argv.slice(2);

function noLinks(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (lstatSync(p).isSymbolicLink()) throw new Error(`Refusing symbolic link ${p}`);
    if (e.isDirectory()) noLinks(p);
  }
}
/** "sha256  size  relative/path" for every file except the record itself, sorted. */
function manifest(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (relative(dir, p) !== SOURCE) {
        const bytes = readFileSync(p);
        out.push(`${createHash('sha256').update(bytes).digest('hex')}  ${bytes.length}  ${relative(dir, p).replaceAll('\\', '/')}`);
      }
    }
  };
  walk(dir);
  const path = (line) => line.split('  ')[2];
  return out.sort((a, b) => (path(a) < path(b) ? -1 : 1));
}
function record(source) {
  const files = manifest(stage);
  writeFileSync(join(stage, SOURCE), `source: ${source}\nstaged: ${new Date().toISOString()}\nfiles:\n${files.join('\n')}\n`);
  console.log(`staged ${source} -> ${stage} (${files.length} files)`);
}

if (mode === '--check') {
  const fail = (m) => { console.error(`stage-helper --check: ${m}`); process.exit(1); };
  if (!existsSync(join(stage, EXE))) fail('no helper is staged. Run: node scripts/stage-helper.mjs --from <helper package folder> <source commit>');
  if (existsSync(join(stage, 'STUB'))) fail('the staged helper is the test stub; a release build needs the real helper.');
  const recorded = readFileSync(join(stage, SOURCE), 'utf8').split('files:\n')[1]?.trim().split('\n') ?? [];
  if (recorded.join('\n') !== manifest(stage).join('\n')) fail('staged files differ from HELPER-SOURCE.txt; stage again.');
  console.log(`helper OK: ${readFileSync(join(stage, SOURCE), 'utf8').split('\n')[0]}`);
} else if (mode === '--stub') {
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
  record(commit ? `${src} @ ${commit}` : src);
} else {
  console.error('usage: stage-helper.mjs --from <helper package folder> [source commit] | --check | --stub');
  process.exit(2);
}
