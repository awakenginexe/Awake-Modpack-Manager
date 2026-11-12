import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { h } from 'vue';
import SearchSelect from '../src/components/SearchSelect.vue';
import VirtualList from '../src/components/VirtualList.vue';
import HistoryView from '../src/views/HistoryView.vue';
import ModsView from '../src/views/ModsView.vue';
import ReviewView from '../src/views/ReviewView.vue';
import type { InstanceSummary, OperationStatus } from '../src/backend/contract';
import { MockBackend } from '../src/backend/mock/MockBackend';
import { appUpdate, canSelfUpdate, updateNow, workInProgress } from '../src/state/appUpdate';
import { createSession, SessionKey, type Session } from '../src/state/session';
import { dialog, settleDialog } from '../src/ui/desktop';

async function mounted(component: typeof ModsView) {
  localStorage.clear();
  const session = createSession(new MockBackend({ stepMs: 1, latencyMs: 0 }), { pollMs: 5 });
  await session.connect();
  await session.selectInstance('inst-atlas');
  const wrapper = mount(component, { global: { provide: { [SessionKey as symbol]: session } } });
  await flushPromises();
  return { wrapper, session };
}

describe('VirtualList', () => {
  it('renders only a window of a large list', () => {
    const items = Array.from({ length: 300 }, (_, i) => `row-${i}`);
    const wrapper = mount(VirtualList<string>, {
      props: { items, rowHeight: 40, itemKey: (s: string) => s },
      slots: { default: ({ item }: { item: string }) => h('span', { class: 'cell' }, item) },
    });
    const rendered = wrapper.findAll('.cell').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(40);
  });
});

describe('SearchSelect', () => {
  const VERSIONS = ['1.21.1', '1.20.6', '1.20.1', '1.20', '1.19.2', '1.12.0'];
  function picker(props: Record<string, unknown> = {}, modelValue = '1.21.1') {
    const updates: string[] = [];
    const wrapper = mount(SearchSelect<string>, {
      attachTo: document.body,
      props: { options: VERSIONS, modelValue, 'onUpdate:modelValue': (v: string) => { updates.push(v); }, ...props },
    });
    const search = () => document.body.querySelector<HTMLInputElement>('.picker-search input')!;
    const rows = () => [...document.body.querySelectorAll('.option .label')].map((e) => e.textContent);
    const type = async (text: string) => { search().value = text; search().dispatchEvent(new Event('input')); await flushPromises(); };
    const key = async (k: string) => { (search() ?? document.body.querySelector('.picker-panel')).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); await flushPromises(); };
    return { wrapper, updates, search, rows, type, key };
  }

  it('narrows a long list to what was typed, exact match first', async () => {
    const p = picker();
    await p.wrapper.find('button').trigger('click');
    await flushPromises();
    expect(p.rows()).toEqual(VERSIONS);
    await p.type('1.20');
    expect(p.rows()).toEqual(['1.20', '1.20.6', '1.20.1']);
    p.wrapper.unmount();
  });

  it('picks with the keyboard and closes', async () => {
    const p = picker();
    await p.wrapper.find('button').trigger('click');
    await flushPromises();
    await p.type('1.20');
    await p.key('ArrowDown');
    await p.key('ArrowDown');
    await p.key('Enter');
    expect(p.updates).toEqual(['1.20.1']);
    expect(document.body.querySelector('.picker-panel')).toBeNull();
    p.wrapper.unmount();
  });

  it('only offers typed text when allowed, and says when nothing matches', async () => {
    const strict = picker();
    await strict.wrapper.find('button').trigger('click');
    await flushPromises();
    await strict.type('25w14a');
    expect(strict.rows()).toEqual([]);
    expect(document.body.querySelector('.no-match')?.textContent).toContain('25w14a');
    strict.wrapper.unmount();

    const custom = picker({ allowCustom: true });
    await custom.wrapper.find('button').trigger('click');
    await flushPromises();
    await custom.type('25w14a');
    await custom.key('Enter');
    expect(custom.updates).toEqual(['25w14a']);
    custom.wrapper.unmount();
  });

  it('closes on an outside press without changing the value', async () => {
    const p = picker();
    await p.wrapper.find('button').trigger('click');
    await flushPromises();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('.picker-panel')).toBeNull();
    expect(p.updates).toEqual([]);
    p.wrapper.unmount();
  });
});

