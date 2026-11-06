<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { PackHit, PackProviderId, PackVersion } from '../backend/contract';
import { formatNumber, t } from '../i18n';
import { asError, useSession } from '../state/session';
import { loaderLabel, opStateKey, opStateTone, packProviderNames } from '../ui/labels';

const emit = defineEmits<{ manage: [] }>();
const session = useSession();
const providers = computed(() => session.state.handshake?.packProviders ?? []);

const provider = ref<PackProviderId>('modrinth');
const text = ref('');
const hits = ref<PackHit[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const picked = ref<PackHit | null>(null);
const versions = ref<PackVersion[]>([]);
const versionId = ref('');
const versionsLoading = ref(false);
const instanceName = ref('');
const installing = ref(false);
const operationId = ref<string | null>(null);
/** Live status of the install this screen started. */
const operation = computed(() => session.state.operations.find((o) => o.operationId === operationId.value) ?? null);
const installError = ref('');
const PAGE = 24;
let requestId = 0;

const info = computed(() => providers.value.find((p) => p.id === provider.value));
const canSearch = computed(() => session.can('packs.search') && !!info.value?.available);
const version = computed(() => versions.value.find((v) => v.id === versionId.value));
const installed = computed(() => operation.value?.state === 'completed');
const nameTaken = computed(() => !installed.value && session.state.instances.some((i) => i.name.trim().toLowerCase() === instanceName.value.trim().toLowerCase()));
// Disabled after success so one click can't install the same pack twice; picking a pack again resets it.
const canInstall = computed(() => session.can('packs.install') && !!picked.value && !!version.value && !!instanceName.value.trim() && !installing.value && !installed.value);

async function search(append = false) {
  if (!canSearch.value) { hits.value = []; total.value = 0; return; }
  const id = ++requestId;
  loading.value = true;
  error.value = '';
  try {
    const page = await session.backend.searchPacks({ provider: provider.value, text: text.value, offset: append ? hits.value.length : 0, limit: PAGE });
    if (id !== requestId) return;
    hits.value = append ? [...hits.value, ...page.hits] : page.hits;
    total.value = page.total;
  } catch (e) {
    if (id === requestId) error.value = asError(e).message;
  } finally {
    if (id === requestId) loading.value = false;
  }
}

async function pick(hit: PackHit) {
  picked.value = hit;
  instanceName.value = hit.name;
  operationId.value = null;
  installError.value = '';
  versions.value = [];
  versionId.value = '';
  versionsLoading.value = true;
  try {
    const list = await session.backend.packVersions(hit.provider, hit.packId);
    if (picked.value !== hit) return;
    versions.value = list;
    versionId.value = list.find((v) => v.releaseType !== 'beta' && v.releaseType !== 'alpha')?.id ?? list[0]?.id ?? '';
  } catch (e) {
    installError.value = asError(e).message;
  } finally {
    versionsLoading.value = false;
  }
}

async function install() {
  if (!canInstall.value || !picked.value) return;
  installing.value = true;
  installError.value = '';
  try {
    const final = await session.installPack(
      { provider: picked.value.provider, packId: picked.value.packId, versionId: versionId.value, instanceName: instanceName.value.trim() },
      (id) => { operationId.value = id; },
    );
    if (final && final.state !== 'completed') installError.value = final.error?.message ?? t('applyFailed');
  } catch (e) {
    installError.value = asError(e).message;
  } finally {
    installing.value = false;
  }
}


let debounce: ReturnType<typeof setTimeout> | undefined;
watch(text, () => { clearTimeout(debounce); debounce = setTimeout(() => void search(), 250); });
watch(provider, () => { picked.value = null; void search(); });
watch(() => session.state.handshake, () => void search());
onMounted(() => void search());
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('packsTitle') }}</h1>
        <p>{{ t('packsSubtitle') }}</p>
      </div>
    </header>

    <div class="toolbar">
      <div class="segmented" role="tablist" :aria-label="t('provider')">
        <button
          v-for="p in providers" :key="p.id" type="button" role="tab" class="seg"
          :class="{ active: provider === p.id, off: !p.available }" :aria-selected="provider === p.id"
          @click="provider = p.id"
        >{{ packProviderNames[p.id] }}</button>
      </div>
      <input v-model="text" class="input search" type="search" :placeholder="t('packsSearch')" :aria-label="t('packsSearch')" :disabled="!canSearch" />
    </div>

    <div v-if="!session.can('packs.search')" class="notice warn">{{ t('capabilityMissing') }}</div>
    <div v-else-if="info && !info.available" class="notice warn" role="status">
      {{ info.unavailableReason === 'curseforge-unauthorized' ? t('curseforgeUnauthorized') : t('providerUnavailable', { provider: packProviderNames[info.id] }) }}
    </div>
    <div v-if="error" class="notice error" role="alert">{{ t('searchFailed') }} <code>{{ error }}</code></div>

    <div class="columns">
      <div class="results-wrap">
        <ul class="results" :aria-busy="loading">
          <li v-for="hit in hits" :key="hit.packId">
            <button type="button" class="hit glass" :class="{ active: picked?.packId === hit.packId }" :aria-pressed="picked?.packId === hit.packId" @click="pick(hit)">
              <img v-if="hit.iconUrl" :src="hit.iconUrl" alt="" class="hit-icon" />
              <span v-else class="hit-icon initial" aria-hidden="true">{{ hit.name.slice(0, 1) }}</span>
              <span class="hit-copy">
                <span class="hit-title"><strong>{{ hit.name }}</strong> <span class="muted">{{ t('byAuthor', { author: hit.author }) }}</span></span>
                <span class="muted summary">{{ hit.summary }}</span>
                <span class="hit-meta">
                  <span v-if="hit.minecraftVersion" class="badge">{{ hit.minecraftVersion }}<template v-if="hit.loader"> · {{ loaderLabel(hit.loader) }}</template></span>
                  <span v-if="hit.downloads !== undefined">{{ t('downloads', { count: formatNumber(hit.downloads) }) }}</span>
                </span>
              </span>
            </button>
          </li>
        </ul>
        <p v-if="loading" class="muted" role="status">{{ t('searching') }}</p>
        <p v-else-if="canSearch && !hits.length && !error" class="empty">{{ t('noResults') }}</p>
        <button v-if="hits.length < total && !loading" class="btn load-more" type="button" @click="search(true)">{{ t('loadMore') }}</button>
      </div>

      <aside class="details glass" :aria-label="t('packDetails')">
        <template v-if="picked">
          <h2>{{ picked.name }}</h2>
          <p class="muted">{{ t('packFrom', { provider: packProviderNames[picked.provider] }) }} · {{ t('byAuthor', { author: picked.author }) }}</p>
          <p>{{ picked.summary }}</p>

          <label class="field"><span>{{ t('packVersionLabel') }}</span>
            <select v-model="versionId" class="select" :disabled="versionsLoading || !versions.length || installing">
              <option v-for="v in versions" :key="v.id" :value="v.id">
                {{ v.name }} · {{ v.minecraftVersion }}<template v-if="v.loader"> · {{ loaderLabel(v.loader) }}</template><template v-if="v.releaseType && v.releaseType !== 'release'"> · {{ t(v.releaseType) }}</template>
              </option>
            </select>
          </label>
          <p v-if="versionsLoading" class="muted small">{{ t('packLoadingVersions') }}</p>
          <p v-else-if="!versions.length && !installError" class="muted small">{{ t('packNoVersions') }}</p>

          <label class="field"><span>{{ t('packInstanceName') }}</span><input v-model="instanceName" class="input" :disabled="installing" /></label>
          <p v-if="nameTaken" class="muted small">{{ t('packNameTaken') }}</p>
          <p class="muted small">{{ t('packInstallHint') }}</p>

          <button class="btn btn-primary" type="button" :disabled="!canInstall" @click="install">{{ installing ? t('packInstalling') : t('packInstall') }}</button>
          <p v-if="!session.can('packs.install')" class="muted small">{{ t('capabilityMissing') }}</p>

          <div v-if="operation" class="operation" aria-live="polite">
            <span class="badge" :class="opStateTone[operation.state]">{{ t(opStateKey[operation.state]) }}</span>
            <div class="progress"><span :style="{ width: `${Math.round((operation.progress ?? 0) * 100)}%` }"></span></div>
          </div>
          <div v-if="operation?.state === 'completed'" class="notice" role="status">
            <span>{{ t('packInstalled', { name: instanceName }) }}</span>
            <button class="btn btn-small btn-primary" type="button" style="margin-left: auto" @click="emit('manage')">{{ t('packManageNow') }}</button>
          </div>
          <p v-if="installError" class="notice error" role="alert">{{ installError }}</p>
        </template>
        <p v-else class="muted">{{ t('packSelectHint') }}</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; }
