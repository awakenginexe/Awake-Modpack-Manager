<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { Check, ChevronDown, Search } from '@lucide/vue';
import { t } from '../i18n';

type Option = { value: T; label: string };

const props = withDefaults(defineProps<{
  options: readonly (T | Option)[];
  disabled?: boolean;
  /** Short lists can turn the search box off and keep the same look. */
  searchable?: boolean;
  /** Offers what was typed as a choice when it is not in the list. */
  allowCustom?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}>(), { searchable: true, placeholder: '', ariaLabel: undefined });
const model = defineModel<T>({ required: true });

const items = computed<Option[]>(() => props.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)));
const selectedLabel = computed(() => items.value.find((i) => i.value === model.value)?.label ?? model.value);

const open = ref(false);
const query = ref('');
const active = ref(0);
const typed = computed(() => query.value.trim());

/** An exact match, then versions that start with the text, then the rest, each in catalog order. */
const matches = computed(() => {
  const q = typed.value.toLowerCase();
  if (!q) return items.value;
  const rank = (label: string) => (label === q ? 0 : label.startsWith(q) ? 1 : 2);
  return items.value
    .map((item) => ({ item, label: item.label.toLowerCase() }))
    .filter(({ label }) => label.includes(q))
    .sort((a, b) => rank(a.label) - rank(b.label))
    .map(({ item }) => item);
});
const customRow = computed(() => props.allowCustom && typed.value && !items.value.some((i) => i.value === typed.value));
const rows = computed<(Option & { custom?: boolean })[]>(() => (customRow.value ? [...matches.value, { value: typed.value as T, label: typed.value, custom: true }] : matches.value));

const id = useId();
const rowId = (index: number) => `${id}-${index}`;
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const search = ref<HTMLInputElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

/** The panel lives on body so a dialog's scrolling cannot clip it. It opens upward when there is more room there. */
function place() {
  if (!trigger.value) return;
  const box = trigger.value.getBoundingClientRect();
  const gap = 6, edge = 8;
  const below = window.innerHeight - box.bottom - gap - edge;
  const above = box.top - gap - edge;
  const upward = below < 240 && above > below;
  const width = Math.max(box.width, 220);
  panelStyle.value = {
    left: `${Math.max(edge, Math.min(box.left, window.innerWidth - width - edge))}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(360, upward ? above : below)}px`,
    ...(upward ? { bottom: `${window.innerHeight - box.top + gap}px` } : { top: `${box.bottom + gap}px` }),
  };
}

function reveal() {
  void nextTick(() => panel.value?.querySelector('.option.active')?.scrollIntoView?.({ block: 'nearest' }));
}

function outside(e: PointerEvent) {
  const target = e.target as Node;
  if (!panel.value?.contains(target) && !trigger.value?.contains(target)) close(false);
}

function listen(on: boolean) {
  const method = on ? 'addEventListener' : 'removeEventListener';
  window[method]('resize', place);
  window[method]('scroll', place, true);
  document[method]('pointerdown', outside as EventListener, true);
}

function show(seed = '') {
  if (open.value || props.disabled) return;
  query.value = seed;
  place();
  open.value = true;
  listen(true);
  active.value = seed ? 0 : Math.max(0, rows.value.findIndex((r) => r.value === model.value));
  void nextTick(() => {
    (search.value ?? panel.value)?.focus();
    reveal();
  });
}

function close(refocus = true) {
  if (!open.value) return;
  open.value = false;
  listen(false);
  if (refocus) trigger.value?.focus();
}

function choose(row: Option) {
  model.value = row.value;
  close();
}

function move(next: number) {
  if (!rows.value.length) return;
  active.value = Math.max(0, Math.min(rows.value.length - 1, next));
  reveal();
}

function onTriggerKey(e: KeyboardEvent) {
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
    e.preventDefault();
    show();
  } else if (props.searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    show(e.key);
  }
}

function onPanelKey(e: KeyboardEvent) {
  const actions: Record<string, () => void> = {
    ArrowDown: () => move(active.value + 1),
    ArrowUp: () => move(active.value - 1),
    PageDown: () => move(active.value + 8),
    PageUp: () => move(active.value - 8),
    Enter: () => { const row = rows.value[active.value]; if (row) choose(row); },
    Escape: () => close(),
    Tab: () => close(),
  };
  const action = actions[e.key];
  if (!action) return;
  e.stopPropagation();
  if (e.key !== 'Tab') e.preventDefault();
  action();
}

