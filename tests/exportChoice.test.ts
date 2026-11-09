import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { InstalledMod, WorkspaceExportItem, WorkspaceSnapshot } from '../src/backend/contract';
import { MockBackend } from '../src/backend/mock/MockBackend';
import WorkspaceExport from '../src/components/WorkspaceExport.vue';
import { fitCount, fits, neededBy, recommend, toCandidates, undecided, type ExportCandidate } from '../src/domain/exportChoice';
import { createSession, SessionKey } from '../src/state/session';

const mod = (key: string, source: InstalledMod['source'], extra: Partial<InstalledMod> = {}): InstalledMod => ({
  key, fileName: `${key}.jar`, name: key, source, projectId: source === 'manual' ? undefined : key, installed: source === 'manual' ? null : { id: `${key}-v`, name: '1' }, enabled: true, ...extra,
});
const list = (...mods: InstalledMod[]): ExportCandidate[] => toCandidates(mods);

describe('which format fits a pack', () => {
  it('recommends the provider format only when it holds the whole pack', () => {
    expect(recommend(list(mod('a', 'curseforge'), mod('b', 'curseforge')))).toBe('curseforge');
    expect(recommend(list(mod('a', 'modrinth')))).toBe('mrpack');
    expect(recommend(list(mod('a', 'modrinth'), mod('b', 'curseforge')))).toBe('instance');
    expect(recommend(list(mod('a', 'curseforge'), mod('m', 'manual')))).toBe('instance');
  });

  it('counts an Instance zip as holding everything', () => {
    const pack = list(mod('a', 'modrinth'), mod('b', 'curseforge'), mod('m', 'manual'));
    expect([fitCount(pack, 'mrpack'), fitCount(pack, 'curseforge'), fitCount(pack, 'instance')]).toEqual([1, 1, 3]);
  });

  it('does not let a changed file claim to be the provider file', () => {
    expect(fits(list(mod('a', 'modrinth', { locallyModified: true }))[0]!, 'mrpack')).toBe(false);
  });

  it('only lists real mod files', () => {
    expect(toCandidates([mod('a', 'modrinth'), mod('dir', 'manual', { kind: 'directory' })]).map((c) => c.key)).toEqual(['a']);
  });

  it('counts only undecided misfits as blocking', () => {
    const pack = list(mod('a', 'modrinth'), mod('b', 'curseforge'), mod('c', 'curseforge'));
    expect(undecided(pack, 'mrpack', {}).map((c) => c.key)).toEqual(['b', 'c']);
    expect(undecided(pack, 'mrpack', { b: { kind: 'leave-out' } }).map((c) => c.key)).toEqual(['c']);
  });

  it('warns when a mod that stays needs one that is left out', () => {
    const lib = mod('lib', 'curseforge');
    const user = mod('user', 'modrinth', { dependencies: [{ kind: 'required', projectId: 'lib', name: 'Lib', state: 'satisfied' }] });
    const pack = list(lib, user);
    expect(neededBy(pack[0]!, pack, {}).map((c) => c.key)).toEqual(['user']);
    expect(neededBy(pack[0]!, pack, { user: { kind: 'leave-out' } })).toEqual([]);
  });
});

