<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import type { DraftChange, OptionalSuggestion, PlanAction, PlanItem } from '../backend/contract';
import { addChange, isStale, removeChange } from '../domain/draft';
import { t, type MessageKey } from '../i18n';
import { useSession } from '../state/session';
import { toast } from '../ui/desktop';
import { opStateKey, opStateTone, planActionKey, sourceLabel } from '../ui/labels';
import {
  ArrowRight, ArrowUpCircle, Check, CircleAlert, CircleCheck, Download, FileCog, FileArchive, Info, ListChecks, Loader, Pin, Power, PowerOff,
  Sparkles, Trash2, TriangleAlert, Undo2,
} from '@lucide/vue';
import Avatar from '../components/Avatar.vue';
import DependencyConflicts from '../components/DependencyConflicts.vue';
import { mergeResolutions } from '../domain/conflicts';
import type { DependencyResolution } from '../backend/contract';
import VirtualList from '../components/VirtualList.vue';
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
  const order: PlanAction[] = ['install', 'update', 'remove', 'enable', 'disable', 'policy', 'override'];
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

const changeLabel: Record<DraftChange['kind'], MessageKey> = { install: 'pendingInstall', update: 'pendingUpdate', remove: 'pendingRemove', enable: 'pendingEnable', disable: 'pendingDisable', policy: 'pendingPolicy' };
/** An import plan has no draft behind it; it is reviewed as it is. */
const fromImport = computed(() => !!review.origin && !!plan.value);
/** Dependency decisions for the current draft, kept across retries until the draft changes. */
const decisions = ref<DependencyResolution[]>([]);
watch(changes, () => { decisions.value = []; });
const canResolve = computed(() => review.source === 'draft' && !!session.backend.canResolveDependencies?.());
function retryWithDecisions(resolutions: DependencyResolution[]) {
  decisions.value = mergeResolutions(decisions.value, resolutions);
  void session.validate(decisions.value);
}
/** Big groups (imports, bulk plans) are windowed so 10,000 files stay responsive. */
const BIG = 80;
const nameOf = (c: DraftChange) => (c.kind === 'install' ? c.name : modName.value.get(c.modKey) ?? c.modKey);
const severityKey = { error: 'issueError', warning: 'issueWarning', info: 'issueInfo' } as const;
const severityTone = { error: 'error', warning: 'warn', info: 'info' } as const;
const severityIcon = { error: CircleAlert, warning: TriangleAlert, info: Info } as const;
const actionIcon: Record<PlanAction, Component> = { install: Download, update: ArrowUpCircle, remove: Trash2, enable: Power, disable: PowerOff, keep: Check, policy: Pin, override: FileCog };
const changeIcon: Record<DraftChange['kind'], Component> = { install: Download, update: ArrowUpCircle, remove: Trash2, enable: Power, disable: PowerOff, policy: Pin };
/** 0 = draft, 1 = plan checked, 2 = applying/applied. */
const step = computed(() => (['applying', 'unconfirmed', 'done'].includes(review.phase) ? 2 : plan.value && !session.planOutdated.value ? 1 : 0));

