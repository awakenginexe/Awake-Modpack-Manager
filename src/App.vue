<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { Boxes, Download, FolderOpen, History, LayoutGrid, ListChecks, PackageSearch, Search, Settings, Upload } from '@lucide/vue';
import Avatar from './components/Avatar.vue';
import { isSettled } from './domain/operation';
import { t, type MessageKey } from './i18n';
import SettingsDialog from './components/SettingsDialog.vue';
import { reducedMotion, systemReducedMotion } from './state/prefs';
import { useSession } from './state/session';
import { instanceSubtitle } from './ui/labels';
import awakeLogo from './assets/brand/awake.png';
import LibraryView from './views/LibraryView.vue';
import ModsView from './views/ModsView.vue';
import PacksView from './views/PacksView.vue';
import BrowseView from './views/BrowseView.vue';
import ReviewView from './views/ReviewView.vue';
import FilesView from './views/FilesView.vue';
import HistoryView from './views/HistoryView.vue';
import ExportView from './views/ExportView.vue';

export type ViewId = 'library' | 'packs' | 'mods' | 'browse' | 'review' | 'files' | 'history' | 'export';

const session = useSession();
const { state } = session;
// Start on the library; jump to Mods only once the remembered instance has actually loaded.
const view = ref<ViewId>('library');
let restored = false;
const settingsOpen = ref(false);
/** With reduced motion, page swaps skip Vue's transition entirely so they are instant. */
const motionOff = computed(() => reducedMotion.value || systemReducedMotion);
// If the selected instance disappears, instance screens have nothing to show.
watch(() => session.instance.value, (inst) => {
  if (inst && !restored) { restored = true; if (view.value === 'library') view.value = 'mods'; }
  if (!inst && view.value !== 'packs') view.value = 'library';
}, { immediate: true });

interface NavItem { id: ViewId; label: MessageKey; icon: Component }
const libraryNav: NavItem[] = [
  { id: 'library', label: 'navLibrary', icon: LayoutGrid },
  { id: 'packs', label: 'navPacks', icon: Download },
];
const instanceNav: NavItem[] = [
  { id: 'mods', label: 'navMods', icon: Boxes },
  { id: 'browse', label: 'navBrowse', icon: Search },
  { id: 'review', label: 'navReview', icon: ListChecks },
  { id: 'files', label: 'navFiles', icon: FolderOpen },
  { id: 'history', label: 'navHistory', icon: History },
  { id: 'export', label: 'navExport', icon: Upload },
];

const draftCount = computed(() => session.draft.value?.changes.length ?? 0);
const activeOps = computed(() => state.operations.filter((o) => !isSettled(o)).length);
const connectionText = computed(() => {
  if (state.connectError?.code === 'unsupported') return t('connUnsupported');
  if (state.waitingForLauncher) return t('launcherNotRunning');
  if (state.reconnecting) return t('connReconnecting');
  if (state.connection === 'connecting') return t('connConnecting');
  if (state.connection === 'connected') return session.backend.kind === 'mock' ? t('connMock') : t('connConnected');
  return state.connectError ? t('connFailed') : t('connDisconnected');
});
const connectionTone = computed(() => {
  if (state.waitingForLauncher) return 'warn';
  if (state.connection === 'connected') return session.backend.kind === 'mock' ? 'warn' : 'ok';
  return state.connection === 'connecting' || state.reconnecting ? 'info' : 'error';
});

function open(id: ViewId) { view.value = id; }

const views: Record<ViewId, Component> = { library: LibraryView, packs: PacksView, mods: ModsView, browse: BrowseView, review: ReviewView, files: FilesView, history: HistoryView, export: ExportView };
const needsInstance = computed(() => view.value !== 'library' && view.value !== 'packs');
const shownView = computed(() => (needsInstance.value && !session.instance.value ? null : views[view.value]));
// Instance screens re-enter when the instance changes, so the switch reads as a new page.
const viewKey = computed(() => (needsInstance.value ? `${view.value}:${state.instanceId}` : view.value));

