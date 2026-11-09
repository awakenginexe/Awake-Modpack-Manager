<script setup lang="ts">
import { computed } from 'vue';
import { CircleAlert, Download, ExternalLink } from '@lucide/vue';
import { formatDate, t } from '../i18n';
import { appUpdate, canSelfUpdate, installAppUpdate, openExternal, workInProgress } from '../state/appUpdate';
import { useSession } from '../state/session';
import { formatBytes } from '../ui/labels';

const session = useSession();
const release = computed(() => appUpdate.info?.latest ?? null);
const percent = computed(() => (appUpdate.progress?.total ? Math.round((appUpdate.progress.done / appUpdate.progress.total) * 100) : 0));
const busyOps = computed(() => workInProgress(session));
</script>

<template>
  <div class="dialog-overlay" @mousedown.self="!appUpdate.installing && (appUpdate.dialogOpen = false)" @keydown.esc="!appUpdate.installing && (appUpdate.dialogOpen = false)">
    <section v-if="release" class="dialog glass update" role="dialog" aria-modal="true" aria-labelledby="update-title">
      <header>
        <h2 id="update-title">{{ t('updateTitle', { version: release.version }) }}</h2>
        <p class="muted small">{{ t('updateCurrent', { version: appUpdate.info!.current }) }}<template v-if="release.publishedAt"> · {{ formatDate(release.publishedAt) }}</template><template v-if="release.installerSize"> · {{ formatBytes(release.installerSize) }}</template></p>
      </header>
      <div class="dialog-body">
        <span v-if="release.prerelease" class="badge warn">{{ t('updatePrerelease') }}</span>
        <pre v-if="release.notes" class="notes">{{ release.notes }}</pre>
        <p v-if="!appUpdate.info!.canInstall" class="notice small">{{ t('updatePortable') }}</p>
        <p v-if="busyOps" class="notice warn small">{{ t('updateBusy') }}</p>
        <div v-if="appUpdate.installing" class="progress-block" role="status">
          <span class="small muted">{{ t('updateDownloading', { percent }) }}</span>
          <div class="progress"><span :style="{ width: `${percent}%` }"></span></div>
        </div>
        <p v-if="appUpdate.installError" class="notice error small" role="alert"><CircleAlert :size="16" />{{ appUpdate.installError }}</p>
      </div>
      <footer>
        <button class="btn" type="button" :disabled="appUpdate.installing" @click="appUpdate.dialogOpen = false">{{ t('updateLater') }}</button>
        <button class="btn" type="button" @click="openExternal(release.url)"><ExternalLink :size="15" />{{ t('updateViewRelease') }}</button>
        <button v-if="canSelfUpdate" class="btn btn-primary" type="button" :disabled="appUpdate.installing || busyOps" @click="installAppUpdate(session.backend)"><Download :size="15" />{{ t('updateInstall') }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.update { width: min(640px, calc(100vw - 32px)); }
.notes { margin: 0; max-height: 300px; overflow: auto; padding: 12px; border-radius: 8px; background: rgba(0, 0, 0, 0.22); border: 1px solid var(--border-subtle); white-space: pre-wrap; font: inherit; font-size: 0.9rem; color: var(--text-secondary); user-select: text; }
.progress-block { display: flex; flex-direction: column; gap: 6px; }
</style>
