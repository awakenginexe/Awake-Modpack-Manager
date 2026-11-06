<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DraftChange, InstalledMod } from '../backend/contract';
import VirtualList from '../components/VirtualList.vue';
import { addChanges, isStale, rebase, removeChange } from '../domain/draft';
import { depState, emptyFilter, filterMods, hasUpdate, sortMods, type SortKey, type StatusFilter } from '../domain/modList';
import { emptySelection, selectAll, selectRange, toggle } from '../domain/selection';
import { formatNumber, t, type MessageKey } from '../i18n';
import { useSession } from '../state/session';
import { formatBytes, sourceLabel } from '../ui/labels';
import type { ViewId } from '../App.vue';

const emit = defineEmits<{ navigate: [ViewId] }>();
const session = useSession();
const { state, inventory, selection, pinned } = session;

const filter = ref(emptyFilter());
const sortKey = ref<SortKey>('name');
const descending = ref(false);
const focusedKey = ref<string | null>(null);
const droppedNotice = ref(0);

const mods = computed(() => inventory.value?.mods ?? []);
const shown = computed(() => sortMods(filterMods(mods.value, filter.value, pinned.value), sortKey.value, descending.value));
const shownKeys = computed(() => shown.value.map((m) => m.key));
const focused = computed(() => mods.value.find((m) => m.key === focusedKey.value) ?? null);
const selectedMods = computed(() => mods.value.filter((m) => selection.value.keys.has(m.key)));
const allShownSelected = computed(() => shown.value.length > 0 && shown.value.every((m) => selection.value.keys.has(m.key)));

const stored = computed(() => (state.instanceId ? session.drafts.value[state.instanceId] : undefined));
const stale = computed(() => !!stored.value && !!inventory.value && isStale(stored.value, inventory.value.revision));
/** One pass over the draft, so each row lookup is O(1). */
const pendingByKey = computed(() => {
  const map = new Map<string, DraftChange[]>();
  for (const c of session.draft.value?.changes ?? []) {
    const key = c.kind === 'install' ? c.projectId : c.modKey;
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  return map;
});
const pendingLabel: Record<DraftChange['kind'], MessageKey> = { install: 'pendingInstall', update: 'pendingUpdate', remove: 'pendingRemove', enable: 'pendingEnable', disable: 'pendingDisable' };

const statusFilters: { id: StatusFilter; label: MessageKey }[] = [
  { id: 'all', label: 'filterAll' }, { id: 'updates', label: 'filterUpdates' }, { id: 'disabled', label: 'filterDisabled' },
  { id: 'pinned', label: 'filterPinned' }, { id: 'manual', label: 'filterManual' }, { id: 'issues', label: 'filterIssues' },
];
const counts = computed(() => {
  const c: Record<StatusFilter, number> = { all: 0, updates: 0, disabled: 0, pinned: 0, manual: 0, issues: 0 };
  for (const id of Object.keys(c) as StatusFilter[]) c[id] = filterMods(mods.value, { ...filter.value, text: '', status: id }, pinned.value).length;
  return c;
});

function onCheck(mod: InstalledMod, event: MouseEvent) {
  selection.value = event.shiftKey ? selectRange(selection.value, mod.key, shownKeys.value) : toggle(selection.value, mod.key);
}
function toggleAllShown() {
  selection.value = allShownSelected.value ? emptySelection() : selectAll(selection.value, shownKeys.value);
}
function onListKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    selection.value = selectAll(selection.value, shownKeys.value);
  } else if (event.key === 'Escape') selection.value = emptySelection();
}

