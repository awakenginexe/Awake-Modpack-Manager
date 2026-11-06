<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ContentArea, ContentEntry } from '../backend/contract';
import { t, type MessageKey } from '../i18n';
import { asError, useSession } from '../state/session';
import { formatBytes } from '../ui/labels';

const session = useSession();
const areas: { id: ContentArea; label: MessageKey }[] = [
  { id: 'config', label: 'areaConfig' }, { id: 'defaultconfigs', label: 'areaDefaultconfigs' }, { id: 'kubejs', label: 'areaKubejs' },
  { id: 'scripts', label: 'areaScripts' }, { id: 'resourcepacks', label: 'areaResourcepacks' }, { id: 'shaderpacks', label: 'areaShaderpacks' },
];
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
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('filesTitle') }}</h1>
        <p>{{ t('filesSubtitle') }}</p>
      </div>
      <span class="badge info">{{ t('filesIncluded', { count: included.size }) }}</span>
    </header>
    <p class="notice">{{ t('filesReadOnly') }}</p>
    <div v-if="!session.can('files.read')" class="notice warn">{{ t('capabilityMissing') }}</div>

    <div class="columns">
      <nav class="areas glass" :aria-label="t('filesTitle')">
        <button v-for="a in areas" :key="a.id" type="button" class="area" :class="{ active: area === a.id }" :aria-current="area === a.id ? 'true' : undefined" @click="area = a.id">{{ t(a.label) }}</button>
      </nav>
      <section class="panel glass">
        <p v-if="loading" class="muted" role="status">{{ t('loadingFiles') }}</p>
        <p v-else-if="error" class="notice error" role="alert">{{ error }}</p>
        <p v-else-if="!entries.length" class="muted">{{ t('filesEmpty') }}</p>
        <ul v-else class="entries">
          <li v-for="e in entries" :key="e.path">
            <span class="path">{{ e.path }}</span>
            <span class="muted small">{{ formatBytes(e.sizeBytes) }}</span>
            <label class="check small"><input type="checkbox" :checked="included.has(e.path)" @change="setIncluded(e.path, ($event.target as HTMLInputElement).checked)" />{{ t('includeInExport') }}</label>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.columns { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: var(--space-4); flex: 1; min-height: 0; }
.areas { display: flex; flex-direction: column; gap: 2px; padding: var(--space-2); border-radius: var(--radius-medium); align-self: start; }
.area { text-align: left; padding: 8px 10px; border-radius: var(--radius-control); border: none; background: transparent; color: var(--text-secondary); cursor: pointer; }
.area:hover { background: var(--surface-hover); color: var(--text); }
.area.active { background: var(--surface-selected); color: #fff; }
.panel { border-radius: var(--radius-medium); overflow-y: auto; min-height: 0; }
.entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.entries li { display: flex; align-items: center; gap: var(--space-3); padding: 6px 4px; border-bottom: 1px solid var(--border-subtle); font-size: 0.88rem; }
.path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 0.82rem; }
.small { font-size: 0.8rem; }
@media (max-width: 800px) { .columns { grid-template-columns: 1fr; } .areas { flex-direction: row; flex-wrap: wrap; } }
</style>
