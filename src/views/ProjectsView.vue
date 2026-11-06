<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { CircleAlert, FileArchive, FolderKanban, Info, Lock, LockOpen, PackagePlus, Plus, Search, Trash2, TriangleAlert, Upload, X } from '@lucide/vue';
import type { LoaderKind } from '../backend/contract';
import ProviderLogo from '../components/ProviderLogo.vue';
import VirtualList from '../components/VirtualList.vue';
import type { ImportPreview } from '../domain/packFormats';
import { analyzeProject, type ExportBlocker, type IssueCode, type PackFormat, type ProjectMod } from '../domain/project';
import { formatDate, formatNumber, t, type MessageKey } from '../i18n';
import { compactRows } from '../state/prefs';
import { useProjects } from '../state/projects';
import { formatBytes, loaderLabel } from '../ui/labels';

const store = useProjects();
const project = store.selected;
const error = ref('');

/* ----- create ----- */
const showCreate = ref(false);
const form = ref({ name: '', minecraftVersion: '1.21.1', loader: 'fabric' as LoaderKind, loaderVersion: '' });
function create() {
  if (!form.value.name.trim() || !form.value.minecraftVersion.trim()) return;
  store.create({ name: form.value.name.trim(), minecraftVersion: form.value.minecraftVersion.trim(), loader: { kind: form.value.loader, version: form.value.loader === 'vanilla' ? '' : form.value.loaderVersion.trim() } });
  showCreate.value = false;
  form.value.name = '';
}

/* ----- import ----- */
const fileInput = ref<HTMLInputElement | null>(null);
const preview = shallowRef<ImportPreview | null>(null);
const importing = ref(false);
async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!file) return;
  error.value = '';
  importing.value = true;
  try { preview.value = await store.preview(file, file.name); } catch (err) { error.value = t('importFailed', { reason: err instanceof Error ? err.message : String(err) }); } finally { importing.value = false; }
}
const previewCounts = computed(() => {
  const mods = preview.value?.project.mods ?? [];
  return { modrinth: mods.filter((m) => m.provider === 'modrinth').length, curseforge: mods.filter((m) => m.provider === 'curseforge').length, manual: mods.filter((m) => m.provider === 'manual').length };
});
function adopt() {
  if (!preview.value) return;
  store.adopt(preview.value);
  preview.value = null;
}

/* ----- mods ----- */
type Filter = 'all' | 'pinned' | 'issues' | 'unverified' | 'optional';
const filter = ref<Filter>('all');
const query = ref('');
const selection = shallowRef(new Set<string>());
watch(() => project.value?.id, () => { selection.value = new Set(); filter.value = 'all'; query.value = ''; });

