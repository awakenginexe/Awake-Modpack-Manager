<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DraftChange, OptionalSuggestion, PlanAction, PlanItem } from '../backend/contract';
import { addChange, isStale, rebase, removeChange } from '../domain/draft';
import { t, type MessageKey } from '../i18n';
import { useSession } from '../state/session';
import { opStateKey, opStateTone, planActionKey } from '../ui/labels';
import type { ViewId } from '../App.vue';

const emit = defineEmits<{ navigate: [ViewId] }>();
const session = useSession();
const { review, inventory } = session;
const acknowledged = ref(false);
const confirmDiscard = ref(false);

const draft = computed(() => session.draft.value);
const changes = computed(() => draft.value?.changes ?? []);
const modName = computed(() => new Map((inventory.value?.mods ?? []).map((m) => [m.key, m.name])));
const stale = computed(() => review.phase === 'stale' || (!!draft.value && !!inventory.value && changes.value.length > 0 && isStale(draft.value, inventory.value.revision)));
const plan = computed(() => review.plan);
const groups = computed(() => {
  const order: PlanAction[] = ['install', 'update', 'remove', 'enable', 'disable'];
  return order.map((action) => ({ action, items: (plan.value?.items ?? []).filter((i) => i.action === action) })).filter((g) => g.items.length);
});
const destructive = computed(() => (plan.value?.items ?? []).filter((i) => i.destructive || i.action === 'remove'));
const busy = computed(() => ['resolving', 'preparing', 'applying', 'unconfirmed'].includes(review.phase));
const canApply = computed(() =>
  review.phase === 'reviewed' && !!plan.value && !plan.value.blocked && !session.planOutdated.value
  && plan.value.items.length > 0 && (!destructive.value.length || acknowledged.value)
  && session.can('plan.apply'));

// A different plan needs a fresh acknowledgement.
watch(() => plan.value?.planHash, () => { acknowledged.value = false; });

const changeLabel: Record<DraftChange['kind'], MessageKey> = { install: 'pendingInstall', update: 'pendingUpdate', remove: 'pendingRemove', enable: 'pendingEnable', disable: 'pendingDisable' };
const nameOf = (c: DraftChange) => (c.kind === 'install' ? c.name : modName.value.get(c.modKey) ?? c.modKey);
const severityKey = { error: 'issueError', warning: 'issueWarning', info: 'issueInfo' } as const;
const severityTone = { error: 'error', warning: 'warn', info: 'info' } as const;

