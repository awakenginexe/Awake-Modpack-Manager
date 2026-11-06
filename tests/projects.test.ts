import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProjectStore, LEGACY_KEY, localPersistence, parseStore, serializeStore, STORE_VERSION } from '../src/state/projects';

const memStorage = () => {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const memory = (st = memStorage()) => localPersistence(st, 'v1');
const open = async (primary = memory(), legacy: ReturnType<typeof memory> | null = null) => {
  const s = createProjectStore(primary, legacy);
  await s.ready;
  return s;
};
const mrpack = () => new Blob([readFileSync('tests/fixtures/packs/large-300.mrpack') as BlobPart]);

describe('project store (Manager drafts)', () => {
  it('persists projects in the versioned format and reloads them', async () => {
    const storage = memory();
    const a = await open(storage);
    const p = a.create({ name: 'My pack', minecraftVersion: '1.21.1', loader: { kind: 'fabric', version: '0.16.9' } });
    a.addPlanned(p.id, { provider: 'modrinth', projectId: 'sodium', versionId: 'abc' });
    await a.flush();
    expect(parseStore((await storage.read())!).version).toBe(STORE_VERSION);
    const b = await open(storage);
    expect(b.projects.value[0]?.mods).toEqual([expect.objectContaining({ key: 'mr:sodium', verified: false, origin: 'planned', pinned: true, versionId: 'abc' })]);
  });

  it('reports a failed save instead of losing it silently', async () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    const s = await open(localPersistence(storage, 'v1'));
    s.create({ name: 'x', minecraftVersion: '1.21.1', loader: { kind: 'vanilla', version: '' } });
    await s.flush();
    expect(s.saveError.value).toMatch(/Quota/);
    expect(s.projects.value).toHaveLength(1); // still on screen
  });

  it('imports a 300-mod pack only after adopt, and bulk edits it', async () => {
    const s = await open();
    const preview = await s.preview(mrpack(), 'large-300.mrpack');
    expect(s.projects.value).toHaveLength(0);
    s.adopt(preview);
    const id = s.selected.value!.id;
    const keys = new Set(s.selected.value!.mods.slice(0, 50).map((m) => m.key));
    s.setPinned(id, keys, true);
    expect(s.selected.value!.mods.filter((m) => m.pinned)).toHaveLength(50);
    s.removeMods(id, new Set([...keys].slice(0, 10)));
    expect(s.selected.value!.mods).toHaveLength(291);
  });

  it('drops verified file data when the version changes, so it cannot be exported as verified', async () => {
    const s = await open();
    s.adopt(await s.preview(mrpack(), 'large-300.mrpack'));
    const p = s.selected.value!;
    const m = p.mods[0]!;
    s.setVersion(p.id, m.key, 'NEWVERSION');
    const changed = s.selected.value!.mods[0]!;
    expect(changed).toMatchObject({ versionId: 'NEWVERSION', verified: false, pinned: true, file: undefined });
    const plan = s.plan(s.selected.value!, 'mrpack', new Set());
    expect(plan.ready).toBe(false);
    expect(plan.blockers.every((b) => b.modKey === m.key)).toBe(true);
    expect(s.plan(s.selected.value!, 'mrpack', new Set([m.key])).ready).toBe(true);
  });

  it('uses projects from the old location in place until the user moves them, and keeps the old copy', async () => {
    const old = memStorage();
    old.setItem(LEGACY_KEY, JSON.stringify([{ id: 'a', name: 'Old', mods: [] }]));
    const primary = memory();
    const s = await open(primary, localPersistence(old, LEGACY_KEY));
    expect(s.legacyPending.value).toBe(true);
    expect(s.projects.value.map((p) => p.name)).toEqual(['Old']);
    expect(await primary.read()).toBeNull(); // nothing migrated automatically
    await s.moveLegacy();
    expect(s.legacyPending.value).toBe(false);
    expect(parseStore((await primary.read())!).projects.map((p) => p.name)).toEqual(['Old']);
    expect(old.getItem(LEGACY_KEY)).toContain('Old'); // old copy untouched
    const again = await open(primary, localPersistence(old, LEGACY_KEY));
    expect(again.legacyPending.value).toBe(false);
  });

  it('never overwrites a store from a newer Manager or one it cannot read', async () => {
    const newer = memory();
    await newer.write(JSON.stringify({ format: 'awake-mm-projects', schemaVersion: STORE_VERSION + 1, projects: [{ id: 'n', name: 'Future', mods: [] }] }));
    const s = await open(newer);
    expect(s.readOnly.value).toBe('newer');
    s.create({ name: 'x', minecraftVersion: '1.21.1', loader: { kind: 'vanilla', version: '' } });
    await s.flush();
    expect(s.projects.value.map((p) => p.name)).toEqual(['Future']);
    expect(parseStore((await newer.read())!).version).toBe(STORE_VERSION + 1);

    const broken = memory();
    await broken.write('{not json');
    const b = await open(broken);
    expect(b.readOnly.value).toBe('unreadable');
    b.create({ name: 'x', minecraftVersion: '1.21.1', loader: { kind: 'vanilla', version: '' } });
    await b.flush();
    expect(await broken.read()).toBe('{not json');
    expect(() => parseStore(serializeStore([]))).not.toThrow();
  });
});