.search { min-width: 240px; flex: 1; max-width: 380px; }
.segmented { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: var(--radius-control); background: rgba(3, 8, 16, 0.4); border: 1px solid var(--control-border); }
.seg { border: none; background: transparent; color: var(--text-secondary); padding: 5px 12px; border-radius: 6px; cursor: pointer; }
.seg.active { background: var(--surface-selected); color: #fff; }
.seg.off:not(.active) { opacity: 0.55; }
.columns { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: var(--space-4); align-items: start; }
.results-wrap { display: flex; flex-direction: column; gap: var(--space-2); }
.results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.hit { display: flex; align-items: center; gap: var(--space-3); width: 100%; padding: var(--space-3); border-radius: var(--radius-medium); text-align: left; cursor: pointer; }
.hit.active { border-color: rgba(96, 165, 250, 0.55); box-shadow: var(--shadow-medium), inset 3px 0 0 #3b82f6; }
.hit-icon { width: 48px; height: 48px; border-radius: 10px; flex-shrink: 0; object-fit: cover; }
.initial { display: grid; place-items: center; background: linear-gradient(135deg, #1e3a5f, #0f2744); font-weight: 700; font-size: 1.2rem; }
.hit-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.summary { font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hit-meta { display: flex; gap: var(--space-2); align-items: center; font-size: 0.8rem; color: var(--text-secondary); flex-wrap: wrap; }
.details { position: sticky; top: 0; padding: var(--space-4); border-radius: var(--radius-medium); display: flex; flex-direction: column; gap: var(--space-3); }
.details h2 { font-size: 1.1rem; }
.small { font-size: 0.82rem; }
.operation { display: flex; flex-direction: column; gap: var(--space-2); }
.load-more { align-self: center; }
@media (max-width: 1000px) { .columns { grid-template-columns: 1fr; } .details { position: static; } }
</style>
