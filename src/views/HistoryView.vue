<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { Archive, Ban, CircleAlert, CircleCheck, Download, FolderOpen, History, LifeBuoy, Loader, PackagePlus, RefreshCw, RotateCcw, ShieldCheck, TriangleAlert, Upload, Wrench, X } from '@lucide/vue';
import type { OperationKind, OperationStatus, RecoveryStatus } from '../backend/contract';
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

const kindIcon: Record<OperationKind, Component> = { 'apply-plan': Wrench, 'create-instance': PackagePlus, 'install-pack': Download, export: Upload };
function stateIcon(op: OperationStatus): Component {
  if (!isTerminal(op)) return op.state === 'recovering' ? RotateCcw : Loader;
  return { completed: CircleCheck, cancelled: Ban, rolled_back: RotateCcw, needs_attention: CircleAlert }[op.state as 'completed'] ?? CircleCheck;
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('historyTitle') }}</h1>
        <p>{{ t('historySubtitle') }}</p>
      </div>
      <button class="btn" type="button" @click="refresh"><RefreshCw :size="16" />{{ t('refresh') }}</button>
    </header>
    <div v-if="!session.can('operations.watch')" class="notice warn"><TriangleAlert :size="18" />{{ t('capabilityMissing') }}</div>
    <div v-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ error }}</div>

    <div class="columns">
      <section class="card panel" aria-live="polite">
        <div v-if="!ops.length" class="empty">
          <span class="empty-icon"><History :size="28" /></span>
          <p>{{ t('historyEmpty') }}</p>
        </div>
        <ol class="timeline">
          <li v-for="(op, i) in ops" :key="op.operationId" class="op rise" :class="opStateTone[op.state]" :style="{ '--i': i }">
            <span class="node"><component :is="stateIcon(op)" :size="16" :class="{ spin: !isTerminal(op) }" /></span>
            <div class="op-body">
              <div class="op-head">
                <component :is="kindIcon[op.kind]" :size="16" class="muted" />
                <strong>{{ t(opKindKey[op.kind]) }}</strong>
                <span class="badge" :class="opStateTone[op.state]">{{ t(opStateKey[op.state]) }}</span>
                <span class="muted small grow">{{ formatDate(op.startedAt) }}</span>
                <button
                  v-if="!isTerminal(op) && op.cancellable"
                  class="btn btn-small btn-danger"
                  type="button"
                  :disabled="!session.can('operations.cancel')"
                  @click="cancel(op.operationId)"
                ><X :size="14" />{{ t('cancelOperation') }}</button>
              </div>
              <div v-if="!isTerminal(op)" class="progress"><span :style="{ width: `${Math.round((op.progress ?? 0) * 100)}%` }"></span></div>
              <div v-if="op.error" class="detail error-box">
                <strong>{{ t('errorDetails') }}</strong>
                <p>{{ op.error.message }}</p>
                <details v-if="op.error.detail"><summary class="small">{{ t('technicalDetails') }}</summary><code class="small">{{ op.error.detail }}</code></details>
              </div>
              <p v-if="op.recovery" class="detail recovery small"><LifeBuoy :size="14" />{{ op.recovery.message }}</p>
              <p v-if="op.result?.exportPath" class="small muted path"><FolderOpen :size="14" />{{ op.result.exportPath }}</p>
            </div>
          </li>
        </ol>
      </section>

      <aside class="card panel side">
        <h2 class="panel-title"><LifeBuoy :size="18" />{{ t('recoveryTitle') }}</h2>
        <p v-if="!session.can('recovery.status')" class="muted small">{{ t('capabilityMissing') }}</p>
        <template v-else-if="recovery">
          <p v-if="recovery.pending" class="notice warn small"><TriangleAlert :size="18" />{{ recovery.message ?? t('recoveryPending') }}</p>
          <p v-else class="ok-line small"><ShieldCheck :size="16" />{{ t('recoveryNone') }}</p>
          <h3>{{ t('backups') }}</h3>
          <ul v-if="recovery.backups.length" class="backups">
            <li v-for="b in recovery.backups" :key="b.backupId"><Archive :size="15" class="muted" /><span class="grow">{{ b.label }}</span><span class="muted small">{{ formatDate(b.createdAt) }}</span></li>
          </ul>
          <p v-else class="muted small">{{ t('noBackups') }}</p>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; padding-right: 4px; }
.columns { display: grid; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); gap: var(--space-4); align-items: start; }
.panel { display: flex; flex-direction: column; gap: var(--space-3); }
.side h3 { font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
.timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.op { display: flex; gap: var(--space-3); position: relative; padding-bottom: var(--space-4); }
.op:not(:last-child)::before { content: ''; position: absolute; left: 15px; top: 34px; bottom: 0; width: 2px; background: var(--border-subtle); }
.node { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; background: var(--surface-interactive); color: var(--text-secondary); border: 1px solid var(--control-border); }
.op.ok .node { background: rgba(52, 211, 153, 0.14); color: #6ee7b7; border-color: rgba(52, 211, 153, 0.35); }
.op.info .node { background: var(--accent-subtle); color: #93c5fd; border-color: rgba(96, 165, 250, 0.4); }
.op.warn .node { background: rgba(245, 158, 11, 0.14); color: #fcd34d; border-color: rgba(245, 158, 11, 0.35); }
.op.error .node { background: rgba(239, 68, 68, 0.14); color: #fca5a5; border-color: rgba(239, 68, 68, 0.35); }
.op-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); padding-top: 4px; }
.op-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.detail { padding: var(--space-2) var(--space-3); border-radius: var(--radius-control); font-size: 0.9rem; }
.error-box { background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.25); }
.recovery { display: flex; align-items: center; gap: 6px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); }
.path { display: flex; align-items: center; gap: 6px; word-break: break-all; }
.ok-line { display: flex; align-items: center; gap: 6px; color: #6ee7b7; }
.backups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.backups li { display: flex; align-items: center; gap: var(--space-2); font-size: 0.9rem; }
.spin { animation: spin 1.2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1000px) { .columns { grid-template-columns: 1fr; } }
</style>
