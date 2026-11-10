import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createHelperClient } from '../src/backend/helper/HelperClient';
import type { HostApi } from '../src/backend/host';
import { BackendError } from '../src/backend/contract';
import { MockBackend } from '../src/backend/mock/MockBackend';
import { filesArea } from '../src/state/nav';
import { createSession, SessionKey } from '../src/state/session';
import { dialog, settleDialog, toasts } from '../src/ui/desktop';
import ContentBrowseView from '../src/views/ContentBrowseView.vue';
import FilesView from '../src/views/FilesView.vue';
import { FakeCore } from './fixtures/fakeCore';

async function demo() {
  localStorage.clear();
  toasts.splice(0);
  filesArea.value = 'config';
  const backend = new MockBackend({ stepMs: 1, latencyMs: 0, providers: [{ id: 'modrinth', available: true }, { id: 'curseforge', available: true }] });
  const session = createSession(backend, { pollMs: 5 });
  await session.connect();
  await session.selectInstance('inst-atlas');
  return { backend, session, provide: { global: { provide: { [SessionKey as symbol]: session } } } };
}
/** Demo calls answer on a timer, like real ones. */
const settle = async () => { for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 4)); await flushPromises(); } };
const names = (w: ReturnType<typeof mount>) => w.findAll('.entries .path').map((e) => e.text());

