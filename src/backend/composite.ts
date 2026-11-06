import { BackendError, type Handshake, type Installation, type OperationStatus } from './contract';
import type { ConnectionState, ManagerBackend } from './ManagerBackend';

export interface Part { backend: ManagerBackend; handshake: Handshake | null; error: BackendError | null }

/**
 * Presents the Manager's own helper (standalone projects) and Awake Launcher (optional) as one
 * backend. They stay separate connections; every call goes to exactly one of them, chosen by the
 * installation, instance, plan or operation it concerns. Neither ever sees the other's data.
 */
export function createCompositeBackend(helper: ManagerBackend, launcher: ManagerBackend, { retryMs = 5000 } = {}) {
  const parts = { helper: { backend: helper, handshake: null, error: null } as Part, launcher: { backend: launcher, handshake: null, error: null } as Part };
  const listeners = new Set<(s: ConnectionState) => void>();
  const changeListeners = new Set<() => void>();
  let state: ConnectionState = 'disconnected';
  const owners = { installation: new Map<string, Part>(), instance: new Map<string, Part>(), plan: new Map<string, Part>(), op: new Map<string, Part>() };
  let current: Part = parts.helper;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const all = [parts.helper, parts.launcher];
  const overall = (): ConnectionState => (all.some((p) => p.handshake && !p.error) ? 'connected' : 'disconnected');
  let signature = '';
  /** Notify only when a side's reachability actually changed, not on every quiet retry. */
  const emit = () => {
    const s = overall();
    if (s !== state) { state = s; for (const l of listeners) l(s); }
    const sig = all.map((p) => `${!!p.handshake}:${p.error?.code ?? ''}`).join('|');
    if (sig !== signature) { signature = sig; for (const l of changeListeners) l(); }
  };

  async function connectPart(p: Part) {
    try { p.handshake = await p.backend.connect(); p.error = null; } catch (e) {
      p.handshake = null;
      p.error = e instanceof BackendError ? e : new BackendError('protocol', String(e));
    }
  }
  /** The Launcher is optional and may start later: keep looking for it while it is merely not running. */
  function scheduleLauncherRetry() {
    clearTimeout(retry);
    if (parts.launcher.error?.code !== 'not-running' && parts.launcher.error?.code !== 'disconnected' && parts.launcher.error?.code !== 'timeout') return;
    if (!launcher.launcherProfiles?.().length) return; // no Launcher installed: nothing to wait for
    retry = setTimeout(async () => { await connectPart(parts.launcher); emit(); scheduleLauncherRetry(); }, retryMs);
  }
  for (const p of all) {
    p.backend.onConnectionChange((s) => {
      if (s === 'disconnected' && p.handshake) { p.error ??= new BackendError('disconnected', 'Connection lost.'); }
      if (s === 'connected') p.error = null;
      emit();
      if (p === parts.launcher && s === 'disconnected') scheduleLauncherRetry();
    });
  }

  const byInstance = (id: string) => owners.instance.get(id) ?? current;
  const byOp = (id: string) => owners.op.get(id) ?? current;
  const own = <T extends { operationId: string }>(p: Part, a: T) => { owners.op.set(a.operationId, p); return a; };

  const backend: ManagerBackend & {
    partFor(installationId: string | null): Part;
    onChanged(l: () => void): () => void;
    parts: typeof parts;
  } = {
    kind: 'composite',
    parts,
    partFor: (id) => (id ? owners.installation.get(id) ?? (id === 'manager' ? parts.helper : parts.launcher) : current),
    onChanged(l) { changeListeners.add(l); return () => changeListeners.delete(l); },

    async connect(): Promise<Handshake> {
      state = 'connecting';
      for (const l of listeners) l('connecting');
      await Promise.all(all.map(connectPart));
      emit();
      scheduleLauncherRetry();
      const ok = all.find((p) => p.handshake);
      if (!ok) {
        // Neither is reachable: report the helper first; the Launcher is optional.
        throw parts.helper.error ?? parts.launcher.error ?? new BackendError('disconnected', 'Not connected.');
      }
      return ok.handshake!;
    },
    onConnectionChange(l) { listeners.add(l); return () => listeners.delete(l); },

    async listInstallations(): Promise<Installation[]> {
      const out: Installation[] = [];
      for (const p of all) {
        let list: Installation[] = [];
        // The Launcher reports discovered profiles even while it is not running.
        try { list = await p.backend.listInstallations(); } catch { /* listed as unavailable below */ }
        for (const i of list) { owners.installation.set(i.id, p); out.push(p.handshake ? i : { ...i, available: false }); }
      }
      return out;
    },
    launcherProfiles: () => launcher.launcherProfiles?.() ?? [],
    setAddedFolders: (f) => launcher.setAddedFolders?.(f),
    canStartLauncher: () => launcher.canStartLauncher?.() ?? false,
    startLauncher: async () => { await launcher.startLauncher?.(); scheduleLauncherRetry(); },
    setPreferredProfile: (d) => launcher.setPreferredProfile?.(d),
    instanceWarnings: () => current.backend.instanceWarnings?.() ?? [],

    async listInstances(installationId) {
      const p = backend.partFor(installationId);
      current = p;
      if (!p.handshake) throw p.error ?? new BackendError('disconnected', 'Not connected.');
      const list = await p.backend.listInstances(installationId);
      for (const i of list) owners.instance.set(i.id, p);
      return list;
    },
    createInstance: async (r) => own(current, await current.backend.createInstance(r)),
    getInventory: (id, onProgress) => byInstance(id).backend.getInventory(id, onProgress),

    // Search and packs follow the selected installation; each side reports its own availability.
    search: (q) => current.backend.search(q),
    searchPacks: (q) => current.backend.searchPacks(q),
    packVersions: (prov, id) => current.backend.packVersions(prov, id),
    installPack: async (r) => own(current, await current.backend.installPack(r)),

    async validateDraft(d) {
      const p = byInstance(d.instanceId);
      const plan = await p.backend.validateDraft(d);
      owners.plan.set(plan.planId, p);
      return plan;
    },
    preparePlan: (planId) => (owners.plan.get(planId) ?? current).backend.preparePlan(planId),
    applyPlan: async (r) => { const p = owners.plan.get(r.planId) ?? current; return own(p, await p.backend.applyPlan(r)); },

    getOperation: (id) => byOp(id).backend.getOperation(id),
    async listOperations(instanceId) {
      const out: OperationStatus[] = [];
      for (const p of all) {
        if (!p.handshake) continue;
        if (instanceId && byInstance(instanceId) !== p) continue;
        try { for (const op of await p.backend.listOperations(instanceId)) { owners.op.set(op.operationId, p); out.push(op); } } catch { /* that side is unreachable */ }
      }
      return out;
    },
    watchOperation: (id, l) => byOp(id).backend.watchOperation(id, l),
    cancelOperation: (id) => byOp(id).backend.cancelOperation(id),
    getRecoveryStatus: (id) => byInstance(id).backend.getRecoveryStatus(id),
    listContent: (id, area) => byInstance(id).backend.listContent(id, area),
    checkExport: (id, f) => byInstance(id).backend.checkExport(id, f),
    startExport: async (r) => own(byInstance(r.instanceId), await byInstance(r.instanceId).backend.startExport(r)),
    versionCatalog: (q) => current.backend.versionCatalog ? current.backend.versionCatalog(q) : Promise.reject(new BackendError('unsupported', 'No version catalog here.')),
    projectVersions: (id, prov, pid) => { const b = byInstance(id).backend; return b.projectVersions ? b.projectVersions(id, prov, pid) : Promise.reject(new BackendError('unsupported', 'No version list here.')); },
    runRecovery: async (opId, key) => { const p = byOp(opId); if (!p.backend.runRecovery) throw new BackendError('unsupported', 'Recovery is not available here.'); return own(p, await p.backend.runRecovery(opId, key)); },
    requestLaunch: async (id, key) => own(byInstance(id), await byInstance(id).backend.requestLaunch(id, key)),
  };
  return backend;
}

export type CompositeBackend = ReturnType<typeof createCompositeBackend>;
export const isComposite = (b: ManagerBackend): b is CompositeBackend => b.kind === 'composite';
