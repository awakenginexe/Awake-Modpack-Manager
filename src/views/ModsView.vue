<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowDown, ArrowUp, ArrowUpCircle, Ban, Boxes, CircleAlert, CircleCheck, CircleHelp, FileQuestion, Info, ListChecks,
  Pin, PinOff, Power, PowerOff, Search, Trash2, TriangleAlert, Undo2, X,
} from '@lucide/vue';
import type { DraftChange, InstalledMod } from '../backend/contract';
import Avatar from '../components/Avatar.vue';
import ProviderLogo from '../components/ProviderLogo.vue';
import VirtualList from '../components/VirtualList.vue';
import { addChanges, isStale, rebase, removeChange } from '../domain/draft';
import { depState, emptyFilter, filterMods, hasUpdate, sortMods, type SortKey, type StatusFilter } from '../domain/modList';
import { emptySelection, selectAll, selectRange, toggle } from '../domain/selection';
import { formatNumber, t, type MessageKey } from '../i18n';
import { compactRows } from '../state/prefs';
import { useSession } from '../state/session';
import { formatBytes } from '../ui/labels';
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

const columns: { label: MessageKey; sort?: SortKey; cls?: string }[] = [
  { label: 'colName', sort: 'name' }, { label: 'colInstalled', sort: 'installed', cls: 'c-installed' }, { label: 'colAvailable' },
  { label: 'colSource', sort: 'source' }, { label: 'colDeps', sort: 'status' }, { label: 'colState', cls: 'c-state' },
];
function sortBy(key: SortKey) {
  if (sortKey.value === key) descending.value = !descending.value;
  else { sortKey.value = key; descending.value = false; }
}

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
        <div class="stats">
          <span class="chip"><Boxes :size="14" />{{ t('instanceMods', { count: formatNumber(mods.length) }) }}</span>
          <button v-if="counts.updates" class="chip link" type="button" @click="filter.status = 'updates'"><ArrowUpCircle :size="14" class="accent" />{{ t('statUpdates', { count: counts.updates }) }}</button>
          <button v-if="counts.issues" class="chip link" type="button" @click="filter.status = 'issues'"><CircleAlert :size="14" class="danger" />{{ t('statIssues', { count: counts.issues }) }}</button>
          <button v-if="counts.manual" class="chip link" type="button" @click="filter.status = 'manual'"><FileQuestion :size="14" />{{ t('statUnknown', { count: counts.manual }) }}</button>
        </div>
      </div>
      <div class="toolbar">
        <button class="btn" type="button" @click="emit('navigate', 'browse')"><Search :size="16" />{{ t('browseMods') }}</button>
        <button class="btn btn-primary" type="button" :disabled="!session.draft.value?.changes.length" @click="emit('navigate', 'review')">
          <ListChecks :size="16" />{{ t('reviewChanges') }}<span v-if="session.draft.value?.changes.length" class="pill-count">{{ session.draft.value.changes.length }}</span>
        </button>
      </div>
    </header>

    <div v-if="stale" class="notice warn" role="alert">
      <TriangleAlert :size="18" /><span class="grow">{{ t('staleDraft') }}</span>
      <button class="btn btn-small" type="button" @click="refreshDraft">{{ t('staleDraftAction') }}</button>
    </div>
    <div v-if="droppedNotice" class="notice" role="status">
      <Info :size="18" /><span class="grow">{{ t('staleDropped', { count: droppedNotice }) }}</span>
      <button class="icon-btn" type="button" :aria-label="t('dismiss')" @click="droppedNotice = 0"><X :size="16" /></button>
    </div>

    <div class="toolbar">
      <label class="search-field">
        <Search :size="16" />
        <input v-model="filter.text" class="input" type="search" :placeholder="t('modsSearch')" :aria-label="t('modsSearch')" />
      </label>
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
    </div>

    <div class="workspace" :class="{ open: !!focused }">
      <div class="table-wrap">
        <div class="table card" role="table" :aria-label="t('modsTitle')" :aria-rowcount="shown.length" tabindex="0" @keydown="onListKey">
          <div class="row head" role="row">
            <span role="columnheader"><input type="checkbox" :checked="allShownSelected" :aria-label="t('selectAllShown')" @change="toggleAllShown" /></span>
            <span v-for="c in columns" :key="c.label" role="columnheader" :class="c.cls" :aria-sort="c.sort && sortKey === c.sort ? (descending ? 'descending' : 'ascending') : undefined">
              <button v-if="c.sort" class="sort" type="button" :class="{ active: sortKey === c.sort }" @click="sortBy(c.sort)">
                {{ t(c.label) }}
                <ArrowDown v-if="sortKey === c.sort && descending" :size="13" />
                <ArrowUp v-else-if="sortKey === c.sort" :size="13" />
              </button>
              <template v-else>{{ t(c.label) }}</template>
            </span>
          </div>
          <div v-if="state.inventoryLoading && !mods.length" class="skeleton-rows" aria-busy="true">
            <div v-for="n in 8" :key="n" class="row"><span></span><span class="skeleton" style="height: 14px; width: 70%"></span><span class="skeleton" style="height: 12px; width: 60%"></span></div>
          </div>
          <div v-else-if="!mods.length" class="empty">
            <span class="empty-icon"><Boxes :size="28" /></span>
            <p>{{ t('noMods') }}</p>
            <button class="btn btn-primary" type="button" @click="emit('navigate', 'browse')"><Search :size="16" />{{ t('browseMods') }}</button>
          </div>
          <div v-else-if="!shown.length" class="empty">
            <span class="empty-icon"><Search :size="28" /></span>
            <p>{{ t('noMatches') }}</p>
            <button class="btn" type="button" @click="clearFilters">{{ t('clearFilters') }}</button>
          </div>
          <VirtualList v-else :items="shown" :row-height="compactRows ? 42 : 56" :item-key="(m) => m.key" :label="t('modsTitle')">
            <template #default="{ item: m }">
              <div
                class="row" role="row"
                :style="compactRows ? { height: '42px' } : undefined"
                :class="{ compact: compactRows, selected: selection.keys.has(m.key), focused: focusedKey === m.key, off: !m.enabled, removing: pendingByKey.get(m.key)?.some((c) => c.kind === 'remove') }"
                @click="focusedKey = focusedKey === m.key ? null : m.key"
              >
                <span role="cell" @click.stop>
                  <input type="checkbox" :checked="selection.keys.has(m.key)" :aria-label="t('selectRow', { name: m.name })" @click="onCheck(m, $event)" />
                </span>
                <span role="cell" class="name">
                  <Avatar :name="m.name" :src="m.iconUrl" :size="34" />
                  <span class="name-copy">
                    <span class="title-line">
                      <span class="title">{{ m.name }}</span>
                      <Pin v-if="pinned.has(m.key)" :size="13" class="pin" :aria-label="t('pinned')" />
                      <span v-for="c in pendingByKey.get(m.key) ?? []" :key="c.kind" class="badge info tiny">{{ t(pendingLabel[c.kind]) }}</span>
                      <span v-if="m.locallyModified" class="badge warn tiny">{{ t('locallyModified') }}</span>
                    </span>
                    <span class="file">{{ m.fileName }}</span>
                  </span>
                </span>
                <span role="cell" class="mono c-installed">{{ m.installed?.name ?? t('noVersion') }}</span>
                <span role="cell" class="mono">
                  <span v-if="hasUpdate(m)" class="update"><ArrowUpCircle :size="14" />{{ m.available?.name }}</span>
                  <span v-else-if="m.source !== 'manual'" class="uptodate"><CircleCheck :size="14" />{{ t('upToDate') }}</span>
                  <span v-else class="muted">{{ t('noVersion') }}</span>
                </span>
                <span role="cell"><ProviderLogo :provider="m.source" :size="16" label /></span>
                <span role="cell">
                  <span class="badge" :class="depTone[depState(m)]">
                    <CircleCheck v-if="depState(m) === 'ok'" :size="13" /><CircleHelp v-else-if="depState(m) === 'unknown'" :size="13" /><CircleAlert v-else :size="13" />
                    {{ t(depLabel[depState(m)]) }}
                  </span>
                </span>
                <span role="cell" class="c-state">
                  <span class="state" :class="{ on: m.enabled }"><span class="dot"></span>{{ m.enabled ? t('enabled') : t('disabled') }}</span>
                </span>
              </div>
            </template>
          </VirtualList>
        </div>

        <Transition name="bar">
          <div v-if="selection.keys.size" class="floating-bar bulkbar" role="toolbar" :aria-label="t('selectedCount', { count: selection.keys.size })">
            <strong class="sel-count">{{ t('selectedCount', { count: formatNumber(selection.keys.size) }) }}</strong>
            <span class="divider"></span>
            <button class="btn btn-small btn-ghost" type="button" @click="bulk('update')"><ArrowUpCircle :size="15" />{{ t('bulkUpdate') }}</button>
            <button class="btn btn-small btn-ghost" type="button" @click="bulk('enable')"><Power :size="15" />{{ t('bulkEnable') }}</button>
            <button class="btn btn-small btn-ghost" type="button" @click="bulk('disable')"><PowerOff :size="15" />{{ t('bulkDisable') }}</button>
            <button class="btn btn-small btn-ghost" type="button" @click="session.setPinned(selection.keys, true)"><Pin :size="15" />{{ t('bulkPin') }}</button>
            <button class="btn btn-small btn-ghost" type="button" @click="session.setPinned(selection.keys, false)"><PinOff :size="15" />{{ t('bulkUnpin') }}</button>
            <button class="btn btn-small btn-ghost btn-danger" type="button" @click="bulk('remove')"><Trash2 :size="15" />{{ t('bulkRemove') }}</button>
            <button class="icon-btn end" type="button" :aria-label="t('clearSelection')" :title="t('clearSelection')" @click="clearSelection"><X :size="16" /></button>
          </div>
        </Transition>
      </div>

      <Transition name="slide">
        <aside v-if="focused" class="details glass" :aria-label="t('modDetails')">
          <button class="icon-btn close" type="button" :aria-label="t('close')" @click="focusedKey = null"><X :size="18" /></button>
          <div class="details-head">
            <Avatar :name="focused.name" :src="focused.iconUrl" :size="56" />
            <div>
              <h2>{{ focused.name }}</h2>
              <span class="meta small"><ProviderLogo :provider="focused.source" :size="15" label /><span v-if="focused.sizeBytes">{{ formatBytes(focused.sizeBytes) }}</span></span>
            </div>
          </div>
          <p v-if="focused.source === 'manual'" class="notice warn small"><FileQuestion :size="18" />{{ t('manualFileHint') }}</p>

          <dl class="facts">
            <dt>{{ t('detailFile') }}</dt><dd class="mono-text">{{ focused.fileName }}</dd>
            <template v-if="focused.projectId"><dt>{{ t('detailProject') }}</dt><dd class="mono-text">{{ focused.projectId }}</dd></template>
            <dt>{{ t('colInstalled') }}</dt>
            <dd>{{ focused.installed?.name ?? t('noVersion') }} <span v-if="focused.installed" class="badge">{{ t(focused.installed.releaseType) }}</span></dd>
            <template v-if="hasUpdate(focused)"><dt>{{ t('colAvailable') }}</dt><dd class="update"><ArrowUpCircle :size="14" />{{ focused.available?.name }}</dd></template>
          </dl>

          <div class="detail-actions">
            <button v-if="hasUpdate(focused) && !pinned.has(focused.key)" class="btn btn-primary btn-small" type="button" @click="draftWith([{ kind: 'update', modKey: focused.key, targetVersionId: focused.available!.id }])"><ArrowUpCircle :size="15" />{{ t('bulkUpdate') }}</button>
            <button class="btn btn-small" type="button" @click="draftWith([{ kind: focused.enabled ? 'disable' : 'enable', modKey: focused.key }])">
              <PowerOff v-if="focused.enabled" :size="15" /><Power v-else :size="15" />{{ focused.enabled ? t('bulkDisable') : t('bulkEnable') }}
            </button>
            <button class="btn btn-small" type="button" @click="session.setPinned([focused.key], !pinned.has(focused.key))">
              <PinOff v-if="pinned.has(focused.key)" :size="15" /><Pin v-else :size="15" />{{ pinned.has(focused.key) ? t('bulkUnpin') : t('bulkPin') }}
            </button>
            <button class="btn btn-small btn-danger" type="button" @click="draftWith([{ kind: 'remove', modKey: focused.key }])"><Trash2 :size="15" />{{ t('bulkRemove') }}</button>
          </div>
          <p v-if="pinned.has(focused.key)" class="muted small hint"><Pin :size="13" />{{ t('pinHint') }}</p>

          <div v-if="pendingByKey.get(focused.key)?.length" class="pending">
            <span v-for="c in pendingByKey.get(focused.key)" :key="c.kind" class="pending-item">
              <span class="badge info">{{ t(pendingLabel[c.kind]) }}</span>
              <button class="btn btn-small btn-ghost" type="button" @click="undo(c)"><Undo2 :size="14" />{{ t('undoChange') }}</button>
            </span>
          </div>

          <h3>{{ t('detailDeps') }}</h3>
          <ul v-if="focused.dependencies.length" class="deps">
            <li v-for="(d, i) in focused.dependencies" :key="i">
              <CircleCheck v-if="d.state === 'satisfied'" :size="16" class="ok" />
              <Ban v-else-if="d.kind === 'incompatible'" :size="16" class="danger" />
              <CircleHelp v-else-if="d.state === 'unknown'" :size="16" />
              <CircleAlert v-else :size="16" class="danger" />
              <span class="grow">{{ d.name }}</span>
              <span class="badge">{{ t(depKindLabel[d.kind]!) }}</span>
            </li>
          </ul>
          <p v-else class="muted small">{{ t('detailNoDeps') }}</p>
        </aside>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.stats { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
.chip.link { cursor: pointer; font: inherit; font-size: 0.82rem; }
.chip.link:hover { border-color: rgba(147, 197, 253, 0.35); color: var(--text); }
.accent { color: #7dd3fc; }
.danger { color: #fca5a5; }
.ok { color: #6ee7b7; }
.pill-count { background: rgba(255, 255, 255, 0.22); border-radius: var(--radius-pill); padding: 0 7px; font-size: 0.78rem; }
.workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); flex: 1; min-height: 0; }
.workspace.open { grid-template-columns: minmax(0, 1fr) 340px; }
.table-wrap { container-type: inline-size; display: flex; flex-direction: column; gap: var(--space-2); min-height: 0; position: relative; }
.table { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; outline: none; }
.row {
  display: grid; grid-template-columns: 40px minmax(220px, 2.6fr) minmax(90px, 0.9fr) minmax(120px, 1fr) minmax(120px, 0.9fr) 112px 104px;
  align-items: center; gap: var(--space-3); height: 56px; padding: 0 var(--space-4); border-bottom: 1px solid var(--border-subtle); font-size: 0.92rem;
}
/* Drop lower-priority columns when the table itself is narrow (e.g. details drawer open). */
@container (max-width: 1000px) {
  .row { grid-template-columns: 40px minmax(200px, 2.6fr) minmax(90px, 0.9fr) minmax(120px, 1fr) minmax(110px, 0.9fr) 112px; }
  .c-state { display: none; }
}
@container (max-width: 800px) {
  .row { grid-template-columns: 40px minmax(180px, 2.6fr) minmax(110px, 1fr) 44px 112px; }
  .c-installed { display: none; }
  .row :deep(.provider > span:last-child) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
}
.row.head { height: 42px; font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); background: rgba(255, 255, 255, 0.025); }
.sort { display: inline-flex; align-items: center; gap: 4px; border: none; background: none; color: inherit; font: inherit; padding: 0; cursor: pointer; }
.sort:hover, .sort.active { color: var(--text); }
.row:not(.head) { cursor: pointer; transition: background-color var(--duration-fast) var(--ease); }
.row:not(.head):hover { background: var(--surface-hover); }
.row.selected { background: rgba(59, 130, 246, 0.14); }
.row.focused { box-shadow: inset 3px 0 0 #3b82f6; background: rgba(59, 130, 246, 0.1); }
.row.off .title, .row.off .mono { color: var(--text-muted); }
.row.removing .title { text-decoration: line-through; color: #fca5a5; }
.name { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.name-copy { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.title-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.row.compact .file { display: none; }
.row.compact :deep(.avatar) { width: 26px !important; height: 26px !important; font-size: 10px !important; }
.file { font-size: 0.78rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pin { color: #93c5fd; flex-shrink: 0; }
.tiny { font-size: 0.7rem; padding: 0 7px; }
.mono { font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.88rem; }
.update { display: inline-flex; align-items: center; gap: 5px; color: #7dd3fc; font-weight: 600; }
.uptodate { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); }
.state { display: inline-flex; align-items: center; gap: 6px; font-size: 0.86rem; color: var(--text-muted); }
.state.on { color: #6ee7b7; }
.skeleton-rows .row { cursor: default; }
.bulkbar { margin: 0 auto; }
.sel-count { padding: 0 var(--space-2); }
.divider { width: 1px; height: 20px; background: var(--border-subtle); }
.end { margin-left: var(--space-1); }
.details { position: relative; padding: var(--space-5); border-radius: var(--radius-medium); overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-4); }
.close { position: absolute; top: 10px; right: 10px; }
.details-head { display: flex; align-items: center; gap: var(--space-3); padding-right: 28px; }
.details-head > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.details-head h2 { font-size: 1.2rem; word-break: break-word; }
.details h3 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
.facts { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; font-size: 0.9rem; }
.facts dt { color: var(--text-muted); }
.facts dd { margin: 0; word-break: break-all; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mono-text { font-family: ui-monospace, Consolas, monospace; font-size: 0.82rem; }
.deps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: 0.9rem; }
.deps li { display: flex; gap: 8px; align-items: center; }
.grow { flex: 1; min-width: 0; }
.detail-actions, .pending { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.pending-item { display: inline-flex; align-items: center; gap: 4px; }
.hint { display: flex; align-items: center; gap: 6px; }
/* Narrower windows: the details panel slides over the table instead of squeezing it. */
@media (max-width: 1280px) {
  .workspace { position: relative; }
  .workspace.open { grid-template-columns: minmax(0, 1fr); }
  .details { position: absolute; top: 0; right: 0; bottom: 0; width: min(360px, 92%); z-index: 6; background: var(--glass-menu); box-shadow: var(--shadow-large); }
}
</style>