describe('files of a Launcher instance managed here', () => {
  it('are listed, read and changed through the desktop host, by the workspace it registered', async () => {
    const core = new FakeCore();
    const added = core.addWorkspace('Sagi');
    Object.assign(added.ws, { sharedRoot: 'E:/Launcher/instances/Sagi' });
    const host = {
      packProviders: async () => [{ id: 'modrinth', available: true }, { id: 'curseforge', available: false }],
      workspaceList: vi.fn(async () => [{ path: 'jei', kind: 'directory' as const }, { path: 'fml.toml', kind: 'file' as const, sizeBytes: 9, modifiedMs: 1_700_000_000_000 }]),
      workspaceReadText: vi.fn(async () => ({ text: 'a = 1', modifiedMs: 5 })),
      workspaceWriteText: vi.fn(async () => 6),
      contentInstall: vi.fn(async () => ({ fileName: 'BSL.zip', replaced: false })),
    } as unknown as HostApi;
    const client = createHelperClient({ transport: core, clientVersion: 'test', heartbeatMs: 0, host });
    const handshake = await client.connect();
    expect(handshake.capabilities).toEqual(expect.arrayContaining(['files.read', 'files.write', 'content.browse']));
    const instance = (await client.listInstances('manager')).find((i) => i.sharedRoot)!;
    const id = added.ws.workspaceId;

    // 1.2.3 refused this for every connected Launcher instance.
    const list = await client.listContent(instance.id, 'config', 'jei');
    expect(host.workspaceList).toHaveBeenCalledExactlyOnceWith(id, 'config', 'jei');
    expect(list).toEqual([{ path: 'jei', kind: 'directory' }, { path: 'fml.toml', kind: 'file', sizeBytes: 9, modifiedAt: new Date(1_700_000_000_000).toISOString() }]);

    expect(await client.readContentText!(instance.id, 'config', 'fml.toml')).toEqual({ text: 'a = 1', modifiedMs: 5 });
    expect(await client.writeContentText!(instance.id, 'config', 'fml.toml', 'a = 2', 5)).toBe(6);
    expect(host.workspaceWriteText).toHaveBeenCalledExactlyOnceWith(id, 'config', 'fml.toml', 'a = 2', 5);
    await client.installContent!(instance.id, 'shader', 'modrinth', 'proj', 'ver');
    expect(host.contentInstall).toHaveBeenCalledExactlyOnceWith(id, 'shader', 'modrinth', 'proj', 'ver', undefined);
    expect(await client.contentProviders!()).toEqual([{ id: 'modrinth', available: true, unavailableReason: undefined }, { id: 'curseforge', available: false, unavailableReason: 'curseforge-disabled' }]);
    expect(core.violations).toEqual([]);
  });

  it('are not offered without the desktop host', async () => {
    const core = new FakeCore();
    core.addWorkspace('Plain');
    const client = createHelperClient({ transport: core, clientVersion: 'test', heartbeatMs: 0 });
    const handshake = await client.connect();
    expect(handshake.capabilities).not.toContain('files.write');
    const [instance] = await client.listInstances('manager');
    await expect(client.listContent(instance!.id, 'config')).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('Files page', () => {
  it('walks folders, folders first, and filters the one on screen', async () => {
    const { provide } = await demo();
    const wrapper = mount(FilesView, provide);
    await settle();
    const top = names(wrapper);
    expect(top.length).toBeGreaterThan(20);
    const folders = wrapper.findAll('.entries li').filter((li) => li.find('.folder-icon').exists()).length;
    expect(folders).toBeGreaterThan(0);
    expect(wrapper.findAll('.entries li').slice(0, folders).every((li) => li.find('.folder-icon').exists())).toBe(true);

    await wrapper.find('.entries .open').trigger('click');
    await settle();
    expect(wrapper.findAll('.crumb')).toHaveLength(2);
    expect(names(wrapper)).toHaveLength(1);
    await wrapper.find('.crumb').trigger('click');
    await settle();
    expect(names(wrapper)).toEqual(top);

    await wrapper.find('input[type=search]').setValue('FML');
    expect(names(wrapper)).toEqual(['fml.toml']);
    wrapper.unmount();
  });

  it('edits a text file, saves it, and asks before dropping unsaved changes', async () => {
    const { backend, provide } = await demo();
    const wrapper = mount(FilesView, provide);
    await settle();
    const open = async () => { await wrapper.findAll('.entries .open').find((b) => b.text() === 'fml.toml')!.trigger('click'); await settle(); };
    await open();
    const box = wrapper.find('textarea');
    // Windows line endings are shown as plain ones and do not count as a change.
    expect((box.element as HTMLTextAreaElement).value).toBe('maxThreads = -1\nversionCheck = true\n');
    const saveButton = () => wrapper.find('.editor .btn-primary');
    expect(saveButton().attributes('disabled')).toBeDefined();

    await box.setValue('maxThreads = 4\nversionCheck = true\n');
    expect(wrapper.find('.badge.warn').exists()).toBe(true);
    await saveButton().trigger('click');
    await settle();
    expect((await backend.readContentText('inst-atlas', 'config', 'fml.toml')).text).toBe('maxThreads = 4\nversionCheck = true\n');
    expect(wrapper.find('.badge.warn').exists()).toBe(false);

    // Leaving with unsaved text asks first; cancelling keeps the editor and the text.
    await box.setValue('oops');
    void wrapper.find('.editor .icon-btn').trigger('click');
    await settle();
    expect(dialog.value?.danger).toBe(true);
    settleDialog(false);
    await settle();
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('oops');
    void wrapper.find('.editor .icon-btn').trigger('click');
    await settle();
    settleDialog(true);
    await settle();
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect((await backend.readContentText('inst-atlas', 'config', 'fml.toml')).text).toBe('maxThreads = 4\nversionCheck = true\n');
    wrapper.unmount();
  });

  it('never overwrites a file that changed on disk while it was open', async () => {
    const { backend, provide } = await demo();
    const wrapper = mount(FilesView, provide);
    await settle();
    await wrapper.findAll('.entries .open').find((b) => b.text() === 'fml.toml')!.trigger('click');
    await settle();
    backend.touchContent('inst-atlas', 'config', 'fml.toml');
    await wrapper.find('textarea').setValue('mine');
    await wrapper.find('.editor .btn-primary').trigger('click');
    await settle();
    expect(wrapper.find('.editor .notice.error').exists()).toBe(true);
    expect((await backend.readContentText('inst-atlas', 'config', 'fml.toml')).text).toContain('maxThreads = -1');
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('mine');
    wrapper.unmount();
  });

  it('says so when a file is not text, and recycles only after a confirmation', async () => {
    const { backend, provide } = await demo();
    filesArea.value = 'resourcepacks';
    const wrapper = mount(FilesView, provide);
    await settle();
    expect(names(wrapper)).toEqual(['Faithful 32x - Demo.zip']);
    await wrapper.find('.entries .open').trigger('click');
    await settle();
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(toasts.at(-1)?.message).toMatch(/not a text file/);

    void wrapper.find('.row-action').trigger('click');
    await settle();
    settleDialog(false);
    await settle();
    expect(await backend.listContent('inst-atlas', 'resourcepacks')).toHaveLength(1);
    void wrapper.find('.row-action').trigger('click');
    await settle();
    settleDialog(true);
    await settle();
    expect(await backend.listContent('inst-atlas', 'resourcepacks')).toHaveLength(0);
    expect(wrapper.find('.empty').exists()).toBe(true);
    wrapper.unmount();
  });

  it('points a Launcher instance that is not managed here to the Mods page', async () => {
    const { session, provide } = await demo();
    session.state.handshake = { ...session.state.handshake!, capabilities: session.state.handshake!.capabilities.filter((c) => !c.startsWith('files.')) };
    session.source.value = 'launcher';
    const wrapper = mount(FilesView, provide);
    await settle();
    expect(wrapper.find('.notice').text()).toContain('Manage mods here');
    expect(wrapper.find('.entries').exists()).toBe(false);
    await wrapper.find('.notice button').trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([['mods']]);
    wrapper.unmount();
  });
});

describe('Browse resource packs and shaders', () => {
  it('lists what fits the instance and installs the chosen version into its folder', async () => {
    const { backend, provide } = await demo();
    const wrapper = mount(ContentBrowseView, { ...provide, props: { kind: 'shader' } });
    await settle();
    const cards = wrapper.findAll('.hit');
    expect(cards.length).toBeGreaterThan(5);
    expect(wrapper.findAll('.seg')).toHaveLength(2);

    await cards[0]!.trigger('click');
    await settle();
    const versions = wrapper.findAll('.version');
    expect(versions.length).toBeGreaterThan(0);
    const fileName = versions[0]!.find('.ellipsis').text().split(' · ')[0]!;
    await wrapper.find('.details .btn-primary').trigger('click');
    await vi.waitFor(async () => expect((await backend.listContent('inst-atlas', 'shaderpacks')).map((e) => e.path)).toContain(fileName));
    await settle();
    expect(toasts.at(-1)?.message).toBe(`Installed ${fileName}`);
    expect(wrapper.find('.version .badge.ok').exists()).toBe(true);
    expect(cards[0]!.find('.badge.ok').exists()).toBe(true);
    // Nothing went through the mod plan.
    expect((await backend.listOperations()).length).toBe(0);
    wrapper.unmount();
  });

  it('keeps resource packs and shaders apart and honours the version filter', async () => {
    const { backend } = await demo();
    const query = { provider: 'modrinth' as const, text: '', offset: 0, limit: 60 };
    const packs = await backend.searchContent({ ...query, kind: 'resourcepack', minecraftVersion: '' });
    const shaders = await backend.searchContent({ ...query, kind: 'shader', minecraftVersion: '' });
    expect(packs.hits.some((p) => shaders.hits.some((s) => s.projectId === p.projectId))).toBe(false);
    const old = await backend.searchContent({ ...query, kind: 'shader', minecraftVersion: '1.12.2' });
    expect(old.total).toBeGreaterThan(0);
    expect(old.total).toBeLessThan(shaders.total);
    for (const hit of old.hits) expect((await backend.contentVersions('modrinth', hit.projectId, '1.12.2')).length).toBeGreaterThan(0);
  });

  it('explains why a Launcher instance that is not managed here cannot install them', async () => {
    const { session, provide } = await demo();
    session.state.handshake = { ...session.state.handshake!, capabilities: session.state.handshake!.capabilities.filter((c) => c !== 'content.browse') };
    session.source.value = 'launcher';
    const wrapper = mount(ContentBrowseView, { ...provide, props: { kind: 'resourcepack' } });
    await settle();
    expect(wrapper.find('.notice').text()).toContain('Manage mods here');
    expect(wrapper.find('.hit').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows a refused install as an error and installs nothing', async () => {
    const { backend, provide } = await demo();
    backend.installContent = async () => { throw new BackendError('provider-restricted', 'Its author only allows downloads from the CurseForge website.'); };
    const wrapper = mount(ContentBrowseView, { ...provide, props: { kind: 'resourcepack' } });
    await settle();
    await wrapper.find('.hit .btn').trigger('click');
    await settle();
    expect(toasts.at(-1)).toMatchObject({ tone: 'error', message: 'Its author only allows downloads from the CurseForge website.' });
    expect(wrapper.find('.hit .badge.ok').exists()).toBe(false);
    wrapper.unmount();
  });
});
