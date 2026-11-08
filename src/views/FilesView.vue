<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import { CircleAlert, Code, Copy, FileCode, FileCog, FileText, Folder, FolderOpen, Image, Lock, PackageCheck, Settings2, Sun, Trash2, TriangleAlert } from '@lucide/vue';
import { confirmDialog, copyText, openMenu, separator, toast } from '../ui/desktop';
import type { ContentArea, ContentEntry } from '../backend/contract';
import { t, type MessageKey } from '../i18n';
import { asError, useSession } from '../state/session';
import { formatBytes } from '../ui/labels';

const session = useSession();
const areas: { id: ContentArea; label: MessageKey }[] = [
  { id: 'config', label: 'areaConfig' }, { id: 'defaultconfigs', label: 'areaDefaultconfigs' }, { id: 'kubejs', label: 'areaKubejs' },
  { id: 'scripts', label: 'areaScripts' }, { id: 'resourcepacks', label: 'areaResourcepacks' }, { id: 'shaderpacks', label: 'areaShaderpacks' },
];
const areaIcon: Record<ContentArea, Component> = { config: Settings2, defaultconfigs: FileCog, kubejs: Code, scripts: FileCode, resourcepacks: Image, shaderpacks: Sun };
const area = ref<ContentArea>('config');
const entries = ref<ContentEntry[]>([]);
const loading = ref(false);
const error = ref('');

/** Export include-list is a Manager draft; it never changes the files themselves. */
const included = computed(() => new Set(session.state.instanceId ? session.exportIncludes.value[session.state.instanceId] ?? [] : []));

async function load() {
  const id = session.state.instanceId;
  if (!id || !session.can('files.read')) return;
  loading.value = true;
  error.value = '';
  try { entries.value = await session.backend.listContent(id, area.value); } catch (e) { error.value = asError(e).message; entries.value = []; } finally { loading.value = false; }
}
function setIncluded(path: string, on: boolean) {
  const id = session.state.instanceId;
  if (!id) return;
  const set = new Set(included.value);
  if (on) set.add(path); else set.delete(path);
  session.exportIncludes.value = { ...session.exportIncludes.value, [id]: [...set] };
}
watch(area, load, { immediate: true });
/** Manager projects: their files can be opened and recycled. Launcher instances stay read-only here. */
const owned = computed(() => session.source.value === 'helper' && !!session.backend.recycleContent);
async function recycle(e: ContentEntry) {
  const id = session.state.instanceId;
  if (!id || !await confirmDialog({ title: t('recycleTitle', { name: e.path }), body: t('recycleBody'), confirm: t('recycleConfirm'), cancel: t('cancel'), danger: true })) return;
  try { await session.backend.recycleContent!(id, area.value, [e.path]); toast(t('recycled', { name: e.path }), 'ok'); await load(); } catch (err) { toast(asError(err).message, 'error'); }
}
function entryMenu(event: MouseEvent, e: ContentEntry) {
  openMenu(event, [
    { label: t('openFolder'), icon: FolderOpen, disabled: !owned.value, action: () => session.backend.openFolder?.(session.state.instanceId!, area.value) },
    { label: t('copyPath'), icon: Copy, action: () => copyText(e.path) },
    separator,
    { label: t('recycleAction'), icon: Trash2, danger: true, disabled: !owned.value, action: () => recycle(e) },
  ]);
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('filesTitle') }}</h1>
        <p>{{ t('filesSubtitle') }}</p>
      </div>
      <span class="chip"><PackageCheck :size="15" />{{ t('filesIncluded', { count: included.size }) }}</span>
    </header>
    <p v-if="!owned" class="notice small"><Lock :size="18" />{{ t('filesReadOnly') }}</p>
    <div v-if="!session.can('files.read')" class="notice warn"><TriangleAlert :size="18" />{{ t('capabilityMissing') }}</div>

    <div class="columns">
      <nav class="areas card" :aria-label="t('filesTitle')">
        <button v-for="a in areas" :key="a.id" type="button" class="area" :class="{ active: area === a.id }" :aria-current="area === a.id ? 'true' : undefined" @click="area = a.id">
          <component :is="areaIcon[a.id]" :size="17" />{{ t(a.label) }}
        </button>
      </nav>
      <section class="card panel">
        <div class="panel-head">
          <h2 class="panel-title"><component :is="areaIcon[area]" :size="18" />{{ t(areas.find((a) => a.id === area)!.label) }}</h2>
          <span class="muted small">{{ t('fileCount', { count: entries.length }) }}</span>
          <button v-if="owned" class="btn btn-small" type="button" @click="session.backend.openFolder?.(session.state.instanceId!, area)"><FolderOpen :size="15" />{{ t('openFolder') }}</button>
        </div>
        <div v-if="loading" class="rows" aria-busy="true"><span v-for="n in 6" :key="n" class="skeleton" style="height: 36px"></span></div>
        <p v-else-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ error }}</p>
        <div v-else-if="!entries.length" class="empty"><span class="empty-icon"><FolderOpen :size="26" /></span><p>{{ t('filesEmpty') }}</p></div>
        <ul v-else class="entries">
          <li v-for="(e, i) in entries" :key="e.path" class="rise" :class="{ on: included.has(e.path) }" :style="{ '--i': i % 30 }" @contextmenu="entryMenu($event, e)">
            <component :is="e.kind === 'directory' ? Folder : FileText" :size="16" class="muted" />
            <span class="path" :title="e.path">{{ e.path }}</span>
            <span class="muted small size">{{ formatBytes(e.sizeBytes) }}</span>
            <label class="check small"><input type="checkbox" :checked="included.has(e.path)" @change="setIncluded(e.path, ($event.target as HTMLInputElement).checked)" />{{ t('includeInExport') }}</label>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.columns { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: var(--space-4); flex: 1; min-height: 0; }
.areas { display: flex; flex-direction: column; gap: 2px; padding: var(--space-2); align-self: start; }
.area { display: flex; align-items: center; gap: var(--space-3); text-align: left; padding: 9px 12px; border-radius: var(--radius-control); border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 0.93rem; }
.area:hover { background: var(--surface-hover); color: var(--text); }
.area.active { background: var(--surface-selected); color: #fff; }
.panel { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.panel-head { display: flex; align-items: center; justify-content: space-between; }
.rows { display: flex; flex-direction: column; gap: 6px; }
.entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.entries li { display: flex; align-items: center; gap: var(--space-3); padding: 8px 8px; border-radius: var(--radius-control); font-size: 0.9rem; }
.entries li:hover { background: var(--surface-hover); }
.entries li.on { background: rgba(59, 130, 246, 0.08); }
.path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 0.85rem; }
.size { width: 72px; text-align: right; }
@media (max-width: 800px) { .columns { grid-template-columns: 1fr; } .areas { flex-direction: row; flex-wrap: wrap; } }
</style>
