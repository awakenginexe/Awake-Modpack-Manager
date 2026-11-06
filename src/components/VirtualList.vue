<script setup lang="ts" generic="T">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

/** Fixed-row-height windowing: renders only visible rows plus a small overscan. */
const props = withDefaults(defineProps<{ items: readonly T[]; rowHeight: number; itemKey: (item: T) => string; overscan?: number; label?: string }>(), { overscan: 8 });

const root = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewport = ref(600);
let observer: ResizeObserver | undefined;

onMounted(() => {
  if (!root.value) return;
  viewport.value = root.value.clientHeight || 600;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => { if (root.value) viewport.value = root.value.clientHeight || viewport.value; });
    observer.observe(root.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());

const range = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / props.rowHeight) - props.overscan);
  const end = Math.min(props.items.length, Math.ceil((scrollTop.value + viewport.value) / props.rowHeight) + props.overscan);
  return { start, end };
});
const visible = computed(() => props.items.slice(range.value.start, range.value.end).map((item, i) => ({ item, index: range.value.start + i })));

function scrollToIndex(index: number) {
  const el = root.value;
  if (!el) return;
  const top = index * props.rowHeight;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (top + props.rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + props.rowHeight - el.clientHeight;
}
defineExpose({ scrollToIndex });
</script>

<template>
  <div ref="root" class="virtual-list" role="rowgroup" :aria-label="label" @scroll.passive="scrollTop = ($event.target as HTMLElement).scrollTop">
    <div :style="{ height: `${items.length * rowHeight}px`, position: 'relative' }">
      <div
        v-for="row in visible"
        :key="itemKey(row.item)"
        class="virtual-row"
        :style="{ transform: `translateY(${row.index * rowHeight}px)`, height: `${rowHeight}px` }"
      >
        <slot :item="row.item" :index="row.index" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-list { overflow-y: auto; min-height: 0; flex: 1; contain: strict; }
.virtual-row { position: absolute; left: 0; right: 0; top: 0; }
</style>
