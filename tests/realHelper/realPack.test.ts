import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createHelperClient } from '../../src/backend/helper/HelperClient';
import { addChanges } from '../../src/domain/draft';
import { buildExport, modKey, newProject, planExport, type ProjectMod } from '../../src/domain/project';
import { writeZip } from '../../src/domain/zip';
import { createSession } from '../../src/state/session';
import { nodeHelperTransport } from './nodeTransport';

/**
 * Opt-in diagnostics for large Forge 1.20.1 packs (Windows only). Source JARs are read-only.
 * AWAKE_REAL_PACK_RUN=1 AWAKE_REAL_HELPER=<exe> AWAKE_REAL_PROFILE=<new absolute dir in an existing parent>
 * AWAKE_REAL_PACK=<instance dir> npx vitest run tests/realHelper/realPack.test.ts
 * Downloads and mutations, including interrupted-Apply recovery, use the disposable profile.
 * Evidence at <profile>-pack-evidence.json can contain private filenames and errors; keep it local.
 * Requires minecraft/mods, mmc-pack.json and flame/manifest.json; scans >200 distinct JAR hashes.
 * AWAKE_REAL_PACK_SKIP is an optional pipe-separated list of filenames to omit from import.
 * AWAKE_REAL_PACK_REVIEW=accept-evidence lets this harness act as the reviewer in the disposable profile:
 * when the helper reports dependency conflicts it records every one (titles, requesters, versions, loader
 * evidence) and retries once with the resolutions the helper marked reviewable (keep the selected version,
 * or proceed without an undeclared requirement). Blocked conflicts are never accepted. Without the variable
 * the conflicts are recorded and the import stage fails, as a person would see it.
 * The stages share state: a failed import invalidates later lifecycle results.
 */
const exe = process.env.AWAKE_REAL_HELPER;
const profile = process.env.AWAKE_REAL_PROFILE;
const pack = process.env.AWAKE_REAL_PACK;
const on = process.env.AWAKE_REAL_PACK_RUN === '1' && process.platform === 'win32' && !!(exe && profile && pack);
if (on) {
  if (!isAbsolute(profile!) || existsSync(profile!)) throw new Error('Use a new absolute disposable profile directory.');
  const fromPack = relative(realpathSync(pack!), join(realpathSync(dirname(profile!)), basename(profile!)));
  if (!fromPack || (!isAbsolute(fromPack) && fromPack !== '..' && !fromPack.startsWith(`..${sep}`))) {
    throw new Error('The disposable profile must be outside the source pack.');
  }
}
const evidence: Record<string, unknown> = {};
const note = (k: string, v: unknown) => { evidence[k] = v; console.log(k, typeof v === 'object' ? JSON.stringify(v).slice(0, 2000) : v); };
afterAll(() => { if (on) writeFileSync(`${profile}-pack-evidence.json`, JSON.stringify(evidence, null, 1)); });
const sha = (alg: string, b: Uint8Array) => createHash(alg).update(b).digest('hex');
const ms = async <T>(k: string, f: () => Promise<T>): Promise<T> => { const t = performance.now(); try { return await f(); } finally { note(`time.${k}.ms`, Math.round(performance.now() - t)); } };
const UA = { 'User-Agent': 'awake-modpack-manager-validation' };
const acceptReviewed = process.env.AWAKE_REAL_PACK_REVIEW === 'accept-evidence';

type MrFile = { url: string; filename: string; size: number; primary: boolean; hashes: { sha1: string; sha512: string } };
type MrVersion = { id: string; project_id: string; version_number: string; loaders: string[]; game_versions: string[]; files: MrFile[] };

function walk(dir: string): string[] {
  const out: string[] = [];
  const go = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) go(p); else out.push(p); } };
  go(dir);
  return out;
}
function workspaceDir(root: string, name: string): string {
  for (const d of readdirSync(root)) {
    const cfg = join(root, d, 'instance.cfg');
    if (existsSync(cfg) && readFileSync(cfg, 'utf8').includes(`name=${name}`)) return join(root, d);
  }
  throw new Error(`workspace ${name} not found`);
}
const helperMemory = (pid: number | undefined) => {
  if (!pid) return null;
  const line = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).trim();
  return line.split('","').at(-1)?.replace(/"/g, '') ?? null;
};

