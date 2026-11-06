import { describe, expect, it } from 'vitest';
import type { InstalledMod } from '../src/backend/contract';
import { addChange, isStale, newDraft, rebase } from '../src/domain/draft';
import { filterMods, sortMods, emptyFilter, hasUpdate } from '../src/domain/modList';
import { emptySelection, prune, selectAll, selectRange, toggle } from '../src/domain/selection';

const v = (id: string) => ({ id, name: id, releaseType: 'release' as const });
const mod = (key: string, over: Partial<InstalledMod> = {}): InstalledMod => ({
  key, fileName: `${key}.jar`, name: key, source: 'modrinth', projectId: key, installed: v('1'), available: v('1'), enabled: true, dependencies: [], ...over,
});

const mods = [
  mod('zeta', { available: v('2') }),
  mod('alpha', { enabled: false }),
  mod('Beta'),
  mod('file:custom.jar', { name: 'custom', source: 'manual', installed: null, available: undefined }),
  mod('gamma', { dependencies: [{ kind: 'required', name: 'x', state: 'missing' }] }),
];

describe('filterMods / sortMods', () => {
  it('filters by status, source and text', () => {
    const none = new Set<string>();
    expect(filterMods(mods, { ...emptyFilter(), status: 'updates' }, none).map((m) => m.key)).toEqual(['zeta']);
    expect(filterMods(mods, { ...emptyFilter(), status: 'disabled' }, none).map((m) => m.key)).toEqual(['alpha']);
    expect(filterMods(mods, { ...emptyFilter(), status: 'manual' }, none).map((m) => m.key)).toEqual(['file:custom.jar']);
    expect(filterMods(mods, { ...emptyFilter(), status: 'issues' }, none).map((m) => m.key)).toEqual(['gamma']);
    expect(filterMods(mods, { ...emptyFilter(), status: 'pinned' }, new Set(['Beta'])).map((m) => m.key)).toEqual(['Beta']);
    expect(filterMods(mods, { ...emptyFilter(), source: 'manual' }, none)).toHaveLength(1);
    expect(filterMods(mods, { ...emptyFilter(), text: 'CUSTOM.J' }, none)).toHaveLength(1);
  });

  it('sorts case-insensitively and by status', () => {
    expect(sortMods(mods, 'name').map((m) => m.name)).toEqual(['alpha', 'Beta', 'custom', 'gamma', 'zeta']);
    expect(sortMods(mods, 'name', true)[0]!.name).toBe('zeta');
    expect(sortMods(mods, 'status').slice(0, 3).map((m) => m.key)).toEqual(['gamma', 'zeta', 'alpha']);
  });

  it('does not treat manual files as having updates', () => {
    expect(hasUpdate(mods[3]!)).toBe(false);
  });

  it('filters and sorts 300 mods quickly', () => {
    const many = Array.from({ length: 300 }, (_, i) => mod(`m${i}`, { available: v(i % 3 ? '1' : '2') }));
    const start = performance.now();
    for (let i = 0; i < 50; i++) sortMods(filterMods(many, { ...emptyFilter(), text: 'm1' }, new Set()), 'name');
    // Sanity bound, not a benchmark: 50 passes should be far under a frame budget each.
    expect((performance.now() - start) / 50).toBeLessThan(16);
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('toggles, range-selects and selects all', () => {
    let s = toggle(emptySelection(), 'b');
    s = selectRange(s, 'd', order);
    expect([...s.keys].sort()).toEqual(['b', 'c', 'd']);
    s = toggle(s, 'c');
    expect(s.keys.has('c')).toBe(false);
    expect(selectAll(emptySelection(), order).keys.size).toBe(5);
  });
  it('prunes keys that no longer exist', () => {
    const s = selectAll(emptySelection(), order);
    expect([...prune(s, new Set(['a', 'e'])).keys]).toEqual(['a', 'e']);
    expect(prune(s, new Set(order))).toBe(s);
  });
});

describe('draft', () => {
  it('replaces superseded changes', () => {
    let d = newDraft('i', 'r1');
    d = addChange(d, { kind: 'update', modKey: 'a', targetVersionId: '2' });
    d = addChange(d, { kind: 'disable', modKey: 'a' });
    expect(d.changes.map((c) => c.kind)).toEqual(['update', 'disable']);
    d = addChange(d, { kind: 'enable', modKey: 'a' });
    expect(d.changes.map((c) => c.kind)).toEqual(['update', 'enable']);
    d = addChange(d, { kind: 'remove', modKey: 'a' });
    expect(d.changes.map((c) => c.kind)).toEqual(['remove']);
    d = addChange(d, { kind: 'update', modKey: 'a', targetVersionId: '3' });
    expect(d.changes.map((c) => c.kind)).toEqual(['update']);
  });

  it('rebases a stale draft and drops changes that no longer apply', () => {
    const d = { ...newDraft('i', 'r1'), changes: [
      { kind: 'update' as const, modKey: 'zeta', targetVersionId: '2' },
      { kind: 'update' as const, modKey: 'gone', targetVersionId: '2' },
      { kind: 'enable' as const, modKey: 'Beta' },
      { kind: 'install' as const, provider: 'modrinth' as const, projectId: 'alpha', name: 'alpha' },
    ] };
    expect(isStale(d, 'r2')).toBe(true);
    const { draft, dropped } = rebase(d, 'r2', mods);
    expect(draft.baseRevision).toBe('r2');
    expect(draft.changes).toHaveLength(1);
    expect(dropped).toHaveLength(3); // missing mod, already enabled, already installed
  });
});