function draftWith(changes: DraftChange[]) {
  const d = session.draft.value;
  if (d && changes.length) session.setDraft(addChanges(d, changes));
}
function bulk(kind: 'update' | 'enable' | 'disable' | 'remove') {
  const changes: DraftChange[] = [];
  for (const m of selectedMods.value) {
    if (kind === 'update') {
      if (hasUpdate(m) && !pinned.value.has(m.key) && m.available) changes.push({ kind: 'update', modKey: m.key, targetVersionId: m.available.id });
    } else if (kind === 'enable' ? !m.enabled : kind === 'disable' ? m.enabled : true) {
      changes.push({ kind, modKey: m.key });
    }
  }
  draftWith(changes);
}
function undo(change: DraftChange) {
  const d = session.draft.value;
  if (d) session.setDraft(removeChange(d, change));
}
function refreshDraft() {
  if (!stored.value || !inventory.value) return;
  const { draft, dropped } = rebase(stored.value, inventory.value.revision, inventory.value.mods);
  session.setDraft(draft);
  session.resetReview();
  droppedNotice.value = dropped.length;
}
function clearSelection() { selection.value = emptySelection(); }
function clearFilters() { filter.value = emptyFilter(); }
const depLabel: Record<ReturnType<typeof depState>, MessageKey> = { ok: 'depsOk', missing: 'depsMissing', conflict: 'depsConflict', unknown: 'depsUnknown' };
const depTone: Record<ReturnType<typeof depState>, string> = { ok: 'ok', missing: 'error', conflict: 'error', unknown: '' };
const depKindLabel: Record<string, MessageKey> = { required: 'depRequired', optional: 'depOptional', incompatible: 'depIncompatible', embedded: 'depEmbedded' };
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('modsTitle') }}</h1>
        <p>{{ t('modsSubtitle', { count: formatNumber(mods.length), name: session.instance.value?.name ?? '' }) }}</p>
      </div>
      <div class="toolbar">
        <span v-if="session.draft.value?.changes.length" class="muted">{{ t('draftPending', { count: session.draft.value.changes.length }) }}</span>
        <button class="btn" type="button" @click="emit('navigate', 'browse')">{{ t('browseMods') }}</button>
        <button class="btn btn-primary" type="button" :disabled="!session.draft.value?.changes.length" @click="emit('navigate', 'review')">{{ t('reviewChanges') }}</button>
      </div>
    </header>

    <div v-if="stale" class="notice warn" role="alert">
      <span>{{ t('staleDraft') }}</span>
      <button class="btn btn-small" type="button" style="margin-left: auto" @click="refreshDraft">{{ t('staleDraftAction') }}</button>
    </div>
    <div v-if="droppedNotice" class="notice" role="status">
      <span>{{ t('staleDropped', { count: droppedNotice }) }}</span>
      <button class="btn btn-small" type="button" style="margin-left: auto" @click="droppedNotice = 0">{{ t('dismiss') }}</button>
    </div>

    <div class="toolbar">
      <input v-model="filter.text" class="input search" type="search" :placeholder="t('modsSearch')" :aria-label="t('modsSearch')" />
      <div class="segmented" role="group" :aria-label="t('filterAll')">
        <button
          v-for="f in statusFilters" :key="f.id" type="button" class="seg" :class="{ active: filter.status === f.id }"
          :aria-pressed="filter.status === f.id" @click="filter.status = f.id"
        >{{ t(f.label) }} <span class="count">{{ counts[f.id] }}</span></button>
      </div>
      <select v-model="filter.source" class="select" :aria-label="t('colSource')">
        <option value="all">{{ t('sourceAll') }}</option>
        <option value="modrinth">Modrinth</option>
        <option value="curseforge">CurseForge</option>
        <option value="manual">{{ t('sourceManual') }}</option>
      </select>
      <select v-model="sortKey" class="select" :aria-label="t('sortBy')">
        <option value="name">{{ t('colName') }}</option>
        <option value="status">{{ t('sortStatus') }}</option>
        <option value="source">{{ t('colSource') }}</option>
        <option value="installed">{{ t('colInstalled') }}</option>
      </select>
      <label class="check"><input v-model="descending" type="checkbox" />{{ t('sortDescending') }}</label>
    </div>

    <div v-if="selection.keys.size" class="bulkbar glass" role="toolbar" :aria-label="t('selectedCount', { count: selection.keys.size })">
      <strong>{{ t('selectedCount', { count: formatNumber(selection.keys.size) }) }}</strong>
      <button class="btn btn-small" type="button" @click="bulk('update')">{{ t('bulkUpdate') }}</button>
      <button class="btn btn-small" type="button" @click="bulk('enable')">{{ t('bulkEnable') }}</button>
      <button class="btn btn-small" type="button" @click="bulk('disable')">{{ t('bulkDisable') }}</button>
      <button class="btn btn-small" type="button" @click="session.setPinned(selection.keys, true)">{{ t('bulkPin') }}</button>
      <button class="btn btn-small" type="button" @click="session.setPinned(selection.keys, false)">{{ t('bulkUnpin') }}</button>
      <button class="btn btn-small btn-danger" type="button" @click="bulk('remove')">{{ t('bulkRemove') }}</button>
      <button class="btn btn-small" type="button" style="margin-left: auto" @click="clearSelection">{{ t('clearSelection') }}</button>
    </div>

    <div class="workspace">
      <div class="table glass" role="table" :aria-label="t('modsTitle')" :aria-rowcount="shown.length" tabindex="0" @keydown="onListKey">
        <div class="row head" role="row">
          <span role="columnheader"><input type="checkbox" :checked="allShownSelected" :aria-label="t('selectAllShown')" @change="toggleAllShown" /></span>
          <span role="columnheader">{{ t('colName') }}</span>
          <span role="columnheader">{{ t('colInstalled') }}</span>
          <span role="columnheader">{{ t('colAvailable') }}</span>
          <span role="columnheader">{{ t('colSource') }}</span>
          <span role="columnheader">{{ t('colDeps') }}</span>
          <span role="columnheader">{{ t('colState') }}</span>
        </div>
        <p v-if="state.inventoryLoading && !mods.length" class="empty">{{ t('loadingMods') }}</p>
        <div v-else-if="!mods.length" class="empty">
          <p>{{ t('noMods') }}</p>
          <button class="btn" type="button" @click="emit('navigate', 'browse')">{{ t('browseMods') }}</button>
        </div>
        <div v-else-if="!shown.length" class="empty">
          <p>{{ t('noMatches') }}</p>
          <button class="btn" type="button" @click="clearFilters">{{ t('clearFilters') }}</button>
        </div>
        <VirtualList v-else :items="shown" :row-height="44" :item-key="(m) => m.key" :label="t('modsTitle')">
          <template #default="{ item: m }">
            <div
              class="row" role="row"
              :class="{ selected: selection.keys.has(m.key), focused: focusedKey === m.key, off: !m.enabled, removing: pendingByKey.get(m.key)?.some((c) => c.kind === 'remove') }"
              @click="focusedKey = m.key"
            >
              <span role="cell" @click.stop>
                <input type="checkbox" :checked="selection.keys.has(m.key)" :aria-label="t('selectRow', { name: m.name })" @click="onCheck(m, $event)" />
              </span>
              <span role="cell" class="name">
                <span class="title">{{ m.name }}</span>
                <span v-if="pinned.has(m.key)" class="badge" :title="t('pinHint')">{{ t('pinned') }}</span>
                <span v-if="m.locallyModified" class="badge warn">{{ t('locallyModified') }}</span>
                <span v-for="c in pendingByKey.get(m.key) ?? []" :key="c.kind" class="badge info">{{ t(pendingLabel[c.kind]) }}</span>
              </span>
              <span role="cell" class="mono">{{ m.installed?.name ?? t('noVersion') }}</span>
              <span role="cell" class="mono">
                <span v-if="hasUpdate(m)" class="update">{{ m.available?.name }}</span>
                <span v-else class="muted">{{ m.source === 'manual' ? t('noVersion') : t('upToDate') }}</span>
              </span>
              <span role="cell">{{ sourceLabel(m.source) }}</span>
              <span role="cell"><span class="badge" :class="depTone[depState(m)]">{{ t(depLabel[depState(m)]) }}</span></span>
              <span role="cell" :class="m.enabled ? '' : 'muted'">{{ m.enabled ? t('enabled') : t('disabled') }}</span>
            </div>
          </template>
        </VirtualList>
      </div>

      <aside class="details glass" :aria-label="t('modDetails')">
        <template v-if="focused">
          <h2>{{ focused.name }}</h2>
          <p class="muted">{{ sourceLabel(focused.source) }}<template v-if="focused.sizeBytes"> · {{ formatBytes(focused.sizeBytes) }}</template></p>
          <p v-if="focused.source === 'manual'" class="notice warn">{{ t('manualFileHint') }}</p>
          <dl>
            <dt>{{ t('detailFile') }}</dt><dd class="mono">{{ focused.fileName }}</dd>
            <template v-if="focused.projectId"><dt>{{ t('detailProject') }}</dt><dd class="mono">{{ focused.projectId }}</dd></template>
            <dt>{{ t('colInstalled') }}</dt><dd>{{ focused.installed?.name ?? t('noVersion') }} <span v-if="focused.installed" class="badge">{{ t(focused.installed.releaseType) }}</span></dd>
            <template v-if="hasUpdate(focused)"><dt>{{ t('colAvailable') }}</dt><dd>{{ focused.available?.name }}</dd></template>
          </dl>
          <h3>{{ t('detailDeps') }}</h3>
          <ul v-if="focused.dependencies.length" class="deps">
            <li v-for="(d, i) in focused.dependencies" :key="i">
              <span>{{ d.name }}</span>
              <span class="badge">{{ t(depKindLabel[d.kind]!) }}</span>
              <span class="badge" :class="d.state === 'satisfied' ? 'ok' : d.state === 'unknown' ? '' : 'error'">{{ t(d.state === 'satisfied' ? 'depsOk' : d.state === 'missing' ? 'depsMissing' : d.state === 'conflict' ? 'depsConflict' : 'depsUnknown') }}</span>
            </li>
          </ul>
          <p v-else class="muted">{{ t('detailNoDeps') }}</p>
          <div class="detail-actions">
            <button class="btn btn-small" type="button" @click="session.setPinned([focused.key], !pinned.has(focused.key))">{{ pinned.has(focused.key) ? t('bulkUnpin') : t('bulkPin') }}</button>
            <button v-if="hasUpdate(focused) && !pinned.has(focused.key)" class="btn btn-small" type="button" @click="draftWith([{ kind: 'update', modKey: focused.key, targetVersionId: focused.available!.id }])">{{ t('bulkUpdate') }}</button>
            <button class="btn btn-small" type="button" @click="draftWith([{ kind: focused.enabled ? 'disable' : 'enable', modKey: focused.key }])">{{ focused.enabled ? t('bulkDisable') : t('bulkEnable') }}</button>
            <button class="btn btn-small btn-danger" type="button" @click="draftWith([{ kind: 'remove', modKey: focused.key }])">{{ t('bulkRemove') }}</button>
          </div>
          <div v-if="pendingByKey.get(focused.key)?.length" class="pending">
            <span v-for="c in pendingByKey.get(focused.key)" :key="c.kind" class="pending-item">
              {{ t(pendingLabel[c.kind]) }} <button class="btn btn-small" type="button" @click="undo(c)">{{ t('undoChange') }}</button>
            </span>
          </div>
        </template>
        <p v-else class="muted">{{ t('selectModHint') }}</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.search { min-width: 220px; flex: 1; max-width: 340px; }
