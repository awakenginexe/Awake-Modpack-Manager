import { describe, expect, it } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { h } from 'vue';
import VirtualList from '../src/components/VirtualList.vue';
import ModsView from '../src/views/ModsView.vue';
import ReviewView from '../src/views/ReviewView.vue';
import { MockBackend } from '../src/backend/mock/MockBackend';
import { createSession, SessionKey } from '../src/state/session';

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
});
