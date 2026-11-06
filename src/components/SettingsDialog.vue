<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Component } from 'vue';
import { Check, ChevronDown, CircleCheck, CircleMinus, Info, Plug, RefreshCw, Settings, SlidersHorizontal, X } from '@lucide/vue';
import { ALL_CAPABILITIES } from '../backend/contract';
import ProviderLogo from './ProviderLogo.vue';
import { locale, localeNames, t, type Locale, type MessageKey } from '../i18n';
import { addedFolders, compactRows, dataSource, preferredProfile, reducedMotion, systemReducedMotion, type DataSource } from '../state/prefs';
import type { LauncherProfile } from '../backend/launcher/transport';
import { useSession } from '../state/session';
import { connectErrorHint, connectErrorTitle, packProviderNames } from '../ui/labels';
import awakeLogo from '../assets/brand/awake.png';
import pkg from '../../package.json';

const emit = defineEmits<{ close: [] }>();
const session = useSession();
const { state } = session;

type Tab = 'general' | 'connection' | 'about';
const tabs: { id: Tab; label: MessageKey; icon: Component }[] = [
  { id: 'general', label: 'settingsGeneral', icon: SlidersHorizontal },
  { id: 'connection', label: 'settingsConnection', icon: Plug },
  { id: 'about', label: 'settingsAbout', icon: Info },
];
const tab = ref<Tab>('general');