function undo(c: DraftChange) { if (draft.value) session.setDraft(removeChange(draft.value, c)); }
function addOptional(o: OptionalSuggestion) {
  if (draft.value) session.setDraft(addChange(draft.value, { kind: 'install', provider: o.provider, projectId: o.projectId, name: o.name }));
}
function refreshDraft() {
  if (!draft.value || !inventory.value) return;
  session.setDraft(rebase(draft.value, inventory.value.revision, inventory.value.mods).draft);
  session.resetReview();
}
function discard() { session.discardDraft(); confirmDiscard.value = false; }
function reasonText(i: PlanItem) {
  if (i.reason === 'required-dependency') return t('reasonRequired', { names: (i.requiredBy ?? []).join(', ') });
  if (i.reason === 'optional-dependency') return t('reasonOptional', { names: (i.requiredBy ?? []).join(', ') });
  return '';
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('reviewTitle') }}</h1>
        <p>{{ t('reviewSubtitle') }}</p>
      </div>
      <div v-if="changes.length" class="toolbar">
        <template v-if="confirmDiscard">
          <span>{{ t('discardConfirm', { count: changes.length }) }}</span>
          <button class="btn btn-small btn-danger" type="button" @click="discard">{{ t('discardDraft') }}</button>
          <button class="btn btn-small" type="button" @click="confirmDiscard = false">{{ t('cancel') }}</button>
        </template>
        <button v-else class="btn" type="button" :disabled="busy" @click="confirmDiscard = true">{{ t('discardDraft') }}</button>
      </div>
    </header>

    <div v-if="review.phase === 'done'" class="notice" role="status">
      <strong>{{ t('applyDone') }}</strong>
      <button class="btn btn-small" type="button" style="margin-left: auto" @click="session.resetReview(); emit('navigate', 'mods')">{{ t('navMods') }}</button>
    </div>

    <div v-if="!changes.length && review.phase !== 'done' && review.phase !== 'applying'" class="empty glass">
      <h2>{{ t('reviewEmpty') }}</h2>
      <p>{{ t('reviewEmptyHint') }}</p>
      <div class="toolbar">
        <button class="btn" type="button" @click="emit('navigate', 'mods')">{{ t('navMods') }}</button>
        <button class="btn" type="button" @click="emit('navigate', 'browse')">{{ t('navBrowse') }}</button>
      </div>
    </div>

    <div v-else class="columns">
      <section class="panel glass draft-panel" :aria-label="t('draftList')">
        <h2>{{ t('draftList') }} <span class="badge">{{ changes.length }}</span></h2>
        <div v-if="stale" class="notice warn" role="alert">
          <span>{{ review.phase === 'stale' ? t('planStale') : t('staleDraft') }}</span>
          <button class="btn btn-small" type="button" @click="refreshDraft">{{ t('staleDraftAction') }}</button>
        </div>
        <ul class="list">
          <li v-for="(c, i) in changes" :key="i">
            <span class="badge" :class="c.kind === 'remove' ? 'error' : 'info'">{{ t(changeLabel[c.kind]) }}</span>
            <span class="grow">{{ nameOf(c) }}</span>
            <button class="btn btn-small" type="button" :disabled="busy" @click="undo(c)">{{ t('undoChange') }}</button>
          </li>
        </ul>
        <button class="btn btn-primary" type="button" :disabled="busy || stale || !changes.length || !session.can('plan.validate')" @click="session.validate()">
          {{ review.phase === 'resolving' ? t('resolving') : t('resolve') }}
        </button>
        <p v-if="!session.can('plan.validate')" class="muted">{{ t('capabilityMissing') }}</p>
      </section>

      <section class="panel glass plan-panel" :aria-label="t('planTitle')" aria-live="polite">
        <h2>{{ t('planTitle') }}</h2>
        <p v-if="!plan && review.phase !== 'failed'" class="muted">{{ t('planNeedsCheck') }}</p>
        <div v-if="session.planOutdated.value" class="notice warn" role="alert">{{ t('planNeedsCheck') }}</div>
        <div v-if="review.phase === 'changed'" class="notice warn" role="alert">
          <span>{{ t('planChanged') }}</span>
          <button class="btn btn-small" type="button" @click="session.acceptChangedPlan()">{{ t('reviewChanges') }}</button>
        </div>

        <template v-if="plan">
          <p v-if="!plan.items.length" class="muted">{{ t('nothingToApply') }}</p>
          <div v-for="g in groups" :key="g.action" class="group">
            <h3>{{ t(planActionKey[g.action]) }} <span class="badge">{{ g.items.length }}</span></h3>
            <ul class="list">
              <li v-for="item in g.items" :key="item.modKey">
                <span class="grow">
                  <strong>{{ item.name }}</strong>
                  <span v-if="item.reason !== 'requested'" class="muted small"> · {{ reasonText(item) }}</span>
                </span>
                <span class="versions">
                  <template v-if="item.action === 'update'">{{ item.from?.name ?? t('noVersion') }} → {{ item.to?.name }}</template>
                  <template v-else-if="item.action === 'install'">{{ item.to?.name }}</template>
                  <template v-else>{{ item.from?.name ?? t('noVersion') }}</template>
                </span>
                <span v-if="item.destructive" class="badge warn">{{ t('destructiveTitle') }}</span>
              </li>
            </ul>
          </div>

          <div v-if="plan.issues.length" class="group">
            <h3>{{ t('issues') }}</h3>
            <ul class="list">
              <li v-for="(issue, i) in plan.issues" :key="i">
                <span class="badge" :class="severityTone[issue.severity]">{{ t(severityKey[issue.severity]) }}</span>
                <span class="grow">{{ issue.message }}</span>
              </li>
            </ul>
          </div>

          <div v-if="plan.optional.length" class="group">
            <h3>{{ t('optionalTitle') }}</h3>
            <p class="muted small">{{ t('optionalHint') }}</p>
            <ul class="list">
              <li v-for="o in plan.optional" :key="o.projectId">
                <span class="grow"><strong>{{ o.name }}</strong> <span class="muted small">· {{ t('reasonOptional', { names: o.suggestedBy.join(', ') }) }}</span></span>
                <button class="btn btn-small" type="button" :disabled="busy" @click="addOptional(o)">{{ t('addOptional') }}</button>
              </li>
            </ul>
          </div>

          <p v-if="plan.blocked" class="notice error" role="alert">{{ t('blockedPlan') }}</p>
          <label v-if="destructive.length && !plan.blocked" class="notice warn check">
            <input v-model="acknowledged" type="checkbox" />
            <span><strong>{{ t('destructiveTitle') }}</strong> — {{ t('destructiveConfirm') }}</span>
          </label>
        </template>

        <div v-if="review.operation" class="operation">
          <div class="op-head">
            <span class="badge" :class="opStateTone[review.operation.state]">{{ t(opStateKey[review.operation.state]) }}</span>
          </div>
          <div class="progress"><span :style="{ width: `${Math.round((review.operation.progress ?? 0) * 100)}%` }"></span></div>
          <p v-if="review.operation.error" class="small">{{ review.operation.error.message }}</p>
          <p v-if="review.operation.recovery" class="small">{{ review.operation.recovery.message }}</p>
        </div>

        <p v-if="review.phase === 'applying' && !review.operation" class="muted" role="status">{{ t('applyAccepted') }}</p>
        <p v-if="review.phase === 'unconfirmed'" class="notice warn" role="status">{{ t('applyLostReply') }}</p>
        <p v-if="review.phase === 'not-received'" class="notice warn" role="alert">{{ t('applyNotReceived') }}</p>
        <div v-if="review.phase === 'failed'" class="notice error" role="alert">
          <div>
            <strong>{{ t('applyFailed') }}</strong>
            <details v-if="review.error"><summary>{{ t('technicalDetails') }}</summary><code>{{ review.error.code }}: {{ review.error.message }}</code></details>
          </div>
        </div>

        <div class="apply-row">
          <button class="btn btn-primary" type="button" :disabled="!canApply" @click="session.apply()">
            {{ review.phase === 'preparing' ? t('preparing') : t('apply', { count: plan?.items.length ?? 0 }) }}
          </button>
          <span v-if="!session.can('plan.apply')" class="muted small">{{ t('capabilityMissing') }}</span>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; }
.columns { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(0, 2fr); gap: var(--space-4); align-items: start; }
.panel { display: flex; flex-direction: column; gap: var(--space-3); border-radius: var(--radius-medium); }
.panel h2 { font-size: 1.05rem; display: flex; align-items: center; gap: var(--space-2); }
.group h3 { font-size: 0.9rem; color: var(--text-secondary); display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 360px; overflow-y: auto; }
.list li { display: flex; align-items: center; gap: var(--space-2); padding: 6px 8px; border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.025); font-size: 0.88rem; }
.grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.small { font-size: 0.8rem; }
.versions { font-variant-numeric: tabular-nums; color: var(--text-secondary); font-size: 0.82rem; white-space: nowrap; }
.operation { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.03); }
.op-head { display: flex; gap: var(--space-2); align-items: center; }
.apply-row { display: flex; align-items: center; gap: var(--space-3); }
@media (max-width: 1000px) { .columns { grid-template-columns: 1fr; } }
</style>
