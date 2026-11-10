<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { CircleAlert, CircleCheck, Copy, Download, ExternalLink, FolderOpen, Gamepad2, Info, Loader, Lock, Search, X } from '@lucide/vue';
import { contentArea, type ContentHit, type ContentKind, type ContentVersion, type ProviderId, type ProviderInfo } from '../backend/contract';
import { formatDate, formatNumber, t } from '../i18n';
import { filesArea } from '../state/nav';
import { asError, useSession } from '../state/session';
import { copyText, openMenu, separator, toast } from '../ui/desktop';
import { useInfiniteScroll } from '../ui/infiniteScroll';
import { formatBytes } from '../ui/labels';
import { openExternal } from '../state/appUpdate';
import Avatar from '../components/Avatar.vue';
import ProviderLogo from '../components/ProviderLogo.vue';
import type { ViewId } from '../App.vue';

/** Resource packs and shaders: found on the same two sites as mods, installed straight into their folder. */
const props = defineProps<{ kind: ContentKind }>();
const emit = defineEmits<{ navigate: [ViewId] }>();
const session = useSession();
const inst = computed(() => session.instance.value!);
const shader = computed(() => props.kind === 'shader');
const canBrowse = computed(() => session.can('content.browse') && !!session.backend.searchContent);
const needsManage = computed(() => !canBrowse.value && session.source.value === 'launcher' && !inst.value.shared);