const issues = computed(() => (project.value ? analyzeProject(project.value) : []));
const issuesByMod = computed(() => {
  const map = new Map<string, IssueCode[]>();
  for (const i of issues.value) if (i.severity !== 'info') for (const k of i.modKeys) map.set(k, [...(map.get(k) ?? []), i.code]);
  return map;
});
const errorCount = computed(() => issues.value.filter((i) => i.severity === 'error').length);
const counts = computed(() => {
  const mods = project.value?.mods ?? [];
  return { all: mods.length, pinned: mods.filter((m) => m.pinned).length, issues: issuesByMod.value.size, unverified: mods.filter((m) => !m.verified).length, optional: mods.filter((m) => !m.required).length };
});
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (project.value?.mods ?? []).filter((m) => {
    if (filter.value === 'pinned' && !m.pinned) return false;
    if (filter.value === 'issues' && !issuesByMod.value.has(m.key)) return false;
    if (filter.value === 'unverified' && m.verified) return false;
    if (filter.value === 'optional' && m.required) return false;
    return !q || m.name.toLowerCase().includes(q) || (m.projectId ?? '').toLowerCase().includes(q) || (m.file?.path ?? '').toLowerCase().includes(q);
  });
});
const allShownSelected = computed(() => shown.value.length > 0 && shown.value.every((m) => selection.value.has(m.key)));
function toggle(key: string) {
  const next = new Set(selection.value);
  next.has(key) ? next.delete(key) : next.add(key);
  selection.value = next;
}
function toggleAll() {
  selection.value = allShownSelected.value ? new Set() : new Set(shown.value.map((m) => m.key));
}
function bulk(action: 'pin' | 'unpin' | 'remove' | 'optional' | 'required') {
  const id = project.value?.id;
  if (!id || !selection.value.size) return;
  if (action === 'remove') store.removeMods(id, selection.value);
  else if (action === 'pin' || action === 'unpin') store.setPinned(id, selection.value, action === 'pin');
  else store.setRequired(id, selection.value, action === 'required');
  if (action === 'remove') selection.value = new Set();
}
const issueKey: Record<IssueCode, MessageKey> = {
  'duplicate-project': 'issueDuplicateProject', 'duplicate-file': 'issueDuplicateFile', 'dependency-missing': 'issueDependencyMissing',
  incompatible: 'issueIncompatible', unverified: 'projUnverified', 'manual-file': 'issueManualFile',
};
const versionText = (m: ProjectMod) => m.versionName || m.versionId || '—';
const detailText = (m: ProjectMod) => m.file?.path ?? (m.projectId ? `${m.provider === 'curseforge' ? 'CurseForge' : 'Modrinth'} · ${m.projectId}` : '');

/* ----- plan a mod / change version ----- */
const showAdd = ref(false);
const addForm = ref({ provider: 'modrinth' as 'modrinth' | 'curseforge', projectId: '', versionId: '', name: '' });
function addPlanned() {
  if (!project.value || !addForm.value.projectId.trim()) return;
  store.addPlanned(project.value.id, addForm.value);
  addForm.value = { ...addForm.value, projectId: '', versionId: '', name: '' };
  showAdd.value = false;
}
const versionEdit = ref<{ key: string; name: string; value: string } | null>(null);
function saveVersion() {
  if (project.value && versionEdit.value) store.setVersion(project.value.id, versionEdit.value.key, versionEdit.value.value);
  versionEdit.value = null;
}