/* Language picker: a listbox like the Launcher's, so native names render in the app font. */
const languages = Object.entries(localeNames) as [Locale, string][];
const languageOpen = ref(false);
const activeIndex = ref(0);
const picker = ref<HTMLElement | null>(null);
const options = ref<HTMLElement[]>([]);
function openLanguages() {
  languageOpen.value = true;
  activeIndex.value = Math.max(0, languages.findIndex(([code]) => code === locale.value));
  void nextTick(() => options.value[activeIndex.value]?.focus());
}
function chooseLanguage(code: Locale) {
  locale.value = code;
  languageOpen.value = false;
}
function languageKeydown(e: KeyboardEvent) {
  if (!languageOpen.value) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeIndex.value = (activeIndex.value + (e.key === 'ArrowDown' ? 1 : languages.length - 1)) % languages.length;
    options.value[activeIndex.value]?.focus();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    languageOpen.value = false;
  }
}
const outside = (e: MouseEvent) => { if (picker.value && !picker.value.contains(e.target as Node)) languageOpen.value = false; };
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !languageOpen.value) emit('close'); };
onMounted(() => { document.addEventListener('mousedown', outside); document.addEventListener('keydown', onKey); });
onBeforeUnmount(() => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', onKey); });

/* Connection facts */
const hs = computed(() => state.handshake);
const isMock = session.backend.kind === 'mock';
const statusText = computed(() => {
  if (state.connectError?.code === 'unsupported') return t('connUnsupported');
  if (state.waitingForLauncher) return t('launcherNotRunning');
  if (state.reconnecting) return t('connReconnecting');
  if (state.connection === 'connecting') return t('connConnecting');
  if (state.connection === 'connected') return isMock ? t('connMock') : t('connConnected');
  return state.connectError ? t('connFailed') : t('connDisconnected');
});
const statusTone = computed(() => (state.connection === 'connected' ? (isMock ? 'warn' : 'ok') : state.connection === 'connecting' || state.reconnecting ? 'info' : 'error'));
const supported = computed(() => hs.value?.capabilities.length ?? 0);
const reasonText = (reason?: string) => (reason === 'curseforge-unauthorized' ? t('curseforgeUnauthorized') : reason === 'launcher-read-only' ? t('launcherReadOnly') : reason ?? t('unavailable'));

/* Data source and Launcher profiles */
const sources: { id: DataSource; label: MessageKey; hint: MessageKey }[] = [
  { id: 'auto', label: 'dsAuto', hint: 'dsAutoHint' },
  { id: 'launcher', label: 'dsLauncher', hint: 'dsLauncherHint' },
  { id: 'demo', label: 'dsDemo', hint: 'dsDemoHint' },
];
function chooseSource(id: DataSource) {
  if (id === dataSource.value) return;
  dataSource.value = id;
  location.reload(); // the backend is chosen once at startup, so switching restarts the app
}
const profiles = ref<LauncherProfile[]>(session.backend.launcherProfiles?.() ?? []);
const refreshProfiles = () => { profiles.value = session.backend.launcherProfiles?.() ?? []; };
const sourceKey: Record<LauncherProfile['source'], MessageKey> = { registry: 'sourceRegistry', environment: 'sourceEnvironment', default: 'sourceDefault', added: 'sourceAdded' };
const newFolder = ref('');
async function reconnect() { await session.connect(); refreshProfiles(); }
async function useProfile(p: LauncherProfile) {
  preferredProfile.value = p.dataRoot;
  session.backend.setPreferredProfile?.(p.dataRoot);
  await reconnect();
}
async function addFolder() {
  const folder = newFolder.value.trim();
  if (!folder || addedFolders.value.includes(folder)) return;
  addedFolders.value = [...addedFolders.value, folder];
  session.backend.setAddedFolders?.(addedFolders.value);
  newFolder.value = '';
  await reconnect();
}
async function removeFolder(folder: string) {
  addedFolders.value = addedFolders.value.filter((f) => f !== folder);
  session.backend.setAddedFolders?.(addedFolders.value);
  await reconnect();
}
</script>

<template>
  <div class="dialog-overlay" @mousedown.self="emit('close')">
    <section class="settings glass" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header class="settings-header">
        <div class="title"><Settings :size="20" /><h2 id="settings-title">{{ t('settings') }}</h2></div>
        <button class="icon-btn" type="button" :aria-label="t('close')" @click="emit('close')"><X :size="18" /></button>
      </header>

      <div class="layout">
        <nav class="tabs" role="tablist" :aria-label="t('settings')">
          <button
            v-for="item in tabs" :key="item.id" type="button" role="tab" class="tab" :class="{ active: tab === item.id }"
            :aria-selected="tab === item.id" @click="tab = item.id"
          ><component :is="item.icon" :size="16" />{{ t(item.label) }}</button>
        </nav>

        <div class="pane">
          <!-- General -->
          <Transition name="swap" mode="out-in">
          <div v-if="tab === 'general'" key="general" class="group" role="tabpanel">
            <div class="row">
              <div class="copy">
                <label id="settings-lang-label" for="settings-lang">{{ t('language') }}</label>
                <span class="hint">{{ t('languageHint') }}</span>
              </div>
              <div ref="picker" class="picker" @keydown="languageKeydown">
                <button
                  id="settings-lang" type="button" class="picker-trigger" aria-haspopup="listbox" aria-controls="settings-lang-list"
                  :aria-expanded="languageOpen" @click="languageOpen ? (languageOpen = false) : openLanguages()"
                >
                  <span>{{ localeNames[locale] }}</span>
                  <ChevronDown :size="16" class="chevron" :class="{ open: languageOpen }" />
                </button>
                <Transition name="menu"><div v-show="languageOpen" id="settings-lang-list" class="picker-menu" role="listbox" aria-labelledby="settings-lang-label">
                  <button
                    v-for="([code, name], i) in languages" :key="code" ref="options" type="button" tabindex="-1" role="option"
                    class="picker-option" :class="{ active: activeIndex === i }" :aria-selected="locale === code"
                    @focus="activeIndex = i" @click="chooseLanguage(code)"
                  ><span>{{ name }}</span><Check v-if="locale === code" :size="16" class="tick" /></button>
                </div></Transition>
              </div>
            </div>

            <div class="row">
              <div class="copy">
                <label for="settings-motion">{{ t('reducedMotion') }}</label>
                <span class="hint">{{ t('reducedMotionHint') }}</span>
                <span v-if="systemReducedMotion" class="hint note">{{ t('systemMotionOn') }}</span>
              </div>
              <input id="settings-motion" v-model="reducedMotion" type="checkbox" role="switch" class="switch" />
            </div>

            <div class="row">
              <div class="copy">
                <label for="settings-compact">{{ t('compactRows') }}</label>
                <span class="hint">{{ t('compactRowsHint') }}</span>
              </div>
              <input id="settings-compact" v-model="compactRows" type="checkbox" role="switch" class="switch" />
            </div>
          </div>

          <!-- Launcher connection -->
          <div v-else-if="tab === 'connection'" key="connection" class="group" role="tabpanel">
            <div class="status-card" :class="statusTone">
              <span class="dot"></span>
              <div class="grow">
                <strong>{{ statusText }}</strong>
                <span class="hint">{{ isMock ? t('connMockHint') : t('connectionHint') }}</span>
              </div>
              <button class="btn btn-small" type="button" :disabled="state.connection === 'connecting'" @click="reconnect()"><RefreshCw :size="14" />{{ t('reconnect') }}</button>
            </div>
            <p v-if="state.connectError" class="hint error-text">{{ t(connectErrorTitle(state.connectError.code)) }}. {{ t(connectErrorHint(state.connectError.code)) }}</p>

            <h3>{{ t('dataSourceLabel') }}</h3>
            <div class="sources" role="radiogroup" :aria-label="t('dataSourceLabel')">
              <label v-for="s in sources" :key="s.id" class="source" :class="{ active: dataSource === s.id }">
                <input type="radio" name="data-source" :checked="dataSource === s.id" @change="chooseSource(s.id)" />
                <span><strong>{{ t(s.label) }}</strong><span class="hint">{{ t(s.hint) }}</span></span>
              </label>
            </div>
            <p class="hint">{{ t('dataSourceHint') }}</p>

            <template v-if="session.backend.kind === 'launcher'">
              <h3>{{ t('profilesLabel') }}</h3>
              <ul class="profiles">
                <li v-for="p in profiles.filter((x) => x.exists || x.source === 'added')" :key="p.dataRoot" :class="{ active: state.installationId === p.dataRoot }">
                  <span class="dot" :class="p.endpoint ? 'on' : ''"></span>
                  <span class="grow profile-copy">
                    <span class="path" :title="p.dataRoot">{{ p.dataRoot }}</span>
                    <span class="hint">{{ t(sourceKey[p.source]) }} · {{ p.endpoint ? t('profileRunning') : p.exists ? t('profileNotRunning') : t('profileMissing') }}<template v-if="p.drive === 'removable' || p.drive === 'remote'"> · {{ t('profileUnsupported') }}</template></span>
                  </span>
                  <span v-if="state.installationId === p.dataRoot && state.connection === 'connected'" class="badge ok">{{ t('profileSelected') }}</span>
                  <button v-else-if="p.exists" class="btn btn-small" type="button" @click="useProfile(p)">{{ t('profileUse') }}</button>
                  <button v-if="p.source === 'added'" class="icon-btn" type="button" :aria-label="t('removeFolder')" :title="t('removeFolder')" @click="removeFolder(p.installDir ?? p.dataRoot)"><X :size="14" /></button>
                </li>
              </ul>
              <form class="add-folder" @submit.prevent="addFolder">
                <label class="field grow"><span>{{ t('addFolderLabel') }}</span><input v-model="newFolder" class="input" placeholder="C:\Games\AwakeLauncher" /></label>
                <button class="btn" type="submit" :disabled="!newFolder.trim()">{{ t('addFolder') }}</button>
              </form>
              <p class="hint">{{ t('addFolderHint') }}</p>
            </template>

            <dl class="facts">
              <div><dt>{{ t('connBackend') }}</dt><dd>{{ isMock ? t('backendMock') : t('backendLauncher') }}</dd></div>
              <div v-if="hs && !isMock"><dt>{{ t('launcherExecutable') }}</dt><dd class="path" :title="hs.launcherVersion">{{ hs.launcherVersion }}</dd></div>
              <div v-if="hs && !isMock"><dt>{{ t('contractVersion') }}</dt><dd>{{ t('contractPinned', { version: hs.contract }) }}</dd></div>
              <div v-if="state.installations[0]"><dt>{{ t('libraryInstallation') }}</dt><dd class="path" :title="state.installations[0].path">{{ state.installations[0].path }}</dd></div>
              <div v-if="hs"><dt>{{ t('capabilitiesLabel') }}</dt><dd>{{ t('capabilitiesCount', { count: supported, total: ALL_CAPABILITIES.length }) }}</dd></div>
            </dl>

            <template v-if="hs">
              <h3>{{ t('modProviders') }}</h3>
              <ul class="providers">
                <li v-for="p in hs.providers" :key="p.id">
                  <ProviderLogo :provider="p.id" :size="20" label />
                  <span v-if="p.available" class="badge ok"><CircleCheck :size="13" />{{ t('available') }}</span>
                  <span v-else class="badge" :title="reasonText(p.unavailableReason)"><CircleMinus :size="13" />{{ t('unavailable') }}</span>
                </li>
              </ul>
              <h3>{{ t('packProviders') }}</h3>
              <ul class="providers">
                <li v-for="p in hs.packProviders" :key="p.id">
                  <ProviderLogo :provider="p.id" :size="20" /><span class="grow">{{ packProviderNames[p.id] }}</span>
                  <span v-if="p.available" class="badge ok"><CircleCheck :size="13" />{{ t('available') }}</span>
                  <span v-else class="badge" :title="reasonText(p.unavailableReason)"><CircleMinus :size="13" />{{ t('unavailable') }}</span>
                </li>
              </ul>
              <p v-if="hs.packProviders.some((p) => p.unavailableReason === 'curseforge-unauthorized')" class="hint">{{ t('curseforgeUnauthorized') }}</p>
            </template>
          </div>

          <!-- About -->
          <div v-else key="about" class="group about" role="tabpanel">
            <div class="brand">
              <img :src="awakeLogo" alt="" width="72" height="72" />
              <div>
                <h3>Awake Modpack Manager</h3>
                <p class="version">{{ t('aboutVersion', { version: pkg.version }) }}</p>
              </div>
            </div>
            <p class="tagline">{{ t('aboutTagline') }}</p>
            <h4>{{ t('aboutOpenSource') }}</h4>
            <ul class="credits">
              <li><span>Vue</span><span class="hint">MIT</span></li>
              <li><span>Lucide icons</span><span class="hint">ISC</span></li>
              <li><span>K2D font</span><span class="hint">SIL OFL 1.1</span></li>
              <li><span>Awake logo</span><span class="hint">CC BY-SA 4.0</span></li>
            </ul>
            <p class="hint">{{ t('aboutTrademarks') }}</p>
          </div>
          </Transition>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings { width: min(760px, calc(100vw - 32px)); height: min(540px, calc(100vh - 48px)); display: flex; flex-direction: column; overflow: hidden; background: var(--glass-menu); box-shadow: 0 28px 70px rgba(0, 0, 0, 0.55), var(--glass-highlight); }
.settings-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 14px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.025); }
.title { display: flex; align-items: center; gap: 10px; color: #60a5fa; }
.title h2 { font-size: 1.15rem; color: var(--text); }
.layout { display: flex; flex: 1; min-height: 0; }
.tabs { width: 210px; flex-shrink: 0; padding: 14px 10px; border-right: 1px solid rgba(255, 255, 255, 0.1); display: flex; flex-direction: column; gap: 4px; background: rgba(8, 16, 29, 0.32); }
.tab { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; border: none; background: transparent; color: var(--text-secondary); font-size: 0.92rem; text-align: left; cursor: pointer; transition: background-color var(--duration-fast) var(--ease), color var(--duration-fast) var(--ease); }
.tab:hover { background: rgba(255, 255, 255, 0.06); color: var(--text); }
.tab.active { background: rgba(96, 165, 250, 0.15); color: #60a5fa; font-weight: 600; }
.pane { flex: 1; min-width: 0; padding: 8px 24px 20px; overflow-y: auto; }
.group { display: flex; flex-direction: column; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
.copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.copy label { font-size: 0.95rem; font-weight: 500; color: var(--text); }
.hint { font-size: 0.84rem; color: var(--text-secondary); }
.note { color: #93c5fd; }

/* Language picker */
.picker { position: relative; width: min(220px, 48%); flex-shrink: 0; }
.picker-trigger { display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; padding: 8px 12px; border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 9px; background: rgba(14, 26, 46, 0.58); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 4px 12px rgba(0, 0, 0, 0.2); color: var(--text); text-align: left; cursor: pointer; transition: border-color var(--duration-fast) ease, background var(--duration-fast) ease; }
.picker-trigger:hover, .picker-trigger[aria-expanded='true'] { border-color: rgba(125, 211, 252, 0.55); background: rgba(20, 38, 66, 0.72); }
.chevron { color: #93c5fd; transition: transform 160ms ease; }
.chevron.open { transform: rotate(180deg); }
.picker-menu { position: absolute; z-index: 20; top: calc(100% + 6px); left: 0; right: 0; padding: 4px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(10, 19, 34, 0.97); box-shadow: 0 16px 34px rgba(0, 0, 0, 0.45); display: flex; flex-direction: column; gap: 2px; }
.picker-option { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border: none; border-radius: 7px; background: transparent; color: var(--text-secondary); text-align: left; cursor: pointer; }
.picker-option.active, .picker-option:hover { background: rgba(96, 165, 250, 0.14); color: var(--text); }
.picker-option[aria-selected='true'] { color: #fff; font-weight: 600; }
.tick { color: #60a5fa; }

/* Toggle switch built on a native checkbox (keeps keyboard + screen reader behaviour). */
.switch { appearance: none; width: 42px !important; height: 24px !important; flex-shrink: 0; border-radius: 999px; background: rgba(255, 255, 255, 0.14); border: 1px solid rgba(255, 255, 255, 0.18); position: relative; cursor: pointer; transition: background-color var(--duration-fast) var(--ease); }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #e2e8f0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); transition: transform var(--duration-fast) var(--ease); }
.switch:checked { background: var(--accent); border-color: transparent; }
.switch:checked::after { transform: translateX(18px); background: #fff; }

/* Connection */
.status-card { display: flex; align-items: center; gap: 12px; margin-top: 16px; padding: 14px 16px; border-radius: var(--radius-medium); border: 1px solid var(--border); background: rgba(255, 255, 255, 0.03); }
.status-card .dot { width: 10px; height: 10px; }
.status-card.ok { color: #6ee7b7; }
.status-card.warn { color: #fcd34d; }
.status-card.info { color: #93c5fd; }
.status-card.error { color: #fca5a5; }
.status-card strong { color: var(--text); display: block; }
.grow { flex: 1; min-width: 0; }
.facts { margin: 12px 0 0; display: flex; flex-direction: column; }
.facts > div { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); font-size: 0.92rem; }
.facts dt { color: var(--text-secondary); }
.facts dd { margin: 0; text-align: right; min-width: 0; }
.path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
.group h3 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-muted); margin: 18px 0 8px; }
.providers { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px; }
.providers li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.035); font-size: 0.92rem; }
.providers li > :first-child { flex: 0 1 auto; }

.sources { display: flex; flex-direction: column; gap: 6px; }
.source { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: var(--radius-control); border: 1px solid var(--border-subtle); background: rgba(255, 255, 255, 0.03); cursor: pointer; }
.source.active { border-color: rgba(96, 165, 250, 0.55); background: rgba(59, 130, 246, 0.1); }
.source > span { display: flex; flex-direction: column; gap: 2px; }
.profiles { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.profiles li { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.035); }
.profiles li.active { box-shadow: inset 3px 0 0 #3b82f6; }
.profiles .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
.profiles .dot.on { background: var(--ok); box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
.profile-copy { display: flex; flex-direction: column; min-width: 0; }
.profile-copy .path { max-width: 100%; text-align: left; }
.add-folder { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
.error-text { color: #fca5a5; margin-top: 8px; }

/* About */
.about { gap: 14px; padding-top: 16px; }
.brand { display: flex; align-items: center; gap: 16px; }
.brand img { border-radius: 16px; filter: drop-shadow(0 6px 18px rgba(37, 99, 235, 0.4)); }
.brand h3 { font-size: 1.3rem; text-transform: none; letter-spacing: 0; color: var(--text); margin: 0; }
.version { color: var(--text-secondary); font-size: 0.9rem; }
.tagline { color: var(--text-secondary); line-height: 1.55; }
.about h4 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-muted); margin: 6px 0 0; font-weight: 600; }
.credits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.credits li { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06); font-size: 0.92rem; }

@media (max-width: 640px) {
  .layout { flex-direction: column; }
  .tabs { width: auto; flex-direction: row; border-right: none; border-bottom: 1px solid rgba(255, 255, 255, 0.1); overflow-x: auto; }
  .picker { width: 100%; }
  .row { flex-wrap: wrap; }
}
</style>
