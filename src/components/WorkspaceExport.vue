<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CircleAlert, CircleCheck, ExternalLink, FileArchive, Loader, PackageCheck, Search, ShieldAlert, TriangleAlert, Undo2, X } from '@lucide/vue';
import type { ExportRestriction, ProjectVersion, WorkspaceExportItem, SearchHit, WorkspaceSnapshot } from '../backend/contract';
import ProviderLogo from './ProviderLogo.vue';
import SearchSelect from './SearchSelect.vue';
import { fitCount, fits, neededBy, recommend, targetProvider, toCandidates, undecided, type Decision, type ExportCandidate, type PackTarget } from '../domain/exportChoice';
import { modKey, newProject } from '../domain/project';
import { formatNumber, t, type MessageKey } from '../i18n';
import { openExternal } from '../state/appUpdate';
import { useProjects } from '../state/projects';
import { asError, useSession } from '../state/session';
import { formatBytes } from '../ui/labels';
import type { ViewId } from '../App.vue';

const emit = defineEmits<{ navigate: [ViewId] }>();
const session = useSession();
const store = useProjects();
const backend = session.backend;
const OPEN_BATCH = 10;

const inst = computed(() => session.instance.value);
const name = ref(inst.value?.name ?? '');
const version = ref('1.0.0');
const candidates = computed(() => toCandidates(session.inventory.value?.mods ?? []));
const target = ref<PackTarget>('instance');
const chosenByUser = ref(false);
const decisions = ref<Record<string, Decision>>({});
const error = ref('');
const skipped = ref<WorkspaceSnapshot['skipped']>([]);
const providerName = (id: string | null) => (id === 'modrinth' ? 'Modrinth' : 'CurseForge');
const provider = computed(() => targetProvider(target.value));

const formats: { id: PackTarget; label: MessageKey; hint: MessageKey }[] = [
  { id: 'mrpack', label: 'formatMrpack', hint: 'formatMrpackHint' },
  { id: 'curseforge', label: 'formatCurseforge', hint: 'formatCurseforgeHint' },
  { id: 'instance', label: 'formatInstance', hint: 'formatInstanceHint' },
];
const recommended = computed(() => recommend(candidates.value));
onMounted(() => { if (!session.inventory.value) void session.loadInventory(); else target.value = recommended.value; });
watch(recommended, (r) => { if (!chosenByUser.value) target.value = r; });
function choose(id: PackTarget) { chosenByUser.value = true; target.value = id; }

const misfits = computed(() => candidates.value.filter((c) => !fits(c, target.value)));
const open = computed(() => undecided(candidates.value, target.value, decisions.value));
const onlyUndecided = ref(true);
/** A decided mod with something to warn about stays visible. */
const needsAttention = (c: ExportCandidate) => { const d = decisions.value[c.key]; return !d || (d.kind === 'replaced' && d.missingDependencies > 0) || (d.kind === 'leave-out' && neededBy(c, candidates.value, decisions.value).length > 0); };
const rows = computed(() => (onlyUndecided.value ? misfits.value.filter(needsAttention) : misfits.value));
const canExport = computed(() => !!name.value.trim() && !!version.value.trim() && !busy.value);

/* ----- identical files on the provider the format needs ----- */
const checking = ref(false);
const checkFailed = ref(false);
let run = 0;
async function findIdentical() {
  const id = inst.value?.id;
  const wanted = provider.value;
  const ticket = ++run;
  checkFailed.value = false;
  if (!id || !wanted || !misfits.value.length || !backend.exportMatches) { checking.value = false; return; }
  checking.value = true;
  try {
    const found = await backend.exportMatches(id, wanted, misfits.value.map((c) => c.fileName));
    if (ticket !== run) return;
    const byFile = new Map(misfits.value.map((c) => [c.fileName, c]));
    const next = { ...decisions.value };
    for (const match of found) { const c = byFile.get(match.fileName); if (c && !next[c.key]) next[c.key] = { kind: 'same-file', match }; }
    decisions.value = next;
  } catch {
    if (ticket === run) checkFailed.value = true;
  } finally {
    if (ticket === run) checking.value = false;
  }
}

