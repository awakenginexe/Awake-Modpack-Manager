<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CircleAlert, FileArchive, Loader, TriangleAlert } from '@lucide/vue';
import type { BackendError, DependencyResolution, ImportInspection, InstanceSummary } from '../backend/contract';
import DependencyConflicts from './DependencyConflicts.vue';
import { mergeResolutions } from '../domain/conflicts';
import { HELPER_INSTALLATION } from '../backend/helper/HelperClient';
import type { ImportPreview } from '../domain/packFormats';
import { formatNumber, t } from '../i18n';
import { asError, useSession } from '../state/session';
import { formatBytes, importErrorHint, loaderLabel } from '../ui/labels';

/**
 * Install a modpack archive into a Manager-owned workspace through the native helper:
 * upload (bounded chunks) → inspect → create or pick a matching workspace → prepare → Review.
 * Nothing is written to the workspace until the user applies the reviewed plan there.
 */
const props = defineProps<{ file: File; preview: ImportPreview }>();
const emit = defineEmits<{ close: []; review: [] }>();
const session = useSession();
const { state } = session;

type Step = 'choose' | 'uploading' | 'inspecting' | 'creating' | 'preparing';
const step = ref<Step>('choose');
const sent = ref(0);
const error = ref<BackendError | null>(null);
const inspection = ref<ImportInspection | null>(null);
const target = ref<'new' | string>('new');
const name = ref(props.preview.project.name.slice(0, 80));
const includeOptional = ref(false);
let abort: AbortController | null = null;
/** Upload and workspace kept after a reviewable dependency conflict, so a retry needs no new upload. */
const pending = ref<{ instanceId: string; token: string } | null>(null);
const decisions = ref<DependencyResolution[]>([]);
const canResolve = computed(() => !!session.backend.canResolveDependencies?.());

const pack = props.preview.project;
/** An existing workspace qualifies only with the exact Minecraft and loader versions of the pack. */
const matches = (w: InstanceSummary) => w.manageable && w.minecraftVersion === pack.minecraftVersion
  && w.loader?.kind === pack.loader.kind && (pack.loader.kind === 'vanilla' || w.loader?.version === pack.loader.version);
const eligible = computed(() => state.instances.filter(matches));
const optionalCount = computed(() => pack.mods.filter((m) => !m.required).length);

onMounted(async () => {
  // Imports land in the Manager's own workspaces, never in a Launcher instance.
  if (state.installationId !== HELPER_INSTALLATION && state.installations.some((i) => i.id === HELPER_INSTALLATION)) {
    state.installationId = HELPER_INSTALLATION;
    await session.refreshInstances().catch(() => undefined);
  }
});

async function run() {
  const b = session.backend;
  if (!b.uploadImport || !b.inspectImport) return;
  error.value = null;
  abort = new AbortController();
  let token: string | null = null;
  try {
    step.value = 'uploading';
    token = await b.uploadImport(props.file, (n) => { sent.value = n; }, abort.signal);
    step.value = 'inspecting';
    const ins = await b.inspectImport(token, props.preview.format);
    inspection.value = ins;
    let instanceId = target.value;
    if (instanceId === 'new') {
      step.value = 'creating';
      // The helper's reading of the archive decides the exact versions, not the Manager's preview.
      const final = await session.createInstance({ name: name.value.trim(), minecraftVersion: ins.minecraftVersion, loader: ins.loader.kind, loaderVersion: ins.loader.version || undefined });
      if (final?.state !== 'completed' || !final.result?.instanceId) throw asError(new Error(final?.error?.message ?? t('importCreateFailed')));
      instanceId = final.result.instanceId;
      await session.refreshInstances();
    } else {
      const w = state.instances.find((i) => i.id === instanceId);
      if (!w || w.minecraftVersion !== ins.minecraftVersion || w.loader?.kind !== ins.loader.kind || (ins.loader.kind !== 'vanilla' && w.loader?.version !== ins.loader.version)) {
        throw asError(new Error(t('importMismatch', { version: ins.minecraftVersion, loader: `${loaderLabel(ins.loader.kind)} ${ins.loader.version}`.trim() })));
      }
    }
    const t0 = token;
    token = null; // prepare() owns the upload from here on
    await prepare(instanceId, t0, []);
  } catch (e) {
    error.value = asError(e);
    step.value = 'choose';
    if (token) await b.discardImport?.(token).catch(() => undefined);
  } finally {
    abort = null;
  }
}
/**
 * The helper reports every dependency problem at once, before it stages any file. A problem the user can
 * decide keeps the upload for a retry with those decisions; anything else discards it immediately.
 */
