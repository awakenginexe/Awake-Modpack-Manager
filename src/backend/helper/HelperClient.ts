import {
  BackendError, TERMINAL_STATES,
  type Accepted, type Capability, type DraftChange, type Handshake, type InstalledMod, type InstanceSummary, type Installation,
  type LoaderKind, type ModInventory, type OperationStatus, type PlanIssue, type PlanItem, type ProjectVersion, type ResolvedPlan, type VersionRef,
} from '../contract';
import { createRpc } from '../coordinator/rpc';
import { CORE_VERSION, descriptorError, paramsError, resultError, type CoreMethod } from '../core/schema';
import type {
  CoreAccepted, CoreCapabilities, CoreChange, CoreHello, CoreInfo, CoreInstalled, CoreOperation, CorePlanPage, CoreVersion, CoreWorkspace,
} from '../core/types';
import type { ConnectionState, ManagerBackend } from '../ManagerBackend';
import type { HelperStatus, PipeTransport } from '../launcher/transport';

export const HELPER_INSTALLATION = 'manager';
const PAGE = 200; // core hello limits.pageItems
const CORE_LOADERS = ['vanilla', 'fabric'] as const;
type CoreLoader = (typeof CORE_LOADERS)[number];

export interface HelperClientOptions {
  transport: PipeTransport | null;
  clientVersion: string;
  requestTimeoutMs?: number;
  /** How long to wait for a freshly started helper to publish its endpoint. */
  startTimeoutMs?: number;
  pollMs?: number;
  /** Liveness check while connected; a failed check reconnects once, restarting a crashed helper. 0 disables. */
  heartbeatMs?: number;
}

/**
 * Manager backend for the Manager's bundled native helper, `awake-core-host.exe` (protocol 2.0,
 * role `modpack-core`, src/backend/core/schema.ts). The helper owns the Manager's standalone
 * workspaces: Modrinth search, downloads, dependency resolution, durable prepare/apply, recovery.
 * This client only asks and displays. Every request and reply is validated against the pinned
 * schema; a method is used only when hello advertises it. A test stub never gets write access.
 */