describe('updating the app', () => {
  const release = { tag: 'v9.0.0', version: '9.0.0', name: '', notes: '', url: 'https://example.test/release', publishedAt: '', prerelease: false, installerSize: 10 };
  const sessionWith = (states: string[]) => ({ state: { operations: states.map((state) => ({ state })) }, backend: {} }) as unknown as Session;
  afterEach(() => { appUpdate.info = null; appUpdate.dialogOpen = false; appUpdate.installing = false; vi.restoreAllMocks(); });

  it('sends a portable copy straight to the release page', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    appUpdate.info = { current: '1.0.0', latest: release, updateAvailable: true, canInstall: false };
    expect(canSelfUpdate.value).toBe(false);
    await updateNow(sessionWith([]));
    expect(open).toHaveBeenCalledOnce();
    expect(appUpdate.dialogOpen).toBe(false);
  });

  it('waits for running work and explains why in the dialog', async () => {
    appUpdate.info = { current: '1.0.0', latest: release, updateAvailable: true, canInstall: true };
    expect(canSelfUpdate.value).toBe(true);
    const session = sessionWith(['running']);
    expect(workInProgress(session)).toBe(true);
    await updateNow(session);
    expect(appUpdate.dialogOpen).toBe(true);
    expect(appUpdate.installing).toBe(false);
  });
});

describe('History', () => {
  const op = (operationId: string, state: OperationStatus['state']): OperationStatus => ({ operationId, kind: 'apply-plan', state, progress: 0.4, startedAt: '2026-11-09T04:11:00Z', updatedAt: '2026-11-09T04:11:00Z', cancellable: true });
  async function history(operations: OperationStatus[], planId?: string) {
    const { wrapper: mods, session } = await mounted(ModsView);
    mods.unmount();
    session.backend.listOperations = async () => operations;
    if (planId) session.review.plan = { planId } as typeof session.review.plan;
    const wrapper = mount(HistoryView, { global: { provide: { [SessionKey as symbol]: session } } });
    await flushPromises();
    return wrapper;
  }

  it('shows a plan waiting for the user as waiting, not as running work', async () => {
    const wrapper = await history([op('plan', 'prepared')]);
    expect(wrapper.find('.spin').exists()).toBe(false);
    expect(wrapper.find('.progress').exists()).toBe(false);
    expect(wrapper.text()).toContain('Cancel');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Review changes')).toBe(false);
  });

  it('still shows real work as running', async () => {
    const wrapper = await history([op('work', 'downloading')]);
    expect(wrapper.find('.spin').exists()).toBe(true);
    expect(wrapper.find('.progress').exists()).toBe(true);
  });

  it('goes back to the plan when it is still open', async () => {
    const wrapper = await history([op('plan', 'prepared')], 'plan');
    await wrapper.findAll('button').find((b) => b.text() === 'Review changes')!.trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([['review']]);
  });
});

describe('handing a pack between the Manager and the Launcher', () => {
  type Hooks = { release?: Promise<void> };
  async function managedPack(hooks: Hooks = {}) {
    localStorage.clear();
    const backend = new MockBackend({ stepMs: 1, latencyMs: 0 });
    const session = createSession(backend, { pollMs: 5 });
    await session.connect();
    const [managed, launcher] = session.state.instances as InstanceSummary[];
    const stopSharingInstance = vi.fn(async () => {
      await hooks.release;
      managed!.shared = false;
    });
    Object.assign(backend, { stopSharingInstance, shareInstance: vi.fn(async () => { await hooks.release; }) });
    managed!.shared = true;
    await session.selectInstance(managed!.id);
    return { session, managed: managed!, launcher: launcher!, stopSharingInstance };
  }
  const stopButton = (w: ReturnType<typeof mount>) => w.findAll('.notice button').find((b) => b.text() === 'Stop managing here');

  it('offers Stop managing on the Mods page of a managed pack, and asks first', async () => {
    const { session, stopSharingInstance } = await managedPack();
    const wrapper = mount(ModsView, { global: { provide: { [SessionKey as symbol]: session } } });
    await flushPromises();
    await stopButton(wrapper)!.trigger('click');
    await flushPromises();
    expect(dialog.value?.title).toContain('Stop managing');
    expect(stopSharingInstance).not.toHaveBeenCalled();
    settleDialog(true);
    await flushPromises();
    expect(stopSharingInstance).toHaveBeenCalledOnce();
    wrapper.unmount();
  });

  it('does not offer it for a pack the Launcher still manages', async () => {
    const { session, managed } = await managedPack();
    managed.shared = false;
    const wrapper = mount(ModsView, { global: { provide: { [SessionKey as symbol]: session } } });
    await flushPromises();
    expect(stopButton(wrapper)).toBeUndefined();
    wrapper.unmount();
  });

  it('reports progress the whole time a pack is handed back', async () => {
    let finish = () => {};
    const release = new Promise<void>((r) => { finish = r; });
    const { session, managed } = await managedPack({ release });
    const running = session.stopSharingInstance(managed.id);
    await flushPromises();
    expect(session.state.instanceAccess).toMatchObject({ instanceId: managed.id, stage: 'releasing' });
    finish();
    await running;
    expect(session.state.instanceAccess).toBeNull();
  });

  it('reports progress while connecting, and clears it when connecting fails', async () => {
    let fail = (_: Error) => {};
    const release = new Promise<void>((_, reject) => { fail = reject; });
    const { session, launcher } = await managedPack({ release });
    const running = session.shareInstance(launcher.id);
    await flushPromises();
    expect(session.state.instanceAccess).toMatchObject({ instanceId: launcher.id, stage: 'connecting' });
    fail(new Error('no'));
    await expect(running).rejects.toThrow('no');
    expect(session.state.instanceAccess).toBeNull();
  });
});

