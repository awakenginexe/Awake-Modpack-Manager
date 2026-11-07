<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Ban, CircleAlert, CircleCheck, FolderOpen, Link2, PackageCheck, ShieldAlert, ShieldCheck, TriangleAlert, Upload } from '@lucide/vue';
import type { Capability, DistributionStatus, ExportFormat, ExportReport, PackProviderId } from '../backend/contract';
import Avatar from '../components/Avatar.vue';
import ProviderLogo from '../components/ProviderLogo.vue';
import { formatNumber, t, type MessageKey } from '../i18n';
import { asError, useSession } from '../state/session';
import { useProjects } from '../state/projects';
import { modKey, newProject } from '../domain/project';
import type { WorkspaceSnapshot } from '../backend/contract';
import type { ViewId } from '../App.vue';

const emit = defineEmits<{ navigate: [ViewId] }>();
const session = useSession();

/* ----- Manager workspaces: the helper has no export, so the Manager builds it from a verified snapshot. ----- */
const helperExport = computed(() => session.source.value === 'helper' && !!session.backend.snapshotWorkspace);
const snapProgress = ref<{ done: number; total: number } | null>(null);
const skipped = ref<WorkspaceSnapshot['skipped']>([]);
async function snapshot() {
  const id = session.state.instanceId;
  if (!id || !session.backend.snapshotWorkspace) return;
  error.value = '';
  skipped.value = [];
  snapProgress.value = { done: 0, total: 0 };
  try {
    const s = await session.backend.snapshotWorkspace(id, (done, total) => { snapProgress.value = { done, total }; });
    const project = newProject({
      name: name.value.trim() || s.name, version: version.value.trim() || '1.0.0', minecraftVersion: s.minecraftVersion, loader: s.loader,
      summary: t('exportFromWorkspace', { name: s.name }),
      mods: s.mods.map((m) => ({
        key: modKey(m.provider, m.projectId), name: m.name, provider: m.provider, projectId: m.projectId, versionId: m.versionId, versionName: m.versionName,
        file: { path: `mods/${m.fileName}`, size: m.size, sha1: m.sha1, sha512: m.sha512, downloads: [m.url] },
        // A disabled mod stays in the pack as optional, so players can turn it on.
        ...(m.enabled ? {} : { env: { client: 'optional' as const, server: 'optional' as const } }),
        required: m.enabled, pinned: false, verified: true, origin: 'import' as const,
      })),
    });
    skipped.value = s.skipped;
    useProjects().addProject(project);
    if (!s.skipped.length) emit('navigate', 'projects');
  } catch (e) {
    error.value = asError(e).message;
  } finally {
    snapProgress.value = null;
  }
}
const skipKey: Record<WorkspaceSnapshot['skipped'][number]['reason'], MessageKey> = { manual: 'skipManual', modified: 'skipModified', provider: 'skipProvider', 'not-found': 'skipNotFound' };
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