function undo(c: DraftChange) { if (draft.value) session.setDraft(removeChange(draft.value, c)); }
function addOptional(o: OptionalSuggestion) {
  if (draft.value) session.setDraft(addChange(draft.value, { kind: 'install', provider: o.provider, projectId: o.projectId, name: o.name }));
}
const refreshDraft = () => void session.rebaseDraft();
async function cleanMissing() {
  const gone = await session.forgetMissingMods();
  if (gone.length) toast(t('cleanMissingDone', { names: gone.join(', ') }), 'ok');
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
        <p>{{ session.instanceSource.value === 'helper' ? t('reviewSubtitleHelper') : t('reviewSubtitle') }}</p>
      </div>
      <div v-if="changes.length" class="toolbar">
        <template v-if="confirmDiscard">
          <span class="small">{{ t('discardConfirm', { count: changes.length }) }}</span>
          <button class="btn btn-small btn-danger" type="button" @click="discard"><Trash2 :size="15" />{{ t('discardDraft') }}</button>
          <button class="btn btn-small" type="button" @click="confirmDiscard = false">{{ t('cancel') }}</button>
        </template>
        <button v-else class="btn btn-ghost" type="button" :disabled="busy" @click="confirmDiscard = true"><Trash2 :size="16" />{{ t('discardDraft') }}</button>
      </div>
    </header>

    <ol class="steps" :aria-label="t('reviewTitle')">
      <li :class="{ done: step > 0, current: step === 0 }"><span class="step-num"><Check v-if="step > 0" :size="14" /><template v-else>1</template></span>{{ t('stepDraft') }}</li>
      <li :class="{ done: step > 1, current: step === 1 }"><span class="step-num"><Check v-if="step > 1" :size="14" /><template v-else>2</template></span>{{ t('stepCheck') }}</li>
      <li :class="{ done: review.phase === 'done', current: step === 2 && review.phase !== 'done' }"><span class="step-num"><Check v-if="review.phase === 'done'" :size="14" /><template v-else>3</template></span>{{ t('stepApply') }}</li>
    </ol>

    <div v-if="review.phase === 'done'" class="notice success" role="status">
      <CircleCheck :size="20" /><strong class="grow">{{ t('applyDone') }}</strong>
      <button class="btn btn-small btn-primary" type="button" @click="session.resetReview(); emit('navigate', 'mods')">{{ t('navMods') }}<ArrowRight :size="15" /></button>
    </div>

    <div v-if="fromImport && review.phase !== 'done'" class="notice" role="status">
      <FileArchive :size="18" /><span class="grow">{{ t('importReviewNotice', { name: review.origin! }) }}</span>
    </div>

    <div v-if="!changes.length && !fromImport && review.phase !== 'done' && review.phase !== 'applying'" class="empty card">
      <span class="empty-icon"><ListChecks :size="28" /></span>
      <h2>{{ t('reviewEmpty') }}</h2>
      <p>{{ t('reviewEmptyHint') }}</p>
      <div class="toolbar">
        <button class="btn" type="button" @click="emit('navigate', 'mods')">{{ t('navMods') }}</button>
        <button class="btn btn-primary" type="button" @click="emit('navigate', 'browse')">{{ t('navBrowse') }}</button>
      </div>
    </div>

    <div v-else class="columns" :class="{ single: fromImport }">
      <section v-if="!fromImport" class="panel card draft-panel" :aria-label="t('draftList')">
        <h2 class="panel-title">{{ t('draftList') }} <span class="badge">{{ changes.length }}</span></h2>
        <div v-if="stale" class="notice warn small" role="alert">
          <TriangleAlert :size="18" />
          <span class="grow">{{ review.phase === 'stale' ? t('planStale') : t('staleDraft') }}</span>
          <button class="btn btn-small" type="button" @click="refreshDraft">{{ t('staleDraftAction') }}</button>
        </div>
        <ul class="list">
          <li v-for="(c, i) in changes" :key="i" class="item rise" :style="{ '--i': i }">
            <Avatar :name="nameOf(c)" :size="28" />
            <span class="grow">
              <span class="item-name">{{ nameOf(c) }}</span>
              <span class="item-kind" :class="c.kind"><component :is="changeIcon[c.kind]" :size="12" />{{ t(changeLabel[c.kind]) }}<template v-if="c.kind === 'install'"> · {{ sourceLabel(c.provider) }}</template></span>
            </span>
            <button class="icon-btn" type="button" :disabled="busy" :aria-label="t('undoChange')" :title="t('undoChange')" @click="undo(c)"><Undo2 :size="15" /></button>
          </li>
        </ul>
        <button class="btn btn-primary btn-block" type="button" :disabled="busy || stale || !changes.length || !session.can('plan.validate')" @click="session.validate(decisions)">
          <Loader v-if="review.phase === 'resolving'" :size="16" class="spin" /><Sparkles v-else :size="16" />
          {{ review.phase === 'resolving' ? t('resolving') : t('resolve') }}
        </button>
        <p v-if="!session.can('plan.validate')" class="muted small">{{ t('capabilityMissing') }}</p>
      </section>

      <section class="panel card plan-panel" :aria-label="t('planTitle')" aria-live="polite">
        <h2 class="panel-title">{{ t('planTitle') }}</h2>
        <p v-if="!plan && review.phase !== 'failed'" class="placeholder muted"><Sparkles :size="18" />{{ t('planPlaceholder') }}</p>
        <div v-if="session.planOutdated.value && review.phase !== 'done'" class="notice warn small" role="alert"><TriangleAlert :size="18" />{{ t('planNeedsCheck') }}</div>
        <div v-if="review.phase === 'changed'" class="notice warn" role="alert">
          <TriangleAlert :size="18" /><span class="grow">{{ t('planChanged') }}</span>
          <button class="btn btn-small" type="button" @click="session.acceptChangedPlan()">{{ t('reviewChanges') }}</button>
        </div>

        <template v-if="plan">
          <p v-if="!plan.items.length" class="muted">{{ t('nothingToApply') }}</p>
          <div v-if="groups.length > 1" class="summary-chips">
            <span v-for="g in groups" :key="g.action" class="chip" :class="g.action"><component :is="actionIcon[g.action]" :size="14" />{{ t(planActionKey[g.action]) }} {{ g.items.length }}</span>
          </div>

          <div v-for="g in groups" :key="g.action" class="group">
            <h3 :class="g.action"><component :is="actionIcon[g.action]" :size="15" />{{ t(planActionKey[g.action]) }} <span class="badge">{{ g.items.length }}</span></h3>
            <VirtualList v-if="g.items.length > BIG" class="big-list" :items="g.items" :row-height="46" :item-key="(x) => x.modKey" :label="t(planActionKey[g.action])">
              <template #default="{ item }">
                <div class="item">
                  <span class="grow"><span class="item-name" :title="item.name">{{ item.name }}</span></span>
                  <span class="versions"><span :class="item.action === 'install' ? 'to' : 'from'">{{ item.action === 'override' ? t(item.destructive ? 'overrideReplace' : 'overrideAdd') : item.to?.name ?? item.from?.name ?? '' }}</span></span>
                  <span v-if="item.destructive" class="badge warn" :title="t('destructiveTitle')"><TriangleAlert :size="12" /></span>
                </div>
              </template>
            </VirtualList>
            <ul v-else class="list">
              <li v-for="(item, i) in g.items" :key="item.modKey" class="item rise" :style="{ '--i': i }">
                <Avatar v-if="item.action !== 'override'" :name="item.name" :size="28" />
                <span class="grow">
                  <span class="item-name">{{ item.name }}</span>
                  <span v-if="item.reason !== 'requested'" class="muted small">{{ reasonText(item) }}</span>
                </span>
                <span class="versions">
                  <template v-if="item.action === 'update'"><span class="from">{{ item.from?.name ?? t('noVersion') }}</span><ArrowRight :size="13" /><span class="to">{{ item.to?.name }}</span></template>
                  <span v-else-if="item.action === 'install' || item.action === 'policy'" class="to">{{ item.to?.name }}</span>
                  <span v-else-if="item.action === 'override'" :class="item.destructive ? 'from' : 'to'">{{ t(item.destructive ? 'overrideReplace' : 'overrideAdd') }}</span>
                  <span v-else class="from">{{ item.from?.name ?? t('noVersion') }}</span>
                </span>
                <span v-if="item.destructive" class="badge warn" :title="t('destructiveTitle')"><TriangleAlert :size="12" /></span>
              </li>
            </ul>
          </div>

          <div v-if="plan.issues.length" class="group">
            <h3>{{ t('issues') }} <span class="badge">{{ plan.issues.length }}</span></h3>
            <ul class="issues">
              <li v-for="(issue, i) in plan.issues" :key="i" class="rise" :class="severityTone[issue.severity]" :style="{ '--i': i }">
                <component :is="severityIcon[issue.severity]" :size="16" />
                <span class="grow"><strong class="sev">{{ t(severityKey[issue.severity]) }}</strong> {{ issue.message }}</span>
              </li>
            </ul>
          </div>

          <div v-if="plan.optional.length" class="group">
            <h3>{{ t('optionalTitle') }}</h3>
            <p class="muted small">{{ t('optionalHint') }}</p>
            <ul class="list">
              <li v-for="(o, i) in plan.optional" :key="o.projectId" class="item rise" :style="{ '--i': i }">
                <Avatar :name="o.name" :size="28" />
                <span class="grow"><span class="item-name">{{ o.name }}</span><span class="muted small">{{ t('reasonOptional', { names: o.suggestedBy.join(', ') }) }}</span></span>
                <button class="btn btn-small" type="button" :disabled="busy" @click="addOptional(o)">{{ t('addOptional') }}</button>
              </li>
            </ul>
          </div>
        </template>

        <div v-if="review.operation" class="operation">
          <div class="op-row">
            <span class="badge" :class="opStateTone[review.operation.state]">{{ t(opStateKey[review.operation.state]) }}</span>
            <span class="muted small">{{ Math.round((review.operation.state === 'completed' ? 1 : review.operation.progress ?? 0) * 100) }}%</span>
          </div>
          <div class="progress"><span :style="{ width: `${Math.round((review.operation.state === 'completed' ? 1 : review.operation.progress ?? 0) * 100)}%` }"></span></div>
          <p v-if="review.operation.error" class="small">{{ review.operation.error.message }}</p>
          <p v-if="review.operation.recovery" class="small">{{ review.operation.recovery.message }}</p>
        </div>

        <p v-if="review.phase === 'applying' && !review.operation" class="notice small" role="status"><Loader :size="16" class="spin" />{{ t('applyAccepted') }}</p>
        <p v-if="review.phase === 'unconfirmed'" class="notice warn small" role="status"><Loader :size="16" class="spin" />{{ t('applyLostReply') }}</p>
        <DependencyConflicts v-if="review.phase === 'failed' && review.error?.code === 'dependency-conflict'" :error="review.error" :can-resolve="canResolve" :busy="busy" @retry="retryWithDecisions" />
        <div v-else-if="review.phase === 'failed'" class="notice error" role="alert">
          <CircleAlert :size="18" />
          <div class="grow">
            <strong>{{ t('applyFailed') }}</strong>
            <p v-if="session.missingTracked.value" class="small">{{ t('cleanMissingHint') }}</p>
            <details v-if="review.error"><summary class="small">{{ t('technicalDetails') }}</summary><code class="small">{{ review.error.code }}: {{ review.error.message }}</code></details>
          </div>
          <button v-if="session.missingTracked.value" class="btn btn-small" type="button" @click="cleanMissing">{{ t('cleanMissing') }}</button>
        </div>

        <div v-if="plan" class="apply-bar">
          <p v-if="plan?.blocked" class="notice error small" role="alert"><CircleAlert :size="18" />{{ t('blockedPlan') }}</p>
          <label v-if="plan && destructive.length && !plan.blocked" class="notice warn check small">
            <input v-model="acknowledged" type="checkbox" />
            <span><strong>{{ t('destructiveTitle') }}.</strong> {{ t('destructiveConfirm') }}</span>
          </label>
          <div class="apply-row">
            <span v-if="!session.can('plan.apply')" class="muted small">{{ t('capabilityMissing') }}</span>
            <button class="btn btn-primary btn-large" type="button" :disabled="!canApply" @click="session.apply()">
              <Loader v-if="review.phase === 'preparing'" :size="18" class="spin" /><Check v-else :size="18" />
              {{ review.phase === 'preparing' ? t('preparing') : t('apply', { count: plan?.items.length ?? 0 }) }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; padding-right: 4px; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.steps li { display: inline-flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 0.9rem; font-weight: 500; }
.steps li + li::before { content: ''; width: 32px; height: 1px; background: var(--border-subtle); margin-right: var(--space-2); }
.steps li, .step-num { transition: color var(--duration-normal) var(--ease), background-color var(--duration-normal) var(--ease), border-color var(--duration-normal) var(--ease); }
.step-num { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--control-border); font-size: 0.8rem; }
.steps li.current { color: var(--text); }
.steps li.current .step-num { background: var(--accent-gradient); border-color: transparent; color: #fff; }
.steps li.done { color: #6ee7b7; }
.steps li.done .step-num { background: rgba(52, 211, 153, 0.15); border-color: rgba(52, 211, 153, 0.4); }
.columns.single { grid-template-columns: minmax(0, 1fr); }
.columns { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(0, 2fr); gap: var(--space-4); align-items: start; }
.panel { display: flex; flex-direction: column; gap: var(--space-4); }
.placeholder { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-4); border: 1px dashed var(--control-border); border-radius: var(--radius-control); }
.summary-chips { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.group h3 { font-size: 0.92rem; display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); color: var(--text-secondary); }
.install { color: #7dd3fc; }
.update { color: #93c5fd; }
.remove { color: #fca5a5; }
.enable { color: #6ee7b7; }
.disable { color: #cbd5e1; }
.big-list { height: 360px; flex: none; }
.big-list .item { height: 42px; }
.policy { color: #c4b5fd; }
.override { color: #fcd34d; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 360px; overflow-y: auto; }
.item { display: flex; align-items: center; gap: var(--space-3); padding: 6px 10px; border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.03); }
.item .grow { display: flex; flex-direction: column; min-width: 0; }
.item-name { font-weight: 600; font-size: 0.92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-kind { display: inline-flex; align-items: center; gap: 4px; font-size: 0.78rem; }
.grow { flex: 1; min-width: 0; }
.versions { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; font-size: 0.86rem; white-space: nowrap; color: var(--text-muted); }
.versions .to { color: #7dd3fc; font-weight: 600; }
.issues { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.issues li { display: flex; gap: var(--space-2); align-items: flex-start; padding: 8px 12px; border-radius: var(--radius-control); font-size: 0.9rem; background: rgba(255, 255, 255, 0.03); }
.issues li.error { background: rgba(239, 68, 68, 0.08); color: #fecaca; }
.issues li.warn { background: rgba(245, 158, 11, 0.07); }
.issues li.warn svg { color: #fcd34d; }
.issues li.info svg { color: #93c5fd; }
.sev { margin-right: 4px; }
.operation { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.03); }
.op-row { display: flex; justify-content: space-between; align-items: center; }
.apply-bar { position: sticky; bottom: 0; display: flex; flex-direction: column; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--border-subtle); background: linear-gradient(180deg, transparent, rgba(10, 19, 34, 0.9) 30%); }
.apply-row { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-3); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1000px) { .columns { grid-template-columns: 1fr; } }
</style>
