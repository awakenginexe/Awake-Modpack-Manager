// Stage the Manager's native helper into src-tauri/helper-stage/ for the installer.
//   node scripts/stage-helper.mjs --from <dir> [commit]   stage the pinned helper package (the whole folder)
//   node scripts/stage-helper.mjs --check                 fail unless the pinned, unmodified helper is staged
//   node scripts/stage-helper.mjs --stub                  build and stage the test stub (marked STUB; tests only)
// The folder is bundled as <install>\core-host\windows-x64\ (tauri.conf.json bundle.resources).
// scripts/helper-pin.json names the only package a release may ship: its executable hash, the hash
// of its own SHA256SUMS manifest and its source commit. Every file must match that manifest, with
// no extra files (a planted DLL would be loaded by the helper). HELPER-SOURCE.txt records the source.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'src-tauri', 'helper-stage');
const pin = JSON.parse(readFileSync(join(root, 'scripts', 'helper-pin.json'), 'utf8'));
const EXE = 'awake-core-host.exe';
const SOURCE = 'HELPER-SOURCE.txt';
const SUMS = 'SHA256SUMS';
/** Files the helper cannot run or be distributed without. */
const REQUIRED = [EXE, 'Qt6Core.dll', 'Qt6Network.dll', 'qt.conf', 'tls/qschannelbackend.dll', 'vcruntime140.dll', 'msvcp140.dll', 'COPYING.md', 'SOURCE.json'];
const [mode, from, commit] = process.argv.slice(2);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (lstatSync(p).isSymbolicLink()) throw new Error(`Refusing symbolic link ${p}`);
      if (e.isDirectory()) walk(p); else out.push(relative(dir, p).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return out.sort();
}
/** "sha256  size  relative/path" for every file except the record itself, sorted. */
function manifest(dir) {
  return files(dir).filter((f) => f !== SOURCE).map((f) => { const b = readFileSync(join(dir, f)); return `${sha256(b)}  ${b.length}  ${f}`; });
}

/** Problems with a helper package folder, compared with the pin. Empty means it is the pinned package. */
export function verifyPackage(dir) {
  const problems = [];
  if (existsSync(join(dir, 'STUB'))) return ['it is the test stub, not the real helper'];
  if (!existsSync(join(dir, EXE)) || !existsSync(join(dir, SUMS))) return [`${EXE} or ${SUMS} is missing`];
  const exe = sha256(readFileSync(join(dir, EXE)));
  if (exe !== pin.exeSha256) problems.push(`${EXE} SHA-256 ${exe} is not the pinned ${pin.exeSha256}`);
  const sumsBytes = readFileSync(join(dir, SUMS));
  if (sha256(sumsBytes) !== pin.sumsSha256) problems.push(`${SUMS} is not the pinned package manifest`);
  const listed = new Map();
  for (const line of sumsBytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) { problems.push(`bad ${SUMS} line: ${line}`); continue; }
    listed.set(m[2], m[1]);
  }
  const present = files(dir).filter((f) => f !== SUMS && f !== SOURCE);
  for (const f of present) {
    if (!listed.has(f)) problems.push(`unexpected file ${f}`);
    else if (sha256(readFileSync(join(dir, f))) !== listed.get(f)) problems.push(`${f} differs from ${SUMS}`);
  }
  for (const f of listed.keys()) if (!present.includes(f)) problems.push(`missing ${f}`);
  for (const f of REQUIRED) if (!listed.has(f)) problems.push(`package does not list ${f}`);
  try {
    const src = JSON.parse(readFileSync(join(dir, 'SOURCE.json'), 'utf8'));
    if (src.sourceCommit !== pin.sourceCommit) problems.push(`SOURCE.json names ${src.sourceCommit}, not ${pin.sourceCommit}`);
    if (src.implementationVersion !== pin.implementationVersion) problems.push(`SOURCE.json implementation ${src.implementationVersion}, not ${pin.implementationVersion}`);
  } catch (e) { problems.push(`SOURCE.json unreadable: ${e.message}`); }
  // Private build paths (C:\Users\<name>) must not ship. Qt's own CI path C:\Users\qt is upstream's.
  for (const f of present) {
    const hit = /[A-Za-z]:[\\/]+Users[\\/]+(?!qt[\\/])[A-Za-z0-9_.-]+/i.exec(readFileSync(join(dir, f)).toString('latin1'));
    if (hit) problems.push(`${f} contains a private path ${hit[0]}`);
  }
  return problems;
}

if (mode === '--check') {
  const fail = (m) => { console.error(`stage-helper --check: ${m}`); process.exit(1); };
  if (!existsSync(join(stage, EXE))) fail('no helper is staged. Run: node scripts/stage-helper.mjs --from <helper package folder> <source commit>');
  if (existsSync(join(stage, 'STUB'))) fail('the staged helper is the test stub; a release build needs the real helper.');
  const problems = verifyPackage(stage);
  if (problems.length) fail(`the staged helper is not the pinned package:\n  ${problems.join('\n  ')}`);
  const recorded = readFileSync(join(stage, SOURCE), 'utf8').split('files:\n')[1]?.trim().split('\n') ?? [];
  if (recorded.join('\n') !== manifest(stage).join('\n')) fail('staged files differ from HELPER-SOURCE.txt; stage again.');
  console.log(`helper OK: ${readFileSync(join(stage, SOURCE), 'utf8').split('\n')[0]} (exe ${pin.exeSha256})`);
} else if (mode === '--stub') {
  const crate = join(root, 'tools', 'stub-helper');
  const target = join(root, 'src-tauri', 'target', 'stub');
  execFileSync('cargo', ['build', '--release', '--manifest-path', join(crate, 'Cargo.toml'), '--target-dir', target], { stdio: 'inherit' });
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(join(target, 'release', EXE), join(stage, EXE));
  writeFileSync(join(stage, 'STUB'), 'Test stub: answers hello only. Not the real Awake native core.\n');
  writeFileSync(join(stage, SOURCE), `source: tools/stub-helper (test stub)\nstaged: ${new Date().toISOString()}\nfiles:\n${manifest(stage).join('\n')}\n`);
  console.log(`staged test stub -> ${stage}`);
} else if (mode === '--from' && from) {
  const src = resolve(from);
  const problems = verifyPackage(src);
  if (problems.length) { console.error(`Refusing ${src}: it is not the pinned helper package:\n  ${problems.join('\n  ')}`); process.exit(1); }
  if (commit && commit !== pin.sourceCommit) { console.error(`Commit ${commit} is not the pinned ${pin.sourceCommit}.`); process.exit(1); }
  rmSync(stage, { recursive: true, force: true });
  cpSync(src, stage, { recursive: true });
  // No local paths: this file ships with the app.
  writeFileSync(join(stage, SOURCE), `source: awakenginexe/Awake-Launcher@${pin.sourceCommit} (package ${basename(src)}, Native Core ${pin.implementationVersion})\nstaged: ${new Date().toISOString()}\nfiles:\n${manifest(stage).join('\n')}\n`);
  console.log(`staged pinned helper ${pin.implementationVersion} -> ${stage} (${manifest(stage).length} files)`);
} else {
  console.error('usage: stage-helper.mjs --from <helper package folder> [source commit] | --check | --stub');
  process.exit(2);
}