describe('ModsView', () => {
  it('filters to updates, bulk-selects and drafts updates', async () => {
    const { wrapper, session } = await mounted(ModsView);
    const updatesTab = wrapper.findAll('.seg')[1]!;
    const expected = Number(updatesTab.find('.count').text());
    await updatesTab.trigger('click');
    await wrapper.find('.row.head input').trigger('change');
    expect(session.selection.value.keys.size).toBe(expected);
    const updateBtn = wrapper.findAll('.bulkbar button').find((b) => b.text() === 'Update')!;
    await updateBtn.trigger('click');
    expect(session.draft.value!.changes.length).toBeGreaterThan(0);
    expect(session.draft.value!.changes.every((c) => c.kind === 'update')).toBe(true);
  });

  it('shows the stale-draft notice when the instance changed underneath', async () => {
    const { wrapper, session } = await mounted(ModsView);
    session.setDraft({ ...session.draft.value!, changes: [{ kind: 'disable', modKey: session.inventory.value!.mods[0]!.key }] });
    (session.backend as MockBackend).touchInstance('inst-atlas');
    await session.loadInventory();
    await flushPromises();
    expect(wrapper.find('.notice.warn').exists()).toBe(true);
  });
});

describe('ReviewView', () => {
  it('requires acknowledging destructive changes before Apply is enabled', async () => {
    const { wrapper, session } = await mounted(ReviewView);
    const mod = session.inventory.value!.mods.find((m) => m.source === 'manual')!;
    session.setDraft({ ...session.draft.value!, changes: [{ kind: 'remove', modKey: mod.key }] });
    await session.validate();
    await flushPromises();
    const apply = wrapper.find('.apply-row button');
    expect(apply.attributes('disabled')).toBeDefined();
    await wrapper.find('.plan-panel label.check input').setValue(true);
    expect(apply.attributes('disabled')).toBeUndefined();
  });
  it('offers a restricted CurseForge mod as a manual download and takes it out of the draft once the file is added', async () => {
    const { wrapper, session } = await mounted(ReviewView);
    const install = (n: number) => ({ kind: 'install' as const, provider: 'curseforge' as const, projectId: `cf-${n}`, name: `Mod ${n}` });
    session.setDraft({ ...session.draft.value!, changes: [install(13), install(39), install(999)] });
    await session.validate();
    await flushPromises();
    expect(session.review.error?.code).toBe('provider-restricted');
    const panel = () => wrapper.find('.manual');
    expect(panel().findAll('.files li')).toHaveLength(2);
    expect(wrapper.find('.notice.error').exists()).toBe(false);
    const buttons = panel().findAll('.toolbar button');
    expect(buttons).toHaveLength(2); // Open all (more than one) and Choose downloaded file
    await buttons[1]!.trigger('click');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 30));
    await flushPromises();
    expect(panel().exists()).toBe(false);
    expect(session.draft.value!.changes.map((c) => c.kind === 'install' && c.projectId)).toEqual(['cf-999']);
    wrapper.unmount();
  });
});
