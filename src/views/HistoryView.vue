<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { RecoveryStatus } from '../backend/contract';
import { isTerminal } from '../domain/operation';
import { formatDate, t } from '../i18n';
import { asError, useSession } from '../state/session';
import { opKindKey, opStateKey, opStateTone } from '../ui/labels';

const session = useSession();
const { state } = session;
const recovery = ref<RecoveryStatus | null>(null);
const error = ref('');

const ops = computed(() => state.operations.filter((o) => !o.instanceId || o.instanceId === state.instanceId));

async function refresh() {
  error.value = '';
  await session.refreshOperations();
  if (state.instanceId && session.can('recovery.status')) {
    try { recovery.value = await session.backend.getRecoveryStatus(state.instanceId); } catch (e) { error.value = asError(e).message; }
  }
}
async function cancel(id: string) {
  try { await session.cancelOperation(id); } catch (e) { error.value = asError(e).message; }
}
onMounted(refresh);
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('historyTitle') }}</h1>
        <p>{{ t('historySubtitle') }}</p>
      </div>
      <button class="btn" type="button" @click="refresh">{{ t('retry') }}</button>
    </header>
    <div v-if="!session.can('operations.watch')" class="notice warn">{{ t('capabilityMissing') }}</div>
    <div v-if="error" class="notice error" role="alert">{{ error }}</div>

    <div class="columns">
      <section class="panel glass" aria-live="polite">
        <p v-if="!ops.length" class="muted">{{ t('historyEmpty') }}</p>
        <ul class="ops">
          <li v-for="op in ops" :key="op.operationId" class="op">
            <div class="op-head">
              <strong>{{ t(opKindKey[op.kind]) }}</strong>
              <span class="badge" :class="opStateTone[op.state]">{{ t(opStateKey[op.state]) }}</span>
              <span v-if="!isTerminal(op)" class="badge info">{{ t('live') }}</span>
              <span class="muted small grow">{{ t('startedAt', { time: formatDate(op.startedAt) }) }}</span>
              <button
                v-if="!isTerminal(op) && op.cancellable"
                class="btn btn-small btn-danger"
                type="button"
                :disabled="!session.can('operations.cancel')"
                @click="cancel(op.operationId)"
              >{{ t('cancelOperation') }}</button>
            </div>
            <div v-if="!isTerminal(op)" class="progress"><span :style="{ width: `${Math.round((op.progress ?? 0) * 100)}%` }"></span></div>
            <div v-if="op.error" class="notice error small">
              <div><strong>{{ t('errorDetails') }}</strong><p>{{ op.error.message }}</p>
                <details v-if="op.error.detail"><summary>{{ t('technicalDetails') }}</summary><code>{{ op.error.detail }}</code></details>
              </div>
            </div>
            <p v-if="op.recovery" class="notice warn small">{{ op.recovery.message }}</p>
            <p v-if="op.result?.exportPath" class="small muted">{{ t('exportDone', { path: op.result.exportPath }) }}</p>
          </li>
        </ul>
      </section>

      <aside class="panel glass">
        <h2>{{ t('recoveryTitle') }}</h2>
        <p v-if="!session.can('recovery.status')" class="muted">{{ t('capabilityMissing') }}</p>
        <template v-else-if="recovery">
          <p :class="recovery.pending ? 'notice warn' : 'muted'">{{ recovery.pending ? recovery.message ?? t('recoveryPending') : t('recoveryNone') }}</p>
          <h3>{{ t('backups') }}</h3>
          <ul v-if="recovery.backups.length" class="backups">
            <li v-for="b in recovery.backups" :key="b.backupId"><span>{{ b.label }}</span><span class="muted small">{{ formatDate(b.createdAt) }}</span></li>
          </ul>
          <p v-else class="muted small">{{ t('noBackups') }}</p>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; }
.columns { display: grid; grid-template-columns: minmax(0, 2fr) minmax(240px, 1fr); gap: var(--space-4); align-items: start; }
.panel { border-radius: var(--radius-medium); display: flex; flex-direction: column; gap: var(--space-3); }
.panel h2 { font-size: 1.05rem; }
.panel h3 { font-size: 0.9rem; color: var(--text-secondary); }
.ops, .backups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.op { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.03); }
.op-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.grow { flex: 1; }
.small { font-size: 0.82rem; }
.backups li { display: flex; justify-content: space-between; gap: var(--space-2); font-size: 0.85rem; }
@media (max-width: 1000px) { .columns { grid-template-columns: 1fr; } }
</style>
