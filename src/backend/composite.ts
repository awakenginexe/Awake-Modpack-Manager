import { BackendError, isLauncherWait, type Handshake, type InstanceSummary, type Installation, type OperationStatus } from './contract';
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
  /** Connected instances: helper id -> the Launcher's id for the same folder. */
  const sharedOf = new Map<string, string>();
  const launcherPaths = new Map<string, string>();
  const samePath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  let retry: ReturnType<typeof setTimeout> | undefined;

  const all = [parts.helper, parts.launcher];
  const noHelper = (): Promise<never> => Promise.reject(new BackendError('unsupported', 'Only Manager projects (the Manager helper) support this.'));
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
    if (!isLauncherWait(parts.launcher.error?.code) && parts.launcher.error?.code !== 'disconnected' && parts.launcher.error?.code !== 'timeout') return;
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

  /** A connected instance appears once: edited through the helper, shown with the Launcher's state and image. */
  async function withShared(list: InstanceSummary[]): Promise<InstanceSummary[]> {
    for (const i of list) if (i.path) launcherPaths.set(i.id, i.path);
    if (!parts.helper.handshake) return list;
    const connected = new Map((await helper.listInstances('manager').catch(() => [] as InstanceSummary[])).filter((w) => w.sharedRoot).map((w) => [samePath(w.sharedRoot!), w]));
    sharedOf.clear();
    return list.map((i) => {
      const w = i.path ? connected.get(samePath(i.path)) : undefined;
      if (!w) return i;
      owners.instance.set(w.id, parts.helper);
      sharedOf.set(w.id, i.id);
      return { ...w, path: i.path, iconUrl: i.iconUrl, shared: true, launcher: i.launcher, status: i.status === 'ready' ? w.status : i.status };
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
    makeProfilePrivate: async () => { await launcher.makeProfilePrivate?.(); clearTimeout(retry); await connectPart(parts.launcher); emit(); scheduleLauncherRetry(); },
    setPreferredProfile: (d) => launcher.setPreferredProfile?.(d),
    instanceWarnings: () => current.backend.instanceWarnings?.() ?? [],

    async listInstances(installationId) {
      const p = backend.partFor(installationId);
      current = p;
      if (!p.handshake) throw p.error ?? new BackendError('disconnected', 'Not connected.');
      const list = await p.backend.listInstances(installationId);
      for (const i of list) owners.instance.set(i.id, p);
      // The Manager's own list holds its projects; connected instances belong to the Launcher's list.
      return p === parts.launcher ? withShared(list) : list.filter((i) => !i.sharedRoot);
    },
    createInstance: async (r) => own(current, await current.backend.createInstance(r)),
    getInventory: (id, onProgress) => byInstance(id).backend.getInventory(id, onProgress),

    // Search and packs follow the selected installation; each side reports its own availability.
    search: (q) => (q.instanceId ? byInstance(q.instanceId) : current).backend.search(q),
    // Packs always become Manager projects, whichever list is on screen.
    searchPacks: (q) => helper.searchPacks(q),
    packVersions: (prov, id) => helper.packVersions(prov, id),
    installPack: async (r) => own(parts.helper, await helper.installPack(r)),
    deleteInstance: async (id, key) => { const p = byInstance(id); if (!p.backend.deleteInstance) throw new BackendError('unsupported', 'Delete this instance in Awake Launcher.'); return own(p, await p.backend.deleteInstance(id, key)); },
    renameInstance: async (id, name) => { const b = byInstance(id).backend; if (!b.renameInstance) throw new BackendError('unsupported', 'Rename this instance in Awake Launcher.'); await b.renameInstance(id, name); },
    checkUpdates: (id) => { const b = byInstance(id).backend; return b.checkUpdates ? b.checkUpdates(id) : Promise.resolve([]); },
    preparePackUpdate: async (id, versionId, onStep) => {
      const p = byInstance(id);
      if (!p.backend.preparePackUpdate) throw new BackendError('unsupported', 'Only Manager projects can update their modpack here.');
      const plan = await p.backend.preparePackUpdate(id, versionId, onStep);
      owners.plan.set(plan.planId, p);
      return plan;
    },
    finishPackUpdate: async (id) => { await byInstance(id).backend.finishPackUpdate?.(id); },
    shutdownHelper: async () => { await helper.shutdownHelper?.(); },
    resumeHelper: () => helper.resumeHelper?.(),
    discardPlan: async (id) => { await byInstance(id).backend.discardPlan?.(id); },
    projectDetail: (provider, projectId) => (helper.projectDetail ? helper.projectDetail(provider, projectId) : noHelper()),
    recycleContent: async (id, area, paths) => { await byInstance(id).backend.recycleContent?.(id, area, paths); },
    openFolder: async (id, area) => { await byInstance(id).backend.openFolder?.(id, area); },

    async validateDraft(d, resolutions) {
      const p = byInstance(d.instanceId);
      const plan = await p.backend.validateDraft(d, resolutions);
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
    requestLaunch: async (id, key) => {
      const launcherId = sharedOf.get(id);
      if (launcherId) return own(parts.launcher, await launcher.requestLaunch(launcherId, key));
      return own(byInstance(id), await byInstance(id).backend.requestLaunch(id, key));
    },
    canShareInstances: () => !!parts.helper.handshake && !!parts.launcher.handshake && !!helper.canAdopt?.() && !!launcher.canEnroll?.(),
    async shareInstance(id) {
      const path = launcherPaths.get(id);
      if (!path || !helper.adoptInstance || !launcher.enrollInstance) throw new BackendError('unsupported', 'Update Awake Launcher to 3.2.0 or newer to manage this instance here.');
      // The Launcher refuses to start the game for this instance until it hears the outcome.
      await launcher.enrollInstance(id, 'begin');
      try { await helper.adoptInstance(path); } catch (e) { await launcher.enrollInstance(id, 'abort').catch(() => undefined); throw e; }
      await launcher.enrollInstance(id, 'finish');
    },
    async stopSharingInstance(id) {
      const launcherId = sharedOf.get(id);
      if (!launcherId || !helper.releaseInstance || !launcher.enrollInstance) throw new BackendError('unsupported', 'Open Awake Launcher first.');
      await launcher.enrollInstance(launcherId, 'begin');
      try { await helper.releaseInstance(id); } catch (e) { await launcher.enrollInstance(launcherId, 'abort').catch(() => undefined); throw e; }
      await launcher.enrollInstance(launcherId, 'finish');
      sharedOf.delete(id);
      owners.instance.delete(id);
    },
    openInLauncher: async (id) => {
      const backend = byInstance(id).backend;
      if (!backend.openInLauncher) throw new BackendError('unsupported', 'This workspace cannot be opened in Launcher.');
      await backend.openInLauncher(id);
    },

    // Imports always land in the Manager's own workspaces: they go to the helper, never the Launcher.
    canImport: () => !!parts.helper.handshake && !!helper.canImport?.(),
    uploadImport: (f, onProgress, signal) => (helper.uploadImport ? helper.uploadImport(f, onProgress, signal) : noHelper()),
    inspectImport: (token, format) => (helper.inspectImport ? helper.inspectImport(token, format) : noHelper()),
    canResolveDependencies: () => !!parts.helper.handshake && !!helper.canResolveDependencies?.(),
    async prepareImport(id, token, format, includeOptional, resolutions) {
      if (!helper.prepareImport || byInstance(id) !== parts.helper) return noHelper();
      const plan = await helper.prepareImport(id, token, format, includeOptional, resolutions);
      owners.plan.set(plan.planId, parts.helper);
      return plan;
    },
    discardImport: (token) => (helper.discardImport ? helper.discardImport(token) : noHelper()),
    forgetMissingMods: (id) => { const b = byInstance(id).backend; return b.forgetMissingMods ? b.forgetMissingMods(id) : noHelper(); },
    exportMatches: (id, target, names) => { const b = byInstance(id).backend; return b.exportMatches ? b.exportMatches(id, target, names) : noHelper(); },
    exportRestricted: (id, ids) => { const b = byInstance(id).backend; return b.exportRestricted ? b.exportRestricted(id, ids) : noHelper(); },
    prepareExport: (id, format, entries, onProgress) => { const b = byInstance(id).backend; return b.prepareExport ? b.prepareExport(id, format, entries, onProgress) : noHelper(); },
    exportInstanceZip: (id, meta, onProgress) => { const b = byInstance(id).backend; return b.exportInstanceZip ? b.exportInstanceZip(id, meta, onProgress) : noHelper(); },
    snapshotWorkspace: (id, onProgress) => { const b = byInstance(id).backend; return b.snapshotWorkspace ? b.snapshotWorkspace(id, onProgress) : noHelper(); },
  };
  return backend;
}

export type CompositeBackend = ReturnType<typeof createCompositeBackend>;
export const isComposite = (b: ManagerBackend): b is CompositeBackend => b.kind === 'composite';
