<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { ProjectVersion, ProviderId, ReleaseType, SearchHit } from '../backend/contract';
import type { ProjectDetail } from '../backend/host';
import { addChanges } from '../domain/draft';
import { formatDate, formatNumber, t } from '../i18n';
import { asError, useSession } from '../state/session';
import { loaderLabel } from '../ui/labels';
import { CircleAlert, CircleCheck, Copy, Download, ExternalLink, Gamepad2, Layers, ListChecks, Plus, Scale, Search, X } from '@lucide/vue';
import { copyText, openMenu, separator, type MenuItem } from '../ui/desktop';
import { openExternal } from '../state/appUpdate';
import Avatar from '../components/Avatar.vue';
import ProviderLogo from '../components/ProviderLogo.vue';
import VersionPicker from '../components/VersionPicker.vue';
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
/* Details panel: opens when a card is clicked, as on Get a modpack. */
const focused = ref<SearchHit | null>(null);
const detail = ref<ProjectDetail | null>(null);
const versions = ref<ProjectVersion[]>([]);
const versionId = ref('');
const versionsLoading = ref(false);
const versionsError = ref('');
const pageUrl = computed(() => (!focused.value ? '' : detail.value?.pageUrl ?? (focused.value.provider === 'modrinth' ? `https://modrinth.com/mod/${focused.value.projectId}` : `https://www.curseforge.com/projects/${focused.value.projectId}`)));
const focusedBlocked = computed(() => !focused.value || installed.value.has(focused.value.projectId) || inDraft.value.has(focused.value.projectId) || !focused.value.compatible);
async function focus(hit: SearchHit) {
  if (focused.value?.projectId === hit.projectId) { focused.value = null; return; }
  focused.value = hit;
  detail.value = null;
  versions.value = [];
  versionId.value = '';
  versionsError.value = '';
  versionsLoading.value = true;
  void session.backend.projectDetail?.(hit.provider, hit.projectId).then((d) => { if (focused.value === hit) detail.value = d; }).catch(() => undefined);
  try {
    const list = canChoose.value ? await session.backend.projectVersions!(inst.value.id, hit.provider, hit.projectId) : [];
    if (focused.value !== hit) return;
    versions.value = list;
    versionId.value = list.find((v) => releaseTypes.value.includes(v.releaseType ?? 'release'))?.id ?? list[0]?.id ?? '';
  } catch (e) {
    if (focused.value === hit) versionsError.value = asError(e).message;
  } finally {
    if (focused.value === hit) versionsLoading.value = false;
  }
}
function addFocused() {
  const hit = focused.value;
  const d = session.draft.value;
  if (!hit || !d) return;
  session.setDraft(addChanges(d, [{ kind: 'install', provider: hit.provider, projectId: hit.projectId, name: hit.name, versionId: versionId.value || hit.latest?.id }]));
}
function hitMenu(event: MouseEvent, hit: SearchHit) {
  const blocked = installed.value.has(hit.projectId) || inDraft.value.has(hit.projectId) || !hit.compatible;
  const items: MenuItem[] = [
    { label: t('addToDraft'), icon: Plus, disabled: blocked, action: () => addToDraft([hit]) },
    ...(canChoose.value ? [{ label: t('chooseVersion'), icon: Layers, disabled: blocked, action: () => { choosing.value = hit; } }] : []),
    separator,
    { label: t('openProviderPage'), icon: ExternalLink, action: () => openExternal(hit.provider === 'modrinth' ? `https://modrinth.com/mod/${hit.projectId}` : `https://www.curseforge.com/projects/${hit.projectId}`) },
    { label: t('copyName'), icon: Copy, action: () => copyText(hit.name) },
  ];
  openMenu(event, items);
}
function addToDraft(list: SearchHit[]) {
  const d = session.draft.value;
  if (!d) return;
  session.setDraft(addChanges(d, list.map((h) => ({ kind: 'install' as const, provider: h.provider, projectId: h.projectId, name: h.name, versionId: h.latest?.id }))));
  picked.value = new Map();
}
/** Exact version choice, where the side serving this instance can list versions. */
const canChoose = computed(() => !!session.backend.projectVersions && session.source.value === 'helper');
const choosing = ref<SearchHit | null>(null);
function addVersion(hit: SearchHit, v: ProjectVersion) {
  const d = session.draft.value;
  if (d) session.setDraft(addChanges(d, [{ kind: 'install', provider: hit.provider, projectId: hit.projectId, name: hit.name, versionId: v.id }]));
  choosing.value = null;
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
      <span>{{ providerInfo.unavailableReason === 'curseforge-unauthorized' ? t('curseforgeUnauthorized') : providerInfo.unavailableReason === 'curseforge-disabled' ? t('curseforgeDisabled') : t('providerUnavailable', { provider: providerInfo.id }) }}</span>
    </div>
    <div v-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ t('searchFailed') }} <code class="small">{{ error }}</code></div>

    <div class="columns" :class="{ open: !!focused }">
    <div class="results-wrap">
    <ul class="results" :aria-busy="loading">
      <template v-if="loading && !hits.length">
        <li v-for="n in 6" :key="`s${n}`" class="card skel"><span class="skeleton" style="width: 52px; height: 52px; border-radius: 12px"></span><span class="lines"><span class="skeleton" style="height: 14px; width: 50%"></span><span class="skeleton" style="height: 12px; width: 85%"></span></span></li>
      </template>
      <li v-for="(hit, i) in hits" :key="hit.projectId" class="card hit rise" :style="{ '--i': i % 30 }" :class="{ selected: picked.has(hit.projectId), dim: !hit.compatible, focused: focused?.projectId === hit.projectId }" tabindex="0" @click="focus(hit)" @keydown.enter.self="focus(hit)" @contextmenu="hitMenu($event, hit)">
        <label class="pick" @click.stop>
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
          <div class="hit-title"><strong>{{ hit.name }}</strong> <span v-if="hit.author" class="muted small">{{ t('byAuthor', { author: hit.author }) }}</span></div>
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
        <template v-else>
          <button v-if="canChoose && !focused" class="btn btn-small" type="button" :disabled="!hit.compatible" @click.stop="choosing = hit">{{ t('chooseVersion') }}</button>
          <button class="btn btn-small" type="button" :disabled="!hit.compatible" @click.stop="addToDraft([hit])"><Plus :size="15" />{{ t('addToDraft') }}</button>
        </template>
      </li>
    </ul>
    <div v-if="!loading && !hits.length && providerInfo?.available && !error" class="empty card">
      <span class="empty-icon"><Search :size="28" /></span><p>{{ t('noResults') }}</p>
    </div>
    <button v-if="hits.length < total && !loading" class="btn load-more" type="button" @click="search(true)">{{ t('loadMore') }}</button>
    </div>

    <Transition name="slide">
      <aside v-if="focused" class="details glass" :aria-label="t('modDetails')" @keydown.esc="focused = null">
        <button class="icon-btn close" type="button" :aria-label="t('close')" @click="focused = null"><X :size="18" /></button>
        <div class="details-head">
          <Avatar :name="focused.name" :src="focused.iconUrl" :size="72" />
          <div>
            <h2>{{ focused.name }}</h2>
            <p v-if="detail?.author || focused.author" class="muted small">{{ t('byAuthor', { author: detail?.author || focused.author }) }}</p>
            <span class="chip"><ProviderLogo :provider="focused.provider" :size="15" />{{ focused.provider === 'modrinth' ? 'Modrinth' : 'CurseForge' }}</span>
          </div>
        </div>
        <p class="description selectable">{{ detail?.summary || focused.summary }}</p>
        <div class="meta small facts-row">
          <span v-if="(detail?.downloads ?? focused.downloads) != null"><Download :size="14" />{{ formatNumber((detail?.downloads ?? focused.downloads)!) }}</span>
          <span v-if="detail?.license"><Scale :size="14" />{{ detail.license }}</span>
          <span v-if="detail?.updatedAt">{{ t('detailUpdated', { date: formatDate(detail.updatedAt) }) }}</span>
        </div>
        <div v-if="detail?.categories.length" class="tags"><span v-for="c in detail.categories.slice(0, 8)" :key="c" class="chip">{{ c }}</span></div>

        <fieldset v-if="canChoose" class="versions">
          <legend class="field-label">{{ t('packVersionLabel') }}</legend>
          <div v-if="versionsLoading" class="version-list"><span v-for="n in 3" :key="n" class="skeleton" style="height: 44px"></span></div>
          <p v-else-if="versionsError" class="notice error small" role="alert"><CircleAlert :size="16" />{{ versionsError }}</p>
          <p v-else-if="!versions.length" class="muted small">{{ t('packNoVersions') }}</p>
          <div v-else class="version-list" role="radiogroup">
            <label v-for="v in versions" :key="v.id" class="version" :class="{ active: v.id === versionId }">
              <input v-model="versionId" type="radio" name="mod-version" :value="v.id" />
              <span class="version-copy">
                <span class="version-name">{{ v.versionNumber || v.name }}
                  <span v-if="v.releaseType && v.releaseType !== 'release'" class="badge warn">{{ t(v.releaseType) }}</span>
                  <span v-else-if="v.id === versions[0]?.id" class="badge info">{{ t('latest') }}</span>
                </span>
                <span v-if="v.fileName" class="muted small ellipsis">{{ v.fileName }}</span>
              </span>
            </label>
          </div>
        </fieldset>

        <span v-if="installed.has(focused.projectId)" class="badge ok center-badge"><CircleCheck :size="13" />{{ t('alreadyInstalled') }}</span>
        <span v-else-if="inDraft.has(focused.projectId)" class="badge info center-badge">{{ t('inDraft') }}</span>
        <button v-else class="btn btn-primary btn-large btn-block" type="button" :disabled="focusedBlocked || (canChoose && !versionId)" @click="addFocused"><Plus :size="18" />{{ t('addToDraft') }}</button>
        <button class="btn btn-block" type="button" @click="openExternal(pageUrl)"><ExternalLink :size="15" />{{ t('openProviderPage') }}</button>
      </aside>
    </Transition>
    </div>
    <Transition name="modal">
      <VersionPicker v-if="choosing" :instance-id="inst.id" :provider="choosing.provider" :project-id="choosing.projectId" :name="choosing.name" @pick="(v) => addVersion(choosing!, v)" @close="choosing = null" />
    </Transition>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; padding-right: 4px; }
