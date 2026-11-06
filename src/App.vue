<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { isTerminal } from './domain/operation';
import { locale, localeNames, t, type Locale, type MessageKey } from './i18n';
import { load, save } from './domain/storage';
import { useSession } from './state/session';
import { loaderLabel } from './ui/labels';
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
watch(reducedMotion, (v) => save('reducedMotion', v));

// Simple line icons (24px grid), drawn for the Manager.
const nav: { id: ViewId; label: MessageKey; icon: string; needsInstance: boolean }[] = [
  { id: 'library', label: 'navLibrary', icon: 'M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4zM13 13h7v6h-7z', needsInstance: false },
  { id: 'packs', label: 'navPacks', icon: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5', needsInstance: false },
  { id: 'mods', label: 'navMods', icon: 'M4 6h16M4 12h16M4 18h10', needsInstance: true },
  { id: 'browse', label: 'navBrowse', icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4', needsInstance: true },
  { id: 'review', label: 'navReview', icon: 'M5 12l4 4L19 6', needsInstance: true },
  { id: 'files', label: 'navFiles', icon: 'M4 6h6l2 2h8v10H4z', needsInstance: true },
  { id: 'history', label: 'navHistory', icon: 'M12 7v5l3 2M12 3a9 9 0 1 0 9 9', needsInstance: true },
  { id: 'export', label: 'navExport', icon: 'M12 4v11M7 9l5-5 5 5M5 20h14', needsInstance: true },
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

function open(id: ViewId) { view.value = id; }
</script>

<template>
  <div class="shell" :class="{ 'reduced-motion': reducedMotion }">
    <nav class="sidebar glass" :aria-label="t('appName')">
      <header class="brand">
        <span class="brand-mark" aria-hidden="true">A</span>
        <div><strong>Awake</strong><span>Modpack Manager</span></div>
      </header>

      <button v-if="session.instance.value" class="current-instance" type="button" @click="open('library')">
        <span class="instance-initial" aria-hidden="true">{{ session.instance.value.name.slice(0, 1) }}</span>
        <span class="current-copy">
          <span class="current-name">{{ session.instance.value.name }}</span>
          <span class="current-meta">{{ session.instance.value.minecraftVersion }} · {{ loaderLabel(session.instance.value.loader.kind) }}</span>
        </span>
      </button>

      <ul class="nav-list">
        <li v-for="item in nav" :key="item.id">
          <button
            type="button"
            class="nav-item"
            :class="{ active: view === item.id }"
            :aria-current="view === item.id ? 'page' : undefined"
            :disabled="item.needsInstance && !session.instance.value"
            @click="open(item.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="item.icon" /></svg>
            <span>{{ t(item.label) }}</span>
            <span v-if="item.id === 'review' && draftCount" class="badge info">{{ draftCount }}</span>
            <span v-if="item.id === 'history' && activeOps" class="badge info">{{ activeOps }}</span>
          </button>
        </li>
      </ul>

      <footer class="sidebar-footer">
        <div class="connection" :class="state.connection" role="status" :title="session.backend.kind === 'mock' ? t('connMockHint') : undefined">
          <span class="dot" aria-hidden="true"></span>
          <span>{{ connectionText }}</span>
        </div>
        <button v-if="state.connectError && state.connectError.code !== 'unsupported'" class="btn btn-small" type="button" @click="session.connect()">{{ t('retry') }}</button>
        <label class="field">
          <span>{{ t('language') }}</span>
          <select v-model="locale" class="select">
            <option v-for="(name, code) in localeNames" :key="code" :value="code as Locale">{{ name }}</option>
          </select>
        </label>
        <label class="check"><input v-model="reducedMotion" type="checkbox" />{{ t('reducedMotion') }}</label>
      </footer>
    </nav>

    <main class="stage">
      <div v-if="session.backend.kind === 'mock' && view !== 'library' && view !== 'packs'" class="mock-banner">{{ t('connMockHint') }}</div>
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
  grid-template-columns: clamp(220px, 18vw, 270px) minmax(0, 1fr);
  gap: var(--space-4);
  height: 100vh;
  padding: var(--space-4);
}
.sidebar { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-4); min-height: 0; overflow-y: auto; }
.brand { display: flex; align-items: center; gap: var(--space-3); }
.brand div { display: flex; flex-direction: column; line-height: 1.15; }
.brand strong { font-size: 1.05rem; }
.brand span { color: var(--text-secondary); font-size: 0.82rem; }
.brand-mark, .instance-initial {
  display: grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
  background: var(--accent-gradient); font-weight: 700; color: #fff; box-shadow: 0 4px 14px var(--accent-glow);
}
.instance-initial { width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #1e3a5f, #0f2744); box-shadow: none; }
.current-instance {
  display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2); border-radius: var(--radius-medium);
  border: 1px solid rgba(96, 165, 250, 0.24); background: linear-gradient(90deg, rgba(59, 130, 246, 0.2), rgba(59, 130, 246, 0.06));
  box-shadow: inset 3.5px 0 0 #3b82f6; text-align: left; cursor: pointer;
}
.current-copy { display: flex; flex-direction: column; min-width: 0; }
.current-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.current-meta { font-size: 0.77rem; color: var(--text-secondary); }
.nav-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex; align-items: center; gap: var(--space-3); width: 100%; padding: 8px 10px; border-radius: var(--radius-control);
  border: 1px solid transparent; background: transparent; color: var(--text-secondary); cursor: pointer; text-align: left;
  transition: background-color var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease);
}
.nav-item svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
.nav-item span:nth-child(2) { flex: 1; }
.nav-item:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
.nav-item.active { background: var(--surface-selected); color: #fff; border-color: rgba(96, 165, 250, 0.24); }
.nav-item:disabled { opacity: 0.4; cursor: default; }
.sidebar-footer { margin-top: auto; display: flex; flex-direction: column; gap: var(--space-3); font-size: 0.85rem; }
.connection { display: flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); }
.connection .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
.connection.connected .dot { background: var(--ok); box-shadow: 0 0 8px rgba(52, 211, 153, 0.6); }
.connection.connecting .dot { background: var(--warning); }
.stage { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.stage > :deep(.view), .stage > .empty { flex: 1; min-height: 0; }
.mock-banner { font-size: 0.8rem; color: #fcd34d; padding: 4px 12px; border-radius: var(--radius-pill); background: rgba(245, 158, 11, 0.1); align-self: flex-start; }

@media (max-width: 860px) {
  .shell { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .sidebar { flex-direction: row; flex-wrap: wrap; align-items: center; }
  .nav-list { flex-direction: row; flex-wrap: wrap; }
  .sidebar-footer { margin-top: 0; flex-direction: row; align-items: center; }
  .current-instance { display: none; }
}
</style>
