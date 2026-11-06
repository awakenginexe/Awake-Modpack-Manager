import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProjectStore } from '../src/state/projects';

const memory = () => {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const mrpack = () => new Blob([readFileSync('tests/fixtures/packs/large-300.mrpack') as BlobPart]);

describe('project store (Manager drafts)', () => {
  it('persists projects and reloads them', () => {
    const storage = memory();
    const a = createProjectStore(storage);
    const p = a.create({ name: 'My pack', minecraftVersion: '1.21.1', loader: { kind: 'fabric', version: '0.16.9' } });
    a.addPlanned(p.id, { provider: 'modrinth', projectId: 'sodium', versionId: 'abc' });
    const b = createProjectStore(storage);
    expect(b.projects.value[0]?.mods).toEqual([expect.objectContaining({ key: 'mr:sodium', verified: false, origin: 'planned', pinned: true, versionId: 'abc' })]);
  });

  it('reports a failed save instead of losing it silently', () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    const s = createProjectStore(storage);
    s.create({ name: 'x', minecraftVersion: '1.21.1', loader: { kind: 'vanilla', version: '' } });
    expect(s.saveError.value).toMatch(/Quota/);
    expect(s.projects.value).toHaveLength(1); // still on screen
  });

  it('imports a 300-mod pack only after adopt, and bulk edits it', async () => {
    const s = createProjectStore(memory());
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
    const s = createProjectStore(memory());
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
});