.view-header .meta { margin-top: 4px; }
.seg.off:not(.active) { opacity: 0.5; }
.types { display: inline-flex; gap: var(--space-3); border: none; margin: 0; padding: 0; }
.results { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: var(--space-3); }
.columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); align-items: start; }
.columns.open { grid-template-columns: minmax(0, 1fr) 380px; }
.results-wrap { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.columns.open .results { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.details { position: sticky; top: 0; padding: var(--space-5); border-radius: var(--radius-medium); display: flex; flex-direction: column; gap: var(--space-3); max-height: calc(100vh - 110px); overflow-y: auto; }
.close { position: absolute; top: 10px; right: 10px; }
.details-head { display: flex; gap: var(--space-3); align-items: center; padding-right: 28px; }
.details-head > div { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
.details-head h2 { font-size: 1.2rem; overflow-wrap: anywhere; }
.description { color: var(--text-secondary); font-size: 0.93rem; line-height: 1.55; }
.facts-row { flex-wrap: wrap; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.versions { border: none; margin: 0; padding: 0; min-width: 0; }
.field-label { font-size: 0.88rem; color: var(--text-secondary); font-weight: 500; margin-bottom: 6px; padding: 0; }
.version-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
.version { display: flex; align-items: center; gap: var(--space-3); padding: 8px 12px; border-radius: var(--radius-control); border: 1px solid var(--border-subtle); background: rgba(255, 255, 255, 0.03); }
.version:hover { border-color: rgba(147, 197, 253, 0.3); }
.version.active { border-color: rgba(96, 165, 250, 0.55); background: rgba(59, 130, 246, 0.12); }
.version-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.version-name { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; overflow-wrap: anywhere; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.center-badge { align-self: center; }
.hit.focused { border-color: rgba(96, 165, 250, 0.6); background: rgba(59, 130, 246, 0.1); }
@media (max-width: 1100px) { .columns.open { grid-template-columns: 1fr; } .details { position: static; max-height: none; } }
.hit { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); }
.hit.dim { opacity: 0.6; }
.skel { display: flex; gap: var(--space-3); padding: var(--space-4); }
.lines { flex: 1; display: flex; flex-direction: column; gap: 8px; padding-top: 6px; }
.hit-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.summary { font-size: 0.88rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.load-more { align-self: center; }
</style>
