<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CircleAlert, Link2, Loader } from '@lucide/vue';
import type { ProjectVersion, ProviderId } from '../backend/contract';
import { t } from '../i18n';
import { asError, useSession } from '../state/session';
import { formatBytes } from '../ui/labels';

/** Choose an exact provider version of one project, compatible with the selected instance. */
const props = defineProps<{ instanceId: string; provider: ProviderId; projectId: string; name: string; current?: string }>();
const emit = defineEmits<{ pick: [ProjectVersion]; close: [] }>();
const session = useSession();
const versions = ref<ProjectVersion[]>([]);
const loading = ref(true);
const error = ref('');
const chosen = ref<string>('');
const selected = computed(() => versions.value.find((v) => v.id === chosen.value));

onMounted(async () => {
  try {
    versions.value = await session.backend.projectVersions!(props.instanceId, props.provider, props.projectId);
    chosen.value = versions.value.find((v) => v.id !== props.current && v.releaseType === 'release')?.id ?? versions.value[0]?.id ?? '';
  } catch (e) {
    error.value = asError(e).message;
  } finally {
    loading.value = false;
  }
});
const required = (v: ProjectVersion) => v.dependencies.filter((d) => d.type === 'required').length;
</script>

<template>
  <div class="dialog-overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <form class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="vp-title" @submit.prevent="selected && emit('pick', selected)">
      <header><h2 id="vp-title">{{ t('chooseVersionTitle', { name }) }}</h2><p class="muted small">{{ t('chooseVersionHint') }}</p></header>
      <div class="dialog-body">
        <p v-if="loading" class="muted"><Loader :size="16" class="spin" /> {{ t('packLoadingVersions') }}</p>
        <p v-else-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ error }}</p>
        <p v-else-if="!versions.length" class="muted">{{ t('noCompatibleVersions') }}</p>
        <div v-else class="version-list" role="radiogroup" :aria-label="t('chooseVersionTitle', { name })">
          <label v-for="v in versions" :key="v.id" class="version" :class="{ active: v.id === chosen }">
            <input v-model="chosen" type="radio" name="version" :value="v.id" />
            <span class="grow">
              <strong>{{ v.versionNumber }}</strong>
              <span v-if="v.releaseType && v.releaseType !== 'release'" class="badge warn">{{ t(v.releaseType) }}</span>
              <span v-if="v.id === current" class="badge info">{{ t('installedNow') }}</span>
              <span class="muted small block">{{ v.gameVersions.slice(0, 4).join(', ') }}<template v-if="v.sizeBytes"> · {{ formatBytes(v.sizeBytes) }}</template></span>
            </span>
            <span v-if="required(v)" class="muted small" :title="t('requiredDepsHint')"><Link2 :size="13" /> {{ t('requiredDeps', { count: required(v) }) }}</span>
          </label>
        </div>
      </div>
      <footer>
        <button class="btn" type="button" @click="emit('close')">{{ t('cancel') }}</button>
        <button class="btn btn-primary" type="submit" :disabled="!selected || selected.id === current">{{ t('useVersion') }}</button>
      </footer>
    </form>
  </div>
</template>

<style scoped>
.version-list { display: grid; gap: 6px; max-height: min(52vh, 460px); overflow: auto; padding-right: 4px; }
.version { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border, rgba(255, 255, 255, 0.08)); cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.version:hover { background: rgba(255, 255, 255, 0.03); }
.version.active { border-color: var(--accent, #3b82f6); background: rgba(59, 130, 246, 0.08); }
.version .badge { margin-left: 6px; }
.block { display: block; margin-top: 2px; }
.grow { flex: 1; min-width: 0; }
</style>
