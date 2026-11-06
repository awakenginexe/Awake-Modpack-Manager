import { computed, inject, reactive, ref, shallowRef, watch, type InjectionKey } from 'vue';
import {
  BackendError, type Capability, type CreateInstanceRequest, type Draft, type ExportRequest, type Handshake,
  type InstallPackRequest, type InstanceSummary, type InstanceWarning, type Installation, type ModInventory, type OperationStatus, type ResolvedPlan,
} from '../backend/contract';
import type { ConnectionState, ManagerBackend } from '../backend/ManagerBackend';
import { newDraft } from '../domain/draft';
import { followOperation, isTerminal } from '../domain/operation';
import { load, save } from '../domain/storage';
import { prune, emptySelection, type Selection } from '../domain/selection';

export type ReviewPhase =
  | 'idle' | 'resolving' | 'reviewed' | 'preparing' | 'changed' | 'stale'
  | 'applying' | 'unconfirmed' | 'not-received' | 'done' | 'failed';

interface PendingApply { key: string; instanceId: string; planHash: string }

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000];

export function createSession(backend: ManagerBackend, { pollMs = 1500 } = {}) {
  const state = reactive({
    connection: 'disconnected' as ConnectionState,
    connectError: null as BackendError | null,
    reconnecting: false,
    handshake: null as Handshake | null,
    installations: [] as Installation[],
    installationId: null as string | null,
    instances: [] as InstanceSummary[],
    instancesLoading: false,
    instanceId: load<string | null>('instance', null),
    inventoryLoading: false,
    inventoryError: null as BackendError | null,
    /** Paged loading progress for large inventories. */
    inventoryProgress: null as { loaded: number; total: number } | null,
    /** When the shown inventory was read; it becomes a snapshot once the Launcher disconnects. */
    inventoryObservedAt: null as number | null,
    instanceWarnings: [] as InstanceWarning[],
    /** No Launcher endpoint yet; connect() keeps checking. */
    waitingForLauncher: false,
    operations: [] as OperationStatus[],
  });
  /** Hundreds of mods: kept shallow so Vue does not make every field reactive. */
  const inventory = shallowRef<ModInventory | null>(null);
  const selection = shallowRef<Selection>(emptySelection());
  const drafts = ref<Record<string, Draft>>(load('drafts', {}));
  const pins = ref<Record<string, string[]>>(load('pins', {}));
  const exportIncludes = ref<Record<string, string[]>>(load('exportIncludes', {}));
  const review = reactive({
    phase: 'idle' as ReviewPhase,
    plan: null as ResolvedPlan | null,
    /** Draft snapshot the plan was resolved from; a different draft means the plan is outdated. */
    planDraft: '',
    operation: null as OperationStatus | null,
    error: null as BackendError | null,
  });
  let pending = load<PendingApply | null>('pendingApply', null);
  const following = new Set<string>();

  watch(drafts, (v) => save('drafts', v), { deep: true });
  watch(pins, (v) => save('pins', v), { deep: true });
  watch(exportIncludes, (v) => save('exportIncludes', v), { deep: true });
  watch(() => state.instanceId, (v) => save('instance', v));

  const can = (cap: Capability) => !!state.handshake?.capabilities.includes(cap);
  const instance = computed(() => state.instances.find((i) => i.id === state.instanceId) ?? null);
  const draft = computed<Draft | null>(() => {
    if (!state.instanceId || !inventory.value) return null;
    return drafts.value[state.instanceId] ?? newDraft(state.instanceId, inventory.value.revision);
  });
  const pinned = computed(() => new Set(state.instanceId ? pins.value[state.instanceId] ?? [] : []));
  const planOutdated = computed(() => !!review.plan && review.planDraft !== JSON.stringify(draft.value?.changes ?? []));

  /* ----- connection ----- */

  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  backend.onConnectionChange((s) => {
    const was = state.connection;
    state.connection = s;
    if (s === 'disconnected' && was === 'connected') scheduleReconnect();
  });

  function scheduleReconnect() {
    state.reconnecting = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => void connect(), RECONNECT_DELAYS[Math.min(attempt++, RECONNECT_DELAYS.length - 1)]);
  }

  async function connect() {
    state.connectError = null;
    try {
      state.handshake = await backend.connect();
      attempt = 0;
      state.reconnecting = false;
      state.waitingForLauncher = false;
      await refreshInstallations();
      if (state.instanceId) await loadInventory();
      await resumePending();
      await refreshOperations();
    } catch (e) {
      state.connectError = asError(e);
      // Launcher not started yet (or restarting): keep looking for its endpoint without user action.
      state.waitingForLauncher = state.connectError.code === 'not-running';
      if (state.waitingForLauncher) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(() => void connect(), 5000); return; }
      // Retry transport failures; an unsupported build will not start working by retrying.
      if (state.reconnecting && state.connectError.code !== 'unsupported') scheduleReconnect();
    }
  }

  /* ----- instances & inventory ----- */

  async function refreshInstallations() {
    if (!can('installations.discover')) return;
    state.installations = await backend.listInstallations();
    if (!state.installations.some((i) => i.id === state.installationId)) state.installationId = (state.installations.find((i) => i.available !== false) ?? state.installations[0])?.id ?? null;
    await refreshInstances();
  }

  async function refreshInstances() {
    if (!state.installationId || !can('instances.list')) return;
    state.instancesLoading = true;
    try {
      state.instances = await backend.listInstances(state.installationId);
      state.instanceWarnings = backend.instanceWarnings?.() ?? [];
      // A remembered instance may have been deleted in the Launcher.
      if (state.instanceId && !state.instances.some((i) => i.id === state.instanceId)) state.instanceId = null;
    } finally {
      state.instancesLoading = false;
    }
  }

  async function selectInstance(id: string) {
    if (state.instanceId !== id) {
      state.instanceId = id;
      inventory.value = null;
      selection.value = emptySelection();
      resetReview();
    }
    await loadInventory();
  }

  async function loadInventory() {
    const id = state.instanceId;
    if (!id || !can('mods.inventory')) return;
    state.inventoryLoading = true;
    state.inventoryProgress = null;
    state.inventoryError = null;
    try {
      const inv = await backend.getInventory(id, (loaded, total) => {
        if (state.instanceId === id) state.inventoryProgress = { loaded, total };
      });
      if (state.instanceId !== id) return;
      inventory.value = inv;
      state.inventoryObservedAt = Date.now();
      selection.value = prune(selection.value, new Set(inv.mods.map((m) => m.key)));
    } catch (e) {
      state.inventoryError = asError(e);
    } finally {
      state.inventoryLoading = false;
    }
  }

  /* ----- draft & pins (Manager-owned) ----- */

  function setDraft(next: Draft) {
    drafts.value = { ...drafts.value, [next.instanceId]: next };
  }

  function discardDraft() {
    if (!state.instanceId) return;
    const { [state.instanceId]: _, ...rest } = drafts.value;
    drafts.value = rest;
    resetReview();
  }

  function setPinned(keys: Iterable<string>, value: boolean) {
    const id = state.instanceId;
    if (!id) return;
    const set = new Set(pins.value[id] ?? []);
    for (const k of keys) value ? set.add(k) : set.delete(k);
    pins.value = { ...pins.value, [id]: [...set] };
  }

  /* ----- review → prepare → apply → follow ----- */

  function resetReview() {
    Object.assign(review, { phase: 'idle', plan: null, planDraft: '', operation: null, error: null });
  }

  async function validate() {
    const d = draft.value;
    if (!d || !can('plan.validate')) return;
    Object.assign(review, { phase: 'resolving', error: null, operation: null });
    try {
      review.plan = await backend.validateDraft({ ...d, pinnedKeys: [...pinned.value] });
      review.planDraft = JSON.stringify(d.changes);
      review.phase = 'reviewed';
    } catch (e) {
      review.error = asError(e);
      review.phase = review.error.code === 'stale-revision' ? 'stale' : 'failed';
      review.plan = null;
    }
  }

  /** Apply exactly the reviewed plan. If preparation changes it, stop and ask again. */
  async function apply() {
    const reviewed = review.plan;
    if (!reviewed || review.phase !== 'reviewed' || planOutdated.value || reviewed.blocked) return;
    if (!can('plan.prepare') || !can('plan.apply')) return;
    review.phase = 'preparing';
    review.error = null;
    let prepared: ResolvedPlan;
    try {
      prepared = await backend.preparePlan(reviewed.planId);
    } catch (e) {
      review.error = asError(e);
      review.phase = review.error.code === 'stale-revision' ? 'stale' : 'failed';
      return;
    }
    if (prepared.planHash !== reviewed.planHash) {
      review.plan = prepared;
      review.phase = 'changed';
      return;
    }
    pending = { key: crypto.randomUUID(), instanceId: prepared.instanceId, planHash: prepared.planHash };
    save('pendingApply', pending);
    review.phase = 'applying';
    try {
      const { operationId } = await backend.applyPlan({ planId: prepared.planId, planHash: prepared.planHash, idempotencyKey: pending.key });
      await track(operationId);
    } catch (e) {
      const err = asError(e);
      if (err.code === 'disconnected' || err.code === 'timeout') {
        // The request may or may not have reached the coordinator. Never resend blindly:
        // resumePending() asks by idempotency key once we are connected again.
        review.phase = 'unconfirmed';
        if (state.connection === 'connected') await resumePending();
        return;
      }
      clearPending();
      review.error = err;
      review.phase = err.code === 'stale-revision' ? 'stale' : 'failed';
    }
  }

  /** User confirmed the changed plan; it becomes the reviewed plan. */
  function acceptChangedPlan() {
    if (review.phase === 'changed') review.phase = 'reviewed';
  }

  async function resumePending() {
    if (!pending) return;
    const p = pending;
    let op: OperationStatus | null;
    try {
      op = await backend.findOperationByIdempotencyKey(p.key);
    } catch {
      return; // still unreachable; try again on the next connect
    }
    if (op) {
      if (state.instanceId === p.instanceId && review.phase !== 'applying') review.phase = 'applying';
      await track(op.operationId);
    } else {
      clearPending();
      if (review.phase === 'unconfirmed') review.phase = 'not-received';
    }
  }

  function clearPending() {
    pending = null;
    save('pendingApply', null);
  }

  function upsertOperation(s: OperationStatus) {
    const i = state.operations.findIndex((o) => o.operationId === s.operationId);
    if (i >= 0) state.operations.splice(i, 1, s); else state.operations.unshift(s);
  }

  /** Follow an operation to a confirmed terminal state. Safe to call twice for the same id. */
  async function track(operationId: string): Promise<OperationStatus | null> {
    if (following.has(operationId)) return null;
    following.add(operationId);
    try {
      const final = await followOperation(backend, operationId, (s) => {
        upsertOperation(s);
        if (s.planHash && s.planHash === review.plan?.planHash) review.operation = s;
      }, { pollMs });
      onTerminal(final);
      return final;
    } catch (e) {
      if (review.phase === 'applying') { review.error = asError(e); review.phase = 'failed'; }
      return null;
    } finally {
      following.delete(operationId);
    }
  }

  function onTerminal(s: OperationStatus) {
    if (pending && s.planHash === pending.planHash) clearPending();
    const ours = !!s.planHash && s.planHash === review.plan?.planHash;
    if (ours) {
      review.operation = s;
      review.phase = s.state === 'completed' ? 'done' : 'failed';
      if (s.state === 'completed' && s.instanceId) {
        const { [s.instanceId]: _, ...rest } = drafts.value;
        drafts.value = rest;
        selection.value = emptySelection();
      }
    }
    if (s.kind === 'create-instance' || s.kind === 'install-pack' || s.instanceId) void refreshInstances();
    if (s.instanceId && s.instanceId === state.instanceId) void loadInventory();
  }

  async function refreshOperations() {
    if (!can('operations.watch')) return;
    try {
      const ops = await backend.listOperations();
      state.operations = ops;
      // Reattach to anything still running (another window, or before a reconnect).
      for (const op of ops) if (!isTerminal(op)) void track(op.operationId);
    } catch {
      /* shown via connection state */
    }
  }

  async function cancelOperation(id: string) {
    await backend.cancelOperation(id);
  }

  async function createInstance(req: Omit<CreateInstanceRequest, 'idempotencyKey'>) {
    const { operationId } = await backend.createInstance({ ...req, idempotencyKey: crypto.randomUUID() });
    return track(operationId);
  }

  /** Install a provider modpack as a new instance and, once it exists, select it for managing. */
  async function installPack(req: Omit<InstallPackRequest, 'idempotencyKey'>, onAccepted?: (operationId: string) => void) {
    const { operationId } = await backend.installPack({ ...req, idempotencyKey: crypto.randomUUID() });
    onAccepted?.(operationId);
    const final = await track(operationId);
    if (final?.state === 'completed' && final.result?.instanceId) {
      await refreshInstances();
      await selectInstance(final.result.instanceId);
    }
    return final;
  }

  async function startExport(req: Omit<ExportRequest, 'idempotencyKey'>) {
    const { operationId } = await backend.startExport({ ...req, idempotencyKey: crypto.randomUUID() });
    return track(operationId);
  }

  return {
    backend, state, inventory, selection, drafts, pins, exportIncludes, review,
    can, instance, draft, pinned, planOutdated,
    connect, refreshInstances, selectInstance, loadInventory,
    setDraft, discardDraft, setPinned,
    validate, apply, acceptChangedPlan, resetReview,
    refreshOperations, cancelOperation, createInstance, installPack, startExport,
  };
}

export function asError(e: unknown): BackendError {
  return e instanceof BackendError ? e : new BackendError('protocol', e instanceof Error ? e.message : String(e));
}

export type Session = ReturnType<typeof createSession>;
export const SessionKey: InjectionKey<Session> = Symbol('session');
export function useSession(): Session {
  const s = inject(SessionKey);
  if (!s) throw new Error('Session not provided');
  return s;
}
