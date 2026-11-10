<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { Boxes, Download, FolderKanban, FolderOpen, History, Image, LayoutGrid, ListChecks, Loader, PackageSearch, Search, Settings, Sun, Upload } from '@lucide/vue';
import Avatar from './components/Avatar.vue';
import { isRunning } from './domain/operation';
import { t, type MessageKey } from './i18n';
import SettingsDialog from './components/SettingsDialog.vue';
import { reducedMotion, systemReducedMotion } from './state/prefs';
import { useSession } from './state/session';
import { instanceSubtitle } from './ui/labels';
import TitleBar from './components/TitleBar.vue';
import ContextMenu from './components/ContextMenu.vue';
import DialogHost from './components/DialogHost.vue';
import UpdateDialog from './components/UpdateDialog.vue';
import { appUpdate } from './state/appUpdate';
import LibraryView from './views/LibraryView.vue';
import ModsView from './views/ModsView.vue';
import PacksView from './views/PacksView.vue';
import BrowseView from './views/BrowseView.vue';
import ContentBrowseView from './views/ContentBrowseView.vue';
import { browseKind, leaveGuard, type BrowseKind } from './state/nav';
import ReviewView from './views/ReviewView.vue';
import FilesView from './views/FilesView.vue';
import HistoryView from './views/HistoryView.vue';
import ExportView from './views/ExportView.vue';
import ProjectsView from './views/ProjectsView.vue';
import { useProjects } from './state/projects';

export type ViewId = 'library' | 'packs' | 'projects' | 'mods' | 'browse' | 'review' | 'files' | 'history' | 'export';

const session = useSession();
/** Dev-only protocol fixture (?mock=core): label it like demo data. */
const devFixture = import.meta.env.DEV && location.search.includes('mock=core');
const { state } = session;
const accessMessage = { connecting: 'shareWorking', loading: 'shareLoading', releasing: 'shareReleasing' } as const;
// Start on the library; jump to Mods only once the remembered instance has actually loaded.
const view = ref<ViewId>('library');
let restored = false;
const settingsOpen = ref(false);
/** With reduced motion, page swaps skip Vue's transition entirely so they are instant. */
const motionOff = computed(() => reducedMotion.value || systemReducedMotion);
// If the selected instance disappears, instance screens have nothing to show.
watch(() => session.instance.value, (inst) => {
  if (inst && !restored) { restored = true; if (view.value === 'library') view.value = 'mods'; }
  if (!inst && view.value !== 'packs' && view.value !== 'projects') view.value = 'library';
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

/** Browse has three shelves: mods go through a reviewed plan, the other two install directly. */
const browseNav: { id: BrowseKind; label: MessageKey; icon: Component }[] = [
  { id: 'mod', label: 'navMods', icon: Boxes },
  { id: 'resourcepack', label: 'browseResourcepacks', icon: Image },
  { id: 'shader', label: 'browseShaders', icon: Sun },
];
async function openBrowse(kind: BrowseKind) {
  if (view.value !== 'browse' && !await canLeave()) return;
  browseKind.value = kind;
  void open('browse');
}

const draftCount = computed(() => session.draft.value?.changes.length ?? 0);
const activeOps = computed(() => state.operations.filter(isRunning).length);
const connectionText = computed(() => {
  if (state.connectError?.code === 'unsupported') return t('connUnsupported');
  if (state.waitingForLauncher) return t('launcherNotRunning');
  if (state.reconnecting) return t('connReconnecting');
  if (state.connection === 'connecting') return t('connConnecting');
  if (state.connection === 'connected' && session.backend.kind === 'mock') return t('connMock');
  if (state.connection === 'connected' && session.source.value === 'helper') return state.handshake?.stub ? t('connHelperStub') : t('connHelper');
  if (state.connection === 'connected') return t('connConnected');
  return state.connectError ? t('connFailed') : t('connDisconnected');
});
const connectionTone = computed(() => {
  if (state.waitingForLauncher) return 'warn';
  if (state.connection === 'connected') return session.backend.kind === 'mock' || state.handshake?.stub ? 'warn' : 'ok';
  return state.connection === 'connecting' || state.reconnecting ? 'info' : 'error';
});

/* Back and forward through screens, by toolbar, Alt+arrows or the mouse's side buttons. */
const back = ref<ViewId[]>([]);
const forward = ref<ViewId[]>([]);
/** A screen with unsaved work gets to ask before it is replaced. */
const canLeave = async () => !leaveGuard.value || await leaveGuard.value();
async function open(id: ViewId) {
  if (id === view.value || !await canLeave()) return;
  back.value = [...back.value.slice(-49), view.value];
  forward.value = [];
  view.value = id;
}
const usable = (id: ViewId) => ['library', 'packs', 'projects'].includes(id) || !!session.instance.value;
async function goBack() {
  if (!await canLeave()) return;
  const list = [...back.value];
  while (list.length) {
    const id = list.pop()!;
    if (usable(id)) { forward.value = [...forward.value, view.value]; back.value = list; view.value = id; return; }
  }
  back.value = [];
}
async function goForward() {
  if (!await canLeave()) return;
  const list = [...forward.value];
  while (list.length) {
    const id = list.pop()!;
    if (usable(id)) { back.value = [...back.value, view.value]; forward.value = list; view.value = id; return; }
  }
  forward.value = [];
}
function onMouseButton(e: MouseEvent) {
  if (e.button === 3) { e.preventDefault(); void goBack(); }
  if (e.button === 4) { e.preventDefault(); void goForward(); }
}

/* A desktop app has no page to reload, print or inspect, and no browser menu. */
const isField = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
function refreshAll() {
  void session.refreshInstances();
  void session.loadInventory();
}
function onKey(e: KeyboardEvent) {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === 'F5' || (ctrl && key === 'r')) { e.preventDefault(); refreshAll(); return; }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); void goBack(); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); void goForward(); return; }
  if (ctrl && key === 'f') {
    const field = document.querySelector<HTMLInputElement>('.stage input[type=search]');
    if (field) { e.preventDefault(); field.focus(); field.select(); }
    return;
  }
  if (ctrl && e.key === ',') { e.preventDefault(); settingsOpen.value = true; return; }
  if (ctrl && (['p', 'u', 'g', 'j', 's', 'o', 'n', 't', 'w'].includes(key) && !(isField(e.target) && key === 'a'))) e.preventDefault();
  if (!import.meta.env.DEV && e.key === 'F12') e.preventDefault();
  if (!import.meta.env.DEV && ctrl && e.shiftKey && ['i', 'j', 'c'].includes(key)) e.preventDefault();
}
function onNativeMenu(e: MouseEvent) { if (!isField(e.target)) e.preventDefault(); }
function onDrop(e: DragEvent) { e.preventDefault(); }
onMounted(() => { addEventListener('keydown', onKey); addEventListener('contextmenu', onNativeMenu); addEventListener('dragover', onDrop); addEventListener('drop', onDrop); });
onBeforeUnmount(() => { removeEventListener('keydown', onKey); removeEventListener('contextmenu', onNativeMenu); removeEventListener('dragover', onDrop); removeEventListener('drop', onDrop); });