async function prepare(instanceId: string, token: string, resolutions: DependencyResolution[]) {
  step.value = 'preparing';
  error.value = null;
  try {
    await session.prepareImport(instanceId, token, props.preview.format, includeOptional.value, props.file.name, resolutions, true);
    pending.value = null;
    emit('review');
  } catch (e) {
    const err = asError(e);
    error.value = err;
    const reviewable = err.code === 'dependency-conflict' && !!err.conflicts?.length && canResolve.value && err.conflicts.every((c) => c.resolutions.length);
    pending.value = reviewable ? { instanceId, token } : null;
    if (!reviewable && err.code === 'dependency-conflict') await session.backend.discardImport?.(token).catch(() => undefined);
  } finally {
    step.value = 'choose';
  }
}
async function retry(resolutions: DependencyResolution[]) {
  if (!pending.value) return;
  decisions.value = mergeResolutions(decisions.value, resolutions);
  await prepare(pending.value.instanceId, pending.value.token, decisions.value);
}
async function dropPending() {
  const p = pending.value;
  pending.value = null;
  if (p) await session.backend.discardImport?.(p.token).catch(() => undefined);
}
function cancel() {
  if (abort) abort.abort();
  else { void dropPending(); emit('close'); }
}
const busy = computed(() => step.value !== 'choose');
const stepText = computed(() => ({
  choose: '', uploading: t('importUploading', { sent: formatBytes(sent.value), total: formatBytes(props.file.size) }),
  inspecting: t('importInspecting'), creating: t('importCreating'), preparing: t('importPreparing'),
}[step.value]));
const hint = computed(() => (error.value ? importErrorHint(error.value.code) : null));
</script>

<template>
  <div class="dialog-overlay" @click.self="!busy && cancel()" @keydown.esc="!busy && cancel()">
    <form class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="native-import" @submit.prevent="run">
      <header>
        <h2 id="native-import"><FileArchive :size="18" /> {{ t('importNativeTitle') }}</h2>
        <p class="muted small">{{ t('importNativeHint') }}</p>
      </header>
      <div class="dialog-body">
        <dl class="facts">
          <dt>{{ t('importFile') }}</dt><dd>{{ file.name }} · {{ formatBytes(file.size) }}</dd>
          <dt>{{ t('createVersion') }}</dt><dd>{{ pack.minecraftVersion }} · {{ loaderLabel(pack.loader.kind) }} {{ pack.loader.version }}</dd>
          <dt>{{ t('importMods') }}</dt><dd>{{ formatNumber(pack.mods.length) }}</dd>
          <dt>{{ t('importOverrides') }}</dt><dd>{{ formatNumber(pack.overrides.length) }}</dd>
        </dl>

        <fieldset class="field" :disabled="busy">
          <legend>{{ t('importTarget') }}</legend>
          <label class="radio"><input v-model="target" type="radio" value="new" /> {{ t('importTargetNew') }}</label>
          <input v-if="target === 'new'" v-model="name" class="input" maxlength="80" required :aria-label="t('createName')" />
          <label v-for="w in eligible" :key="w.id" class="radio"><input v-model="target" type="radio" :value="w.id" /> {{ t('importTargetExisting', { name: w.name }) }}</label>
          <p v-if="!eligible.length" class="muted small">{{ t('importNoMatching') }}</p>
        </fieldset>
        <label v-if="optionalCount" class="check small"><input v-model="includeOptional" type="checkbox" :disabled="busy" /> {{ t('importIncludeOptional', { count: optionalCount }) }}</label>

        <div v-if="busy" class="progress-block" role="status">
          <span class="small"><Loader :size="14" class="spin" /> {{ stepText }}</span>
          <div v-if="step === 'uploading'" class="progress"><span :style="{ width: `${Math.round((sent / Math.max(file.size, 1)) * 100)}%` }"></span></div>
        </div>
        <div v-if="inspection?.warnings.length" class="notice warn small">
          <TriangleAlert :size="18" /><ul class="warn-list"><li v-for="(w, i) in inspection.warnings" :key="i">{{ w }}</li></ul>
        </div>
        <DependencyConflicts v-if="error?.code === 'dependency-conflict'" :error="error" :can-resolve="canResolve" :busy="busy" @retry="retry" />
        <div v-else-if="error" class="notice error" role="alert">
          <CircleAlert :size="18" />
          <div class="grow">
            <strong>{{ t('importNativeFailed') }}</strong>
            <p v-if="hint" class="small">{{ t(hint) }}</p>
            <code class="small">{{ error.message }}</code>
          </div>
        </div>
      </div>
      <footer>
        <button class="btn" type="button" :disabled="busy && step !== 'uploading'" @click="cancel">{{ t('cancel') }}</button>
        <button v-if="!pending" class="btn btn-primary" type="submit" :disabled="busy || (target === 'new' && !name.trim())">{{ t('importPrepare') }}</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
h2 { display: flex; align-items: center; gap: 8px; }
.facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: 0.9rem; }
.facts dt { color: var(--text-muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
legend { font-weight: 600; margin-bottom: 4px; }
.radio, .check { display: flex; gap: 8px; align-items: center; }
.progress-block { display: flex; flex-direction: column; gap: 6px; }
.warn-list { margin: 0; padding-left: 18px; max-height: 140px; overflow-y: auto; }
.grow { flex: 1; min-width: 0; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
