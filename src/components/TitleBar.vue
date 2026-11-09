<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ArrowLeft, ArrowRight, ArrowUpCircle, Loader } from '@lucide/vue';
import { isDesktopHost } from '../backend/launcher/transport';
import { t } from '../i18n';
import { appUpdate, updateAvailable, updateNow } from '../state/appUpdate';
import { useSession } from '../state/session';
import awakeLogo from '../assets/brand/modpack-manager.png';
import pkg from '../../package.json';

defineProps<{ canBack: boolean; canForward: boolean; activeOps: number }>();
defineEmits<{ back: []; forward: []; history: [] }>();

const session = useSession();
const desktop = isDesktopHost();
const maximized = ref(false);
const win = computed(() => import('@tauri-apps/api/window').then((m) => m.getCurrentWindow()));
let stop: (() => void) | undefined;
onMounted(async () => {
  if (!desktop) return;
  const w = await win.value;
  const sync = async () => { maximized.value = await w.isMaximized(); };
  await sync();
  stop = await w.onResized(() => void sync());
});
onBeforeUnmount(() => stop?.());
const act = async (f: 'minimize' | 'toggleMaximize' | 'close') => { (await win.value)[f](); };
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <img :src="awakeLogo" alt="" class="logo" width="26" height="26" data-tauri-drag-region />
    <span class="brand" data-tauri-drag-region>AWAKE MODPACK MANAGER <em data-tauri-drag-region>{{ pkg.version }}</em></span>
    <nav class="nav" :aria-label="t('titleNavigation')">
      <button class="tb-btn" type="button" :disabled="!canBack" :title="t('titleBack')" :aria-label="t('titleBack')" @click="$emit('back')"><ArrowLeft :size="16" /></button>
      <button class="tb-btn" type="button" :disabled="!canForward" :title="t('titleForward')" :aria-label="t('titleForward')" @click="$emit('forward')"><ArrowRight :size="16" /></button>
    </nav>
    <div class="spacer" data-tauri-drag-region></div>
    <button v-if="activeOps" class="pill" type="button" :title="t('titleWorking', { count: activeOps })" @click="$emit('history')"><Loader :size="13" class="spin" />{{ activeOps }}</button>
    <button v-if="updateAvailable" class="pill accent" type="button" :title="t('titleUpdate', { version: appUpdate.info!.latest!.version })" @click="updateNow(session)"><ArrowUpCircle :size="14" />{{ t('titleUpdateNow', { version: appUpdate.info!.latest!.version }) }}</button>
    <div v-if="desktop" class="traffic" role="group" :aria-label="t('titleWindow')">
      <button class="light min" type="button" :title="t('titleMinimize')" :aria-label="t('titleMinimize')" @click="act('minimize')"><span>−</span></button>
      <button class="light max" type="button" :title="t(maximized ? 'titleRestore' : 'titleMaximize')" :aria-label="t(maximized ? 'titleRestore' : 'titleMaximize')" @click="act('toggleMaximize')"><span>+</span></button>
      <button class="light close" type="button" :title="t('titleClose')" :aria-label="t('titleClose')" @click="act('close')"><span>×</span></button>
    </div>
  </header>
</template>

<style scoped>
@font-face { font-family: 'Bayon'; src: url('../assets/fonts/Bayon-Regular.ttf') format('truetype'); font-display: swap; }
.titlebar { height: 46px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 14px; }
.logo { filter: drop-shadow(0 2px 8px rgba(37, 99, 235, 0.4)); -webkit-user-drag: none; }
.brand { font-family: 'Bayon', 'K2D', sans-serif; font-size: 22px; line-height: 1; letter-spacing: 0.01em; color: #fff; white-space: nowrap; padding-top: 2px; }
.brand em { font-style: normal; color: #60a5fa; }
.nav { display: flex; gap: 2px; margin-left: 14px; }
.tb-btn { width: 28px; height: 28px; display: grid; place-items: center; border: none; border-radius: 7px; background: transparent; color: var(--text-secondary); }
.tb-btn:hover:not(:disabled) { background: var(--surface-hover); color: var(--text); }
.tb-btn:disabled { opacity: 0.3; }
.spacer { flex: 1; align-self: stretch; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: var(--radius-pill); border: 1px solid var(--control-border); background: var(--surface-interactive); color: var(--text-secondary); font: inherit; font-size: 0.82rem; }
.pill:hover { color: var(--text); background: var(--surface-hover); }
.pill.accent { color: #bfdbfe; border-color: rgba(96, 165, 250, 0.5); background: rgba(59, 130, 246, 0.18); }
.pill.accent:hover { background: rgba(59, 130, 246, 0.3); }
.spin { animation: spin 1.2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.traffic { display: flex; align-items: center; gap: 8px; margin-left: 8px; }
.light { width: 13px; height: 13px; padding: 0; border: none; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; line-height: 1; color: transparent; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18); }
.light span { margin-top: -1px; }
.traffic:hover .light, .light:focus-visible { color: rgba(0, 0, 0, 0.62); }
.min { background: #febc2e; }
.max { background: #28c840; }
.close { background: #ff5f57; }
.light:hover { filter: brightness(1.12); }
</style>