const formats: { id: ExportFormat; provider: PackProviderId; label: MessageKey; hint: MessageKey }[] = [
  { id: 'mrpack', provider: 'modrinth', label: 'formatMrpack', hint: 'formatMrpackHint' },
  { id: 'curseforge', provider: 'curseforge', label: 'formatCurseforge', hint: 'formatCurseforgeHint' },
];
const sources = computed(() => new Map((session.inventory.value?.mods ?? []).map((m) => [m.key, m.source])));
const sourceOf = (key: string) => sources.value.get(key);
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

    <section v-if="helperExport" class="card panel">
      <h2 class="panel-title">{{ t('exportWorkspaceTitle') }}</h2>
      <p class="muted small">{{ t('exportWorkspaceHint') }}</p>
      <div class="form-row">
        <label class="field"><span>{{ t('packName') }}</span><input v-model="name" class="input" /></label>
        <label class="field narrow"><span>{{ t('packVersion') }}</span><input v-model="version" class="input" /></label>
        <button class="btn btn-primary" type="button" :disabled="!!snapProgress" @click="snapshot"><PackageCheck :size="16" />{{ snapProgress ? t('exportSnapshotting', { done: formatNumber(snapProgress.done), total: formatNumber(snapProgress.total) }) : t('exportWorkspaceAction') }}</button>
      </div>
      <div v-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ error }}</div>
      <div v-if="skipped.length" class="notice warn" role="status">
        <TriangleAlert :size="18" />
        <div class="grow">
          <strong>{{ t('exportSkipped', { count: skipped.length }) }}</strong>
          <ul class="small"><li v-for="s in skipped" :key="s.fileName"><code>{{ s.fileName }}</code> — {{ t(skipKey[s.reason]) }}</li></ul>
          <button class="btn btn-small" type="button" @click="emit('navigate', 'projects')">{{ t('exportOpenProject') }}</button>
        </div>
      </div>
    </section>

    <section v-if="!helperExport" class="card panel">
      <h2 class="panel-title">{{ t('exportFormat') }}</h2>
      <div class="formats" role="radiogroup" :aria-label="t('exportFormat')">
        <label v-for="f in formats" :key="f.id" class="format" :class="{ active: format === f.id }">
          <input v-model="format" type="radio" name="export-format" :value="f.id" class="sr-only" />
          <ProviderLogo :provider="f.provider" :size="32" />
          <span class="format-copy"><strong>{{ t(f.label) }}</strong><span class="muted small">{{ t(f.hint) }}</span></span>
          <CircleCheck v-if="format === f.id" :size="20" class="check-mark" />
        </label>
      </div>
      <div class="form-row">
        <label class="field"><span>{{ t('packName') }}</span><input v-model="name" class="input" /></label>
        <label class="field narrow"><span>{{ t('packVersion') }}</span><input v-model="version" class="input" /></label>
        <button class="btn" type="button" :disabled="checking" @click="check"><ShieldCheck :size="16" />{{ checking ? t('checking') : t('checkPermissions') }}</button>
      </div>
    </section>

    <template v-if="!helperExport">
    <div v-if="!session.can(cap)" class="notice warn"><TriangleAlert :size="18" />{{ t('capabilityMissing') }}</div>
    <div v-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ error }}</div>
    <div v-if="result" class="notice success" role="status"><CircleCheck :size="18" />{{ t('exportDone', { path: result }) }}</div>

    <template v-if="report">
      <div class="summary">
        <div class="stat card rise" style="--i: 0"><Link2 :size="20" class="ok" /><strong>{{ byStatus['provider-reference'].length }}</strong><span class="muted small">{{ t('distReference') }}</span></div>
        <div class="stat card rise" style="--i: 1"><PackageCheck :size="20" class="info" /><strong>{{ include.size }}</strong><span class="muted small">{{ t('statBundled') }}</span></div>
        <div class="stat card rise" style="--i: 2"><Ban :size="20" class="danger" /><strong>{{ excluded.length }}</strong><span class="muted small">{{ t('statExcluded') }}</span></div>
        <div class="stat card rise" style="--i: 3"><FolderOpen :size="20" class="muted" /><strong>{{ overrides.length }}</strong><span class="muted small">{{ t('statOverrides') }}</span></div>
      </div>

      <section v-if="needsPermission.length" class="card panel">
        <h2 class="panel-title"><ShieldAlert :size="18" class="warn" />{{ t('distPermission') }} <span class="badge warn">{{ needsPermission.length }}</span></h2>
        <p class="muted small">{{ t('permissionHint') }}</p>
        <ul class="list">
          <li v-for="e in needsPermission" :key="e.modKey" :class="{ on: include.has(e.modKey) }">
            <label class="check grow">
              <input type="checkbox" :checked="include.has(e.modKey)" @change="toggle(e.modKey, ($event.target as HTMLInputElement).checked)" />
              <Avatar :name="e.name" :size="26" />
              <span class="ellipsis">{{ e.name }}</span>
            </label>
            <ProviderLogo v-if="sourceOf(e.modKey)" :provider="sourceOf(e.modKey)!" :size="16" />
            <span class="badge">{{ t(statusLabel[e.status]) }}</span>
          </li>
        </ul>
        <label v-if="include.size" class="notice warn check small"><input v-model="confirmed" type="checkbox" />{{ t('confirmPermission') }}</label>
      </section>

      <section v-if="byStatus.blocked.length" class="card panel">
        <h2 class="panel-title"><Ban :size="18" class="danger" />{{ t('distBlocked') }} <span class="badge error">{{ byStatus.blocked.length }}</span></h2>
        <p class="muted small">{{ t('blockedHint') }}</p>
        <ul class="list">
          <li v-for="e in byStatus.blocked" :key="e.modKey"><Avatar :name="e.name" :size="26" /><span class="grow ellipsis">{{ e.name }}</span><ProviderLogo v-if="sourceOf(e.modKey)" :provider="sourceOf(e.modKey)!" :size="16" /></li>
        </ul>
      </section>

      <div class="export-row">
        <button class="btn btn-primary btn-large" type="button" :disabled="!canExport || exporting" @click="run"><Upload :size="18" />{{ exporting ? t('exporting') : t('startExport') }}</button>
      </div>
    </template>
    </template>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; padding-right: 4px; }
.panel { display: flex; flex-direction: column; gap: var(--space-3); }
.formats { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-3); }
.format { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-medium); border: 1px solid var(--control-border); background: rgba(255, 255, 255, 0.03); cursor: pointer; }
.format:hover { border-color: rgba(147, 197, 253, 0.35); }
.format.active { border-color: rgba(96, 165, 250, 0.6); background: rgba(59, 130, 246, 0.1); }
.format:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
.format-copy { flex: 1; display: flex; flex-direction: column; }
.check-mark { color: #60a5fa; }
.form-row { display: flex; gap: var(--space-3); align-items: flex-end; flex-wrap: wrap; }
.form-row .field { flex: 1; min-width: 200px; }
.form-row .narrow { flex: 0 0 160px; min-width: 120px; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3); }
.stat { display: flex; flex-direction: column; gap: 4px; padding: var(--space-4); }
.stat strong { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
.ok { color: #6ee7b7; }
.info { color: #93c5fd; }
.warn { color: #fcd34d; }
.danger { color: #fca5a5; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow-y: auto; }
.list li { display: flex; align-items: center; gap: var(--space-3); padding: 6px 10px; border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.03); font-size: 0.92rem; }
.list li.on { background: rgba(59, 130, 246, 0.1); }
.grow { flex: 1; min-width: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.export-row { display: flex; justify-content: flex-end; }
</style>
