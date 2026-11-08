// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { PAGE_GAP_MS, useInfiniteScroll } from '../src/ui/infiniteScroll';

let observe: (near: boolean) => void;
class FakeObserver {
  constructor(callback: (e: { isIntersecting: boolean }[]) => void) { observe = (near) => callback([{ isIntersecting: near }]); }
  observe() {}
  disconnect() {}
}

function setup() {
  const ready = ref(true);
  const load = vi.fn(() => { ready.value = false; });
  const wrapper = mount(defineComponent({
    setup() {
      const sentinel = ref<HTMLElement | null>(null);
      useInfiniteScroll(sentinel, () => ready.value, load);
      return () => h('div', { ref: sentinel });
    },
  }));
  return { ready, load, wrapper };
}
/** A real page load awaits, so Vue sees "loading" before it sees "finished". */
const finishPage = async (ready: { value: boolean }) => { await nextTick(); ready.value = true; await nextTick(); };

describe('useInfiniteScroll', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IntersectionObserver', FakeObserver); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('loads only once the end of the list is near', () => {
    const { load } = setup();
    vi.advanceTimersByTime(PAGE_GAP_MS * 3);
    expect(load).not.toHaveBeenCalled();
    observe(true);
    vi.advanceTimersByTime(0);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps the gap between pages however fast the list is scrolled', async () => {
    const { ready, load } = setup();
    observe(true);
    vi.advanceTimersByTime(0);
    await finishPage(ready);
    observe(false);
    observe(true);
    vi.advanceTimersByTime(PAGE_GAP_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('cancels a waiting page when the user scrolls away', async () => {
    const { ready, load } = setup();
    observe(true);
    vi.advanceTimersByTime(0);
    await finishPage(ready);
    observe(false);
    vi.advanceTimersByTime(PAGE_GAP_MS * 2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('stops while canLoad is false, as after a provider error', async () => {
    const { ready, load } = setup();
    observe(true);
    vi.advanceTimersByTime(0);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PAGE_GAP_MS * 10);
    expect(load).toHaveBeenCalledTimes(1); // ready stayed false: the failed page is not retried on its own
    await finishPage(ready); // the user pressed Load more and it worked
    vi.advanceTimersByTime(PAGE_GAP_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stops scheduling after unmount', async () => {
    const { ready, load, wrapper } = setup();
    observe(true);
    vi.advanceTimersByTime(0);
    await finishPage(ready);
    wrapper.unmount();
    vi.advanceTimersByTime(PAGE_GAP_MS * 2);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