const providers = ref<ProviderInfo[]>([]);
const provider = ref<ProviderId>('modrinth');
const providerInfo = computed(() => providers.value.find((p) => p.id === provider.value));
const text = ref('');
/** Only what has a version for this instance's Minecraft version. */
const matchVersion = ref(true);
const minecraft = computed(() => (matchVersion.value ? inst.value.minecraftVersion ?? '' : ''));
const hits = ref<ContentHit[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const PAGE = 30;
let requestId = 0;

/** File names already in this instance's folder, to mark what is installed. */
const present = ref<Set<string>>(new Set());
async function loadPresent() {
  try { present.value = new Set((await session.backend.listContent(inst.value.id, contentArea[props.kind])).map((e) => e.path.toLowerCase())); } catch { present.value = new Set(); }
}
const has = (v: ContentVersion) => present.value.has(v.fileName.toLowerCase());

async function search(append = false) {
  if (!canBrowse.value || !providerInfo.value?.available) { hits.value = []; total.value = 0; return; }
  const id = ++requestId;
  loading.value = true;
  error.value = '';
  try {
    const page = await session.backend.searchContent!({ kind: props.kind, provider: provider.value, text: text.value, minecraftVersion: minecraft.value, offset: append ? hits.value.length : 0, limit: PAGE });
    if (id !== requestId) return; // a newer query superseded this one
    hits.value = append ? [...hits.value, ...page.hits] : page.hits;
    total.value = append && !page.hits.length ? hits.value.length : page.total; // an empty page is the real end
  } catch (e) {
    if (id === requestId) error.value = asError(e).message;
  } finally {
    if (id === requestId) loading.value = false;
  }
}
let debounce: ReturnType<typeof setTimeout> | undefined;
watch(text, () => { clearTimeout(debounce); debounce = setTimeout(() => void search(), 250); });
watch([provider, matchVersion], () => { focused.value = null; void search(); });
onMounted(async () => {
  if (!canBrowse.value) return;
  providers.value = await session.backend.contentProviders?.().catch(() => []) ?? [];
  provider.value = providers.value.find((p) => p.available)?.id ?? 'modrinth';
  void loadPresent();
  void search();
});
const sentinel = ref<HTMLElement | null>(null);
const hasMore = computed(() => hits.value.length > 0 && hits.value.length < total.value);
useInfiniteScroll(sentinel, () => hasMore.value && !loading.value && !error.value, () => search(true));

/* Details panel: versions of the clicked project, as on Browse mods. */
const focused = ref<ContentHit | null>(null);
const versions = ref<ContentVersion[]>([]);
const versionId = ref('');
const versionsLoading = ref(false);
const versionsError = ref('');
const chosen = computed(() => versions.value.find((v) => v.id === versionId.value));
const pageUrl = (hit: ContentHit) => hit.pageUrl ?? (hit.provider === 'modrinth' ? `https://modrinth.com/${props.kind}/${hit.projectId}` : `https://www.curseforge.com/projects/${hit.projectId}`);
async function loadVersions(hit: ContentHit): Promise<ContentVersion[]> {
  return session.backend.contentVersions!(hit.provider, hit.projectId, minecraft.value);
}
async function focus(hit: ContentHit) {
  if (focused.value?.projectId === hit.projectId) { focused.value = null; return; }
  focused.value = hit;
  versions.value = [];
  versionId.value = '';
  versionsError.value = '';
  versionsLoading.value = true;
  try {
    const list = await loadVersions(hit);
    if (focused.value !== hit) return;
    versions.value = list;
    versionId.value = (list.find((v) => (v.releaseType ?? 'release') === 'release') ?? list[0])?.id ?? '';
  } catch (e) {
    if (focused.value === hit) versionsError.value = asError(e).message;
  } finally {
    if (focused.value === hit) versionsLoading.value = false;
  }
}

/* Installing: one at a time, with the download's progress on the button that started it. */
const installing = ref<{ projectId: string; progress: number } | null>(null);
/** Projects installed from this screen since it opened, for the cards' own mark. */
const justInstalled = ref<Set<string>>(new Set());
async function install(hit: ContentHit, version?: ContentVersion) {
  if (installing.value || !session.backend.installContent) return;
  installing.value = { projectId: hit.projectId, progress: 0 };
  try {
    // From a card: the newest stable version for this instance.
    const list = version ? [version] : await loadVersions(hit);
    const pick = list.find((v) => (v.releaseType ?? 'release') === 'release') ?? list[0];
    if (!pick) { toast(noVersionsText.value, 'warn'); return; }
    const done = await session.backend.installContent(inst.value.id, props.kind, hit.provider, hit.projectId, pick.id, (got, all) => {
      if (installing.value) installing.value = { projectId: hit.projectId, progress: all > 0 ? Math.min(1, got / all) : 0 };
    });
    toast(t(done.replaced ? 'contentReplaced' : 'contentInstalled', { name: done.fileName }), 'ok');
    justInstalled.value = new Set(justInstalled.value).add(hit.projectId);
    await loadPresent();
  } catch (e) {
    toast(asError(e).message, 'error');
  } finally {
    installing.value = null;
  }
}
const noVersionsText = computed(() => (minecraft.value ? t('contentNoVersions', { version: minecraft.value }) : t('packNoVersions')));
function showInFiles() {
  filesArea.value = contentArea[props.kind];
  emit('navigate', 'files');
}
function hitMenu(event: MouseEvent, hit: ContentHit) {
  openMenu(event, [
    { label: t('contentInstall'), icon: Download, disabled: !!installing.value, action: () => install(hit) },
    separator,
    { label: t('openProviderPage'), icon: ExternalLink, action: () => openExternal(pageUrl(hit)) },
    { label: t('copyName'), icon: Copy, action: () => copyText(hit.name) },
  ]);
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t(shader ? 'contentTitleShader' : 'contentTitleResourcepack') }}</h1>
        <p class="meta">
          <span v-if="inst.minecraftVersion"><Gamepad2 :size="15" />Minecraft {{ inst.minecraftVersion }}</span>
          <span><Info :size="15" />{{ t(shader ? 'contentShaderHint' : 'contentDirectHint') }}</span>
        </p>
      </div>
      <div class="toolbar">
        <button class="btn" type="button" :disabled="!canBrowse" @click="showInFiles"><FolderOpen :size="16" />{{ t('contentShowInFiles') }}</button>
      </div>
    </header>

    <div v-if="needsManage" class="notice">
      <Lock :size="18" /><span class="grow">{{ t('contentNeedManage') }}</span>
      <button class="btn btn-small" type="button" @click="emit('navigate', 'mods')">{{ t('navMods') }}</button>
    </div>
    <div v-else-if="!canBrowse" class="notice warn"><CircleAlert :size="18" />{{ t('capabilityMissing') }}</div>

    <template v-else>
    <div class="toolbar">
      <div class="segmented" role="tablist" :aria-label="t('provider')">
        <button
          v-for="p in providers" :key="p.id" type="button" role="tab" class="seg" :class="{ active: provider === p.id, off: !p.available }"
          :aria-selected="provider === p.id" @click="provider = p.id"
        ><ProviderLogo :provider="p.id" :size="18" />{{ p.id === 'modrinth' ? 'Modrinth' : 'CurseForge' }}</button>
      </div>
      <label class="search-field">
        <Search :size="16" />
        <input v-model="text" class="input" type="search" :placeholder="t(shader ? 'contentSearchShader' : 'contentSearchResourcepack')" :aria-label="t(shader ? 'contentSearchShader' : 'contentSearchResourcepack')" />
      </label>
      <label v-if="inst.minecraftVersion" class="check"><input v-model="matchVersion" type="checkbox" />{{ t('contentForVersion', { version: inst.minecraftVersion }) }}</label>
    </div>

    <div v-if="providerInfo && !providerInfo.available" class="notice warn" role="status">
      <ProviderLogo :provider="providerInfo.id" :size="22" />
      <span>{{ providerInfo.id === 'curseforge' ? t('curseforgeDisabled') : t('providerUnavailable', { provider: providerInfo.id }) }}</span>
    </div>
    <div v-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ t('searchFailed') }} <code class="small">{{ error }}</code></div>

    <div class="columns" :class="{ open: !!focused }">
    <div class="results-wrap">
    <ul class="results" :aria-busy="loading">
      <template v-if="loading && !hits.length">
        <li v-for="n in 6" :key="`s${n}`" class="card skel"><span class="skeleton" style="width: 52px; height: 52px; border-radius: 12px"></span><span class="lines"><span class="skeleton" style="height: 14px; width: 50%"></span><span class="skeleton" style="height: 12px; width: 85%"></span></span></li>
      </template>
      <li v-for="(hit, i) in hits" :key="hit.projectId" class="card hit rise" :style="{ '--i': i % 30 }" :class="{ focused: focused?.projectId === hit.projectId }" tabindex="0" @click="focus(hit)" @keydown.enter.self="focus(hit)" @contextmenu="hitMenu($event, hit)">
        <Avatar :name="hit.name" :src="hit.iconUrl" :size="52" />
        <div class="hit-copy">
          <div class="hit-title"><strong>{{ hit.name }}</strong> <span v-if="hit.author" class="muted small">{{ t('byAuthor', { author: hit.author }) }}</span></div>
          <p class="summary">{{ hit.summary }}</p>
          <div class="meta small"><span v-if="hit.downloads !== undefined"><Download :size="13" />{{ formatNumber(hit.downloads) }}</span></div>
        </div>
        <span v-if="justInstalled.has(hit.projectId)" class="badge ok"><CircleCheck :size="13" />{{ t('installedNow') }}</span>
        <button v-else class="btn btn-small" type="button" :disabled="!!installing" @click.stop="install(hit)">
          <Loader v-if="installing?.projectId === hit.projectId" :size="15" class="spin" /><Download v-else :size="15" />
          {{ installing?.projectId === hit.projectId ? `${Math.round(installing.progress * 100)}%` : t('contentInstall') }}
        </button>
      </li>
    </ul>
    <div v-if="!loading && !hits.length && providerInfo?.available && !error" class="empty card">
      <span class="empty-icon"><Search :size="28" /></span><p>{{ t('contentNoResults') }}</p>
    </div>
    <button v-if="hasMore && error && !loading" class="btn load-more" type="button" @click="search(true)">{{ t('loadMore') }}</button>
    <div ref="sentinel" class="load-status" aria-hidden="true"><Loader v-if="hasMore && !error" :size="20" class="spin" /></div>
    </div>

    <Transition name="slide">
      <aside v-if="focused" class="details glass" :aria-label="focused.name" @keydown.esc="focused = null">
        <button class="icon-btn close" type="button" :aria-label="t('close')" @click="focused = null"><X :size="18" /></button>
        <div class="details-head">
          <Avatar :name="focused.name" :src="focused.iconUrl" :size="72" />
          <div>
            <h2>{{ focused.name }}</h2>
            <p v-if="focused.author" class="muted small">{{ t('byAuthor', { author: focused.author }) }}</p>
            <span class="chip"><ProviderLogo :provider="focused.provider" :size="15" />{{ focused.provider === 'modrinth' ? 'Modrinth' : 'CurseForge' }}</span>
          </div>
        </div>
        <p class="description selectable">{{ focused.summary }}</p>
        <div v-if="focused.downloads !== undefined" class="meta small"><span><Download :size="14" />{{ formatNumber(focused.downloads) }}</span></div>

        <fieldset class="versions">
          <legend class="field-label">{{ t('packVersionLabel') }}</legend>
          <div v-if="versionsLoading" class="version-list"><span v-for="n in 3" :key="n" class="skeleton" style="height: 44px"></span></div>
          <p v-else-if="versionsError" class="notice error small" role="alert"><CircleAlert :size="16" />{{ versionsError }}</p>
          <p v-else-if="!versions.length" class="muted small">{{ noVersionsText }}</p>
          <div v-else class="version-list" role="radiogroup">
            <label v-for="v in versions" :key="v.id" class="version" :class="{ active: v.id === versionId }">
              <input v-model="versionId" type="radio" name="content-version" :value="v.id" />
              <span class="version-copy">
                <span class="version-name">{{ v.versionNumber || v.name }}
                  <span v-if="has(v)" class="badge ok"><CircleCheck :size="12" />{{ t('contentInFolder') }}</span>
                  <span v-else-if="v.releaseType && v.releaseType !== 'release'" class="badge warn">{{ t(v.releaseType) }}</span>
                  <span v-else-if="v.id === versions[0]?.id" class="badge info">{{ t('latest') }}</span>
                </span>
                <span class="muted small ellipsis">{{ v.fileName }}<template v-if="v.sizeBytes"> · {{ formatBytes(v.sizeBytes) }}</template></span>
                <span v-if="v.loaders.length || v.publishedAt" class="muted small ellipsis">{{ [v.loaders.join(', '), v.publishedAt ? formatDate(v.publishedAt) : ''].filter(Boolean).join(' · ') }}</span>
              </span>
            </label>
          </div>
        </fieldset>

        <div v-if="installing?.projectId === focused.projectId" class="progress" role="progressbar" :aria-valuenow="Math.round(installing.progress * 100)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${installing.progress * 100}%` }"></span></div>
        <button class="btn btn-primary btn-large btn-block" type="button" :disabled="!chosen || !!installing" @click="install(focused, chosen)">
          <Download :size="18" />{{ installing?.projectId === focused.projectId ? t('contentInstalling') : chosen && has(chosen) ? t('contentInstallAgain') : t('contentInstall') }}
        </button>
        <button class="btn btn-block" type="button" @click="openExternal(pageUrl(focused))"><ExternalLink :size="15" />{{ t('openProviderPage') }}</button>
      </aside>
    </Transition>
    </div>
    </template>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; padding-right: 4px; }
