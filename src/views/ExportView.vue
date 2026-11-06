<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Capability, DistributionStatus,ExportFormat, ExportReport } from '../backend/contract';
import { t, type MessageKey } from '../i18n';
import { asError, useSession } from '../state/session';

const session = useSession();
const format = ref<ExportFormat>('mrpack');
const name = ref(session.instance.value?.name ?? '');
const version = ref('1.0.0');
const report = ref<ExportReport | null>(null);
const checking = ref(false);
const exporting = ref(false);
const error = ref('');
const result = ref('');
/** Bundled files are opt-in: only what the user explicitly confirms permission for. */
const include = ref<Set<string>>(new Set());
const confirmed = ref(false);

const cap = computed<Capability>(() => (format.value === 'mrpack' ? 'export.mrpack' : 'export.curseforge'));
const overrides = computed(() => (session.state.instanceId ? session.exportIncludes.value[session.state.instanceId] ?? [] : []));
const byStatus = computed(() => {
  const g: Record<DistributionStatus, ExportReport['entries']> = { 'provider-reference': [], 'needs-permission': [], blocked: [], unknown: [] };
  for (const e of report.value?.entries ?? []) g[e.status].push(e);
  return g;
});
const needsPermission = computed(() => [...byStatus.value['needs-permission'], ...byStatus.value.unknown]);
const excluded = computed(() => [...byStatus.value.blocked, ...needsPermission.value.filter((e) => !include.value.has(e.modKey))]);
const canExport = computed(() => !!report.value && session.can(cap.value) && name.value.trim() && version.value.trim() && (include.value.size === 0 || confirmed.value));
const statusLabel: Record<DistributionStatus, MessageKey> = { 'provider-reference': 'distReference', 'needs-permission': 'distPermission', blocked: 'distBlocked', unknown: 'distUnknown' };

watch(format, () => { report.value = null; include.value = new Set(); confirmed.value = false; result.value = ''; });
watch(include, () => { confirmed.value = false; });

async function check() {
  const id = session.state.instanceId;
  if (!id) return;
  checking.value = true;
  error.value = '';
  try { report.value = await session.backend.checkExport(id, format.value); } catch (e) { error.value = asError(e).message; } finally { checking.value = false; }
}
function toggle(key: string, on: boolean) {
  const next = new Set(include.value);
  if (on) next.add(key); else next.delete(key);
  include.value = next;
}
async function run() {
  const id = session.state.instanceId;
  if (!id || !canExport.value) return;
  exporting.value = true;
  error.value = '';
  try {
    const op = await session.startExport({ instanceId: id, format: format.value, name: name.value.trim(), version: version.value.trim(), includePaths: overrides.value, excludeModKeys: excluded.value.map((e) => e.modKey) });
    if (op?.state === 'completed' && op.result?.exportPath) result.value = op.result.exportPath;
    else if (op) error.value = op.error?.message ?? t('applyFailed');
  } catch (e) {
    error.value = asError(e).message;
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('exportTitle') }}</h1>
        <p>{{ t('exportSubtitle') }}</p>
      </div>
    </header>

    <section class="panel glass form">
      <label class="field"><span>{{ t('exportFormat') }}</span>
        <select v-model="format" class="select">
          <option value="mrpack">{{ t('formatMrpack') }}</option>
          <option value="curseforge">{{ t('formatCurseforge') }}</option>
        </select>
      </label>
      <label class="field"><span>{{ t('packName') }}</span><input v-model="name" class="input" /></label>
      <label class="field"><span>{{ t('packVersion') }}</span><input v-model="version" class="input" /></label>
      <button class="btn" type="button" :disabled="checking" @click="check">{{ checking ? t('checking') : t('checkPermissions') }}</button>
    </section>
    <div v-if="!session.can(cap)" class="notice warn">{{ t('capabilityMissing') }}</div>
    <div v-if="error" class="notice error" role="alert">{{ error }}</div>
    <div v-if="result" class="notice" role="status">{{ t('exportDone', { path: result }) }}</div>

    <template v-if="report">
      <p class="muted">
        {{ t('exportSummary', { reference: byStatus['provider-reference'].length, bundled: include.size, excluded: excluded.length }) }}
        · {{ t('overridesIncluded', { count: overrides.length }) }}
      </p>
      <section v-if="needsPermission.length" class="panel glass">
        <h2>{{ t('distPermission') }} <span class="badge warn">{{ needsPermission.length }}</span></h2>
        <p class="muted small">{{ t('permissionHint') }}</p>
        <ul class="list">
          <li v-for="e in needsPermission" :key="e.modKey">
            <label class="check grow"><input type="checkbox" :checked="include.has(e.modKey)" @change="toggle(e.modKey, ($event.target as HTMLInputElement).checked)" />{{ e.name }}</label>
            <span class="badge">{{ t(statusLabel[e.status]) }}</span>
          </li>
        </ul>
        <label v-if="include.size" class="notice warn check"><input v-model="confirmed" type="checkbox" />{{ t('confirmPermission') }}</label>
      </section>
      <section v-if="byStatus.blocked.length" class="panel glass">
        <h2>{{ t('distBlocked') }} <span class="badge error">{{ byStatus.blocked.length }}</span></h2>
        <p class="muted small">{{ t('blockedHint') }}</p>
        <ul class="list"><li v-for="e in byStatus.blocked" :key="e.modKey">{{ e.name }}</li></ul>
      </section>
      <div>
        <button class="btn btn-primary" type="button" :disabled="!canExport || exporting" @click="run">{{ exporting ? t('exporting') : t('startExport') }}</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; }
.panel { border-radius: var(--radius-medium); display: flex; flex-direction: column; gap: var(--space-3); }
.panel h2 { font-size: 1rem; display: flex; gap: var(--space-2); align-items: center; }
.form { flex-direction: row; flex-wrap: wrap; align-items: flex-end; }
.form .field { min-width: 180px; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 280px; overflow-y: auto; }
.list li { display: flex; align-items: center; gap: var(--space-2); padding: 4px 8px; border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.025); font-size: 0.88rem; }
.grow { flex: 1; }
.small { font-size: 0.82rem; }
</style>