const views: Record<ViewId, Component> = { library: LibraryView, packs: PacksView, projects: ProjectsView, mods: ModsView, browse: BrowseView, review: ReviewView, files: FilesView, history: HistoryView, export: ExportView };
const needsInstance = computed(() => !['library', 'packs', 'projects'].includes(view.value));
const projectCount = computed(() => useProjects().projects.value.length);
const contentKind = computed(() => (view.value === 'browse' && browseKind.value !== 'mod' ? browseKind.value : null));
const shownView = computed(() => (needsInstance.value && !session.instance.value ? null : contentKind.value ? ContentBrowseView : views[view.value]));
// Instance screens re-enter when the instance changes, so the switch reads as a new page.
const viewKey = computed(() => (needsInstance.value ? `${view.value}:${contentKind.value ?? ''}:${state.instanceId}` : view.value));

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
watch([view, browseKind, () => session.instance.value?.id, () => state.connection], () => void nextTick(placeIndicator));
</script>

<template>
  <div class="frame" :class="{ 'reduced-motion': reducedMotion }" @mouseup="onMouseButton">
  <TitleBar :can-back="back.length > 0" :can-forward="forward.length > 0" :active-ops="activeOps" @back="goBack" @forward="goForward" @history="session.instance.value && open('history')" />
  <div class="shell">
    <nav ref="sidebar" class="sidebar glass" :aria-label="t('appName')">
      <span
        class="nav-indicator" aria-hidden="true"
        :class="{ ready: indicator.ready, hidden: !indicator.visible }"
        :style="{ transform: `translate3d(${indicator.x}px, ${indicator.y}px, 0)`, width: `${indicator.w}px`, height: `${indicator.h}px` }"
      ></span>
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
        <span class="nav-label">{{ t('navSectionProjects') }}</span>
        <button type="button" class="nav-item" :class="{ active: view === 'projects' }" :aria-current="view === 'projects' ? 'page' : undefined" @click="open('projects')">
          <FolderKanban :size="18" aria-hidden="true" />
          <span class="nav-text">{{ t('navProjects') }}</span>
          <span v-if="projectCount" class="badge">{{ projectCount }}</span>
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
        <template v-for="item in instanceNav" :key="item.id">
          <!-- Browse is a heading for its three shelves: the open shelf carries the highlight. -->
          <button
            type="button" class="nav-item"
            :class="{ active: view === item.id && item.id !== 'browse', parent: view === 'browse' && item.id === 'browse' }" :aria-current="view === item.id && item.id !== 'browse' ? 'page' : undefined"
            :disabled="!session.instance.value" @click="open(item.id)"
          >
            <component :is="item.icon" :size="18" aria-hidden="true" />
            <span class="nav-text">{{ t(item.label) }}</span>
            <span v-if="item.id === 'review' && draftCount" :key="draftCount" class="badge info pop">{{ draftCount }}</span>
            <span v-if="item.id === 'history' && activeOps" :key="activeOps" class="badge info pop"><span class="dot pulse"></span>{{ activeOps }}</span>
          </button>
          <div v-if="item.id === 'browse'" class="nav-sub" role="group" :aria-label="t('navBrowse')">
            <button
              v-for="shelf in browseNav" :key="shelf.id" type="button" class="nav-item sub"
              :class="{ active: view === 'browse' && browseKind === shelf.id }" :aria-current="view === 'browse' && browseKind === shelf.id ? 'page' : undefined"
              :disabled="!session.instance.value" @click="openBrowse(shelf.id)"
            >
              <component :is="shelf.icon" :size="16" aria-hidden="true" />
              <span class="nav-text">{{ t(shelf.label) }}</span>
            </button>
          </div>
        </template>
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
      <div v-if="(session.backend.kind === 'mock' || devFixture) && view !== 'projects'" class="mock-banner" role="note">
        <span class="dot"></span>{{ t('connMockHint') }}
      </div>
      <div v-if="state.instanceAccess" class="notice access-status" role="status">
        <Loader :size="18" class="access-spin" />
        <span class="grow">{{ t(accessMessage[state.instanceAccess.stage], { name: state.instanceAccess.name }) }}<span class="access-bar" aria-hidden="true"></span></span>
      </div>
      <Transition name="page" :mode="motionOff ? 'default' : 'out-in'" :css="!motionOff">
        <component
          :is="shownView" v-if="shownView" :key="viewKey" v-bind="contentKind ? { kind: contentKind } : {}"
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
  <Transition name="modal"><UpdateDialog v-if="appUpdate.dialogOpen && appUpdate.info?.latest" /></Transition>
  <ContextMenu />
  <DialogHost />
  </div>