/* ----- export ----- */
const showExport = ref(false);
const exportFormat = ref<PackFormat>('mrpack');
const excludeBlocked = ref(false);
const exportPlan = computed(() => {
  const p = project.value;
  if (!p) return null;
  const first = store.plan(p, exportFormat.value, new Set());
  if (!excludeBlocked.value) return first;
  return store.plan(p, exportFormat.value, new Set(first.blockers.map((b) => b.modKey).filter((k): k is string => !!k)));
});
const blockerKey: Record<ExportBlocker, MessageKey> = {
  'no-hashes': 'blockNoHashes', 'no-download': 'blockNoDownload', 'download-host': 'blockDownloadHost', 'no-size': 'blockNoSize',
  'not-curseforge': 'blockNotCurseforge', 'no-file-id': 'blockNoFileId', 'no-loader-version': 'blockNoLoaderVersion',
  'no-minecraft-version': 'blockNoMinecraftVersion', 'nothing-to-export': 'blockNothing',
};
const blockerSummary = computed(() => {
  const groups = new Map<ExportBlocker, number>();
  for (const b of exportPlan.value?.blockers ?? []) groups.set(b.code, (groups.get(b.code) ?? 0) + 1);
  return [...groups];
});
const savedTo = ref('');
const saving = ref(false);
/** Desktop: native Save As, written atomically by the host. Browser: a normal download. */
async function download() {
  const p = project.value;
  const plan = exportPlan.value;
  if (!p || !plan?.ready) return;
  const blob = store.exportArchive(p, plan.format, new Set(plan.excluded));
  const name = `${p.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}-${p.version}.${plan.format === 'mrpack' ? 'mrpack' : 'zip'}`;
  if ('__TAURI_INTERNALS__' in window) {
    saving.value = true;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const path = await invoke<string | null>('save_export', { fileName: name, format: plan.format, bytes });
      if (path === null) return; // cancelled: keep the dialog open
      savedTo.value = path;
      showExport.value = false;
    } catch (e) {
      error.value = t('projExportFailed', { reason: String(e) });
    } finally {
      saving.value = false;
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  showExport.value = false;
}

function removeProject() {
  if (project.value && confirm(t('projDeleteConfirm', { name: project.value.name }))) store.remove(project.value.id);
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('projectsTitle') }}</h1>
        <p>{{ t('projectsSubtitle') }}</p>
      </div>
      <div class="toolbar">
        <input ref="fileInput" type="file" accept=".mrpack,.zip" hidden @change="onFile" />
        <button class="btn" type="button" :disabled="importing" @click="fileInput?.click()"><FileArchive :size="16" />{{ importing ? t('importReading') : t('importPack') }}</button>
        <button class="btn btn-primary" type="button" @click="showCreate = true"><Plus :size="16" />{{ t('projNew') }}</button>
      </div>
    </header>

    <p v-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ error }}</p>
    <p v-if="store.saveError.value" class="notice error" role="alert"><CircleAlert :size="18" />{{ t('projSaveFailed', { reason: store.saveError.value }) }}</p>
    <p v-if="store.readOnly.value === 'newer'" class="notice warn" role="alert"><Lock :size="18" />{{ t('projStoreNewer') }}</p>
    <div v-if="store.legacyPending.value" class="notice" role="note">
      <Info :size="18" /><span class="grow">{{ t('projLegacyFound', { count: store.projects.value.length }) }}</span>
      <button class="btn btn-small btn-primary" type="button" @click="store.moveLegacy()">{{ t('projLegacyMove') }}</button>
    </div>
    <p v-if="savedTo" class="notice" role="status"><Info :size="18" /><span class="grow">{{ t('projExportSaved', { path: savedTo }) }}</span><button class="icon-btn" type="button" :aria-label="t('dismiss')" @click="savedTo = ''"><X :size="16" /></button></p>

    <div v-if="!store.projects.value.length" class="empty card">
      <span class="empty-icon"><FolderKanban :size="26" /></span>
      <h2>{{ t('projEmptyTitle') }}</h2>
      <p>{{ t('projEmptyHint') }}</p>
    </div>

    <div v-else class="layout">
      <ul class="project-list" :aria-label="t('projectsTitle')">
        <li v-for="p in store.projects.value" :key="p.id">
          <button type="button" class="project card" :class="{ selected: p.id === project?.id }" @click="store.select(p.id)">
            <strong>{{ p.name }}</strong>
            <span class="muted small">{{ p.minecraftVersion }} · {{ loaderLabel(p.loader.kind) || t('vanilla') }}{{ p.loader.version ? ` ${p.loader.version}` : '' }}</span>
            <span class="row-badges"><span class="badge warn">{{ t('projDraft') }}</span><span class="badge">{{ t('projModCount', { count: formatNumber(p.mods.length) }) }}</span></span>
          </button>
        </li>
      </ul>

      <div v-if="project" class="detail">
        <div class="detail-head">
          <div>
            <h2>{{ project.name }} <span class="muted">{{ project.version }}</span></h2>
            <p class="muted small">
              {{ project.minecraftVersion }} · {{ loaderLabel(project.loader.kind) || t('vanilla') }} {{ project.loader.version || (project.loader.kind === 'vanilla' ? '' : t('projLoaderVersionMissing')) }}
              · {{ project.source.kind === 'import' ? t('projFromImport', { file: project.source.fileName }) : t('projCreated', { date: formatDate(project.createdAt) }) }}
            </p>
          </div>
          <div class="toolbar">
            <button class="btn" type="button" @click="showAdd = true"><PackagePlus :size="16" />{{ t('projPlanMod') }}</button>
            <button class="btn" type="button" @click="showExport = true"><Upload :size="16" />{{ t('projExport') }}</button>
            <button class="icon-btn" type="button" :title="t('projDelete')" :aria-label="t('projDelete')" @click="removeProject"><Trash2 :size="18" /></button>
          </div>
        </div>

        <p class="notice small"><Info :size="18" />{{ t('projDraftNotice') }}</p>
        <p v-if="project.overrides.length" class="notice warn small"><TriangleAlert :size="18" />{{ t('projOverridesListed', { count: formatNumber(project.overrides.length) }) }}</p>

        <div class="toolbar">
          <label class="search-field"><Search :size="16" /><input v-model="query" class="input" type="search" :placeholder="t('projSearch')" :aria-label="t('projSearch')" /></label>
          <div class="segmented" role="tablist">
            <button v-for="f in (['all', 'pinned', 'issues', 'unverified', 'optional'] as Filter[])" :key="f" type="button" role="tab" :aria-selected="filter === f" :class="{ active: filter === f }" @click="filter = f">
              {{ t(({ all: 'filterAll', pinned: 'filterPinned', issues: 'projFilterIssues', unverified: 'projUnverified', optional: 'projOptional' } as const)[f]) }} <span class="count-pill">{{ counts[f] }}</span>
            </button>
          </div>
        </div>

        <p v-if="errorCount" class="notice error small" role="status"><CircleAlert :size="18" />{{ t('projIssueSummary', { count: errorCount }) }}</p>

        <Transition name="swap">
          <div v-if="selection.size" class="bulk glass" role="toolbar">
            <span>{{ t('selectedCount', { count: selection.size }) }}</span>
            <button class="btn btn-small" type="button" @click="bulk('pin')"><Lock :size="14" />{{ t('projPin') }}</button>
            <button class="btn btn-small" type="button" @click="bulk('unpin')"><LockOpen :size="14" />{{ t('projUnpin') }}</button>
            <button class="btn btn-small" type="button" @click="bulk('optional')">{{ t('projMakeOptional') }}</button>
            <button class="btn btn-small" type="button" @click="bulk('required')">{{ t('projMakeRequired') }}</button>
            <button class="btn btn-small danger" type="button" @click="bulk('remove')"><Trash2 :size="14" />{{ t('projRemove') }}</button>
            <button class="icon-btn" type="button" :aria-label="t('clearSelection')" @click="selection = new Set()"><X :size="16" /></button>
          </div>
        </Transition>

        <div class="table card">
          <div class="thead">
            <input type="checkbox" :checked="allShownSelected" :aria-label="t('selectAll')" @change="toggleAll" />
            <span>{{ t('colName') }}</span><span>{{ t('projColVersion') }}</span><span>{{ t('colSource') }}</span><span>{{ t('projColState') }}</span>
          </div>
          <p v-if="!shown.length" class="muted small empty-rows">{{ project.mods.length ? t('noMatches') : t('projNoMods') }}</p>
          <VirtualList v-else class="rows" :items="shown" :row-height="compactRows ? 44 : 56" :item-key="(m) => m.key" :label="t('projectsTitle')">
            <template #default="{ item: m }">
              <div class="row" :class="{ compact: compactRows, selected: selection.has(m.key) }">
                <input type="checkbox" :checked="selection.has(m.key)" :aria-label="m.name" @change="toggle(m.key)" />
                <span class="name"><strong>{{ m.name }}</strong><span class="muted small ellipsis">{{ detailText(m) }}</span></span>
                <span class="version">
                  <button class="link" type="button" :title="t('projChangeVersion')" @click="versionEdit = { key: m.key, name: m.name, value: m.versionId ?? '' }">{{ versionText(m) }}</button>
                  <Lock v-if="m.pinned" :size="13" :aria-label="t('projPinned')" />
                </span>
                <span class="source"><ProviderLogo :provider="m.provider" :size="16" label /></span>
                <span class="row-badges">
                  <span v-if="!m.verified" class="badge warn" :title="t('projUnverifiedHint')">{{ t('projUnverified') }}</span>
                  <span v-if="!m.required" class="badge">{{ t('projOptional') }}</span>
                  <span v-if="m.env?.server === 'unsupported'" class="badge">{{ t('projClientOnly') }}</span>
                  <span v-for="code in issuesByMod.get(m.key) ?? []" :key="code" class="badge" :class="code === 'manual-file' ? 'warn' : 'error'">{{ t(issueKey[code]) }}</span>
                </span>
              </div>
            </template>
          </VirtualList>
        </div>
      </div>
    </div>

    <!-- Create -->
    <Transition name="modal">
      <div v-if="showCreate" class="dialog-overlay" @click.self="showCreate = false" @keydown.esc="showCreate = false">
        <form class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="proj-create" @submit.prevent="create">
          <header><h2 id="proj-create">{{ t('projNew') }}</h2><p class="muted small">{{ t('projNewHint') }}</p></header>
          <div class="dialog-body">
            <label class="field"><span>{{ t('createName') }}</span><input v-model="form.name" class="input" required autofocus /></label>
            <label class="field"><span>{{ t('createVersion') }}</span><input v-model="form.minecraftVersion" class="input" list="mc-versions" required /></label>
            <datalist id="mc-versions"><option>1.21.1</option><option>1.20.1</option><option>1.19.2</option><option>1.18.2</option><option>1.16.5</option></datalist>
            <label class="field"><span>{{ t('createLoader') }}</span>
              <select v-model="form.loader" class="select"><option v-for="l in (['fabric', 'quilt', 'forge', 'neoforge', 'vanilla'] as LoaderKind[])" :key="l" :value="l">{{ loaderLabel(l) }}</option></select>
            </label>
            <label v-if="form.loader !== 'vanilla'" class="field"><span>{{ t('projLoaderVersion') }}</span><input v-model="form.loaderVersion" class="input" :placeholder="t('projLoaderVersionHint')" /></label>
          </div>
          <footer>
            <button class="btn" type="button" @click="showCreate = false">{{ t('cancel') }}</button>
            <button class="btn btn-primary" type="submit" :disabled="!form.name.trim() || !form.minecraftVersion.trim()">{{ t('projCreate') }}</button>
          </footer>
        </form>
      </div>
    </Transition>

    <!-- Import preview -->
    <Transition name="modal">
      <div v-if="preview" class="dialog-overlay" @click.self="preview = null" @keydown.esc="preview = null">
        <div class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="proj-import">
          <header><h2 id="proj-import">{{ t('importPreviewTitle') }}</h2><p class="muted small">{{ t('importPreviewHint') }}</p></header>
          <div class="dialog-body">
            <dl class="facts">
              <dt>{{ t('createName') }}</dt><dd>{{ preview.project.name }} {{ preview.project.version }}</dd>
              <dt>{{ t('importFormat') }}</dt><dd>{{ preview.format === 'mrpack' ? 'Modrinth (.mrpack)' : 'CurseForge (.zip)' }}</dd>
              <dt>{{ t('createVersion') }}</dt><dd>{{ preview.project.minecraftVersion }} · {{ loaderLabel(preview.project.loader.kind) || t('vanilla') }} {{ preview.project.loader.version }}</dd>
              <dt>{{ t('importMods') }}</dt><dd>{{ t('importModBreakdown', { total: formatNumber(preview.project.mods.length), modrinth: previewCounts.modrinth, curseforge: previewCounts.curseforge, manual: previewCounts.manual }) }}</dd>
              <dt>{{ t('importOverrides') }}</dt><dd>{{ t('importOverrideSummary', { count: formatNumber(preview.project.overrides.length), size: formatBytes(preview.stats.overrideBytes) }) }}</dd>
            </dl>
            <p v-if="preview.format === 'curseforge'" class="notice small"><Info :size="18" />{{ t('importCurseforgeNames') }}</p>
            <div v-if="preview.warnings.length" class="notice warn small">
              <TriangleAlert :size="18" />
              <div><strong>{{ t('importWarnings', { count: preview.warnings.length }) }}</strong>
                <ul class="warn-list"><li v-for="(w, i) in preview.warnings.slice(0, 8)" :key="i"><code>{{ w.code }}</code> {{ w.detail }}</li></ul>
              </div>
            </div>
          </div>
          <footer>
            <button class="btn" type="button" @click="preview = null">{{ t('cancel') }}</button>
            <button class="btn btn-primary" type="button" @click="adopt">{{ t('importSave') }}</button>
          </footer>
        </div>
      </div>
    </Transition>

    <!-- Plan a mod -->
    <Transition name="modal">
      <div v-if="showAdd" class="dialog-overlay" @click.self="showAdd = false" @keydown.esc="showAdd = false">
        <form class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="proj-add" @submit.prevent="addPlanned">
          <header><h2 id="proj-add">{{ t('projPlanMod') }}</h2><p class="muted small">{{ t('projPlanModHint') }}</p></header>
          <div class="dialog-body">
            <label class="field"><span>{{ t('colSource') }}</span>
              <select v-model="addForm.provider" class="select"><option value="modrinth">Modrinth</option><option value="curseforge">CurseForge</option></select>
            </label>
            <label class="field"><span>{{ t('projProjectId') }}</span><input v-model="addForm.projectId" class="input" required autofocus :placeholder="addForm.provider === 'modrinth' ? 'sodium' : '394468'" /></label>
            <label class="field"><span>{{ t('projVersionIdOptional') }}</span><input v-model="addForm.versionId" class="input" /></label>
            <label class="field"><span>{{ t('projDisplayName') }}</span><input v-model="addForm.name" class="input" /></label>
          </div>
          <footer>
            <button class="btn" type="button" @click="showAdd = false">{{ t('cancel') }}</button>
            <button class="btn btn-primary" type="submit" :disabled="!addForm.projectId.trim()">{{ t('projAddToPlan') }}</button>
          </footer>
        </form>
      </div>
    </Transition>

    <!-- Change version -->
    <Transition name="modal">
      <div v-if="versionEdit" class="dialog-overlay" @click.self="versionEdit = null" @keydown.esc="versionEdit = null">
        <form class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="proj-version" @submit.prevent="saveVersion">
          <header><h2 id="proj-version">{{ t('projChangeVersion') }}</h2><p class="muted small">{{ versionEdit.name }}. {{ t('projChangeVersionHint') }}</p></header>
          <div class="dialog-body"><label class="field"><span>{{ t('projVersionId') }}</span><input v-model="versionEdit.value" class="input" autofocus /></label></div>
          <footer>
            <button class="btn" type="button" @click="versionEdit = null">{{ t('cancel') }}</button>
            <button class="btn btn-primary" type="submit">{{ t('save') }}</button>
          </footer>
        </form>
      </div>
    </Transition>

    <!-- Export -->
    <Transition name="modal">
      <div v-if="showExport && project && exportPlan" class="dialog-overlay" @click.self="showExport = false" @keydown.esc="showExport = false">
        <div class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="proj-export">
          <header><h2 id="proj-export">{{ t('projExport') }}</h2><p class="muted small">{{ t('projExportHint') }}</p></header>
          <div class="dialog-body">
            <label class="field"><span>{{ t('importFormat') }}</span>
              <select v-model="exportFormat" class="select"><option value="mrpack">Modrinth (.mrpack)</option><option value="curseforge">CurseForge (.zip)</option></select>
            </label>
            <label class="check"><input v-model="excludeBlocked" type="checkbox" />{{ t('projExcludeBlocked') }}</label>
            <p class="small">{{ t('projExportIncluded', { included: formatNumber(exportPlan.included.length), excluded: formatNumber(exportPlan.excluded.length) }) }}</p>
            <div v-if="blockerSummary.length" class="notice error small">
              <CircleAlert :size="18" />
              <div><strong>{{ t('projExportBlocked') }}</strong><ul class="warn-list"><li v-for="[code, n] in blockerSummary" :key="code">{{ t(blockerKey[code]) }}<template v-if="n > 1"> ({{ formatNumber(n) }})</template></li></ul></div>
            </div>
            <p v-else class="notice small"><Info :size="18" />{{ t('projExportReady') }}</p>
            <p v-if="exportPlan.overridesOmitted" class="notice warn small"><TriangleAlert :size="18" />{{ t('projOverridesOmitted', { count: formatNumber(exportPlan.overridesOmitted) }) }}</p>
          </div>
          <footer>
            <button class="btn" type="button" @click="showExport = false">{{ t('cancel') }}</button>
            <button class="btn btn-primary" type="button" :disabled="!exportPlan.ready || saving" @click="download">{{ t('projDownload') }}</button>
          </footer>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(220px, 280px) 1fr; gap: var(--space-4); container-type: inline-size; }
