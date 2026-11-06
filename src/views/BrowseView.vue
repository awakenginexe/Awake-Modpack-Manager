<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { ProviderId, ReleaseType, SearchHit } from '../backend/contract';
import { addChanges } from '../domain/draft';
import { formatNumber, t } from '../i18n';
import { asError, useSession } from '../state/session';
import { loaderLabel } from '../ui/labels';
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
      text: text.value, provider: provider.value, minecraftVersion: inst.value.minecraftVersion, loader: inst.value.loader.kind,
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
        <p>{{ t('browseSubtitle', { version: inst.minecraftVersion, loader: loaderLabel(inst.loader.kind) }) }}</p>
      </div>
      <div class="toolbar">
        <button class="btn btn-primary" type="button" :disabled="!picked.size" @click="addToDraft([...picked.values()])">{{ t('addSelected', { count: picked.size }) }}</button>
        <button class="btn" type="button" :disabled="!session.draft.value?.changes.length" @click="emit('navigate', 'review')">{{ t('reviewChanges') }}</button>
      </div>
    </header>

    <div class="toolbar">
      <input v-model="text" class="input search" type="search" :placeholder="t('browseSearch')" :aria-label="t('browseSearch')" />
      <label class="field inline"><span>{{ t('provider') }}</span>
        <select v-model="provider" class="select">
          <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.id === 'modrinth' ? 'Modrinth' : 'CurseForge' }}</option>
        </select>
      </label>
      <fieldset class="types">
        <legend class="sr-only">{{ t('releaseTypes') }}</legend>
        <label v-for="r in (['release', 'beta', 'alpha'] as ReleaseType[])" :key="r" class="check"><input v-model="releaseTypes" type="checkbox" :value="r" />{{ t(r) }}</label>
      </fieldset>
      <label class="check"><input v-model="compatibleOnly" type="checkbox" />{{ t('compatibleOnly') }}</label>
    </div>

    <div v-if="!session.can('providers.search')" class="notice warn">{{ t('capabilityMissing') }}</div>
    <div v-else-if="providerInfo && !providerInfo.available" class="notice warn" role="status">
      {{ providerInfo.unavailableReason === 'curseforge-unauthorized' ? t('curseforgeUnauthorized') : t('providerUnavailable', { provider: providerInfo.id }) }}
    </div>
    <div v-if="error" class="notice error" role="alert">{{ t('searchFailed') }} <code>{{ error }}</code></div>

    <ul class="results" :aria-busy="loading">
      <li v-for="hit in hits" :key="hit.projectId" class="hit glass" :class="{ picked: picked.has(hit.projectId) }">
        <label class="pick">
          <input
            type="checkbox"
            :checked="picked.has(hit.projectId)"
            :disabled="installed.has(hit.projectId) || inDraft.has(hit.projectId) || !hit.compatible"
            :aria-label="t('selectRow', { name: hit.name })"
            @change="togglePick(hit)"
          />
        </label>
        <span class="hit-icon" aria-hidden="true">{{ hit.name.slice(0, 1) }}</span>
        <div class="hit-copy">
          <div class="hit-title"><strong>{{ hit.name }}</strong> <span class="muted">{{ t('byAuthor', { author: hit.author }) }}</span></div>
          <p class="muted">{{ hit.summary }}</p>
          <div class="hit-meta">
            <span>{{ t('downloads', { count: formatNumber(hit.downloads) }) }}</span>
            <span v-if="hit.latest" class="badge" :class="hit.latest.releaseType === 'release' ? '' : 'warn'">{{ hit.latest.name }} · {{ t(hit.latest.releaseType) }}</span>
            <span v-if="!hit.compatible" class="badge error">{{ t('notCompatible') }}</span>
          </div>
        </div>
        <span v-if="installed.has(hit.projectId)" class="badge ok">{{ t('alreadyInstalled') }}</span>
        <span v-else-if="inDraft.has(hit.projectId)" class="badge info">{{ t('inDraft') }}</span>
        <button v-else class="btn btn-small" type="button" :disabled="!hit.compatible" @click="addToDraft([hit])">{{ t('addToDraft') }}</button>
      </li>
    </ul>
    <p v-if="loading" class="muted" role="status">{{ t('searching') }}</p>
    <p v-else-if="!hits.length && providerInfo?.available && !error" class="empty">{{ t('noResults') }}</p>
    <button v-if="hits.length < total && !loading" class="btn load-more" type="button" @click="search(true)">{{ t('loadMore') }}</button>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; }
.search { min-width: 240px; flex: 1; max-width: 380px; }
.inline { flex-direction: row; align-items: center; gap: var(--space-2); }
.types { display: inline-flex; gap: var(--space-3); border: none; margin: 0; padding: 0; }
.results { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.hit { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-medium); }
.hit.picked { border-color: rgba(96, 165, 250, 0.5); }
.pick input { accent-color: var(--accent); width: 16px; height: 16px; }
.hit-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0; background: linear-gradient(135deg, #1e3a5f, #0f2744); font-weight: 700; }
.hit-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.hit-copy p { font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hit-meta { display: flex; gap: var(--space-2); align-items: center; font-size: 0.8rem; color: var(--text-secondary); flex-wrap: wrap; }
.load-more { align-self: center; }
</style>