/* ----- mods CurseForge players have to fetch by hand ----- */
const restricted = ref<ExportRestriction[]>([]);
const opened = ref(0);
async function loadRestricted() {
  restricted.value = [];
  opened.value = 0;
  const id = inst.value?.id;
  if (!id || target.value !== 'curseforge' || !backend.exportRestricted) return;
  const refs = candidates.value.filter((c) => c.source === 'curseforge' && c.projectId).map((c) => c.projectId!);
  try { restricted.value = await backend.exportRestricted(id, refs); } catch { /* the export does not depend on this list */ }
}
function openNext() {
  for (const r of restricted.value.slice(opened.value, opened.value + OPEN_BATCH)) if (r.pageUrl) void openExternal(r.pageUrl);
  opened.value = Math.min(restricted.value.length, opened.value + OPEN_BATCH);
}
const nextBatch = computed(() => Math.min(OPEN_BATCH, restricted.value.length - opened.value));

/* ----- finding a replacement by hand ----- */
const searchKey = ref<string | null>(null);
const query = ref('');
const hits = ref<SearchHit[]>([]);
const searching = ref(false);
const searched = ref(false);
const searchFailed = ref(false);
const pickedHit = ref<SearchHit | null>(null);
const versions = ref<ProjectVersion[]>([]);
const pickedVersion = ref('');
const loadingVersions = ref(false);
const versionOptions = computed(() => versions.value.map((v) => ({ value: v.id, label: v.versionNumber || v.name })));
function closeSearch() { searchKey.value = null; hits.value = []; searched.value = false; searchFailed.value = false; pickedHit.value = null; versions.value = []; }
function openSearch(c: ExportCandidate) {
  closeSearch();
  searchKey.value = c.key;
  query.value = c.name;
  void search();
}
async function search() {
  const i = inst.value;
  const wanted = provider.value;
  if (!i || !wanted || !query.value.trim()) return;
  searching.value = true;
  searchFailed.value = false;
  pickedHit.value = null;
  versions.value = [];
  hits.value = [];
  try {
    const page = await backend.search({ instanceId: i.id, text: query.value.trim(), provider: wanted, minecraftVersion: i.minecraftVersion ?? '', loader: i.loader?.kind ?? 'vanilla', releaseTypes: ['release', 'beta', 'alpha'], compatibleOnly: true, offset: 0, limit: 8 });
    hits.value = page.hits;
    searched.value = true;
  } catch { searchFailed.value = true; } finally { searching.value = false; }
}
async function pickHit(hit: SearchHit) {
  const i = inst.value;
  if (!i || !backend.projectVersions) return;
  pickedHit.value = hit;
  versions.value = [];
  pickedVersion.value = '';
  loadingVersions.value = true;
  try {
    versions.value = await backend.projectVersions(i.id, hit.provider, hit.projectId);
    pickedVersion.value = versions.value[0]?.id ?? '';
  } catch (e) { error.value = asError(e).message; } finally { loadingVersions.value = false; }
}
function useVersion(c: ExportCandidate) {
  const hit = pickedHit.value;
  const v = versions.value.find((x) => x.id === pickedVersion.value);
  if (!hit || !v) return;
  const inPack = new Set(candidates.value.map((x) => x.projectId));
  const missingDependencies = v.dependencies.filter((d) => d.type === 'required' && d.projectId && !inPack.has(d.projectId)).length;
  decide(c, { kind: 'replaced', provider: hit.provider, projectId: hit.projectId, versionId: v.id, name: hit.name, versionName: v.versionNumber || v.name, missingDependencies });
  closeSearch();
}

watch([target, () => candidates.value.length], () => {
  decisions.value = {};
  closeSearch();
  void findIdentical();
  void loadRestricted();
}, { immediate: true });