/* Sliding highlight behind the active nav item. */
const sidebar = ref<HTMLElement | null>(null);
const indicator = ref({ x: 0, y: 0, w: 0, h: 0, visible: false, ready: false });
function placeIndicator() {
  const el = sidebar.value?.querySelector<HTMLElement>('.nav-item.active');
  if (!el) { indicator.value.visible = false; return; }
  indicator.value = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, visible: true, ready: indicator.value.ready };
  // Enable the slide only after the first placement so it doesn't fly in from the corner.
  if (!indicator.value.ready) requestAnimationFrame(() => { indicator.value.ready = true; });
}
let resize: ResizeObserver | undefined;
onMounted(() => {
  void nextTick(placeIndicator);
  if (typeof ResizeObserver !== 'undefined' && sidebar.value) { resize = new ResizeObserver(placeIndicator); resize.observe(sidebar.value); }
});
onBeforeUnmount(() => resize?.disconnect());
watch([view, () => session.instance.value?.id, () => state.connection], () => void nextTick(placeIndicator));
</script>

<template>
  <div class="shell" :class="{ 'reduced-motion': reducedMotion }">
    <nav ref="sidebar" class="sidebar glass" :aria-label="t('appName')">
      <span
        class="nav-indicator" aria-hidden="true"
        :class="{ ready: indicator.ready, hidden: !indicator.visible }"
        :style="{ transform: `translate3d(${indicator.x}px, ${indicator.y}px, 0)`, width: `${indicator.w}px`, height: `${indicator.h}px` }"
      ></span>
      <header class="brand">
        <img :src="awakeLogo" alt="" class="brand-logo" width="38" height="38" />
        <div><strong>Awake</strong><span>Modpack Manager</span></div>
      </header>

      <div class="nav-group">
        <span class="nav-label">{{ t('navSectionLibrary') }}</span>
        <button
          v-for="item in libraryNav" :key="item.id" type="button" class="nav-item"
          :class="{ active: view === item.id }" :aria-current="view === item.id ? 'page' : undefined" @click="open(item.id)"
        >
          <component :is="item.icon" :size="18" aria-hidden="true" />
          <span class="nav-text">{{ t(item.label) }}</span>
        </button>
      </div>

      <div class="nav-group">
        <span class="nav-label">{{ t('navSectionInstance') }}</span>
        <Transition name="swap" mode="out-in" @after-enter="placeIndicator" @after-leave="placeIndicator">
        <button v-if="session.instance.value" :key="session.instance.value.id" class="current-instance" type="button" :title="t('switchInstance')" @click="open('library')">
          <Avatar :name="session.instance.value.name" :src="session.instance.value.iconUrl" :size="36" />
          <span class="current-copy">
            <span class="current-name">{{ session.instance.value.name }}</span>
            <span class="current-meta">{{ instanceSubtitle(session.instance.value) }}</span>
          </span>
        </button>
        <button v-else class="current-instance empty-instance" type="button" @click="open('library')">
          <PackageSearch :size="18" aria-hidden="true" />
          <span>{{ t('noInstance') }}</span>
        </button>
        </Transition>
        <button
          v-for="item in instanceNav" :key="item.id" type="button" class="nav-item"
          :class="{ active: view === item.id }" :aria-current="view === item.id ? 'page' : undefined"
          :disabled="!session.instance.value" @click="open(item.id)"
        >
          <component :is="item.icon" :size="18" aria-hidden="true" />
          <span class="nav-text">{{ t(item.label) }}</span>
          <span v-if="item.id === 'review' && draftCount" :key="draftCount" class="badge info pop">{{ draftCount }}</span>
          <span v-if="item.id === 'history' && activeOps" :key="activeOps" class="badge info pop"><span class="dot pulse"></span>{{ activeOps }}</span>
        </button>
      </div>

      <footer class="sidebar-footer">
        <div class="connection badge" :class="connectionTone" role="status" :title="session.backend.kind === 'mock' ? t('connMockHint') : undefined">
          <span class="dot"></span><span class="conn-text">{{ connectionText }}</span>
        </div>
        <button v-if="state.connectError && state.connectError.code !== 'unsupported' && !state.waitingForLauncher" class="btn btn-small" type="button" @click="session.connect()">{{ t('retry') }}</button>
        <button class="icon-btn" type="button" aria-haspopup="dialog" :aria-label="t('settings')" :title="t('settings')" @click="settingsOpen = true">
          <Settings :size="18" />
        </button>
      </footer>
    </nav>

    <Transition name="modal">
      <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />
    </Transition>

    <main class="stage">
      <div v-if="session.backend.kind === 'mock'" class="mock-banner" role="note">
        <span class="dot"></span>{{ t('connMockHint') }}
      </div>
      <Transition name="page" :mode="motionOff ? 'default' : 'out-in'" :css="!motionOff">
        <component
          :is="shownView" v-if="shownView" :key="viewKey"
          @manage="open('mods')" @get-pack="open('packs')" @navigate="open"
        />
        <div v-else key="empty" class="empty glass">
          <span class="empty-icon"><PackageSearch :size="28" /></span>
          <h2>{{ t('noInstance') }}</h2>
          <p>{{ t('chooseInstanceHint') }}</p>
          <button class="btn btn-primary" type="button" @click="open('library')">{{ t('goToLibrary') }}</button>
        </div>
      </Transition>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: clamp(232px, 17vw, 268px) minmax(0, 1fr);
  gap: var(--space-4);
  height: 100vh;
  padding: var(--space-4);
}
.sidebar { position: relative; display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-4) var(--space-3); min-height: 0; overflow-y: auto; }
.brand { display: flex; align-items: center; gap: var(--space-3); padding: 0 var(--space-2); }
.brand-logo { border-radius: 10px; filter: drop-shadow(0 4px 12px rgba(37, 99, 235, 0.35)); }
.brand div { display: flex; flex-direction: column; line-height: 1.15; }
.brand strong { font-size: 1.1rem; font-weight: 700; }
.brand span { color: var(--text-secondary); font-size: 0.84rem; }
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.nav-label { font-size: 0.74rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); padding: 0 var(--space-3) var(--space-2); }
.current-instance {
  display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2); margin-bottom: var(--space-2); border-radius: var(--radius-medium);
  border: 1px solid rgba(96, 165, 250, 0.22); background: linear-gradient(90deg, rgba(59, 130, 246, 0.16), rgba(59, 130, 246, 0.04));
  text-align: left; cursor: pointer;
}
.current-instance:hover { border-color: rgba(96, 165, 250, 0.45); }
.empty-instance { color: var(--text-secondary); border-style: dashed; background: transparent; font-size: 0.9rem; padding: var(--space-3); }
.current-copy { display: flex; flex-direction: column; min-width: 0; }
.current-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.current-meta { font-size: 0.8rem; color: var(--text-secondary); }
.nav-item {
  display: flex; align-items: center; gap: var(--space-3); width: 100%; padding: 9px 12px; border-radius: var(--radius-control);
  border: 1px solid transparent; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left; font-size: 0.95rem;
  transition: background-color var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.nav-text { flex: 1; }
.nav-item:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
.nav-item { position: relative; z-index: 1; }
.nav-item.active { color: #fff; }
/* Active highlight lives on one element that slides between items. */
.nav-indicator {
  position: absolute; top: 0; left: 0; z-index: 0; pointer-events: none; border-radius: var(--radius-control);
  background: var(--surface-selected); border: 1px solid rgba(96, 165, 250, 0.24); box-shadow: inset 3px 0 0 #3b82f6, 0 4px 14px rgba(37, 99, 235, 0.18);
}
.nav-indicator.ready { transition: transform var(--duration-slow) var(--ease), width var(--duration-slow) var(--ease), height var(--duration-slow) var(--ease), opacity var(--duration-fast) var(--ease); }
.nav-indicator.hidden { opacity: 0; }
.nav-item:disabled { opacity: 0.38; cursor: not-allowed; }
.pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
.sidebar-footer { margin-top: auto; display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-1); }
.connection { flex: 1; min-width: 0; padding: 5px 10px; }
.conn-text { overflow: hidden; text-overflow: ellipsis; }
.stage { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.stage > :deep(.view), .stage > .empty { flex: 1; min-height: 0; }
.mock-banner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #fcd34d; padding: 4px 12px; border-radius: var(--radius-pill); background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); align-self: flex-start; }

@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .sidebar { flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .nav-group { flex-direction: row; flex-wrap: wrap; }
  .nav-label, .current-instance { display: none; }
  .sidebar-footer { margin-top: 0; }
}
</style>
