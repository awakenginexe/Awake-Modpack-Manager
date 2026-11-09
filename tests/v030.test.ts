import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHelperClient } from '../src/backend/helper/HelperClient';
import type { HostApi } from '../src/backend/host';
import { addChange } from '../src/domain/draft';
import { createSession } from '../src/state/session';
import { FakeCore, FIXTURE_IMPORT } from './fixtures/fakeCore';

const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const bytes = new Uint8Array([1, 2, 3, 4]);

function fakeHost(over: Partial<HostApi> = {}): HostApi {
  return {
    packProviders: async () => (['modrinth', 'curseforge', 'ftb', 'atlauncher', 'technic'] as const).map((id) => ({ id, available: true })),
    packSearch: async () => ({ hits: [], total: 0 }),
    packVersions: async () => [{ id: 'v2', name: '2.0', minecraftVersion: '1.20.1', releaseType: 'release' }, { id: 'v1', name: '1.0', minecraftVersion: '1.20.1', releaseType: 'release' }],
    packFetch: async () => ({ token: 't.pack', format: 'mrpack', size: bytes.length, sha256: 'ab'.repeat(32), notes: ['A note'] }),
    packCancel: async () => undefined,
    packRead: async (_t, offset, length) => bytes.subarray(offset, offset + length),
    packDiscard: vi.fn(async () => undefined),
    projectMeta: async () => [],
    projectDetail: async () => ({ author: '', summary: '', downloads: null, updatedAt: null, license: null, categories: [], pageUrl: null }),
    modUpdates: async () => [],
    workspaceList: async () => [],
    workspaceRecycle: async () => undefined,
    workspaceOpen: async () => undefined,
    exportMatch: async () => [],
    exportInstance: async () => null,
    ...over,
  };
}
let core: FakeCore;
beforeEach(() => localStorage.clear());
afterEach(() => expect(core.violations).toEqual([]));

function start(host = fakeHost(), setup?: (c: FakeCore) => void) {
  core = new FakeCore();
  core.capabilities['core.shutdown'] = true;
  setup?.(core);
  return createSession(createHelperClient({ transport: core, clientVersion: 'test', pollMs: 1, host }), { pollMs: 1 });
}

describe('catalog modpack install', () => {
  it('fetches, uploads, creates a matching project, applies, and remembers the pack', async () => {
    const session = start();
    await session.connect();
    expect(session.can('packs.search') && session.can('packs.install')).toBe(true);
    const final = await session.installPack({ provider: 'modrinth', packId: 'pack', versionId: 'v1', instanceName: 'New Pack' });
    expect(final?.error?.message).toBeUndefined();
    expect(final?.state).toBe('completed');
    expect(final?.notes).toContain('A note');
    expect(session.instance.value?.name).toBe('New Pack');
    expect(session.instance.value?.pack).toMatchObject({ provider: 'modrinth', packId: 'pack', versionId: 'v1', versionName: '1.0' });
    expect(core.prepareRequests.at(-1)).toMatchObject({ packAuthoritative: true });
  });

  it('leaves no empty project behind when the pack cannot be prepared', async () => {
    const discard = vi.fn(async () => undefined);
    const session = start(fakeHost({ packDiscard: discard }), (c) => { c.failImportPrepare = true; });
    await session.connect();
    const final = await session.installPack({ provider: 'modrinth', packId: 'pack', versionId: 'v1', instanceName: 'Broken' });
    expect(final?.state).toBe('failed');
    expect(core.workspaces.size).toBe(0);
    expect(discard).toHaveBeenCalledWith('t.pack');
  });

  it('reports a provider-only download as such, without creating anything', async () => {
    const session = start(fakeHost({ packFetch: async () => { throw Object.assign(new Error('https://www.curseforge.com/x'), { code: 'manual-download', detail: 'manual-download' }); } }));
    await session.connect();
    const final = await session.installPack({ provider: 'curseforge', packId: '1', versionId: '2', instanceName: 'CF' });
    expect(final?.state).toBe('failed');
    expect(core.workspaces.size).toBe(0);
  });
});

describe('deleting and renaming projects', () => {
  it('deletes through the helper and forgets everything kept about the project', async () => {
    const session = start();
    core.addWorkspace('Doomed');
    await session.connect();
    const id = session.state.instances[0]!.id;
    await session.selectInstance(id);
    session.setDraft(addChange(session.draft.value!, { kind: 'remove', modKey: 'whatever' }));
    const final = await session.deleteInstance(id);
    expect(final?.state).toBe('completed');
    expect(final?.kind).toBe('delete-instance');
    expect(core.workspaces.size).toBe(0);
    expect(session.state.instances).toEqual([]);
    expect(session.state.instanceId).toBeNull();
    expect(session.drafts.value[id]).toBeUndefined();
  });

  it('renames through the helper', async () => {
    const session = start();
    core.addWorkspace('Old');
    await session.connect();
    await session.renameInstance(session.state.instances[0]!.id, 'New name');
    expect(session.state.instances[0]!.name).toBe('New name');
  });

  it('cannot delete an instance the Manager does not own', async () => {
    const session = start();
    core.addWorkspace('Mine');
    await session.connect();
    core.extCaps['workspaces.delete'] = false;
    await session.connect();
    expect(session.can('instances.delete')).toBe(false);
  });
});

describe('mod updates and icons', () => {
  function withMods(host: HostApi) {
    const session = start(host);
    const w = core.addWorkspace('Pack');
    w.mods.push(core.installed('a', 'alpha', 'old', '1.0'));
    return session;
  }

  it('shows the list first, then fills updates from the batched lookup', async () => {
    const modUpdates = vi.fn(async () => [{ provider: 'modrinth' as const, projectId: 'alpha', installedVersionId: 'old', candidate: { id: 'new', name: '2.0', releaseType: 'release' as const } }]);
    const session = withMods(fakeHost({ modUpdates }));
    await session.connect();
    await session.selectInstance(session.state.instances[0]!.id);
    await wait();
    expect(modUpdates).toHaveBeenCalledTimes(1);
    expect(core.calls.filter((m) => m === 'updates.check')).toEqual([]);
    expect(session.inventory.value!.mods.find((m) => m.projectId === 'alpha')!.available?.id).toBe('new');
  });

  it('does not repeat a recent check unless asked', async () => {
    const modUpdates = vi.fn(async () => []);
    const session = withMods(fakeHost({ modUpdates }));
    await session.connect();
    await session.selectInstance(session.state.instances[0]!.id);
    await wait();
    await session.loadInventory();
    await wait();
    expect(modUpdates).toHaveBeenCalledTimes(1);
    await session.checkUpdates(true);
    expect(modUpdates).toHaveBeenCalledTimes(2);
  });

  it('backfills icons for projects remembered before they had one', async () => {
    localStorage.setItem('awake-mm:core-titles', JSON.stringify({ 'modrinth:alpha': { name: 'Alpha' } }));
    const projectMeta = vi.fn(async () => [{ provider: 'modrinth' as const, projectId: 'alpha', name: 'Alpha', iconUrl: 'https://cdn.example/a.png' }]);
    const session = withMods(fakeHost({ projectMeta }));
    await session.connect();
    await session.selectInstance(session.state.instances[0]!.id);
    expect(projectMeta).toHaveBeenCalledTimes(1);
    expect(session.inventory.value!.mods.find((m) => m.projectId === 'alpha')!.iconUrl).toBe('https://cdn.example/a.png');
  });
});

it('fixture still describes a pack the install flow can create', () => {
  core = new FakeCore();
  expect(FIXTURE_IMPORT.loader.id).toBe('forge');
});