.project-list { list-style: none; margin: 0; padding: 0 4px 0 0; display: flex; flex-direction: column; gap: var(--space-2); overflow-y: auto; }
.project { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 4px; padding: var(--space-3); cursor: pointer; color: var(--text); font: inherit; transition: border-color var(--duration-fast) var(--ease), background-color var(--duration-fast) var(--ease); }
.project:hover { background: var(--surface-hover); }
.project.selected { border-color: rgba(96, 165, 250, 0.6); }
.row-badges { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.detail { min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.detail-head { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap; }
.detail-head h2 { font-size: 1.25rem; }
.segmented { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--radius-control); background: var(--surface); flex-wrap: wrap; }
.segmented button { border: none; background: transparent; color: var(--text-secondary); padding: 5px 10px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 0.86rem; }
.segmented button.active { background: var(--accent-subtle); color: var(--text); }
.count-pill { opacity: 0.7; font-size: 0.78rem; margin-left: 2px; }
.bulk { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-radius: var(--radius-control); flex-wrap: wrap; }
.danger { color: #fca5a5; }
.table { flex: 1; min-height: 240px; display: flex; flex-direction: column; overflow: hidden; }
.thead, .row { display: grid; grid-template-columns: 28px minmax(180px, 2fr) minmax(90px, 1fr) minmax(110px, 1fr) minmax(140px, 1.4fr); align-items: center; gap: var(--space-3); padding: 0 var(--space-4); }
.thead { min-height: 40px; font-size: 0.8rem; color: var(--text-muted); border-bottom: 1px solid var(--border-subtle); }
.rows { flex: 1; min-height: 0; }
.row { height: 56px; border-bottom: 1px solid var(--border-subtle); }
.row.compact { height: 44px; }
.row.selected { background: var(--accent-subtle); }
.name { display: flex; flex-direction: column; min-width: 0; }
.name strong { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.version { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.link { border: none; background: none; color: var(--text); padding: 0; cursor: pointer; font: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-decoration: underline dotted var(--text-muted); }
.empty-rows { padding: var(--space-5); text-align: center; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px var(--space-3); margin: 0; }
.facts dt { color: var(--text-muted); font-size: 0.86rem; }
.facts dd { margin: 0; }
.warn-list { margin: 4px 0 0; padding-left: 18px; }
.check { display: flex; align-items: center; gap: var(--space-2); font-size: 0.9rem; }
@container (max-width: 720px) {
  .thead, .row { grid-template-columns: 28px 1fr minmax(80px, auto); }
  .thead span:nth-of-type(n + 3), .row .source, .row .row-badges { display: none; }
}
@media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } .project-list { flex-direction: row; overflow-x: auto; } .project-list li { min-width: 220px; } }
</style>