export function createHelperClient(options: HelperClientOptions): ManagerBackend {
  const listeners = new Set<(s: ConnectionState) => void>();
  let state: ConnectionState = 'disconnected';
  let status: HelperStatus | null = null;
  let info: CoreInfo | null = null;
  const setState = (s: ConnectionState) => {
    if (s === state) return;
    state = s;
    for (const l of listeners) l(s);
  };
  const transport = () => {
    const t = options.transport;
    if (!t?.ensureHelper || !t.openHelper) throw new BackendError('helper-unavailable', 'Standalone projects need the Awake Modpack Manager desktop app.');
    return t as Required<PipeTransport>;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const poll = options.pollMs ?? 500;

  async function ensure(): Promise<HelperStatus> {
    const deadline = Date.now() + (options.startTimeoutMs ?? 20_000);
    for (;;) {
      status = await transport().ensureHelper();
      if (status.state === 'ready' && status.descriptor) {
        const bad = descriptorError(status.descriptor);
        if (bad) throw new BackendError('helper-unavailable', `The helper published an invalid endpoint: ${bad}`, 'descriptor');
        return status;
      }
      if (status.state === 'not_installed') throw new BackendError('helper-unavailable', status.message ?? 'The Manager helper is not installed. Reinstall Awake Modpack Manager.', 'not_installed');
      if (status.state === 'failed') throw new BackendError('helper-unavailable', status.message ?? 'The Manager helper could not start.', 'failed');
      if (Date.now() > deadline) throw new BackendError('helper-unavailable', 'The Manager helper did not become ready in time.', 'timeout');
      await sleep(Math.min(poll, 250));
    }
  }

  const rpc = createRpc({
    transport,
    clientVersion: options.clientVersion,
    timeoutMs: options.requestTimeoutMs ?? 30_000,
    pageLimit: PAGE,
    versions: [CORE_VERSION],
    validate: { params: (m, p) => paramsError(m as CoreMethod, p), result: (m, r) => resultError(m as CoreMethod, r) },
    peer: 'The Manager helper',
    storePrefix: 'core-ops',
    onLost: () => setState('disconnected'),
    async locate() {
      const d = (await ensure()).descriptor!;
      return { conn: await transport().openHelper(d.serverName, d.pid), expect: { profileId: d.profileId, sessionId: d.sessionId } };
    },
    checkHello(h) {
      if (h.role !== 'modpack-core') throw new BackendError('identity', 'The helper endpoint reported a different role.');
    },
  });
  const call = <T>(m: CoreMethod, params: Record<string, unknown>) => rpc.call<T>(m, params);
  const hello = () => rpc.hello() as unknown as CoreHello | null;
  const stub = () => !!status?.stub;
  /** Advertised and allowed: a stub gets reads only. */
  const has = (m: keyof CoreCapabilities, write = false) => hello()?.capabilities[m] === true && !(write && stub());
  const notYet = (what = 'this'): Promise<never> => Promise.reject(new BackendError('unsupported', `The Manager helper in this build does not support ${what} yet.`));

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function startHeartbeat() {
    clearInterval(heartbeat);
    if (!options.heartbeatMs) return;
    heartbeat = setInterval(() => {
      if (state === 'connected' && has('core.info')) call('core.info', {}).catch(() => undefined);
    }, options.heartbeatMs);
  }

  /* ----- identity of workspaces and their content ----- */

  const workspaces = new Map<string, CoreWorkspace>();
  const key = (physicalId: string) => `core|${physicalId}`;
  const workspaceOf = (id: string) => {
    const w = workspaces.get(id);
    if (!w) throw new BackendError('rejected', 'This project is not known to the Manager helper. Refresh the list.', 'NOT_FOUND');
    return w;
  };
  /** Last inventory per workspace: drafts name mods by inventoryId; replace needs their projectId. */
  const inventories = new Map<string, Map<string, CoreInstalled>>();
  /** Plan digest per operation, so every status of that operation carries it. */
  const digests = new Map<string, string>();
  /** The prepared, not yet applied plan per workspace; replaced plans are cancelled (no auto-expiry). */
  const prepared = new Map<string, string>();

  const coreLoader = (l: LoaderKind | undefined): CoreLoader => {
    if (l && (CORE_LOADERS as readonly string[]).includes(l)) return l as CoreLoader;
    throw new BackendError('unsupported', 'The Manager helper supports vanilla and Fabric so far.');
  };
  const time = (ms: string) => { const n = Number(ms); return new Date(n < 1e12 ? n * 1000 : n).toISOString(); };
  const fileStem = (f: string) => f.replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, '');

  function toInstance(w: CoreWorkspace): InstanceSummary {
    const id = key(w.physicalId);
    workspaces.set(id, w);
    return {
      id, name: w.name, minecraftVersion: w.minecraftVersion,
      loader: { kind: w.loader.id, version: w.loader.version || undefined },
      status: w.recoveryRequired ? 'broken' : 'ready',
      manageable: !w.recoveryRequired, blockedReason: w.recoveryRequired ? 'recovery' : undefined,
      revision: w.instanceRevision,
    };
  }

  function toMod(it: CoreInstalled): InstalledMod {
    return {
      key: it.inventoryId, fileName: it.fileName, name: fileStem(it.fileName),
      source: it.projectId ? 'modrinth' : 'manual', projectId: it.projectId ?? undefined,
      installed: it.versionId ? { id: it.versionId, name: it.versionNumber ?? it.versionId } : null,
      enabled: it.enabled, sizeBytes: Number.isSafeInteger(Number(it.size)) ? Number(it.size) : undefined,
      metadataState: it.metadataState === 'unknown' ? 'unindexed' : 'indexed',
      locallyModified: it.metadataState === 'modified', kind: 'jar', updateLocked: it.updateLocked,
    };
  }

  const toVersion = (v: CoreVersion): ProjectVersion => ({
    id: v.versionId, name: v.name, versionNumber: v.versionNumber, releaseType: v.releaseType,
    gameVersions: v.gameVersions, loaders: v.loaders, fileName: v.files[0]?.fileName,
    sizeBytes: v.files[0] ? Number(v.files[0].size) : undefined,
    dependencies: v.dependencies.map((d) => ({ projectId: d.projectId, versionId: d.versionId, type: d.type })),
  });

  function toStatus(op: CoreOperation): OperationStatus {
    const ws = op.result?.workspace;
    if (ws) toInstance(ws);
    const digest = op.result?.planDigest ?? digests.get(op.operationId);
    const total = op.progress?.total ? Number(op.progress.total) : 0;
    return {
      operationId: op.operationId,
      kind: op.kind === 'workspace-create' ? 'create-instance' : 'apply-plan',
      instanceId: op.physicalId ? key(op.physicalId) : ws ? key(ws.physicalId) : undefined,
      planHash: digest,
      state: op.state,
      progress: total ? Math.min(1, Number(op.progress!.completed) / total) : undefined,
      step: op.progress?.phase,
      startedAt: time(op.createdAt), updatedAt: time(op.updatedAt),
      // Cancel is a request: allowed before Apply acquires the workspace, never during replacement or recovery.
      cancellable: has('operations.cancel', true) && !op.terminal && !op.cancellationRequested && ['queued', 'resolving', 'downloading', 'prepared'].includes(op.state),
      error: op.error ? { code: op.error.code, message: op.error.message } : undefined,
      result: { revision: op.result?.instanceRevision, instanceId: ws ? key(ws.physicalId) : undefined },
    };
  }

  async function readOp(operationId: string): Promise<CoreOperation> {
    const op = await call<CoreOperation>('operations.get', { operationId });
    if (op.operationId !== operationId) throw new BackendError('protocol', 'The helper returned a different operation.');
    return op;
  }

  /** Submit side-effect work; fresh accepted work is never terminal success. */
  async function submit(method: CoreMethod, params: Record<string, unknown>): Promise<CoreAccepted> {
    return call<CoreAccepted>(method, params);
  }

  /** Every page of a paged read; the helper bounds pages at 200 items. */
  async function all<T, R extends { nextOffset: number | null }>(method: CoreMethod, base: Record<string, unknown>, pick: (r: R) => T[]): Promise<{ items: T[]; first: R | null }> {
    const items: T[] = [];
    let offset = 0;
    let first: R | null = null;
    for (;;) {
      const page = await call<R>(method, { ...base, offset, limit: PAGE });
      first ??= page;
      items.push(...pick(page));
      if (page.nextOffset === null) return { items, first };
      if (page.nextOffset <= offset) throw new BackendError('protocol', 'Helper pagination did not advance.');
      offset = page.nextOffset;
    }
  }

  const coreError = (e: { code: string; message: string } | undefined, fallback: string): BackendError => {
    const map: Record<string, BackendError['code']> = { STALE_INSTANCE: 'stale-revision', STALE_PLAN: 'plan-expired', BUSY: 'instance-busy', RECOVERY_REQUIRED: 'recovery-required' };
    return new BackendError(e ? map[e.code] ?? 'rejected' : 'rejected', e?.message ?? fallback, e?.code);
  };

  /** Draft changes in the helper's terms. Installs without a chosen version get the newest compatible release. */
  async function toChanges(id: string, changes: DraftChange[]): Promise<CoreChange[]> {
    const inv = inventories.get(id) ?? new Map<string, CoreInstalled>();
    const out: CoreChange[] = [];
    for (const c of changes) {
      if (c.kind === 'install') {
        if (c.provider !== 'modrinth') throw new BackendError('unsupported', 'Only Modrinth mods can be installed by the Manager helper so far.');
        const versionId = c.versionId ?? (await newestRelease(id, c.projectId))?.id;
        if (!versionId) throw new BackendError('rejected', `${c.name} has no version for this Minecraft version and loader.`);
        out.push({ action: 'install', projectId: c.projectId, versionId });
      } else if (c.kind === 'update') {
        const projectId = inv.get(c.modKey)?.projectId;
        if (!projectId) throw new BackendError('rejected', 'This file has no Modrinth project, so it cannot be updated.');
        out.push({ action: 'replace', projectId, versionId: c.targetVersionId });
      } else {
        out.push({ action: c.kind, inventoryId: c.modKey });
      }
    }
    return out;
  }

  async function versionsOf(id: string, projectId: string): Promise<ProjectVersion[]> {
    const w = workspaceOf(id);
    const page = await call<{ versions: CoreVersion[] }>('providers.versions', {
      provider: 'modrinth', minecraftVersion: w.minecraftVersion, loader: coreLoader(w.loader.id), projectId, limit: 50,
    });
    return page.versions.map(toVersion);
  }
  async function newestRelease(id: string, projectId: string): Promise<VersionRef | undefined> {
    const list = await versionsOf(id, projectId);
    return list.find((v) => v.releaseType === 'release') ?? list[0];
  }

  /** The full reviewed plan: every page, all with the same digest. */
  async function readPlan(id: string, operationId: string): Promise<ResolvedPlan> {
    const { items: files, first } = await all<CorePlanPage['files'][number], CorePlanPage>('plans.get', { operationId }, (p) => p.files);
    const head = first!;
    digests.set(operationId, head.planDigest);
    const items: PlanItem[] = files.map((f) => ({
      action: f.action === 'replace' ? 'update' : f.action,
      modKey: f.path, name: f.path.split('/').pop() ?? f.path,
      reason: 'requested',
      destructive: f.action !== 'install',
    }));
    const issues: PlanIssue[] = [
      ...head.warnings.map((w) => ({ severity: 'warning' as const, code: 'coordinator-warning' as const, message: w, modKeys: [] })),
      ...head.dependencies.filter((d) => d.type === 'incompatible').map((d) => ({ severity: 'warning' as const, code: 'incompatible' as const, message: `Declared incompatible: ${d.projectId ?? 'unknown project'}`, modKeys: [] })),
      ...head.dependencies.filter((d) => d.type === 'required').map((d) => ({ severity: 'info' as const, code: 'dependency-included' as const, message: `Required dependency included and verified: ${d.projectId ?? 'unknown project'}${d.versionId ? ` (${d.versionId})` : ''}`, modKeys: [] })),
    ];
    return {
      planId: operationId, planHash: head.planDigest, instanceId: id, baseRevision: head.instanceRevision,
      items, issues,
      // Optional dependencies are reported, never downloaded silently; the user may add them.
      optional: head.dependencies.filter((d) => d.type === 'optional' && d.projectId).map((d) => ({ provider: 'modrinth' as const, projectId: d.projectId!, name: d.projectId!, suggestedBy: [] })),
      blocked: false,
    };
  }

  function capabilities(): Capability[] {
    const caps: Capability[] = ['installations.discover'];
    if (has('workspaces.list')) caps.push('instances.list');
    if (has('mods.list')) caps.push('mods.inventory');
    if (has('providers.search')) caps.push('providers.search');
    if (has('operations.get')) {
      caps.push('operations.watch');
      if (has('operations.list')) caps.push('operations.reconnect');
      if (has('operations.cancel', true)) caps.push('operations.cancel');
      if (has('workspaces.create', true) && has('catalog.versions')) caps.push('instances.create');
      if (has('plans.prepare', true) && has('plans.get')) {
        caps.push('plan.validate', 'plan.prepare');
        if (has('transactions.apply', true)) caps.push('plan.apply');
      }
    }
    if (has('recovery.list')) caps.push('recovery.status');
    return caps;
  }

  return {
    kind: 'helper',

    async connect(): Promise<Handshake> {
      setState('connecting');
      try {
        await rpc.serial(rpc.open);
        info = has('core.info') ? await call<CoreInfo>('core.info', {}) : null;
      } catch (e) {
        setState('disconnected');
        throw rpc.toBackendError(e);
      }
      setState('connected');
      startHeartbeat();
      const search = has('providers.search');
      const reason = stub() ? 'helper-stub' : 'helper-pending';
      return {
        contract: `${CORE_VERSION.major}.${CORE_VERSION.minor}`,
        launcherVersion: hello()?.coreVersion ?? '',
        stub: stub(),
        capabilities: capabilities(),
        providers: [
          { id: 'modrinth', available: search, unavailableReason: search ? undefined : reason },
          { id: 'curseforge', available: false, unavailableReason: 'helper-modrinth-only' },
        ],
        packProviders: (['modrinth', 'curseforge', 'ftb', 'atlauncher', 'technic'] as const).map((id) => ({ id, available: false, unavailableReason: 'helper-packs-pending' })),
      };
    },
    onConnectionChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    async listInstallations(): Promise<Installation[]> {
      return [{ id: HELPER_INSTALLATION, displayName: 'Manager projects', path: info?.workspaceRoot ?? status?.dataRoot ?? '', launcherVersion: hello()?.coreVersion ?? '', portable: false, available: state === 'connected' }];
    },

    async listInstances(): Promise<InstanceSummary[]> {
      if (!has('workspaces.list')) return [];
      const { items } = await all<CoreWorkspace, { workspaces: CoreWorkspace[]; nextOffset: number | null }>('workspaces.list', {}, (p) => p.workspaces);
      return items.map(toInstance);
    },

    async getInventory(instanceId, onProgress): Promise<ModInventory> {
      const w = workspaceOf(instanceId);
      const { items, revision } = await rpc.paged<{ nextOffset: number | null; instanceRevision: string; total: number }, CoreInstalled>(
        'mods.list', { physicalId: w.physicalId }, 'items', (l, t) => onProgress?.(l, t),
      );
      inventories.set(instanceId, new Map(items.map((m) => [m.inventoryId, m])));
      const mods = items.map(toMod);
      if (has('updates.check')) {
        try {
          const { items: updates } = await all<{ projectId: string; installedVersionId: string; candidate: CoreVersion | null; excluded: boolean }, { updates: never[]; nextOffset: number | null }>(
            'updates.check', { physicalId: w.physicalId }, (p) => p.updates,
          );
          for (const u of updates) {
            if (u.excluded || !u.candidate) continue;
            const m = mods.find((x) => x.projectId === u.projectId && x.installed?.id === u.installedVersionId);
            if (m) m.available = { id: u.candidate.versionId, name: u.candidate.versionNumber, releaseType: u.candidate.releaseType };
          }
        } catch { /* update availability is optional; the inventory stands on its own */ }
      }
      return { instanceId, revision, mods };
    },

    async createInstance(r) {
      if (!has('workspaces.create', true)) return notYet('creating projects');
      const loader = coreLoader(r.loader);
      const acc = await submit('workspaces.create', { idempotencyKey: r.idempotencyKey, name: r.name, minecraftVersion: r.minecraftVersion, loader: { id: loader, version: loader === 'vanilla' ? '' : r.loaderVersion ?? '' } });
      return { operationId: acc.operationId };
    },

    async versionCatalog(q) {
      if (!has('catalog.versions')) return notYet('the version catalog');
      const params: Record<string, unknown> = {};
      if (q.minecraftVersion) params.minecraftVersion = q.minecraftVersion;
      if (q.loader) params.loader = coreLoader(q.loader);
      const r = await call<{ minecraftVersions: string[]; loaderVersions: string[] }>('catalog.versions', params);
      return { ...r, loaders: (info?.supportedLoaders ?? ['vanilla']) as LoaderKind[] };
    },

    async search(q) {
      if (!has('providers.search')) return notYet('mod search');
      if (q.provider !== 'modrinth') throw new BackendError('unsupported', 'Only Modrinth is available in the Manager helper.');
      const r = await call<{ projects: { projectId: string; title: string; description: string; iconUrl: string | null }[]; total: number }>('providers.search', {
        provider: 'modrinth', minecraftVersion: q.minecraftVersion, loader: coreLoader(q.loader), query: q.text, offset: q.offset, limit: Math.min(Math.max(q.limit, 1), PAGE),
      });
      return {
        total: r.total,
        hits: r.projects.map((p) => ({ provider: 'modrinth' as const, projectId: p.projectId, name: p.title, author: '', summary: p.description, iconUrl: p.iconUrl ?? undefined, compatible: true })),
      };
    },
    async projectVersions(instanceId, provider, projectId) {
      if (!has('providers.versions')) return notYet('version lists');
      if (provider !== 'modrinth') throw new BackendError('unsupported', 'Only Modrinth is available in the Manager helper.');
      return versionsOf(instanceId, projectId);
    },

    async validateDraft(d) {
      if (!has('plans.prepare', true) || !has('plans.get')) return notYet('reviewing changes');
      const w = workspaceOf(d.instanceId);
      const old = prepared.get(d.instanceId);
      if (old && has('operations.cancel', true)) await call('operations.cancel', { operationId: old }).catch(() => undefined);
      prepared.delete(d.instanceId);
      const acc = await submit('plans.prepare', { idempotencyKey: crypto.randomUUID(), physicalId: w.physicalId, instanceRevision: d.baseRevision, changes: await toChanges(d.instanceId, d.changes) });
      // Resolve, download and verify happen in the helper; the plan exists once the operation is prepared.
      let op = await readOp(acc.operationId);
      while (op.state !== 'prepared' && !TERMINAL_STATES.includes(op.state) && op.state !== 'recovery_required') {
        await sleep(poll);
        op = await readOp(acc.operationId);
      }
      if (op.state !== 'prepared') throw coreError(op.error, 'The helper could not prepare these changes.');
      prepared.set(d.instanceId, op.operationId);
      return readPlan(d.instanceId, op.operationId);
    },
    // The reviewed plan is immutable: re-reading it returns the same digest unless the helper replaced it.
    preparePlan: async (planId) => {
      const id = [...prepared].find(([, op]) => op === planId)?.[0];
      if (!id) throw new BackendError('plan-expired', 'This plan is no longer prepared. Review the changes again.');
      return readPlan(id, planId);
    },
    async applyPlan(r) {
      if (!has('transactions.apply', true)) return notYet('applying changes');
      const acc = await submit('transactions.apply', { idempotencyKey: r.idempotencyKey, operationId: r.planId, planDigest: r.planHash, instanceRevision: r.baseRevision });
      for (const [id, op] of prepared) if (op === r.planId) prepared.delete(id);
      digests.set(acc.operationId, r.planHash);
      return { operationId: acc.operationId };
    },

    getOperation: async (id) => toStatus(await readOp(id)),
    async listOperations(instanceId) {
      if (!has('operations.list')) return [];
      const { items } = await all<CoreOperation, { operations: CoreOperation[]; nextOffset: number | null }>('operations.list', {}, (p) => p.operations);
      return items.map(toStatus).filter((o) => !instanceId || o.instanceId === instanceId);
    },
    watchOperation: () => () => {},
    async cancelOperation(operationId) {
      if (!has('operations.cancel', true)) return notYet('cancelling');
      await call('operations.cancel', { operationId });
    },
    async getRecoveryStatus(instanceId) {
      if (!has('recovery.list')) return notYet('recovery');
      const w = workspaceOf(instanceId);
      const r = await call<{ operations: CoreOperation[]; blockedWorkspaces: string[] }>('recovery.list', {});
      const ops = r.operations.filter((o) => o.physicalId === w.physicalId);
      return { instanceId, pending: r.blockedWorkspaces.includes(w.physicalId) || ops.length > 0, message: ops[0]?.error?.message, backups: [] };
    },
    async runRecovery(operationId, idempotencyKey): Promise<Accepted> {
      if (!has('recovery.run', true)) return notYet('recovery');
      const acc = await submit('recovery.run', { idempotencyKey, operationId, action: 'rollback' });
      return { operationId: acc.operationId };
    },

    // Not in this helper slice (core-protocol.md): CurseForge, modpack catalogs, content listing, export.
    searchPacks: () => notYet('modpack search'), packVersions: () => notYet('modpack search'), installPack: () => notYet('modpack installs'),
    listContent: () => notYet('file listing'), checkExport: () => notYet('export'), startExport: () => notYet('export'),
    // The helper never launches Minecraft or signs in; playing goes through Awake Launcher.
    requestLaunch: () => Promise.reject(new BackendError('unsupported', 'Playing needs Awake Launcher.')),
  };
}
