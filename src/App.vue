<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import { Boxes, Download, FolderOpen, History, LayoutGrid, ListChecks, PackageSearch, Search, Settings, Upload } from '@lucide/vue';
import Avatar from './components/Avatar.vue';
import { isTerminal } from './domain/operation';
import { locale, localeNames, t, type Locale, type MessageKey } from './i18n';
import { load, save } from './domain/storage';
import { useSession } from './state/session';
import { loaderLabel } from './ui/labels';
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
const view = ref<ViewId>(state.instanceId ? 'mods' : 'library');
const reducedMotion = ref(load('reducedMotion', false));
const settingsOpen = ref(false);
watch(reducedMotion, (v) => save('reducedMotion', v));
// If the selected instance disappears, instance screens have nothing to show.
watch(() => session.instance.value, (inst) => { if (!inst && view.value !== 'packs') view.value = 'library'; });

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
const activeOps = computed(() => state.operations.filter((o) => !isTerminal(o)).length);
const connectionText = computed(() => {
  if (state.connectError?.code === 'unsupported') return t('connUnsupported');
  if (state.reconnecting) return t('connReconnecting');
  if (state.connection === 'connecting') return t('connConnecting');
  if (state.connection === 'connected') return session.backend.kind === 'mock' ? t('connMock') : t('connConnected');
  return state.connectError ? t('connFailed') : t('connDisconnected');
});
const connectionTone = computed(() => (state.connection === 'connected' ? (session.backend.kind === 'mock' ? 'warn' : 'ok') : state.connection === 'connecting' || state.reconnecting ? 'info' : 'error'));

function open(id: ViewId) { view.value = id; }
</script>

<template>
  <div class="shell" :class="{ 'reduced-motion': reducedMotion }">
    <nav class="sidebar glass" :aria-label="t('appName')">
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
        <button v-if="session.instance.value" class="current-instance" type="button" :title="t('switchInstance')" @click="open('library')">
          <Avatar :name="session.instance.value.name" :src="session.instance.value.iconUrl" :size="36" />
          <span class="current-copy">
            <span class="current-name">{{ session.instance.value.name }}</span>
            <span class="current-meta">{{ session.instance.value.minecraftVersion }} · {{ loaderLabel(session.instance.value.loader.kind) }}</span>
          </span>
        </button>
        <button v-else class="current-instance empty-instance" type="button" @click="open('library')">
          <PackageSearch :size="18" aria-hidden="true" />
          <span>{{ t('noInstance') }}</span>
        </button>
        <button
          v-for="item in instanceNav" :key="item.id" type="button" class="nav-item"
          :class="{ active: view === item.id }" :aria-current="view === item.id ? 'page' : undefined"
          :disabled="!session.instance.value" @click="open(item.id)"
        >
          <component :is="item.icon" :size="18" aria-hidden="true" />
          <span class="nav-text">{{ t(item.label) }}</span>
          <span v-if="item.id === 'review' && draftCount" class="badge info">{{ draftCount }}</span>
          <span v-if="item.id === 'history' && activeOps" class="badge info"><span class="dot pulse"></span>{{ activeOps }}</span>
        </button>
      </div>

      <footer class="sidebar-footer">
        <div class="connection badge" :class="connectionTone" role="status" :title="session.backend.kind === 'mock' ? t('connMockHint') : undefined">
          <span class="dot"></span><span class="conn-text">{{ connectionText }}</span>
        </div>
        <button v-if="state.connectError && state.connectError.code !== 'unsupported'" class="btn btn-small" type="button" @click="session.connect()">{{ t('retry') }}</button>
        <div class="settings-wrap">
          <button class="icon-btn" type="button" :aria-expanded="settingsOpen" :aria-label="t('settings')" :title="t('settings')" @click="settingsOpen = !settingsOpen">
            <Settings :size="18" />
          </button>
          <Transition name="fade">
            <div v-if="settingsOpen" class="settings glass" role="dialog" :aria-label="t('settings')" @keydown.esc="settingsOpen = false">
              <strong>{{ t('settings') }}</strong>
              <label class="field">
                <span>{{ t('language') }}</span>
                <select v-model="locale" class="select">
                  <option v-for="(name, code) in localeNames" :key="code" :value="code as Locale">{{ name }}</option>
                </select>
              </label>
              <label class="check"><input v-model="reducedMotion" type="checkbox" />{{ t('reducedMotion') }}</label>
            </div>
          </Transition>
        </div>
      </footer>
    </nav>

    <main class="stage" @click="settingsOpen = false">
      <div v-if="session.backend.kind === 'mock'" class="mock-banner" role="note">
        <span class="dot"></span>{{ t('connMockHint') }}
      </div>
      <LibraryView v-if="view === 'library'" @manage="open('mods')" @get-pack="open('packs')" />
      <PacksView v-else-if="view === 'packs'" @manage="open('mods')" />
      <template v-else-if="session.instance.value">
        <ModsView v-if="view === 'mods'" @navigate="open" />
        <BrowseView v-else-if="view === 'browse'" @navigate="open" />
        <ReviewView v-else-if="view === 'review'" @navigate="open" />
        <FilesView v-else-if="view === 'files'" />
        <HistoryView v-else-if="view === 'history'" />
        <ExportView v-else-if="view === 'export'" />
      </template>
      <div v-else class="empty glass">
        <span class="empty-icon"><PackageSearch :size="28" /></span>
        <h2>{{ t('noInstance') }}</h2>
        <p>{{ t('chooseInstanceHint') }}</p>
        <button class="btn btn-primary" type="button" @click="open('library')">{{ t('goToLibrary') }}</button>
      </div>
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
.sidebar { display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-4) var(--space-3); min-height: 0; overflow-y: auto; }
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
.nav-item.active { background: var(--surface-selected); color: #fff; border-color: rgba(96, 165, 250, 0.24); box-shadow: inset 3px 0 0 #3b82f6; }
.nav-item:disabled { opacity: 0.38; cursor: not-allowed; }
.pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
.sidebar-footer { margin-top: auto; display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-1); }
.connection { flex: 1; min-width: 0; padding: 5px 10px; }
.conn-text { overflow: hidden; text-overflow: ellipsis; }
.settings-wrap { position: relative; }
.settings { position: absolute; bottom: 44px; left: 0; width: 240px; padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); background: var(--glass-menu); border-radius: var(--radius-medium); z-index: 20; }
.stage { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.stage > :deep(.view), .stage > .empty { flex: 1; min-height: 0; }
.mock-banner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #fcd34d; padding: 4px 12px; border-radius: var(--radius-pill); background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); align-self: flex-start; }

@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .sidebar { flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .nav-group { flex-direction: row; flex-wrap: wrap; }
  .nav-label, .current-instance { display: none; }
  .sidebar-footer { margin-top: 0; }
  .settings { bottom: auto; top: 44px; left: auto; right: 0; }
}
</style>
