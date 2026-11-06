<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { ProviderId, ReleaseType, SearchHit } from '../backend/contract';
import { addChanges } from '../domain/draft';
import { formatNumber, t } from '../i18n';
import { asError, useSession } from '../state/session';
import { loaderLabel } from '../ui/labels';
import { CircleAlert, CircleCheck, Download, Gamepad2, Layers, ListChecks, Plus, Search } from '@lucide/vue';
import Avatar from '../components/Avatar.vue';
import ProviderLogo from '../components/ProviderLogo.vue';
import type { ViewId } from '../App.vue';

const emit = defineEmits<{ navigate: [ViewId] }>();
const session = useSession();
const inst = computed(() => session.instance.value!);
const providers = computed(() => session.state.handshake?.providers ?? []);

const text = ref('');
const provider = ref<ProviderId>(providers.value.find((p) => p.available)?.id ?? 'modrinth');
const releaseTypes = ref<ReleaseType[]>(['release']);
const compatibleOnly = ref(true);
const hits = ref<SearchHit[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const picked = ref<Map<string, SearchHit>>(new Map());
const PAGE = 30;
let requestId = 0;

const providerInfo = computed(() => providers.value.find((p) => p.id === provider.value));
const installed = computed(() => new Set((session.inventory.value?.mods ?? []).map((m) => m.projectId)));
const inDraft = computed(() => new Set((session.draft.value?.changes ?? []).flatMap((c) => (c.kind === 'install' ? [c.projectId] : []))));

async function search(append = false) {
  if (!session.can('providers.search') || !providerInfo.value?.available) { hits.value = []; total.value = 0; return; }
  const id = ++requestId;
  loading.value = true;
  error.value = '';
  try {
    const page = await session.backend.search({
      text: text.value, provider: provider.value, minecraftVersion: inst.value.minecraftVersion ?? '', loader: inst.value.loader?.kind ?? 'vanilla',
      releaseTypes: releaseTypes.value, compatibleOnly: compatibleOnly.value, offset: append ? hits.value.length : 0, limit: PAGE,
    });
    if (id !== requestId) return; // a newer query superseded this one
    hits.value = append ? [...hits.value, ...page.hits] : page.hits;
    total.value = page.total;
  } catch (e) {
    if (id === requestId) error.value = asError(e).message;
  } finally {
    if (id === requestId) loading.value = false;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch(text, () => { clearTimeout(debounce); debounce = setTimeout(() => void search(), 250); });
watch([provider, releaseTypes, compatibleOnly], () => void search(), { deep: true });
onMounted(() => void search());

function togglePick(hit: SearchHit) {
  const next = new Map(picked.value);
  if (next.has(hit.projectId)) next.delete(hit.projectId); else next.set(hit.projectId, hit);
  picked.value = next;
}
function addToDraft(list: SearchHit[]) {
  const d = session.draft.value;
  if (!d) return;
  session.setDraft(addChanges(d, list.map((h) => ({ kind: 'install' as const, provider: h.provider, projectId: h.projectId, name: h.name, versionId: h.latest?.id }))));
  picked.value = new Map();
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('browseTitle') }}</h1>
        <p class="meta">
          <span v-if="inst.minecraftVersion"><Gamepad2 :size="15" />Minecraft {{ inst.minecraftVersion }}</span>
          <span v-if="inst.loader"><Layers :size="15" />{{ loaderLabel(inst.loader.kind) }}</span>
        </p>
      </div>
      <div class="toolbar">
        <button class="btn btn-primary" type="button" :disabled="!picked.size" @click="addToDraft([...picked.values()])"><Plus :size="16" />{{ t('addSelected', { count: picked.size }) }}</button>
        <button class="btn" type="button" :disabled="!session.draft.value?.changes.length" @click="emit('navigate', 'review')"><ListChecks :size="16" />{{ t('reviewChanges') }}</button>
      </div>
    </header>

    <div class="toolbar">
      <div class="segmented" role="tablist" :aria-label="t('provider')">
        <button
          v-for="p in providers" :key="p.id" type="button" role="tab" class="seg" :class="{ active: provider === p.id, off: !p.available }"
          :aria-selected="provider === p.id" @click="provider = p.id"
        ><ProviderLogo :provider="p.id" :size="18" />{{ p.id === 'modrinth' ? 'Modrinth' : 'CurseForge' }}</button>
      </div>
      <label class="search-field">
        <Search :size="16" />
        <input v-model="text" class="input" type="search" :placeholder="t('browseSearch')" :aria-label="t('browseSearch')" />
      </label>
      <fieldset class="types">
        <legend class="sr-only">{{ t('releaseTypes') }}</legend>
        <label v-for="r in (['release', 'beta', 'alpha'] as ReleaseType[])" :key="r" class="check"><input v-model="releaseTypes" type="checkbox" :value="r" />{{ t(r) }}</label>
      </fieldset>
      <label class="check"><input v-model="compatibleOnly" type="checkbox" />{{ t('compatibleOnly') }}</label>
    </div>

    <div v-if="!session.can('providers.search')" class="notice warn"><CircleAlert :size="18" />{{ t('capabilityMissing') }}</div>
    <div v-else-if="providerInfo && !providerInfo.available" class="notice warn" role="status">
      <ProviderLogo :provider="providerInfo.id" :size="22" />
      <span>{{ providerInfo.unavailableReason === 'curseforge-unauthorized' ? t('curseforgeUnauthorized') : t('providerUnavailable', { provider: providerInfo.id }) }}</span>
    </div>
    <div v-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ t('searchFailed') }} <code class="small">{{ error }}</code></div>

    <ul class="results" :aria-busy="loading">
      <template v-if="loading && !hits.length">
        <li v-for="n in 6" :key="`s${n}`" class="card skel"><span class="skeleton" style="width: 52px; height: 52px; border-radius: 12px"></span><span class="lines"><span class="skeleton" style="height: 14px; width: 50%"></span><span class="skeleton" style="height: 12px; width: 85%"></span></span></li>
      </template>
      <li v-for="(hit, i) in hits" :key="hit.projectId" class="card hit rise" :style="{ '--i': i % 30 }" :class="{ selected: picked.has(hit.projectId), dim: !hit.compatible }">
        <label class="pick">
          <input
            type="checkbox"
            :checked="picked.has(hit.projectId)"
            :disabled="installed.has(hit.projectId) || inDraft.has(hit.projectId) || !hit.compatible"
            :aria-label="t('selectRow', { name: hit.name })"
            @change="togglePick(hit)"
          />
        </label>
        <Avatar :name="hit.name" :src="hit.iconUrl" :size="52" />
        <div class="hit-copy">
          <div class="hit-title"><strong>{{ hit.name }}</strong> <span class="muted small">{{ t('byAuthor', { author: hit.author }) }}</span></div>
          <p class="summary">{{ hit.summary }}</p>
          <div class="meta small">
            <span v-if="hit.downloads !== undefined"><Download :size="13" />{{ formatNumber(hit.downloads) }}</span>
            <span v-if="hit.latest">{{ hit.latest.name }}</span>
            <span v-if="hit.latest?.releaseType && hit.latest.releaseType !== 'release'" class="badge warn">{{ t(hit.latest.releaseType) }}</span>
            <span v-if="!hit.compatible" class="badge error">{{ t('notCompatible') }}</span>
          </div>
        </div>
        <span v-if="installed.has(hit.projectId)" class="badge ok"><CircleCheck :size="13" />{{ t('alreadyInstalled') }}</span>
        <span v-else-if="inDraft.has(hit.projectId)" class="badge info">{{ t('inDraft') }}</span>
        <button v-else class="btn btn-small" type="button" :disabled="!hit.compatible" @click="addToDraft([hit])"><Plus :size="15" />{{ t('addToDraft') }}</button>
      </li>
    </ul>
    <div v-if="!loading && !hits.length && providerInfo?.available && !error" class="empty card">
      <span class="empty-icon"><Search :size="28" /></span><p>{{ t('noResults') }}</p>
    </div>
    <button v-if="hits.length < total && !loading" class="btn load-more" type="button" @click="search(true)">{{ t('loadMore') }}</button>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; padding-right: 4px; }
.view-header .meta { margin-top: 4px; }
.seg.off:not(.active) { opacity: 0.5; }
.types { display: inline-flex; gap: var(--space-3); border: none; margin: 0; padding: 0; }
.results { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: var(--space-3); }
.hit { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); }
.hit.dim { opacity: 0.6; }
.skel { display: flex; gap: var(--space-3); padding: var(--space-4); }
.lines { flex: 1; display: flex; flex-direction: column; gap: 8px; padding-top: 6px; }
.hit-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.summary { font-size: 0.88rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.load-more { align-self: center; }
</style>
