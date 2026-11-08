import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue';

/** Modrinth and CurseForge never get a page request sooner than this after the last one finished. */
export const PAGE_GAP_MS = 1500;
/** Start fetching this far before the end of the list, so most scrolling never reaches a gap. */
const LOOK_AHEAD = '600px 0px';

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/**
 * Calls `load` when `sentinel` nears the visible area and `canLoad()` is true, at most once per gap.
 * `canLoad` goes false while a page loads and after a failure, so errors (a 429 included) stop the
 * loading until the user retries.
 */
export function useInfiniteScroll(sentinel: Ref<HTMLElement | null>, canLoad: () => boolean, load: () => unknown, gapMs = PAGE_GAP_MS) {
  let near = false;
  let readyAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: IntersectionObserver | undefined;

  function plan() {
    clearTimeout(timer);
    if (!near || !canLoad()) return;
    timer = setTimeout(() => { if (near && canLoad()) load(); }, Math.max(0, readyAt + gapMs - Date.now()));
  }

  watch(canLoad, (ready) => { if (ready) readyAt = Date.now(); plan(); }, { flush: 'post' });
  onMounted(() => {
    const el = sentinel.value;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    observer = new IntersectionObserver((entries) => { near = entries[entries.length - 1]!.isIntersecting; plan(); }, { root: scrollParent(el), rootMargin: LOOK_AHEAD });
    observer.observe(el);
  });
  onBeforeUnmount(() => { observer?.disconnect(); clearTimeout(timer); });
}
