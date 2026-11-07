import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHelperClient } from '../../src/backend/helper/HelperClient';
import { addChange, addChanges } from '../../src/domain/draft';
import { createSession } from '../../src/state/session';
import { nodeHelperTransport } from './nodeTransport';

/**
 * REAL backend: the Manager's TypeScript client against the packaged awake-core-host.exe and the
 * public Modrinth API. Opt-in only, with a disposable profile:
 *   AWAKE_REAL_HELPER=<...>/awake-core-host.exe AWAKE_REAL_PROFILE=<new empty dir> npx vitest run tests/realHelper
 */
const exe = process.env.AWAKE_REAL_HELPER;
const profile = process.env.AWAKE_REAL_PROFILE;
const EXTRA = 'PtjYWJkn'; // Sodium Extra
const EXTRA_OLD = 'YEWu6red';
const SODIUM = 'AANobbMI';

const sha512 = (f: string) => createHash('sha512').update(readFileSync(f)).digest('hex');
async function modrinthFiles(versionId: string): Promise<{ filename: string; sha512: string }[]> {
  const r = await fetch(`https://api.modrinth.com/v2/version/${versionId}`, { headers: { 'User-Agent': 'awake-modpack-manager-tests' } });
  const files = ((await r.json()) as { files: { filename: string; primary: boolean; hashes: { sha512: string } }[] }).files;
  // The primary file is the one a mod install uses.
  return [files.find((f) => f.primary) ?? files[0]!].map((f) => ({ filename: f.filename, sha512: f.hashes.sha512 }));
}
/** Every .jar / .jar.disabled under the workspace's mods folder. */
function modFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (!n.startsWith('.awake') && n !== '.index') walk(p); } else if (/\.jar(\.disabled)?$/i.test(n) && /[\\/]mods$/.test(d)) out.push(p);
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!exe || !profile)('REAL helper + Modrinth (opt-in)', () => {
  it('creates a Fabric workspace, installs Sodium Extra with Sodium, updates, toggles, removes, and survives a reconnect', async () => {
    const t = nodeHelperTransport(exe!, profile!);
    const client = () => createHelperClient({ transport: t, clientVersion: 'real-test', pollMs: 300, startTimeoutMs: 60_000, requestTimeoutMs: 60_000 });
    const session = createSession(client(), { pollMs: 300 });
    await session.connect();
    const hs = session.state.handshake!;
    expect(hs, session.state.connectError?.message).toBeTruthy();
    expect(hs.stub).toBeFalsy();
    expect(hs.capabilities).toEqual(expect.arrayContaining(['instances.create', 'providers.search', 'plan.validate', 'plan.apply']));

    const cat = await session.backend.versionCatalog!({ minecraftVersion: '1.21.1', loader: 'fabric' });
    expect(cat.minecraftVersions).toContain('1.21.1');
    expect(cat.loaderVersions.length).toBeGreaterThan(0);
    const created = await session.createInstance({ name: 'Real test pack', minecraftVersion: '1.21.1', loader: 'fabric', loaderVersion: cat.loaderVersions[0]! });
    expect(created?.state, JSON.stringify(created?.error)).toBe('completed');
    await session.refreshInstances();
    const inst = session.state.instances.find((i) => i.name === 'Real test pack')!;
    expect(inst).toBeTruthy();
    await session.selectInstance(inst.id);

    const page = await session.backend.search({ text: 'Sodium Extra', provider: 'modrinth', minecraftVersion: '1.21.1', loader: 'fabric', releaseTypes: ['release'], compatibleOnly: true, offset: 0, limit: 20 });
    expect(page.hits.some((h) => h.projectId === EXTRA), JSON.stringify(page.hits.slice(0, 3))).toBe(true);
    const versions = await session.backend.projectVersions!(inst.id, 'modrinth', EXTRA);
    expect(versions.some((v) => v.id === EXTRA_OLD)).toBe(true);

    // Install the older exact version so a real update exists afterwards.
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: EXTRA, name: 'Sodium Extra', versionId: EXTRA_OLD }));
    await session.validate();
    expect(session.review.phase, session.review.error?.message).toBe('reviewed');
    const plan = session.review.plan!;
    console.log('plan items:', plan.items.map((i) => `${i.action} ${i.name}`), 'issues:', plan.issues.map((i) => `${i.code}: ${i.message}`));
    expect(plan.items.length).toBe(2);
    expect(plan.issues.some((i) => i.code === 'dependency-included')).toBe(true);
    await session.apply();
    expect(session.review.phase, session.review.error?.message ?? JSON.stringify(session.review.operation)).toBe('done');
    await session.loadInventory();
    let mods = session.inventory.value!.mods;
    console.log('inventory:', mods.map((m) => `${m.name} ${m.projectId} ${m.installed?.id} enabled=${m.enabled} update=${m.available?.id ?? '-'}`));
    expect(mods.map((m) => m.projectId).sort()).toEqual([SODIUM, EXTRA].sort());
    // Checked with no newer stable release: up to date (available = installed).
    const sodium = mods.find((m) => m.projectId === SODIUM)!;
    expect(sodium.available?.id).toBe(sodium.installed?.id);

    // Real files on disk match Modrinth's published SHA-512.
    const files = modFiles(join(profile!, 'workspaces'));
    const expected = [...await modrinthFiles(EXTRA_OLD), ...await modrinthFiles(mods.find((m) => m.projectId === SODIUM)!.installed!.id)];
    for (const f of expected) {
      const onDisk = files.find((p) => p.endsWith(f.filename));
      expect(onDisk, f.filename).toBeTruthy();
      expect(sha512(onDisk!)).toBe(f.sha512);
    }
    console.log('verified files:', files);

    // Update to the newest compatible release the helper offers.
    const extra = mods.find((m) => m.projectId === EXTRA)!;
    expect(extra.available?.id).toBeTruthy();
    session.setDraft(addChange(session.draft.value!, { kind: 'update', modKey: extra.key, targetVersionId: extra.available!.id }));
    await session.validate();
    expect(session.review.phase, session.review.error?.message).toBe('reviewed');
    await session.apply();
    expect(session.review.phase, session.review.error?.message).toBe('done');
    await session.loadInventory();
    mods = session.inventory.value!.mods;
    expect(mods.find((m) => m.projectId === EXTRA)!.installed!.id).toBe(extra.available!.id);

    // Disable, then (in a fresh client: reconnect + hello) enable, then remove.
    const run = async (s: typeof session, changes: Parameters<typeof addChanges>[1]) => {
      s.setDraft(addChanges(s.draft.value!, changes));
      await s.validate();
      expect(s.review.phase, s.review.error?.message).toBe('reviewed');
      await s.apply();
      expect(s.review.phase, s.review.error?.message).toBe('done');
      await s.loadInventory();
      return s.inventory.value!.mods;
    };
    mods = await run(session, [{ kind: 'disable', modKey: mods.find((m) => m.projectId === EXTRA)!.key }]);
    // (Removing Sodium now is refused by the helper: Sodium Extra declares it as required.)
    // Leave a prepared, never-applied plan behind (enable Extra) for the next session to clean up.
    session.setDraft(addChange(session.draft.value!, { kind: 'enable', modKey: mods.find((m) => m.projectId === EXTRA)!.key }));
    await session.validate();
    const leftover = session.review.plan!.planId;
    expect((await session.backend.getOperation(leftover)).state).toBe('prepared');
    session.discardDraft();
    expect(mods.find((m) => m.projectId === EXTRA)!.enabled).toBe(false);
    expect(modFiles(join(profile!, 'workspaces')).some((p) => p.endsWith('.jar.disabled'))).toBe(true);

    const again = createSession(client(), { pollMs: 300 });
    await again.connect();
    await again.selectInstance(inst.id);
    expect((await again.backend.getOperation(leftover)).state, 'leftover plan cancelled at connect').toBe('cancelled');
    expect(again.inventory.value!.mods.find((m) => m.projectId === EXTRA)!.enabled).toBe(false);
    mods = await run(again, [{ kind: 'enable', modKey: again.inventory.value!.mods.find((m) => m.projectId === EXTRA)!.key }]);
    expect(mods.find((m) => m.projectId === EXTRA)!.enabled).toBe(true);
    mods = await run(again, [{ kind: 'remove', modKey: mods.find((m) => m.projectId === EXTRA)!.key }]);
    expect(mods.map((m) => m.projectId)).toEqual([SODIUM]);
    const ops = await again.backend.listOperations(inst.id);
    console.log('operations:', ops.map((o) => `${o.kind} ${o.state}`));
  }, 600_000);
});