function decide(c: ExportCandidate, decision: Decision) { decisions.value = { ...decisions.value, [c.key]: decision }; }
function undo(c: ExportCandidate) { const { [c.key]: _, ...rest } = decisions.value; decisions.value = rest; }
function leaveOutRest() {
  const next = { ...decisions.value };
  for (const c of open.value) next[c.key] = { kind: 'leave-out' };
  decisions.value = next;
  closeSearch();
}
const decision = (c: ExportCandidate) => decisions.value[c.key];
const dependedOn = (c: ExportCandidate) => decision(c)?.kind === 'leave-out' && neededBy(c, candidates.value, decisions.value).length > 0;
const reason = (c: ExportCandidate) => (c.modified ? t('exportModifiedFile') : c.source === 'manual' ? t('exportFromManual') : t('exportFromProvider', { provider: providerName(c.source) }));

/* ----- producing the pack ----- */
const progress = ref<{ done: number; total: number } | null>(null);
const saving = ref<number | null>(null);
const saved = ref('');
const busy = computed(() => !!progress.value || saving.value !== null);
const entries = computed<WorkspaceExportItem[]>(() => candidates.value.flatMap((c): WorkspaceExportItem[] => {
  if (fits(c, target.value)) return [{ kind: 'installed', fileName: c.fileName }];
  const d = decision(c);
  if (d?.kind === 'same-file') return [{ kind: 'matched', fileName: c.fileName, provider: provider.value!, match: d.match }];
  if (d?.kind === 'replaced') return [{ kind: 'replaced', fileName: c.fileName, provider: d.provider, projectId: d.projectId, versionId: d.versionId, name: d.name }];
  return [];
}));
async function prepare() {
  const id = inst.value?.id;
  if (!id || !backend.prepareExport || target.value === 'instance' || open.value.length) return;
  const format = target.value;
  error.value = '';
  skipped.value = [];
  progress.value = { done: 0, total: entries.value.length };
  try {
    const s = await backend.prepareExport(id, format, entries.value, (done, total) => { progress.value = { done, total }; });
    const project = newProject({
      name: name.value.trim() || s.name, version: version.value.trim() || '1.0.0', minecraftVersion: s.minecraftVersion, loader: s.loader,
      summary: t('exportFromWorkspace', { name: s.name }),
      overrides: (s.configs ?? []).map((c) => ({ path: c.path, size: c.data.length })),
      mods: s.mods.map((m) => ({
        key: modKey(m.provider, m.projectId), name: m.name, provider: m.provider, projectId: m.projectId, versionId: m.versionId, versionName: m.versionName,
        file: { path: `mods/${m.fileName}`, size: m.size, sha1: m.sha1 || undefined, sha512: m.sha512, downloads: m.url ? [m.url] : [] },
        // A disabled mod stays in the pack as optional, so players can turn it on.
        ...(m.enabled ? {} : { env: { client: 'optional' as const, server: 'optional' as const } }),
        required: m.enabled, pinned: false, verified: true, origin: 'import' as const,
      })),
    });
    skipped.value = s.skipped;
    store.addProject(project);
    if (s.configs?.length) store.attachOverrides(project.id, s.name, s.configs.map((c) => ({ root: 'overrides' as const, path: c.path, data: c.data })));
    store.exportIntent.value = { projectId: project.id, format };
    if (!s.skipped.length) emit('navigate', 'projects');
  } catch (e) {
    error.value = asError(e).message;
  } finally {
    progress.value = null;
  }
}
async function saveInstance() {
  const id = inst.value?.id;
  if (!id || !backend.exportInstanceZip) return;
  error.value = '';
  saved.value = '';
  saving.value = 0;
  try {
    const done = await backend.exportInstanceZip(id, { name: name.value.trim(), version: version.value.trim() }, (written, total) => { saving.value = total ? Math.round((written / total) * 100) : 0; });
    if (done) saved.value = t('exportInstanceDone', { files: formatNumber(done.files), size: formatBytes(done.bytes), path: done.path });
  } catch (e) {
    error.value = asError(e).message;
  } finally {
    saving.value = null;
  }
}
const skipKey: Record<WorkspaceSnapshot['skipped'][number]['reason'], MessageKey> = { manual: 'skipManual', modified: 'skipModified', provider: 'skipProvider', 'not-found': 'skipNotFound', restricted: 'skipRestricted' };
onBeforeUnmount(() => { run++; });
</script>

