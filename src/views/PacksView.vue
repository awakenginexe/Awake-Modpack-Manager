<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ArrowRight, CircleAlert, CircleCheck, Download, Gamepad2, Info, Layers, PackageSearch, Search, X } from '@lucide/vue';
import type { PackHit, PackProviderId, PackVersion } from '../backend/contract';
import Avatar from '../components/Avatar.vue';
import ProviderLogo from '../components/ProviderLogo.vue';
import { formatDate, formatNumber, t } from '../i18n';
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
          :title="p.available ? undefined : t('providerUnavailable', { provider: packProviderNames[p.id] })"
          @click="provider = p.id"
        ><ProviderLogo :provider="p.id" :size="18" />{{ packProviderNames[p.id] }}</button>
      </div>
      <label class="search-field">
        <Search :size="16" />
        <input v-model="text" class="input" type="search" :placeholder="t('packsSearch')" :aria-label="t('packsSearch')" :disabled="!canSearch" />
      </label>
    </div>

    <div v-if="!session.can('packs.search')" class="notice warn"><CircleAlert :size="18" />{{ t('capabilityMissing') }}</div>
    <div v-else-if="info && !info.available" class="notice warn" role="status">
      <ProviderLogo :provider="info.id" :size="22" />
      <span>{{ info.unavailableReason === 'curseforge-unauthorized' ? t('curseforgeUnauthorized') : t('providerUnavailable', { provider: packProviderNames[info.id] }) }}</span>
    </div>
    <div v-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ t('searchFailed') }} <code class="small">{{ error }}</code></div>

    <div class="columns" :class="{ open: !!picked }">
      <div class="results-wrap">
        <ul class="results" :aria-busy="loading">
          <template v-if="loading && !hits.length">
            <li v-for="n in 6" :key="`s${n}`" class="card skel"><span class="skeleton" style="width: 64px; height: 64px; border-radius: 14px"></span><span class="skeleton-lines"><span class="skeleton" style="height: 14px; width: 55%"></span><span class="skeleton" style="height: 12px; width: 85%"></span></span></li>
          </template>
          <li v-for="hit in hits" :key="hit.packId">
            <button type="button" class="card hit" :class="{ selected: picked?.packId === hit.packId }" :aria-pressed="picked?.packId === hit.packId" @click="pick(hit)">
              <Avatar :name="hit.name" :src="hit.iconUrl" :size="64" />
              <span class="hit-copy">
                <span class="hit-title"><strong>{{ hit.name }}</strong></span>
                <span class="muted small">{{ t('byAuthor', { author: hit.author }) }}</span>
                <span class="summary">{{ hit.summary }}</span>
                <span class="meta">
                  <span v-if="hit.minecraftVersion"><Gamepad2 :size="14" />{{ hit.minecraftVersion }}</span>
                  <span v-if="hit.loader"><Layers :size="14" />{{ loaderLabel(hit.loader) }}</span>
                  <span v-if="hit.downloads !== undefined"><Download :size="14" />{{ formatNumber(hit.downloads) }}</span>
                </span>
              </span>
            </button>
          </li>
        </ul>
        <div v-if="!loading && canSearch && !hits.length && !error" class="empty card">
          <span class="empty-icon"><PackageSearch :size="28" /></span>
          <p>{{ t('noResults') }}</p>
        </div>
        <button v-if="hits.length < total && !loading" class="btn load-more" type="button" @click="search(true)">{{ t('loadMore') }}</button>
      </div>

      <Transition name="slide">
        <aside v-if="picked" class="details glass" :aria-label="t('packDetails')">
          <button class="icon-btn close" type="button" :aria-label="t('close')" @click="picked = null"><X :size="18" /></button>
          <div class="details-head">
            <Avatar :name="picked.name" :src="picked.iconUrl" :size="72" />
            <div>
              <h2>{{ picked.name }}</h2>
              <p class="muted small">{{ t('byAuthor', { author: picked.author }) }}</p>
              <span class="chip"><ProviderLogo :provider="picked.provider" :size="15" />{{ packProviderNames[picked.provider] }}</span>
            </div>
          </div>
          <p class="description">{{ picked.summary }}</p>

          <fieldset class="versions" :disabled="installing">
            <legend class="field-label">{{ t('packVersionLabel') }}</legend>
            <div v-if="versionsLoading" class="version-list">
              <span v-for="n in 3" :key="n" class="skeleton" style="height: 44px"></span>
            </div>
            <p v-else-if="!versions.length && !installError" class="muted small">{{ t('packNoVersions') }}</p>
            <div v-else class="version-list" role="radiogroup">
              <label v-for="v in versions" :key="v.id" class="version" :class="{ active: v.id === versionId }">
                <input v-model="versionId" type="radio" name="pack-version" :value="v.id" />
                <span class="version-copy">
                  <span class="version-name">{{ v.name }}
                    <span v-if="v.releaseType && v.releaseType !== 'release'" class="badge warn">{{ t(v.releaseType) }}</span>
                    <span v-else-if="v.id === versions[0]?.id" class="badge info">{{ t('latest') }}</span>
                  </span>
                  <span class="meta small">
                    <span><Gamepad2 :size="13" />{{ v.minecraftVersion }}</span>
                    <span v-if="v.loader"><Layers :size="13" />{{ loaderLabel(v.loader) }}</span>
                    <span v-if="v.publishedAt">{{ formatDate(v.publishedAt) }}</span>
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          <label class="field"><span>{{ t('packInstanceName') }}</span><input v-model="instanceName" class="input" :disabled="installing" /></label>
          <p v-if="nameTaken" class="hint warn-text small"><Info :size="14" />{{ t('packNameTaken') }}</p>

          <div v-if="operation && !installed" class="operation" aria-live="polite">
            <div class="op-row"><span class="badge" :class="opStateTone[operation.state]">{{ t(opStateKey[operation.state]) }}</span><span class="muted small">{{ Math.round((operation.progress ?? 0) * 100) }}%</span></div>
            <div class="progress"><span :style="{ width: `${Math.round((operation.progress ?? 0) * 100)}%` }"></span></div>
          </div>
          <div v-if="installed" class="notice success" role="status">
            <CircleCheck :size="18" /><span class="grow">{{ t('packInstalled', { name: instanceName }) }}</span>
          </div>
          <p v-if="installError" class="notice error" role="alert"><CircleAlert :size="18" />{{ installError }}</p>

          <button v-if="installed" class="btn btn-primary btn-large btn-block" type="button" @click="emit('manage')">{{ t('packManageNow') }}<ArrowRight :size="18" /></button>
          <button v-else class="btn btn-primary btn-large btn-block" type="button" :disabled="!canInstall" @click="install">
            <Download :size="18" />{{ installing ? t('packInstalling') : t('packInstall') }}
          </button>
          <p class="muted small center">{{ session.can('packs.install') ? t('packInstallHint') : t('capabilityMissing') }}</p>
        </aside>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; padding-right: 4px; }
