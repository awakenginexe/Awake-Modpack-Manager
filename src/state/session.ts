import { computed, inject, reactive, ref, shallowRef, watch, type InjectionKey } from 'vue';
import {
  BackendError, isLauncherWait, type Capability, type CreateInstanceRequest, type DependencyResolution, type Draft, type ExportRequest, type Handshake,
  type InstallPackRequest, type InstanceSummary, type InstanceWarning, type Installation, type ModInventory, type OperationStatus, type ResolvedPlan, type VersionRef,
} from '../backend/contract';
import type { ConnectionState, ManagerBackend } from '../backend/ManagerBackend';
import { isComposite } from '../backend/composite';
import { newDraft } from '../domain/draft';
import { followOperation, isSettled } from '../domain/operation';
import { load, save } from '../domain/storage';
import { prune, emptySelection, type Selection } from '../domain/selection';

export type ReviewPhase =
  | 'idle' | 'resolving' | 'reviewed' | 'preparing' | 'changed' | 'stale'
  | 'applying' | 'unconfirmed' | 'done' | 'failed';

/** The exact Apply request, kept so a lost reply is recovered by resending it unchanged. */
interface PendingApply { key: string; instanceId: string; planId: string; planHash: string; baseRevision: string }

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
    /** Set when the user started the Launcher from the Manager and it has not connected yet. */
    launcherStartedAt: null as number | null,
    updatesChecking: false,
    updatesCheckedAt: null as number | null,
    updatesError: null as string | null,
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
    /** Set when the plan came from a modpack import rather than the mod draft (shown on Review). */
    origin: null as string | null,
    /** Which request produced the current plan or failure: retries with dependency decisions go back there. */
    source: null as 'draft' | 'import' | null,
  });
  let pending = load<PendingApply | null>('pendingApply', null);
  let packUpdateFor: string | null = null;
  const following = new Set<string>();

  watch(drafts, (v) => save('drafts', v), { deep: true });
  watch(pins, (v) => save('pins', v), { deep: true });
  watch(exportIncludes, (v) => save('exportIncludes', v), { deep: true });
  watch(() => state.instanceId, (v) => save('instance', v));

  const can = (cap: Capability) => !!state.handshake?.capabilities.includes(cap);
  /** Which side serves the selected installation: the Manager's helper, Awake Launcher, or demo data. */
  const source = ref<'mock' | 'launcher' | 'helper'>(backend.kind === 'composite' ? 'helper' : backend.kind === 'mock' ? 'mock' : backend.kind === 'helper' ? 'helper' : 'launcher');
  /** Capabilities, errors and "waiting for Launcher" follow the selected installation's side. */
  function syncPart() {
    if (!isComposite(backend)) return;
    const p = backend.partFor(state.installationId);
    source.value = p === backend.parts.helper ? 'helper' : 'launcher';
    state.handshake = p.handshake;
    state.connectError = p.error;
    state.waitingForLauncher = p === backend.parts.launcher && isLauncherWait(p.error?.code);
  }
  if (isComposite(backend)) backend.onChanged(() => { syncPart(); void refreshInstallations().catch(() => undefined); });
  const instance = computed(() => state.instances.find((i) => i.id === state.instanceId) ?? null);
  const draft = computed<Draft | null>(() => {
    if (!state.instanceId || !inventory.value) return null;
    return drafts.value[state.instanceId] ?? newDraft(state.instanceId, inventory.value.revision);
  });
  /** With helper policies the pin lives in the workspace (updateLocked); otherwise it is a Manager-side note. */
  const policies = computed(() => can('mods.policies') && source.value === 'helper');
  // manager.v0.2 reads the pin back on its own. Older replies only give updateLocked (pin OR native
  // lock OR exclusion), so there an excluded mod is shown as excluded only.
  const lockedPin = (m: { updateLocked?: boolean; updateExcluded?: boolean; pinned?: boolean }) => m.pinned ?? (!!m.updateLocked && !m.updateExcluded);
  const pinned = computed(() => policies.value
    ? new Set((inventory.value?.mods ?? []).filter(lockedPin).map((m) => m.key))
    : new Set(state.instanceId ? pins.value[state.instanceId] ?? [] : []));
  /** Modpack catalogs live with the helper, whichever list is on screen. */
  const packHandshake = computed(() => (isComposite(backend) && state.connection !== 'disconnected' ? backend.parts.helper.handshake : state.handshake));
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
      state.launcherStartedAt = null;
      await refreshInstallations();
      syncPart();
      if (state.instanceId) await loadInventory();
      await resumePending();
      await refreshOperations();
    } catch (e) {
      state.connectError = asError(e);
      // Launcher not started yet (or restarting): keep looking for its endpoint without user action.
      state.waitingForLauncher = isLauncherWait(state.connectError.code);
      if (state.waitingForLauncher) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(() => void connect(), 5000); return; }
      // Retry transport failures; an unsupported build will not start working by retrying.
      if (state.reconnecting && state.connectError.code !== 'unsupported') scheduleReconnect();
    }
  }

  /* ----- instances & inventory ----- */

  async function refreshInstallations() {
    if (!can('installations.discover') && !isComposite(backend)) return;
    state.installations = await backend.listInstallations();
    if (!state.installations.some((i) => i.id === state.installationId)) state.installationId = (state.installations.find((i) => i.available !== false) ?? state.installations[0])?.id ?? null;
    await refreshInstances();
  }

  async function refreshInstances() {
    syncPart();
    if (!state.installationId || !can('instances.list')) { if (isComposite(backend)) state.instances = []; return; }
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
      inventory.value = applyKnownUpdates(inv);
      state.inventoryObservedAt = Date.now();
      selection.value = prune(selection.value, new Set(inv.mods.map((m) => m.key)));
      void checkUpdates();
    } catch (e) {
      state.inventoryError = asError(e);
    } finally {
      state.inventoryLoading = false;
    }
  }

  /* ----- mod updates: looked up after the list is on screen, so a large pack never waits for them ----- */

  const UPDATE_CHECK_MS = 30 * 60_000;
  const knownUpdates = new Map<string, { at: number; byKey: Map<string, VersionRef | null> }>();
  function applyKnownUpdates(inv: ModInventory): ModInventory {
    const known = knownUpdates.get(inv.instanceId);
    if (!known) return inv;
    return { ...inv, mods: inv.mods.map((m) => (known.byKey.get(m.key) ? { ...m, available: known.byKey.get(m.key)! } : m)) };
  }
  /** `force`: the user asked; otherwise a recent answer for this project is reused. */
  async function checkUpdates(force = false) {
    const id = state.instanceId;
    if (!id || !backend.checkUpdates || !can('mods.updates') || state.updatesChecking) return;
    if (!force && Date.now() - (knownUpdates.get(id)?.at ?? 0) < UPDATE_CHECK_MS) return;
    state.updatesChecking = true;
    state.updatesError = null;
    try {
      const found = await backend.checkUpdates(id);
      knownUpdates.set(id, { at: Date.now(), byKey: new Map(found.map((u) => [u.modKey, u.available])) });
      state.updatesCheckedAt = Date.now();
      if (state.instanceId === id && inventory.value) inventory.value = applyKnownUpdates(inventory.value);
    } catch (e) {
      state.updatesError = asError(e).message;
    } finally {
      state.updatesChecking = false;
    }
  }

  /* ----- project management ----- */

  /** Permanently delete a project the Manager owns, and forget everything Manager kept about it. */
  async function deleteInstance(id: string) {
    if (!backend.deleteInstance) throw new BackendError('unsupported', 'This cannot be deleted from here.');
    const { operationId } = await backend.deleteInstance(id, crypto.randomUUID());
    const final = await track(operationId);
    if (final?.state === 'completed') {
      const { [id]: _d, ...restDrafts } = drafts.value; drafts.value = restDrafts;
      const { [id]: _p, ...restPins } = pins.value; pins.value = restPins;
      const { [id]: _e, ...restIncludes } = exportIncludes.value; exportIncludes.value = restIncludes;
      knownUpdates.delete(id);
      if (state.instanceId === id) { state.instanceId = null; inventory.value = null; selection.value = emptySelection(); resetReview(); }
      await refreshInstances();
    }
    return final;
  }
  async function renameInstance(id: string, name: string) {
    if (!backend.renameInstance) throw new BackendError('unsupported', 'This cannot be renamed from here.');
    await backend.renameInstance(id, name);
    await refreshInstances();
  }
  /** Fetch a newer pack version and put its full change list on Review. Nothing changes until it is applied. */
  async function preparePackUpdate(instanceId: string, versionId: string, label: string) {
    if (!backend.preparePackUpdate) throw new BackendError('unsupported', 'Only Manager projects can update their modpack here.');
    if (drafts.value[instanceId]?.changes.length) throw new BackendError('rejected', 'This project has unreviewed changes. Review or discard them first.');
    await selectInstance(instanceId);
    resetReview();
    review.phase = 'resolving';
    review.source = 'import';
    try {
      const plan = await backend.preparePackUpdate(instanceId, versionId);
      Object.assign(review, { plan, planDraft: JSON.stringify(draft.value?.changes ?? []), phase: 'reviewed', origin: label });
      packUpdateFor = instanceId;
      return plan;
    } catch (e) {
      review.error = asError(e);
      review.phase = 'failed';
      throw review.error;
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

  /** The policy a mod will have after the draft: its pending policy change, else what the helper reports. */
  function policyOf(key: string) {
    const c = draft.value?.changes.find((x) => x.kind === 'policy' && x.modKey === key);
    const m = inventory.value?.mods.find((x) => x.key === key);
    return c?.kind === 'policy' ? { pinned: c.pinned, excluded: c.excluded } : { pinned: !!m && lockedPin(m), excluded: !!m?.updateExcluded };
  }
  /** Helper policies are reviewed changes like any other: they go into the draft. */
  function draftPolicy(keys: Iterable<string>, field: 'pinned' | 'excluded', value: boolean) {
    const d = draft.value;
    if (!d) return;
    const mods = new Map((inventory.value?.mods ?? []).map((m) => [m.key, m]));
    const changes = [...keys].filter((k) => mods.get(k)?.installed && mods.get(k)?.source !== 'manual')
      .map((k) => ({ kind: 'policy' as const, modKey: k, ...policyOf(k), [field]: value }));
    // A change back to the current state is no change.
    const kept = d.changes.filter((c) => !(c.kind === 'policy' && changes.some((n) => n.modKey === c.modKey)));
    const real = changes.filter((c) => c.pinned !== lockedPin(mods.get(c.modKey)!) || c.excluded !== !!mods.get(c.modKey)?.updateExcluded);
    setDraft({ ...d, changes: [...kept, ...real] });
  }
  function setExcluded(keys: Iterable<string>, value: boolean) {
    if (policies.value) draftPolicy(keys, 'excluded', value);
  }

  function setPinned(keys: Iterable<string>, value: boolean) {
    if (policies.value) return draftPolicy(keys, 'pinned', value);
    const id = state.instanceId;
    if (!id) return;
    const set = new Set(pins.value[id] ?? []);
    for (const k of keys) value ? set.add(k) : set.delete(k);
    pins.value = { ...pins.value, [id]: [...set] };
  }

  /* ----- review → prepare → apply → follow ----- */

  function resetReview() {
    Object.assign(review, { phase: 'idle', plan: null, planDraft: '', operation: null, error: null, origin: null, source: null });
  }

  /** `resolutions` answers dependency conflicts the previous attempt reported (reviewed by the user). */
  async function validate(resolutions?: DependencyResolution[]) {
    const d = draft.value;
    if (!d || !can('plan.validate')) return;
    Object.assign(review, { phase: 'resolving', error: null, operation: null, source: 'draft' });
    try {
      review.plan = await backend.validateDraft({ ...d, pinnedKeys: [...pinned.value] }, resolutions?.length ? resolutions : undefined);
      review.origin = null;
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
    pending = { key: crypto.randomUUID(), instanceId: prepared.instanceId, planId: prepared.planId, planHash: prepared.planHash, baseRevision: prepared.baseRevision };
    save('pendingApply', pending);
    review.phase = 'applying';
    try {
      const { operationId } = await backend.applyPlan(applyRequest(pending));
      await track(operationId);
    } catch (e) {
      const err = asError(e);
      if (err.code === 'disconnected' || err.code === 'timeout') {
        // The request may or may not have reached the coordinator. resumePending() resends the
        // identical request with the same idempotency key, which the coordinator de-duplicates.
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

  const applyRequest = (p: PendingApply) => ({ planId: p.planId, planHash: p.planHash, baseRevision: p.baseRevision, idempotencyKey: p.key });

  async function resumePending() {
    if (!pending?.planId) { if (pending) clearPending(); return; } // record from an older Manager version
    const p = pending;
    let operationId: string;
    try {
      ({ operationId } = await backend.applyPlan(applyRequest(p)));
    } catch (e) {
      const err = asError(e);
      if (err.code === 'disconnected' || err.code === 'timeout') return; // try again on the next connect
      clearPending();
      if (state.instanceId === p.instanceId && review.phase === 'unconfirmed') {
        review.error = err;
        review.phase = err.code === 'stale-revision' ? 'stale' : 'failed';
      }
      return;
    }
    if (state.instanceId === p.instanceId && review.phase === 'unconfirmed') review.phase = 'applying';
    await track(operationId);
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
      if (s.state === 'completed' && packUpdateFor === s.instanceId && s.instanceId) void backend.finishPackUpdate?.(s.instanceId).then(() => refreshInstances()).catch(() => undefined);
      packUpdateFor = null;
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
      // A prepared plan waits for the user's review, not for the coordinator: don't poll it.
      for (const op of ops) if (!isSettled(op) && op.state !== 'prepared') void track(op.operationId);
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
      // Packs always become Manager projects: show that list even if a Launcher profile was selected.
      if (isComposite(backend) && state.installationId !== 'manager') state.installationId = 'manager';
      await refreshInstances();
      await selectInstance(final.result.instanceId);
    }
    return final;
  }

  /** User asked to start Awake Launcher; connect() keeps polling for its endpoint. */
  async function startLauncher() {
    await backend.startLauncher?.();
    state.launcherStartedAt = Date.now();
  }

  /** The user confirmed it. An open Launcher still has to be restarted: it only tries to publish at startup. */
  async function makeProfilePrivate() {
    await backend.makeProfilePrivate?.();
    state.launcherStartedAt = null;
  }

  /** Ask the Launcher to start the instance with its own account, Java and GPU settings. */
  async function launch(instanceId: string) {
    const { operationId } = await backend.requestLaunch(instanceId, crypto.randomUUID());
    return track(operationId);
  }

  /** Roll back an interrupted change, as the coordinator's recovery allows. Never a direct file repair. */
  async function runRecovery(operationId: string) {
    if (!backend.runRecovery) return null;
    const { operationId: id } = await backend.runRecovery(operationId, crypto.randomUUID());
    const final = await track(id);
    void refreshOperations();
    return final;
  }

  /**
   * Native import, after the archive was uploaded and the workspace exists: the helper resolves,
   * downloads and stages it; the full plan becomes the reviewed plan for the Review screen. The
   * upload is discarded once staged (the prepared plan does not need it).
   */
  async function prepareImport(instanceId: string, token: string, format: 'mrpack' | 'curseforge', includeOptional: boolean, label: string,
    resolutions?: DependencyResolution[], keepUploadOnFailure = false) {
    if (!backend.prepareImport) throw new BackendError('unsupported', 'This backend cannot import modpacks.');
    if (drafts.value[instanceId]?.changes.length) throw new BackendError('rejected', 'This project has unreviewed changes. Review or discard them before importing into it.');
    await selectInstance(instanceId);
    resetReview();
    review.phase = 'resolving';
    review.source = 'import';
    let keep = false;
    try {
      const plan = await backend.prepareImport(instanceId, token, format, includeOptional, resolutions?.length ? resolutions : undefined);
      Object.assign(review, { plan, planDraft: JSON.stringify(draft.value?.changes ?? []), phase: 'reviewed', origin: label });
      return plan;
    } catch (e) {
      review.error = asError(e);
      review.phase = 'failed';
      // A reviewable dependency conflict keeps the upload so the caller can retry with decisions; it then discards it.
      keep = keepUploadOnFailure && review.error.code === 'dependency-conflict';
      throw review.error;
    } finally {
      if (!keep) await backend.discardImport?.(token).catch(() => undefined);
    }
  }

  async function startExport(req: Omit<ExportRequest, 'idempotencyKey'>) {
    const { operationId } = await backend.startExport({ ...req, idempotencyKey: crypto.randomUUID() });
    return track(operationId);
  }

  return {
    backend, source, state, inventory, selection, drafts, pins, exportIncludes, review,
    can, instance, draft, pinned, planOutdated, policies, policyOf, packHandshake,
    connect, refreshInstances, selectInstance, loadInventory, checkUpdates, deleteInstance, renameInstance, preparePackUpdate,
    setDraft, discardDraft, setPinned, setExcluded, prepareImport,
    validate, apply, acceptChangedPlan, resetReview,
    refreshOperations, cancelOperation, runRecovery, createInstance, installPack, startExport, launch, startLauncher, makeProfilePrivate,
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