<template>
  <section class="card panel">
    <h2 class="panel-title">{{ t('exportFormat') }}</h2>
    <div class="formats" role="radiogroup" :aria-label="t('exportFormat')">
      <label v-for="f in formats" :key="f.id" class="format" :class="{ active: target === f.id }">
        <input type="radio" name="workspace-format" class="sr-only" :checked="target === f.id" @change="choose(f.id)" />
        <FileArchive v-if="f.id === 'instance'" :size="30" class="instance-icon" />
        <ProviderLogo v-else :provider="f.id === 'mrpack' ? 'modrinth' : 'curseforge'" :size="30" />
        <span class="format-copy">
          <strong>{{ t(f.label) }}<span v-if="recommended === f.id" class="badge info">{{ t('exportRecommended') }}</span></strong>
          <span class="muted small">{{ t(f.hint) }}</span>
          <span class="small fit" :class="{ partial: fitCount(candidates, f.id) < candidates.length }">{{ t('exportFit', { fit: formatNumber(fitCount(candidates, f.id)), total: formatNumber(candidates.length) }) }}</span>
        </span>
      </label>
    </div>
    <div class="form-row">
      <label class="field"><span>{{ t('packName') }}</span><input v-model="name" class="input" /></label>
      <label class="field narrow"><span>{{ t('packVersion') }}</span><input v-model="version" class="input" /></label>
    </div>
    <div v-if="target === 'instance'" class="notice warn" role="note"><TriangleAlert :size="18" /><span class="grow">{{ t('exportInstanceWarning') }}</span></div>
    <div v-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ error }}</div>
    <div v-if="saved" class="notice success" role="status"><CircleCheck :size="18" /><span class="grow selectable">{{ saved }}</span></div>
    <div v-if="saving !== null" class="progress-block" role="status">
      <span class="small muted">{{ t('exportInstanceSaving', { percent: saving }) }}</span>
      <div class="progress"><span :style="{ width: `${saving}%` }"></span></div>
    </div>
    <div v-if="skipped.length" class="notice warn" role="status">
      <TriangleAlert :size="18" />
      <div class="grow">
        <strong>{{ t('exportSkipped', { count: skipped.length }) }}</strong>
        <ul class="small"><li v-for="s in skipped" :key="s.fileName"><code>{{ s.fileName }}</code> — {{ t(skipKey[s.reason]) }}</li></ul>
        <button class="btn btn-small" type="button" @click="emit('navigate', 'projects')">{{ t('exportOpenProject') }}</button>
      </div>
    </div>
    <div class="action-row">
      <span v-if="target !== 'instance' && open.length" class="small warn-text">{{ t('exportUndecided', { count: formatNumber(open.length) }) }}</span>
      <button v-if="target === 'instance'" class="btn btn-primary" type="button" :disabled="!canExport || !candidates.length" @click="saveInstance"><FileArchive :size="16" />{{ t('exportInstanceAction') }}</button>
      <button v-else class="btn btn-primary" type="button" :disabled="!canExport || !!open.length || checking" @click="prepare"><PackageCheck :size="16" />{{ progress ? t('exportSnapshotting', { done: formatNumber(progress.done), total: formatNumber(progress.total) }) : t('exportWorkspaceAction') }}</button>
    </div>
  </section>

  <section v-if="misfits.length && provider" class="card panel">
    <header class="review-head">
      <div>
        <h2 class="panel-title">{{ t('exportMismatch', { count: formatNumber(misfits.length), provider: providerName(provider) }) }}</h2>
        <p v-if="checking" class="muted small" role="status"><Loader :size="14" class="spin" /> {{ t('exportChecking', { provider: providerName(provider) }) }}</p>
        <p v-else-if="checkFailed" class="muted small" role="status">{{ t('exportCheckFailed') }}</p>
      </div>
      <div class="review-actions">
        <label class="check small"><input v-model="onlyUndecided" type="checkbox" />{{ t('exportOnlyUndecided') }}</label>
        <button class="btn btn-small" type="button" :disabled="!open.length" @click="leaveOutRest">{{ t('exportLeaveOutRest') }}</button>
      </div>
    </header>
    <ul class="list">
      <li v-for="c in rows" :key="c.key" class="row-block">
        <div class="row">
          <span class="grow ellipsis"><strong>{{ c.name }}</strong><span class="muted small"> · {{ reason(c) }}</span></span>
          <template v-if="decision(c)">
            <span v-if="decision(c)!.kind === 'same-file'" class="badge ok">{{ t('exportSameFile') }}</span>
            <span v-else-if="decision(c)!.kind === 'replaced'" class="badge warn" :title="t('exportDifferentFile')">{{ t('exportReplaced') }}</span>
            <span v-else class="badge">{{ t('exportLeftOut') }}</span>
            <button class="btn btn-small btn-ghost" type="button" @click="undo(c)"><Undo2 :size="14" />{{ t('exportUndo') }}</button>
          </template>
          <template v-else>
            <button class="btn btn-small" type="button" @click="searchKey === c.key ? closeSearch() : openSearch(c)"><Search :size="14" />{{ t('exportFindOn', { provider: providerName(provider) }) }}</button>
            <button class="btn btn-small btn-ghost" type="button" @click="decide(c, { kind: 'leave-out' })">{{ t('exportLeaveOut') }}</button>
          </template>
        </div>
        <p v-if="decision(c)?.kind === 'replaced'" class="small detail">
          {{ (decision(c) as Extract<Decision, { kind: 'replaced' }>).name }} {{ (decision(c) as Extract<Decision, { kind: 'replaced' }>).versionName }} · {{ t('exportDifferentFile') }}
          <template v-if="(decision(c) as Extract<Decision, { kind: 'replaced' }>).missingDependencies"> · {{ t('exportNeedsMore', { count: (decision(c) as Extract<Decision, { kind: 'replaced' }>).missingDependencies }) }}</template>
        </p>
        <p v-if="dependedOn(c)" class="small detail warn-text">{{ t('exportDependedOn') }}</p>
        <div v-if="searchKey === c.key" class="search-panel">
          <form class="search-row" @submit.prevent="search">
            <input v-model="query" class="input grow" :aria-label="t('exportSearchPlaceholder', { provider: providerName(provider) })" :placeholder="t('exportSearchPlaceholder', { provider: providerName(provider) })" />
            <button class="btn btn-small" type="submit" :disabled="searching"><Search :size="14" />{{ t('exportSearch') }}</button>
            <button class="icon-btn" type="button" :aria-label="t('dismiss')" @click="closeSearch"><X :size="16" /></button>
          </form>
          <p v-if="searching" class="muted small" role="status"><Loader :size="14" class="spin" /> {{ t('exportChecking', { provider: providerName(provider) }) }}</p>
          <p v-else-if="searchFailed" class="small warn-text" role="alert">{{ t('searchFailed') }}</p>
          <p v-else-if="searched && !hits.length" class="muted small">{{ t('exportNoHits') }}</p>
          <ul v-if="hits.length" class="hits">
            <li v-for="h in hits" :key="h.projectId" :class="{ on: pickedHit?.projectId === h.projectId }">
              <button type="button" class="hit" @click="pickHit(h)"><strong class="ellipsis">{{ h.name }}</strong><span class="muted small ellipsis">{{ h.summary }}</span></button>
              <div v-if="pickedHit?.projectId === h.projectId" class="version-row">
                <Loader v-if="loadingVersions" :size="14" class="spin" />
                <span v-else-if="!versions.length" class="muted small">{{ t('exportNoVersion') }}</span>
                <template v-else>
                  <div class="version-pick"><SearchSelect v-model="pickedVersion" :options="versionOptions" :aria-label="t('exportUseVersion')" /></div>
                  <button class="btn btn-small btn-primary" type="button" @click="useVersion(c)">{{ t('exportUseVersion') }}</button>
                </template>
              </div>
            </li>
          </ul>
        </div>
      </li>
    </ul>
  </section>

  <section v-if="restricted.length" class="card panel">
    <header class="review-head">
      <div>
        <h2 class="panel-title"><ShieldAlert :size="18" class="warn-text" />{{ t('exportRestrictedTitle', { count: formatNumber(restricted.length) }) }}</h2>
        <p class="muted small">{{ t('exportRestrictedHint') }}</p>
      </div>
      <button class="btn btn-small" type="button" :disabled="!nextBatch" @click="openNext"><ExternalLink :size="14" />{{ t('exportOpenNext', { count: nextBatch }) }}</button>
    </header>
    <ul class="list">
      <li v-for="r in restricted" :key="r.projectId" class="row">
        <span class="grow ellipsis">{{ r.name }}</span>
        <button class="btn btn-small btn-ghost" type="button" :disabled="!r.pageUrl" @click="r.pageUrl && openExternal(r.pageUrl)"><ExternalLink :size="14" />{{ t('exportOpenPage') }}</button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: var(--space-3); }
