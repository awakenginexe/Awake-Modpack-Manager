<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { closeMenu, menu, type MenuItem } from '../ui/desktop';

const root = ref<HTMLElement | null>(null);
const pos = ref({ x: 0, y: 0 });
const items = computed(() => menu.value?.items ?? []);

/** Stay on screen: flip against the right and bottom edges, as a native menu does. */
function place() {
  const m = menu.value;
  const el = root.value;
  if (!m || !el) return;
  const { width, height } = el.getBoundingClientRect();
  pos.value = { x: m.x + width > innerWidth - 8 ? Math.max(8, m.x - width) : m.x, y: m.y + height > innerHeight - 8 ? Math.max(8, innerHeight - height - 8) : m.y };
  el.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
}
watch(menu, (m) => { if (m) { pos.value = { x: m.x, y: m.y }; void nextTick(place); } });

function run(item: MenuItem) {
  closeMenu();
  void item.action?.();
}
function move(delta: number) {
  const buttons = [...(root.value?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
  const i = buttons.indexOf(document.activeElement as HTMLElement);
  buttons[(i + delta + buttons.length) % buttons.length]?.focus();
}
function onKey(e: KeyboardEvent) {
  if (!menu.value) return;
  if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
}
const onPointer = (e: Event) => { if (menu.value && !root.value?.contains(e.target as Node)) closeMenu(); };
onMounted(() => {
  addEventListener('keydown', onKey, true);
  addEventListener('pointerdown', onPointer, true);
  addEventListener('blur', closeMenu);
  addEventListener('resize', closeMenu);
  addEventListener('wheel', closeMenu, { passive: true });
});
onBeforeUnmount(() => {
  removeEventListener('keydown', onKey, true);
  removeEventListener('pointerdown', onPointer, true);
  removeEventListener('blur', closeMenu);
  removeEventListener('resize', closeMenu);
  removeEventListener('wheel', closeMenu);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="menu" ref="root" class="context-menu" role="menu" :style="{ left: `${pos.x}px`, top: `${pos.y}px` }" @contextmenu.prevent>
      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.separator" class="sep" role="separator"></div>
        <button v-else type="button" role="menuitem" :disabled="item.disabled" :class="{ danger: item.danger }" :title="item.disabled ? item.hint : undefined" @click="run(item)">
          <component :is="item.icon" v-if="item.icon" :size="15" class="icon" aria-hidden="true" />
          <span v-else class="icon"></span>
          <span class="label">{{ item.label }}</span>
          <kbd v-if="item.hint && !item.disabled">{{ item.hint }}</kbd>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed; z-index: 200; min-width: 196px; max-width: 340px; max-height: calc(100vh - 16px); overflow-y: auto; padding: 5px;
  border-radius: 10px; border: 1px solid var(--glass-border); background: rgba(12, 22, 39, 0.97); box-shadow: var(--shadow-large), var(--glass-highlight);
  animation: appear 90ms var(--ease);
}
@keyframes appear { from { opacity: 0; transform: translateY(-3px) scale(0.985); } }
button {
  display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 10px; border: none; border-radius: 6px; background: transparent;
  color: var(--text); font: inherit; font-size: 0.92rem; text-align: left; cursor: default; outline: none;
}
button:hover:not(:disabled), button:focus-visible { background: var(--surface-selected); }
button:disabled { color: var(--text-muted); opacity: 0.6; }
button.danger:not(:disabled) { color: #fca5a5; }
button.danger:hover:not(:disabled), button.danger:focus-visible { background: rgba(239, 68, 68, 0.2); color: #fecaca; }
.icon { width: 15px; flex-shrink: 0; color: var(--text-secondary); }
button.danger:not(:disabled) .icon { color: inherit; }
.label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
kbd { font: inherit; font-size: 0.78rem; color: var(--text-muted); }
.sep { height: 1px; margin: 4px 6px; background: rgba(255, 255, 255, 0.09); }
</style>
