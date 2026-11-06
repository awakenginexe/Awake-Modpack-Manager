<script setup lang="ts">
import { computed, ref } from 'vue';
import type { InstanceSummary, LoaderKind } from '../backend/contract';
import { formatNumber, t, type MessageKey } from '../i18n';
import { asError, useSession } from '../state/session';
import { blockedText, loaderLabel, packProviderNames } from '../ui/labels';

const emit = defineEmits<{ manage: []; getPack: [] }>();
const session = useSession();
const { state } = session;
const query = ref('');
const notice = ref('');
const showCreate = ref(false);
const creating = ref(false);
const createError = ref('');
const form = ref({ name: '', minecraftVersion: '1.21.1', loader: 'fabric' as LoaderKind });

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? state.instances.filter((i) => i.name.toLowerCase().includes(q)) : state.instances;
});
const statusKey: Record<InstanceSummary['status'], MessageKey> = { ready: 'statusReady', running: 'statusRunning', busy: 'statusBusy', broken: 'statusBroken' };
const statusTone: Record<InstanceSummary['status'], string> = { ready: 'ok', running: 'info', busy: 'warn', broken: 'error' };

function manage(inst: InstanceSummary) {
  void session.selectInstance(inst.id); // Mods view shows its own loading state
  emit('manage');
}

async function launch(inst: InstanceSummary) {
  try {
    await session.backend.requestLaunch(inst.id);
    notice.value = t('launchRequested', { name: inst.name });
  } catch (e) {
    notice.value = asError(e).message;
  }
}