.view-header .meta { margin-top: 4px; }
.seg.off:not(.active) { opacity: 0.5; }
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
.versions { border: none; margin: 0; padding: 0; min-width: 0; }
.field-label { font-size: 0.88rem; color: var(--text-secondary); font-weight: 500; margin-bottom: 6px; padding: 0; }
.version-list { display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow-y: auto; }
.version { display: flex; align-items: center; gap: var(--space-3); padding: 8px 12px; border-radius: var(--radius-control); border: 1px solid var(--border-subtle); background: rgba(255, 255, 255, 0.03); }
.version:hover { border-color: rgba(147, 197, 253, 0.3); }
.version.active { border-color: rgba(96, 165, 250, 0.55); background: rgba(59, 130, 246, 0.12); }
.version-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.version-name { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; overflow-wrap: anywhere; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hit.focused { border-color: rgba(96, 165, 250, 0.6); background: rgba(59, 130, 246, 0.1); }
@media (max-width: 1100px) { .columns.open { grid-template-columns: 1fr; } .details { position: static; max-height: none; } }
.hit { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); }
.skel { display: flex; gap: var(--space-3); padding: var(--space-4); }
.lines { flex: 1; display: flex; flex-direction: column; gap: 8px; padding-top: 6px; }
.hit-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.summary { font-size: 0.88rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.load-more { align-self: center; }
.load-status { display: flex; justify-content: center; min-height: 24px; color: var(--text-secondary); }
.spin { animation: spin 1.2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