describe('the workspace export screen', () => {
  async function screen(mods: InstalledMod[], over: Record<string, unknown> = {}) {
    localStorage.clear();
    const backend = new MockBackend({ stepMs: 1, latencyMs: 0 });
    const session = createSession(backend, { pollMs: 5 });
    await session.connect();
    await session.selectInstance('inst-atlas');
    session.inventory.value = { ...session.inventory.value!, mods };
    const prepared: WorkspaceExportItem[][] = [];
    Object.assign(backend, {
      exportMatches: async (_: string, __: string, names: string[]) => names.filter((n) => n.startsWith('twin')).map((fileName) => ({ fileName, projectId: 'p', versionId: 'v', versionName: '1', remoteFileName: fileName, size: 1, sha1: 'a', url: 'https://cdn.modrinth.com/x' })),
      exportRestricted: async () => [],
      prepareExport: async (_: string, __: string, items: WorkspaceExportItem[]): Promise<WorkspaceSnapshot> => { prepared.push(items); return { name: 'P', minecraftVersion: '1.20.1', loader: { kind: 'forge', version: '47' }, mods: [], skipped: [] }; },
      ...over,
    });
    const wrapper = mount(WorkspaceExport, { attachTo: document.body, global: { provide: { [SessionKey as symbol]: session } } });
    await flushPromises();
    return { wrapper, prepared };
  }
  const button = (w: ReturnType<typeof mount>, text: string) => w.findAll('button').find((b) => b.text().includes(text));
  const pick = async (w: ReturnType<typeof mount>, index: number) => { await w.findAll('input[name="workspace-format"]')[index]!.trigger('change'); await flushPromises(); };

  it('starts on the recommended format and says how much fits', async () => {
    const { wrapper } = await screen([mod('a', 'modrinth'), mod('b', 'curseforge')]);
    expect(wrapper.find('.format.active').text()).toContain('Instance');
    expect(wrapper.text()).toContain('1 of 2 mods fit');
    expect(wrapper.text()).toContain('backups');
    wrapper.unmount();
  });

  it('marks identical files itself and blocks Prepare until the rest are decided', async () => {
    const { wrapper, prepared } = await screen([mod('a', 'modrinth'), mod('twin', 'curseforge'), mod('solo', 'curseforge')]);
    await pick(wrapper, 0);
    expect(wrapper.text()).toContain('1 mods still need a decision');
    expect(button(wrapper, 'Prepare export')!.attributes('disabled')).toBeDefined();
    await button(wrapper, 'Leave out')!.trigger('click');
    await flushPromises();
    expect(button(wrapper, 'Prepare export')!.attributes('disabled')).toBeUndefined();
    await button(wrapper, 'Prepare export')!.trigger('click');
    await flushPromises();
    expect(prepared[0]!.map((e) => [e.kind, e.fileName])).toEqual([['installed', 'a.jar'], ['matched', 'twin.jar']]);
    wrapper.unmount();
  });

  it('lets you search the other site and use a version in place', async () => {
    const { wrapper, prepared } = await screen([mod('a', 'modrinth'), mod('solo', 'curseforge')], {
      search: async () => ({ total: 1, hits: [{ provider: 'modrinth', projectId: 'mr-solo', name: 'Solo', author: '', summary: 'same mod', compatible: true }] }),
      projectVersions: async () => [{ id: 'v2', name: '2', versionNumber: '2.0', gameVersions: [], loaders: [], dependencies: [{ projectId: 'other', versionId: null, type: 'required' }] }],
    });
    await pick(wrapper, 0);
    await button(wrapper, 'Find on Modrinth')!.trigger('click');
    await flushPromises();
    await wrapper.find('.hit').trigger('click');
    await flushPromises();
    await button(wrapper, 'Use this version')!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('also needs 1 more mods');
    await wrapper.find('input[type="checkbox"]').setValue(false);
    expect(wrapper.text()).toContain('Replaced by you');
    await button(wrapper, 'Prepare export')!.trigger('click');
    await flushPromises();
    expect(prepared[0]![1]).toMatchObject({ kind: 'replaced', fileName: 'solo.jar', projectId: 'mr-solo', versionId: 'v2' });
    wrapper.unmount();
  });

  it('says so in place when a search fails', async () => {
    const { wrapper } = await screen([mod('a', 'modrinth'), mod('solo', 'curseforge')], { search: async () => { throw new Error('curseforge-unauthorized'); } });
    await pick(wrapper, 0);
    await button(wrapper, 'Find on Modrinth')!.trigger('click');
    await flushPromises();
    expect(wrapper.find('.search-panel').text()).toContain('Search failed.');
    expect(wrapper.text()).not.toContain('curseforge-unauthorized');
    wrapper.unmount();
  });

  it('keeps working when the automatic check is unavailable', async () => {
    const { wrapper } = await screen([mod('a', 'modrinth'), mod('b', 'curseforge')], { exportMatches: async () => { throw new Error('offline'); } });
    await pick(wrapper, 0);
    expect(wrapper.text()).toContain("isn't available");
    expect(button(wrapper, 'Find on Modrinth')).toBeDefined();
    wrapper.unmount();
  });
});