describe.skipIf(!on)('REAL Forge 1.20.1 pack (explicit opt-in, read-only source)', () => {
  const t = on ? nodeHelperTransport(exe!, profile!) : null!;
  const client = () => createHelperClient({ transport: t, clientVersion: '0.2.0-real-pack', pollMs: 300, startTimeoutMs: 90_000, requestTimeoutMs: 300_000 });
  let session = createSession(client(), { pollMs: 300 });
  let root = '';
  const local = new Map<string, { file: string; sha1: string; sha512: string; size: number }>(); // by sha512
  const onModrinth: { local: string; v: MrVersion; f: MrFile }[] = [];
  let mainId = '';
  const MAIN = 'Real pack (Modrinth files)';
  const LOADER = { kind: 'forge' as const, version: '' };

  async function applyDraft(changes: Parameters<typeof addChanges>[1], label: string) {
    session.setDraft(addChanges(session.draft.value!, changes));
    await ms(`${label}.prepare`, () => session.validate());
    expect(session.review.phase, session.review.error?.message).toBe('reviewed');
    const plan = session.review.plan!;
    await ms(`${label}.apply`, () => session.apply());
    expect(session.review.phase, session.review.error?.message ?? JSON.stringify(session.review.operation)).toBe('done');
    await session.loadInventory();
    return plan;
  }
  async function importArchive(bytes: Uint8Array, format: 'mrpack' | 'curseforge', name: string, label: string) {
    const b = session.backend;
    const token = await ms(`${label}.upload`, () => b.uploadImport!(new Blob([bytes as BlobPart])));
    const ins = await ms(`${label}.inspect`, () => b.inspectImport!(token, format));
    note(`${label}.inspect`, { mc: ins.minecraftVersion, loader: ins.loader, projects: ins.projects.length, downloadCount: ins.downloadCount, files: ins.files.length, warnings: ins.warnings.slice(0, 20), warningCount: ins.warnings.length });
    const made = await ms(`${label}.createWorkspace`, () => session.createInstance({ name, minecraftVersion: ins.minecraftVersion, loader: ins.loader.kind, loaderVersion: ins.loader.version || undefined }));
    expect(made?.state, JSON.stringify(made?.error)).toBe('completed');
    await session.refreshInstances();
    const id = made!.result!.instanceId!;
    let plan = await ms(`${label}.prepareImport`, () => session.prepareImport(id, token, format, false, name, undefined, true)).catch(() => null);
    const first = session.review.error;
    if (!plan && first?.code === 'dependency-conflict') {
      const conflicts = first.conflicts ?? [];
      note(`${label}.conflicts`, { truncated: first.conflictsTruncated, structured: conflicts.length > 0, message: first.message.slice(0, 600),
        conflicts: conflicts.map((c) => ({ kind: c.kind, dependency: c.title, selected: c.selected?.versionNumber ?? null, resolutions: c.resolutions,
          requests: c.requests.map((r) => ({ mod: r.title, version: r.versionNumber, requested: r.requestedVersionNumber, evidence: r.evidence.result, range: r.evidence.declaredRange })) })) });
      const reviewable = conflicts.length > 0 && conflicts.every((c) => c.resolutions.length);
      if (acceptReviewed && reviewable) {
        const decisions = conflicts.map((c) => ({ provider: c.provider, projectId: c.projectId, versionId: c.kind === 'version_pin' ? c.selected!.versionId : null }));
        note(`${label}.decisions`, decisions);
        plan = await ms(`${label}.prepareImportReviewed`, () => session.prepareImport(id, token, format, false, name, decisions, true)).catch(() => null);
      }
    }
    if (!plan) await session.backend.discardImport?.(token).catch(() => undefined);
    return { ins, plan, id, error: plan ? null : session.review.error };
  }
  const project = (name: string, mods: ProjectMod[]) => newProject({ name, version: '1.0.0', minecraftVersion: '1.20.1', loader: { kind: 'forge', version: LOADER.version }, mods });

  it('reads the real pack read-only and identifies its exact files on Modrinth', async () => {
    const mmc = JSON.parse(readFileSync(join(pack!, 'mmc-pack.json'), 'utf8')) as { components: { uid: string; version: string }[] };
    LOADER.version = mmc.components.find((c) => c.uid === 'net.minecraftforge')!.version;
    expect(mmc.components.find((c) => c.uid === 'net.minecraft')?.version).toBe('1.20.1');
    const modsDir = join(pack!, 'minecraft', 'mods');
    const t0 = performance.now();
    for (const f of readdirSync(modsDir).filter((x) => /\.jar(\.disabled)?$/i.test(x))) {
      const b = new Uint8Array(readFileSync(join(modsDir, f)));
      local.set(sha('sha512', b), { file: f, sha1: sha('sha1', b), sha512: sha('sha512', b), size: b.length });
    }
    note('time.hashLocal.ms', Math.round(performance.now() - t0));
    const bySha1 = new Map([...local.values()].map((l) => [l.sha1, l]));
    const found: Record<string, MrVersion> = await ms('modrinthLookup', async () => (await fetch('https://api.modrinth.com/v2/version_files', { method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes: [...bySha1.keys()], algorithm: 'sha1' }) })).json());
    for (const [h, v] of Object.entries(found)) {
      const f = v.files.find((x) => x.hashes.sha1 === h)!;
      onModrinth.push({ local: bySha1.get(h)!.file, v, f });
    }
    note('pack', { loader: LOADER, jars: local.size, onModrinth: onModrinth.length, notOnModrinth: local.size - onModrinth.length });
    expect(local.size).toBeGreaterThan(200);
  }, 600_000);

  it('connects to the final helper and creates a real Forge 1.20.1 workspace for the pack loader version', async () => {
    await ms('connect', () => session.connect());
    const hs = session.state.handshake!;
    expect(hs, session.state.connectError?.message).toBeTruthy();
    note('helper', { version: hs.launcherVersion, caps: hs.capabilities, providers: hs.providers });
    root = (await session.backend.listInstallations())[0]!.path;
    const cat = await session.backend.versionCatalog!({ minecraftVersion: '1.20.1', loader: 'forge' });
    note('forgeCatalogHasPackVersion', cat.loaderVersions.includes(LOADER.version));
    expect(cat.loaderVersions).toContain(LOADER.version);
  }, 600_000);

  const toMods = (list: typeof onModrinth): ProjectMod[] => list.map(({ v, f }) => ({
    key: modKey('modrinth', v.project_id), name: f.filename, provider: 'modrinth', projectId: v.project_id, versionId: v.id, versionName: v.version_number,
    required: true, pinned: false, verified: true, origin: 'import', file: { path: `mods/${f.filename}`, size: f.size, sha1: f.hashes.sha1, sha512: f.hashes.sha512, downloads: [f.url] },
  }));
  const forgeTagged = (x: (typeof onModrinth)[number]) => x.v.loaders.includes('forge') && x.v.game_versions.includes('1.20.1');

  // Alone, these Fabric files lack Sinytra Connector in the subset: 0.2.1 reports a loader_bridge conflict here.
  it('isolates Modrinth versions not tagged forge+1.20.1 (Fabric mods the pack runs via Sinytra Connector)', async () => {
    const other = onModrinth.filter((x) => !forgeTagged(x));
    note('nonForgeTagged', other.map((x) => ({ file: x.local, loaders: x.v.loaders, games: x.v.game_versions })));
    if (!other.length) return;
    const p = project('Connector files only', toMods(other));
    const r = await importArchive(buildExport(p, planExport(p, 'mrpack')), 'mrpack', 'Connector files only', 'connectorOnly').catch((e) => ({ thrown: e }));
    const err = 'thrown' in r ? r.thrown : r.error;
    note('connectorOnly.result', { code: err?.code, detail: err?.detail, message: err?.message });
    session.discardDraft();
  }, 900_000);

  // Projects whose Modrinth loaders include "datapack" (mod + datapack in one project). Helpers before 0.2.1
  // refused them as datapacks; 0.2.1 admits them as mods when the version lists Forge and ships a JAR.
  const datapackProjects = new Set<string>();
  it('isolates mod+datapack Modrinth projects', async () => {
    const ids = [...new Set(onModrinth.map((x) => x.v.project_id))];
    for (let i = 0; i < ids.length; i += 100) {
      const list = (await (await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(ids.slice(i, i + 100)))}`, { headers: UA })).json()) as { id: string; loaders: string[] }[];
      for (const pr of list) if (pr.loaders.includes('datapack')) datapackProjects.add(pr.id);
    }
    const hit = onModrinth.filter((x) => forgeTagged(x) && datapackProjects.has(x.v.project_id));
    note('datapackClassified', hit.map((x) => x.local));
    if (!hit.length) return;
    const p = project('Mod+datapack files only', toMods(hit));
    const r = await importArchive(buildExport(p, planExport(p, 'mrpack')), 'mrpack', 'Mod+datapack files only', 'datapackOnly').catch((e) => ({ thrown: e }));
    const err = 'thrown' in r ? r.thrown : r.error;
    note('datapackOnly.result', { code: err?.code, detail: err?.detail, message: err?.message });
    session.discardDraft();
  }, 900_000);

  it('imports every Modrinth-identified file of the pack as .mrpack: helper downloads, verifies, applies; hashes equal the owner files', async () => {
    // Native Core 0.2.1 admits Connector-loaded Fabric files and mod+datapack projects; nothing is filtered by loader.
    const skip = new Set((process.env.AWAKE_REAL_PACK_SKIP ?? '').split('|').filter(Boolean));
    note('import.skipped', [...skip]);
    note('import.includesConnectorAndDatapackFiles', { nonForgeTagged: onModrinth.filter((x) => !forgeTagged(x)).length, modAndDatapack: onModrinth.filter((x) => datapackProjects.has(x.v.project_id)).length });
    onModrinth.splice(0, onModrinth.length, ...onModrinth.filter((x) => !skip.has(x.local)));
    note('import.fileCount', onModrinth.length);
    const mods: ProjectMod[] = onModrinth.map(({ v, f }) => ({
      key: modKey('modrinth', v.project_id), name: f.filename, provider: 'modrinth', projectId: v.project_id, versionId: v.id, versionName: v.version_number,
      required: true, pinned: false, verified: true, origin: 'import', file: { path: `mods/${f.filename}`, size: f.size, sha1: f.hashes.sha1, sha512: f.hashes.sha512, downloads: [f.url] },
    }));
    const bytes = buildExport(project(MAIN, mods), planExport(project(MAIN, mods), 'mrpack'));
    note('mrpack.bytes', bytes.length);
    const r = await importArchive(bytes, 'mrpack', MAIN, 'import');
    expect(r.error, r.error?.message).toBeNull();
    const plan = r.plan!;
    const byAction: Record<string, number> = {};
    for (const i of plan.items) byAction[i.action] = (byAction[i.action] ?? 0) + 1;
    note('import.plan', { items: plan.items.length, byAction, issues: plan.issues.map((i) => `${i.severity}:${i.code}:${i.message}`).slice(0, 80), issueCount: plan.issues.length, optional: plan.optional.length });
    await ms('import.apply', () => session.apply());
    note('import.applyResult', { phase: session.review.phase, error: session.review.error?.message, op: session.review.operation?.state });
    expect(session.review.phase, session.review.error?.message).toBe('done');
    mainId = r.id;
    // Every installed file must be byte-identical to the owner's own JAR.
    const dir = join(workspaceDir(root, MAIN), '.minecraft', 'mods');
    const installed = readdirSync(dir).filter((f) => f.endsWith('.jar')).map((f) => sha('sha512', new Uint8Array(readFileSync(join(dir, f)))));
    const identical = installed.filter((h) => local.has(h)).length;
    note('import.hashes', { installedJars: installed.length, identicalToOwnerJar: identical, extraNotInOwnerPack: installed.length - identical });
    expect(identical).toBe(onModrinth.length);
  }, 3_600_000);

  it('lists the full real inventory with names, and measures reads', async () => {
    await session.refreshInstances();
    await ms('inventory.first', () => session.selectInstance(mainId));
    const mods = session.inventory.value!.mods;
    const named = mods.filter((m) => m.name !== m.fileName.replace(/\.disabled$/i, '').replace(/\.jar$/i, '')).length;
    await ms('inventory.second', () => session.loadInventory());
    const named2 = session.inventory.value!.mods.filter((m) => m.name !== m.fileName.replace(/\.disabled$/i, '').replace(/\.jar$/i, '')).length;
    note('inventory', { count: mods.length, verified: mods.filter((m) => m.metadataState === 'indexed' && !m.locallyModified).length, namedAfterFirstLoad: named, namedAfterSecondLoad: named2,
      updatesOffered: session.inventory.value!.mods.filter((m) => m.available && m.available.id !== m.installed?.id).length, helperMemory: helperMemory(t.pid()), nodeRssMB: Math.round(process.memoryUsage().rss / 2 ** 20) });
    expect(mods.length).toBe(onModrinth.length);
  }, 900_000);

  it('pins and excludes a real mod with separate read-back, then clears both', async () => {
    let m = session.inventory.value!.mods.find((x) => x.projectId)!;
    session.setPinned([m.key], true);
    session.setExcluded([m.key], true);
    await applyDraft([], 'policy');
    m = session.inventory.value!.mods.find((x) => x.key === m.key)!;
    note('policy.readBack', { name: m.name, pinned: m.pinned, excluded: m.updateExcluded, nativeLock: m.nativeLock, updateLocked: m.updateLocked });
    expect([m.pinned, m.updateExcluded, m.nativeLock]).toEqual([true, true, false]);
    session.setExcluded([m.key], false);
    expect(session.draft.value!.changes).toEqual([{ kind: 'policy', modKey: m.key, pinned: true, excluded: false }]);
    session.setPinned([m.key], false);
    await applyDraft([], 'policyClear');
    m = session.inventory.value!.mods.find((x) => x.key === m.key)!;
    expect([m.pinned, m.updateExcluded, m.updateLocked]).toEqual([false, false, false]);
  }, 900_000);

  it('updates a real mod where Modrinth offers a newer compatible version', async () => {
    const cand = session.inventory.value!.mods.filter((m) => m.available && m.installed && m.available.id !== m.installed.id);
    note('update.candidates', cand.map((m) => `${m.name}: ${m.installed!.name} -> ${m.available!.name}`));
    if (!cand.length) { note('update.result', 'no newer compatible version offered for any mod'); return; }
    const m = cand[0]!;
    await applyDraft([{ kind: 'update', modKey: m.key, targetVersionId: m.available!.id }], 'update');
    const after = session.inventory.value!.mods.find((x) => x.projectId === m.projectId)!;
    const v = (await (await fetch(`https://api.modrinth.com/v2/version/${m.available!.id}`, { headers: UA })).json()) as MrVersion;
    const f = v.files.find((x) => x.primary) ?? v.files[0]!;
    const onDisk = join(workspaceDir(root, MAIN), '.minecraft', 'mods', f.filename);
    note('update.result', { mod: m.name, from: m.installed!.name, to: after.installed?.name, sha512Matches: sha('sha512', new Uint8Array(readFileSync(onDisk))) === f.hashes.sha512 });
    expect(after.installed?.id).toBe(m.available!.id);
  }, 900_000);

  it('disables, re-enables and removes real mods; reports what a dependency removal plan says', async () => {
    const pick = session.inventory.value!.mods.find((x) => x.projectId && x.enabled)!;
    await applyDraft([{ kind: 'disable', modKey: pick.key }], 'disable');
    expect(session.inventory.value!.mods.find((x) => x.projectId === pick.projectId)!.enabled).toBe(false);
    await applyDraft([{ kind: 'enable', modKey: session.inventory.value!.mods.find((x) => x.projectId === pick.projectId)!.key }], 'enable');
    expect(session.inventory.value!.mods.find((x) => x.projectId === pick.projectId)!.enabled).toBe(true);
    // A widely used library: does the reviewed plan warn that other mods need it?
    const lib = session.inventory.value!.mods.find((x) => /architectury|cloth|geckolib|balm|puzzles/i.test(x.fileName));
    if (lib) {
      session.setDraft(addChanges(session.draft.value!, [{ kind: 'remove', modKey: lib.key }]));
      await session.validate();
      note('removeLibrary.plan', { mod: lib.fileName, phase: session.review.phase, issues: session.review.plan?.issues.map((i) => `${i.severity}:${i.code}:${i.message}`) });
      session.discardDraft();
    }
    const n = session.inventory.value!.mods.length;
    const victim = session.inventory.value!.mods.find((x) => x.projectId && x.key !== lib?.key)!;
    await applyDraft([{ kind: 'remove', modKey: victim.key }], 'remove');
    note('remove.result', { mod: victim.fileName, before: n, after: session.inventory.value!.mods.length });
    expect(session.inventory.value!.mods.length).toBe(n - 1);
  }, 900_000);

  let exported: Uint8Array;
  it('exports the workspace (snapshot -> .mrpack) and re-imports it into a new workspace', async () => {
    const snap = await ms('export.snapshot', () => session.backend.snapshotWorkspace!(mainId));
    note('export.snapshot', { mods: snap.mods.length, skipped: snap.skipped.length, skippedReasons: snap.skipped.slice(0, 20), configs: snap.configs?.length ?? 0 });
    const p = project('Real pack round trip', snap.mods.map((m) => ({
      key: modKey(m.provider, m.projectId), name: m.name, provider: m.provider, projectId: m.projectId, versionId: m.versionId, required: true, pinned: false, verified: true, origin: 'import' as const,
      file: { path: `mods/${m.fileName}`, size: m.size, sha1: m.sha1, sha512: m.sha512, downloads: [m.url] },
    })));
    exported = buildExport(p, planExport(p, 'mrpack'));
    const r = await importArchive(exported, 'mrpack', 'Real pack round trip', 'reimport');
    expect(r.error, r.error?.message).toBeNull();
    await ms('reimport.apply', () => session.apply());
    expect(session.review.phase, session.review.error?.message).toBe('done');
    await session.selectInstance(r.id);
    const a = new Set(snap.mods.map((m) => m.versionId));
    const b = new Set(session.inventory.value!.mods.map((m) => m.installed?.id));
    note('reimport.compare', { exported: a.size, reimported: b.size, missing: [...a].filter((x) => !b.has(x)).length });
    expect([...a].every((x) => b.has(x))).toBe(true);
  }, 3_600_000);

  it('keeps every workspace and inventory after a helper restart (persistence)', async () => {
    const before = { ws: session.state.instances.map((i) => [i.name, i.revision]), count: session.inventory.value!.mods.length };
    t.kill();
    await new Promise((r) => setTimeout(r, 2000));
    session = createSession(client(), { pollMs: 300 });
    await ms('reconnectAfterRestart', () => session.connect());
    await session.refreshInstances();
    await session.selectInstance(session.state.instances.find((i) => i.name === 'Real pack round trip')!.id);
    const after = { ws: session.state.instances.map((i) => [i.name, i.revision]), count: session.inventory.value!.mods.length };
    note('restart', { before, after });
    expect(after).toEqual(before);
  }, 900_000);

  it('recovers when the helper is killed during a large real Apply (disposable workspace)', async () => {
    const mods = session.inventory.value!.mods;
    session.setDraft(addChanges(session.draft.value!, mods.slice(0, 150).map((m) => ({ kind: 'remove' as const, modKey: m.key }))));
    await session.validate();
    expect(session.review.phase, session.review.error?.message).toBe('reviewed');
    const plan = session.review.plan!;
    const acc = await session.backend.applyPlan({ planId: plan.planId, planHash: plan.planHash, baseRevision: plan.baseRevision, idempotencyKey: crypto.randomUUID() });
    let seen = '';
    for (let i = 0; i < 400; i++) {
      seen = (await session.backend.getOperation(acc.operationId)).state;
      if (['backing_up', 'applying', 'verifying', 'completed'].includes(seen)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    t.kill();
    await new Promise((r) => setTimeout(r, 2000));
    session = createSession(client(), { pollMs: 300 });
    await session.connect();
    let op = await session.backend.getOperation(acc.operationId);
    const states = [op.state];
    for (let i = 0; i < 400 && !['completed', 'rolled_back', 'failed', 'cancelled'].includes(op.state); i++) {
      if (op.state === 'recovery_required') await session.runRecovery(acc.operationId);
      await new Promise((r) => setTimeout(r, 300));
      op = await session.backend.getOperation(acc.operationId);
      if (states.at(-1) !== op.state) states.push(op.state);
    }
    await session.refreshInstances();
    await session.selectInstance(session.state.instances.find((i) => i.name === 'Real pack round trip')!.id);
    const n = session.inventory.value!.mods.length;
    note('recovery', { killedDuring: seen, states, final: op.state, error: op.error, modsAfter: n, before: mods.length });
    expect(['completed', 'rolled_back']).toContain(op.state);
    expect(n === mods.length || n === mods.length - 150).toBe(true); // all or nothing
  }, 1_800_000);

  it('imports the real CurseForge manifest of the pack: CurseForge files stay unavailable without authorization', async () => {
    const manifest = new Uint8Array(readFileSync(join(pack!, 'flame', 'manifest.json')));
    const zip = writeZip([{ path: 'manifest.json', data: manifest }]);
    const r = await importArchive(zip, 'curseforge', 'Real pack CurseForge manifest', 'cfImport').catch((e) => ({ thrown: e }));
    const err = 'thrown' in r ? r.thrown : r.error;
    note('cfImport.result', { code: err?.code, detail: err?.detail, message: err?.message?.slice(0, 500), plan: 'plan' in r ? r.plan?.items.length : undefined });
    expect(err?.code).toMatch(/provider-restricted|unsupported/);
  }, 900_000);
});