.panel + .panel { margin-top: var(--space-3); }
.panel-title { display: flex; align-items: center; gap: 8px; }
.formats { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-3); }
.format { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-medium); border: 1px solid var(--control-border); background: rgba(255, 255, 255, 0.03); cursor: pointer; }
.format:hover { border-color: rgba(147, 197, 253, 0.35); }
.format.active { border-color: rgba(96, 165, 250, 0.6); background: rgba(59, 130, 246, 0.1); }
.format:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
.format-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.format-copy strong { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.instance-icon { color: #93c5fd; }
.fit { color: #6ee7b7; font-variant-numeric: tabular-nums; }
.fit.partial { color: #fcd34d; }
.form-row { display: flex; gap: var(--space-3); flex-wrap: wrap; }
.form-row .field { flex: 1; min-width: 200px; }
.form-row .narrow { flex: 0 0 160px; min-width: 120px; }
.action-row { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-3); }
.progress-block { display: flex; flex-direction: column; gap: 6px; }
.warn-text { color: #fcd34d; }
.review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.review-actions { display: flex; align-items: center; gap: var(--space-3); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 420px; overflow-y: auto; }
.row-block { padding: 6px 10px; border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.03); font-size: 0.92rem; }
.row { display: flex; align-items: center; gap: var(--space-2); }
li.row { padding: 6px 10px; border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.03); font-size: 0.92rem; }
.detail { margin-top: 4px; color: var(--text-secondary); }
.detail.warn-text { color: #fcd34d; }
.grow { flex: 1; min-width: 0; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-panel { margin-top: 8px; padding: 10px; border-radius: var(--radius-control); background: rgba(3, 8, 16, 0.4); border: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 8px; }
.search-row { display: flex; align-items: center; gap: 8px; }
.hits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.hits li { border-radius: 7px; }
.hits li.on { background: var(--surface-hover); }
.hit { width: 100%; display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; border: none; border-radius: 7px; background: transparent; text-align: left; color: var(--text); cursor: pointer; }
.hit:hover { background: var(--surface-hover); }
.version-row { display: flex; align-items: center; gap: 8px; padding: 2px 8px 8px; }
.version-pick { flex: 1; min-width: 0; }
.spin { animation: export-spin 1.2s linear infinite; vertical-align: -2px; }
@keyframes export-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