watch(query, () => { active.value = 0; reveal(); });
watch(() => props.disabled, (disabled) => { if (disabled) close(false); });
onBeforeUnmount(() => { if (open.value) listen(false); });
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="select picker-trigger"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? `${id}-list` : undefined"
    :aria-label="ariaLabel"
    :disabled="disabled"
    @click="open ? close() : show()"
    @keydown="onTriggerKey"
  >
    <span class="picker-value" :class="{ empty: !selectedLabel }">{{ selectedLabel || placeholder }}</span>
    <ChevronDown :size="16" class="chevron" :class="{ flipped: open }" />
  </button>
  <Teleport to="body">
    <div v-if="open" ref="panel" class="picker-panel" :style="panelStyle" tabindex="-1" @keydown="onPanelKey">
      <div v-if="searchable" class="picker-search">
        <Search :size="15" />
        <input
          ref="search"
          v-model="query"
          type="text"
          role="searchbox"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('pickerSearch')"
          :aria-label="t('pickerSearch')"
          :aria-controls="`${id}-list`"
          :aria-activedescendant="rows.length ? rowId(active) : undefined"
        />
      </div>
      <ul :id="`${id}-list`" class="picker-list" role="listbox" :aria-label="ariaLabel">
        <li
          v-for="(row, index) in rows"
          :id="rowId(index)"
          :key="`${row.custom ? 'custom' : 'item'}:${row.value}`"
          class="option"
          :class="{ active: index === active, selected: row.value === model }"
          role="option"
          :aria-selected="row.value === model"
          @pointermove="active = index"
          @click="choose(row)"
        >
          <span class="label">{{ row.custom ? t('pickerUseTyped', { value: row.label }) : row.label }}</span>
          <Check v-if="row.value === model" :size="15" />
        </li>
        <li v-if="!rows.length" class="no-match">{{ t('pickerNoMatch', { query: typed }) }}</li>
      </ul>
    </div>
  </Teleport>
</template>

<style scoped>
.picker-trigger { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; text-align: left; font-weight: 400; cursor: pointer; transition: border-color var(--duration-fast) var(--ease), background-color var(--duration-fast) var(--ease); }
.picker-trigger:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.24); background: rgba(3, 8, 16, 0.6); }
.picker-trigger[aria-expanded='true'] { border-color: rgba(147, 197, 253, 0.78); box-shadow: 0 0 0 3px var(--accent-subtle); }
.picker-trigger:disabled { opacity: 0.55; cursor: not-allowed; }
.picker-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.picker-value.empty { color: var(--text-muted); }
.chevron { color: var(--text-muted); transition: transform var(--duration-fast) var(--ease); }
.chevron.flipped { transform: rotate(180deg); }

.picker-panel { position: fixed; z-index: 200; display: flex; flex-direction: column; overflow: hidden; padding: 6px; border-radius: var(--radius-panel); border: 1px solid var(--glass-border); background: var(--glass-menu); box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55), var(--glass-highlight); backdrop-filter: var(--glass-filter); outline: none; animation: picker-in 110ms var(--ease); }
@keyframes picker-in { from { opacity: 0; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .picker-panel { animation: none; } }

.picker-search { flex-shrink: 0; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px; margin-bottom: 6px; border-radius: var(--radius-control); background: rgba(3, 8, 16, 0.5); border: 1px solid var(--control-border); color: var(--text-muted); }
.picker-search:focus-within { border-color: rgba(147, 197, 253, 0.78); color: #93c5fd; }
.picker-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: var(--text); font-size: 0.92rem; font-variant-numeric: tabular-nums; }
.picker-search input::placeholder { color: var(--text-muted); }

.picker-list { flex: 1; min-height: 0; margin: 0; padding: 0; list-style: none; overflow-y: auto; }
.option { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 32px; padding: 5px 10px; border-radius: 7px; color: var(--text-secondary); font-size: 0.92rem; font-variant-numeric: tabular-nums; }
.option .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.option.active { background: var(--surface-hover); color: var(--text); }
.option.selected { color: #bfdbfe; font-weight: 600; }
.option.selected.active { background: var(--surface-selected); }
.option svg { color: #60a5fa; }
.no-match { padding: 14px 10px; text-align: center; color: var(--text-muted); font-size: 0.88rem; overflow-wrap: anywhere; }
</style>