</template>

<style scoped>
.frame { display: flex; flex-direction: column; height: 100vh; }
.shell {
  flex: 1; min-height: 0;
  display: grid;
  grid-template-columns: clamp(232px, 17vw, 268px) minmax(0, 1fr);
  gap: var(--space-4);
  padding: 0 var(--space-4) var(--space-4);
}
.sidebar { position: relative; display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-4) var(--space-3); min-height: 0; overflow-y: auto; }
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
.nav-item.active, .nav-item.parent { color: #fff; }
.nav-sub { display: flex; flex-direction: column; gap: 2px; margin-left: 21px; padding-left: 8px; border-left: 1px solid var(--border-subtle); }
.nav-item.sub { padding: 6px 10px; font-size: 0.9rem; }
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
.access-status { flex-shrink: 0; }
.access-spin { animation: access-spin 1.2s linear infinite; }
@keyframes access-spin { to { transform: rotate(360deg); } }
.access-bar { display: block; position: relative; height: 3px; margin-top: 7px; border-radius: var(--radius-pill); background: var(--surface-interactive); overflow: hidden; }
.access-bar::after { content: ''; position: absolute; inset: 0 auto 0 0; width: 34%; border-radius: inherit; background: var(--accent-gradient); animation: access-slide 1.4s var(--ease) infinite; }
@keyframes access-slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
@media (prefers-reduced-motion: reduce) { .access-spin, .access-bar::after { animation: none; } .access-bar::after { width: 100%; opacity: 0.6; } }
.mock-banner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #fcd34d; padding: 4px 12px; border-radius: var(--radius-pill); background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); align-self: flex-start; }

@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .sidebar { flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .nav-group { flex-direction: row; flex-wrap: wrap; }
  .nav-label, .current-instance { display: none; }
  .nav-sub { flex-direction: row; margin-left: 0; padding-left: 0; border-left: none; }
  .sidebar-footer { margin-top: 0; }
}
</style>