async function create() {
  if (!form.value.name.trim()) return;
  creating.value = true;
  createError.value = '';
  try {
    const result = await session.createInstance({ ...form.value, name: form.value.name.trim() });
    if (result?.state === 'completed') {
      showCreate.value = false;
      notice.value = t('createDone');
      form.value.name = '';
    } else if (result) createError.value = result.error?.message ?? t('applyFailed');
  } catch (e) {
    createError.value = asError(e).message;
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('libraryTitle') }}</h1>
        <p>{{ t('librarySubtitle') }}</p>
      </div>
      <div class="toolbar">
        <label v-if="state.installations.length > 1" class="field">
          <span>{{ t('libraryInstallation') }}</span>
          <select v-model="state.installationId" class="select" @change="session.refreshInstances()">
            <option v-for="inst in state.installations" :key="inst.id" :value="inst.id">{{ inst.displayName }}</option>
          </select>
        </label>
        <input v-model="query" class="input" type="search" :placeholder="t('librarySearch')" :aria-label="t('librarySearch')" />
        <button class="btn" type="button" @click="emit('getPack')">{{ t('installModpack') }}</button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!session.can('instances.create')"
          :title="session.can('instances.create') ? undefined : t('capabilityMissing')"
          @click="showCreate = true"
        >+ {{ t('createInstance') }}</button>
      </div>
    </header>

    <div v-if="notice" class="notice" role="status">
      <span>{{ notice }}</span>
      <button class="btn btn-small" type="button" style="margin-left: auto" @click="notice = ''">{{ t('dismiss') }}</button>
    </div>
    <div v-if="state.connectError" class="notice error" role="alert">
      <div>
        <strong>{{ state.connectError.code === 'unsupported' ? t('connUnsupported') : t('connFailed') }}</strong>
        <details><summary>{{ t('technicalDetails') }}</summary><code>{{ state.connectError.message }}</code></details>
      </div>
    </div>

    <p v-if="state.instancesLoading && !state.instances.length" class="muted">{{ t('loadingInstances') }}</p>
    <div v-else-if="!shown.length && !state.connectError" class="empty glass">
      <h2>{{ t('libraryEmpty') }}</h2>
      <p>{{ t('libraryEmptyHint') }}</p>
    </div>

    <ul class="grid">
      <li v-for="inst in shown" :key="inst.id" class="card glass" :class="{ selected: inst.id === state.instanceId }">
        <div class="card-top">
          <img v-if="inst.iconUrl" :src="inst.iconUrl" alt="" class="icon" />
          <span v-else class="icon initial" aria-hidden="true">{{ inst.name.slice(0, 1) }}</span>
          <div class="card-copy">
            <h2>{{ inst.name }}</h2>
            <p class="muted">{{ inst.minecraftVersion }} · {{ loaderLabel(inst.loader.kind) }}<template v-if="inst.loader.version"> {{ inst.loader.version }}</template></p>
          </div>
          <span class="badge" :class="statusTone[inst.status]">{{ t(statusKey[inst.status]) }}</span>
        </div>
        <dl class="facts">
          <div><dt class="sr-only">{{ t('navMods') }}</dt><dd>{{ t('instanceMods', { count: formatNumber(inst.modCount) }) }}</dd></div>
          <div v-if="inst.pack"><dt class="sr-only">{{ t('navPacks') }}</dt><dd>{{ t('packLinked', { pack: inst.pack.packName, provider: packProviderNames[inst.pack.provider], version: inst.pack.versionName }) }}</dd></div>
          <div v-if="inst.path" class="path"><dt>{{ t('storageLocation') }}</dt><dd :title="inst.path">{{ inst.path }}</dd></div>
        </dl>
        <p v-if="!inst.manageable" class="blocked">{{ blockedText(inst) }}</p>
        <div class="card-actions">
          <button class="btn btn-primary" type="button" :disabled="!inst.manageable" @click="manage(inst)">
            {{ inst.id === state.instanceId ? t('managing') : t('manage') }}
          </button>
          <button
            class="btn"
            type="button"
            :disabled="!session.can('launch.request')"
            :title="session.can('launch.request') ? undefined : t('capabilityMissing')"
            @click="launch(inst)"
          >{{ t('openInLauncher') }}</button>
        </div>
      </li>
    </ul>

    <Transition name="fade">
      <div v-if="showCreate" class="dialog-overlay" @click.self="showCreate = false" @keydown.esc="showCreate = false">
        <form class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="create-title" @submit.prevent="create">
          <header><h2 id="create-title">{{ t('createTitle') }}</h2></header>
          <div class="dialog-body">
            <p class="muted">{{ t('createHint') }}</p>
            <label class="field"><span>{{ t('createName') }}</span><input v-model="form.name" class="input" required autofocus /></label>
            <label class="field"><span>{{ t('createVersion') }}</span>
              <select v-model="form.minecraftVersion" class="select"><option>1.21.1</option><option>1.20.1</option><option>1.19.2</option><option>1.18.2</option></select>
            </label>
            <label class="field"><span>{{ t('createLoader') }}</span>
              <select v-model="form.loader" class="select">
                <option v-for="l in (['fabric', 'quilt', 'forge', 'neoforge', 'vanilla'] as LoaderKind[])" :key="l" :value="l">{{ loaderLabel(l) }}</option>
              </select>
            </label>
            <p v-if="createError" class="notice error" role="alert">{{ createError }}</p>
          </div>
          <footer>
            <button class="btn" type="button" @click="showCreate = false">{{ t('cancel') }}</button>
            <button class="btn btn-primary" type="submit" :disabled="creating || !form.name.trim()">{{ creating ? t('creating') : t('createSubmit') }}</button>
          </footer>
        </form>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-4); }
.card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); border-radius: var(--radius-medium); }
.card.selected { border-color: rgba(96, 165, 250, 0.5); box-shadow: var(--shadow-medium), inset 0 0 0 1px rgba(96, 165, 250, 0.3); }
.card-top { display: flex; align-items: center; gap: var(--space-3); }
.card-copy { flex: 1; min-width: 0; }
.card-copy h2 { font-size: 1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-copy p { font-size: 0.82rem; }
.icon { width: 44px; height: 44px; border-radius: 10px; flex-shrink: 0; object-fit: cover; }
.initial { display: grid; place-items: center; background: linear-gradient(135deg, #1e3a5f, #0f2744); font-weight: 700; font-size: 1.2rem; }
.facts { margin: 0; display: flex; flex-direction: column; gap: 2px; font-size: 0.85rem; color: var(--text-secondary); }
.facts dd { margin: 0; }
.path { display: flex; gap: var(--space-2); }
.path dt { color: var(--text-muted); }
.path dd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.blocked { font-size: 0.85rem; color: #fcd34d; }
.card-actions { display: flex; gap: var(--space-2); margin-top: auto; flex-wrap: wrap; }
</style>