.seg.off:not(.active) { opacity: 0.5; }
.columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); align-items: start; }
.columns.open { grid-template-columns: minmax(0, 1fr) 380px; }
.results-wrap { display: flex; flex-direction: column; gap: var(--space-3); }
.results { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: var(--space-3); }
.hit { display: flex; align-items: flex-start; gap: var(--space-3); width: 100%; height: 100%; padding: var(--space-4); }
.skel { display: flex; gap: var(--space-3); padding: var(--space-4); }
.skeleton-lines { flex: 1; display: flex; flex-direction: column; gap: 8px; padding-top: 6px; }
.hit-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.hit-title strong { font-size: 1.02rem; }
.summary { font-size: 0.9rem; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 2px 0 4px; }
.details { position: sticky; top: 0; padding: var(--space-5); border-radius: var(--radius-medium); display: flex; flex-direction: column; gap: var(--space-4); max-height: calc(100vh - 120px); overflow-y: auto; }
.close { position: absolute; top: 10px; right: 10px; }
.details-head { display: flex; gap: var(--space-3); align-items: center; padding-right: 28px; }
.details-head > div { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
.details-head h2 { font-size: 1.25rem; }
.description { color: var(--text-secondary); font-size: 0.93rem; line-height: 1.55; }
.versions { border: none; margin: 0; padding: 0; min-width: 0; }
.field-label { font-size: 0.88rem; color: var(--text-secondary); font-weight: 500; margin-bottom: 6px; padding: 0; }
.version-list { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; }
.version { display: flex; align-items: center; gap: var(--space-3); padding: 8px 12px; border-radius: var(--radius-control); border: 1px solid var(--border-subtle); background: rgba(255, 255, 255, 0.03); cursor: pointer; }
.version:hover { border-color: rgba(147, 197, 253, 0.3); }
.version.active { border-color: rgba(96, 165, 250, 0.55); background: rgba(59, 130, 246, 0.12); }
.version-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.version-name { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.hint { display: flex; align-items: center; gap: 6px; }
.warn-text { color: #fcd34d; }
.operation { display: flex; flex-direction: column; gap: var(--space-2); }
.op-row { display: flex; justify-content: space-between; align-items: center; }
.center { text-align: center; }
.load-more { align-self: center; }
@media (max-width: 1100px) { .columns.open { grid-template-columns: 1fr; } .details { position: static; max-height: none; } }
</style>