.segmented { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: var(--radius-control); background: rgba(3, 8, 16, 0.4); border: 1px solid var(--control-border); }
.seg { border: none; background: transparent; color: var(--text-secondary); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
.seg.active { background: var(--surface-selected); color: #fff; }
.seg .count { color: var(--text-muted); font-size: 0.75rem; }
.seg.active .count { color: #bfdbfe; }
.bulkbar { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-radius: var(--radius-medium); flex-wrap: wrap; }
.workspace { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--space-4); flex: 1; min-height: 0; }
.table { display: flex; flex-direction: column; min-height: 0; border-radius: var(--radius-medium); overflow: hidden; }
.row {
  display: grid; grid-template-columns: 36px minmax(180px, 2.4fr) minmax(90px, 1fr) minmax(90px, 1fr) 100px 100px 80px;
  align-items: center; gap: var(--space-2); height: 44px; padding: 0 var(--space-3); border-bottom: 1px solid var(--border-subtle); font-size: 0.88rem;
}
.row.head { height: 38px; font-size: 0.78rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em; background: rgba(255, 255, 255, 0.02); }
.row:not(.head):hover { background: var(--surface-hover); }
.row.selected { background: var(--surface-selected); }
.row.focused { box-shadow: inset 3px 0 0 #3b82f6; }
.row.off .title { color: var(--text-secondary); }
.row.removing .title { text-decoration: line-through; color: #fca5a5; }
.row input { accent-color: var(--accent); width: 16px; height: 16px; }
.name { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.mono { font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.82rem; }
.update { color: #7dd3fc; }
.details { padding: var(--space-4); border-radius: var(--radius-medium); overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-3); }
.details h2 { font-size: 1.1rem; word-break: break-word; }
.details h3 { font-size: 0.9rem; color: var(--text-secondary); }
.details dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 0.85rem; }
.details dt { color: var(--text-muted); }
.details dd { margin: 0; word-break: break-all; }
.deps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 0.85rem; }
.deps li { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.detail-actions, .pending { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.pending-item { display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; color: #93c5fd; }
@media (max-width: 1180px) { .workspace { grid-template-columns: 1fr; } .details { max-height: 260px; } }
</style>
