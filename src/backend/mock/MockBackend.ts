import {
  ALL_CAPABILITIES, BackendError, TERMINAL_STATES,
  type Accepted, type ApplyRequest, type Capability, type ContentArea, type ContentEntry, type CreateInstanceRequest,
  type Draft, type ExportFormat, type ExportReport, type ExportRequest, type Handshake, type InstalledMod,
  type InstanceSummary, type Installation, type ModInventory, type OperationKind, type OperationState,
  type OperationStatus, type PlanIssue, type PlanItem, type ProviderInfo, type RecoveryStatus, type ResolvedPlan,
  type SearchPage, type SearchQuery, type InstallPackRequest, type PackProviderId, type PackProviderInfo,
  type PackSearchPage, type PackSearchQuery, type PackVersion,
} from '../contract';
import type { ConnectionState, ManagerBackend } from '../ManagerBackend';
import { buildCatalog, buildInstances, buildInventory, buildPackCatalog, type CatalogProject } from './fixtures';

export interface MockOptions {
  /** Delay between simulated operation steps. 0 in tests (with fake timers). */
  stepMs?: number;
  /** Network latency for ordinary calls. */
  latencyMs?: number;
  capabilities?: Capability[];
  providers?: ProviderInfo[];
  packProviders?: PackProviderInfo[];
  /** The next prepare returns a materially different plan (new hash). */
  driftOnPrepare?: boolean;
  /** Apply fails during verification and the coordinator rolls back. */
  failApply?: boolean;
}

export { ALL_CAPABILITIES };

export const DEFAULT_PROVIDERS: ProviderInfo[] = [
  { id: 'modrinth', available: true },
  { id: 'curseforge', available: false, unavailableReason: 'curseforge-unauthorized' },
];

/** Mirrors an unkeyed build: CurseForge needs the Launcher's build-time API key. */
export const DEFAULT_PACK_PROVIDERS: PackProviderInfo[] = [
  { id: 'modrinth', available: true },
  { id: 'curseforge', available: false, unavailableReason: 'curseforge-unauthorized' },
  { id: 'ftb', available: true },
  { id: 'atlauncher', available: true },
  { id: 'technic', available: true },
];


interface StoredPlan { plan: ResolvedPlan; draft: Draft; drifted?: boolean }

function hash(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

const now = () => new Date().toISOString();

/**
 * In-memory stand-in for the Launcher coordinator. It simulates a coordinator's behaviour
 * (revisions, plan hashes, operation state machine, disconnects) on fixture data only.
 * It never touches the filesystem.
 */
export class MockBackend implements ManagerBackend {
  readonly kind = 'mock' as const;
  private opts: Required<Omit<MockOptions, 'capabilities' | 'providers' | 'packProviders'>> & Pick<MockOptions, 'capabilities' | 'providers' | 'packProviders'>;
  private connection: ConnectionState = 'disconnected';
  private connectionListeners = new Set<(s: ConnectionState) => void>();
  private catalog: CatalogProject[] = buildCatalog();
  private packs = buildPackCatalog();
  private instances: InstanceSummary[] = buildInstances();
  private inventories = new Map<string, InstalledMod[]>();
  private plans = new Map<string, StoredPlan>();
  private operations = new Map<string, OperationStatus>();
  private byIdempotency = new Map<string, string>();
  private watchers = new Map<string, Set<(s: OperationStatus) => void>>();
  private seq = 0;

  constructor(options: MockOptions = {}) {
    this.opts = { stepMs: 450, latencyMs: 120, driftOnPrepare: false, failApply: false, ...options };
    const sizes: Record<string, [number, number]> = { 'inst-atlas': [280, 11], 'inst-cozy': [64, 23], 'inst-sky': [140, 5], 'inst-vanilla': [0, 1], 'inst-old': [30, 3] };
    for (const inst of this.instances) {
      const [count, seed] = sizes[inst.id] ?? [0, 1];
      const mods = count ? buildInventory(this.catalog, count, seed, inst.minecraftVersion ?? '1.21.1') : [];
      this.inventories.set(inst.id, mods);
      inst.modCount = mods.length;
    }
  }

  /* ----- test & dev controls ----- */

  configure(options: Partial<MockOptions>) { Object.assign(this.opts, options); }
  simulateDisconnect() { this.setConnection('disconnected'); }
  /** Simulates another tool (e.g. the Launcher) changing the instance behind the Manager's back. */
  touchInstance(instanceId: string) { const inst = this.instance(instanceId); inst.revision = `${inst.revision}*`; }

  /* ----- connection ----- */

  async connect(): Promise<Handshake> {
    this.setConnection('connecting');
    await this.delay();
    this.setConnection('connected');
    return {
      contract: 'mock',
      launcherVersion: 'mock',
      capabilities: this.opts.capabilities ?? ALL_CAPABILITIES,
      providers: this.opts.providers ?? DEFAULT_PROVIDERS,
      packProviders: this.opts.packProviders ?? DEFAULT_PACK_PROVIDERS,
    };
  }

  onConnectionChange(listener: (s: ConnectionState) => void) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  private setConnection(state: ConnectionState) {
    this.connection = state;
    for (const l of this.connectionListeners) l(state);
  }

  private async call<T>(fn: () => T): Promise<T> {
    if (this.connection !== 'connected') throw new BackendError('disconnected', 'Not connected to the coordinator.');
    await this.delay();
    if (this.connection !== 'connected') throw new BackendError('disconnected', 'Connection lost during the request.');
    return structuredClone(fn());
  }

  private delay(ms = this.opts.latencyMs) { return new Promise<void>((r) => setTimeout(r, ms)); }

  private instance(id: string) {
    const inst = this.instances.find((i) => i.id === id);
    if (!inst) throw new BackendError('rejected', `Unknown instance ${id}`);
    return inst;
  }

  /* ----- inventory ----- */

  listInstallations(): Promise<Installation[]> {
    return this.call(() => [{ id: 'default', displayName: 'Awake Launcher', path: 'C:\\Users\\Player\\AppData\\Roaming\\AwakeLauncher', launcherVersion: '2.0.2', portable: false }]);
  }

  listInstances(): Promise<InstanceSummary[]> { return this.call(() => this.instances); }

  getInventory(instanceId: string): Promise<ModInventory> {
    return this.call(() => ({ instanceId, revision: this.instance(instanceId).revision, mods: this.inventories.get(instanceId) ?? [] }));
  }

  createInstance(request: CreateInstanceRequest): Promise<Accepted> {
    return this.call(() => this.startOperation('create-instance', request.idempotencyKey, undefined, undefined, () => {
      const id = `inst-${++this.seq}`;
      this.instances.push({ id, name: request.name, minecraftVersion: request.minecraftVersion, loader: { kind: request.loader }, modCount: 0, status: 'ready', manageable: true, revision: 'r1' });
      this.inventories.set(id, []);
      return { revision: 'r1', instanceId: id };
    }));
  }

  search(q: SearchQuery): Promise<SearchPage> {
    return this.call(() => {
      const provider = (this.opts.providers ?? DEFAULT_PROVIDERS).find((p) => p.id === q.provider);
      if (provider && !provider.available) throw new BackendError('unsupported', provider.unavailableReason ?? 'Provider unavailable');
      const text = q.text.trim().toLowerCase();
      const hits = this.catalog
        .filter((p) => p.provider === q.provider)
        .map((p) => ({ ...p, compatible: p.minecraftVersions.includes(q.minecraftVersion) && p.loaders.includes(q.loader) }))
        .filter((p) => (!text || p.name.toLowerCase().includes(text) || p.summary.toLowerCase().includes(text))
          && (!q.compatibleOnly || p.compatible)
          && (!p.latest?.releaseType || q.releaseTypes.includes(p.latest.releaseType)))
        .sort((a, b) => b.downloads - a.downloads);
      return {
        total: hits.length,
        hits: hits.slice(q.offset, q.offset + q.limit).map(({ provider, projectId, name, author, summary, downloads, compatible, latest }) => ({ provider, projectId, name, author, summary, downloads, compatible, latest })),
      };
    });
  }

  /* ----- modpacks ----- */

  private requirePackProvider(id: PackProviderId) {
    const info = (this.opts.packProviders ?? DEFAULT_PACK_PROVIDERS).find((p) => p.id === id);
    if (!info?.available) throw new BackendError('unsupported', info?.unavailableReason ?? 'Provider unavailable');
  }

  searchPacks(q: PackSearchQuery): Promise<PackSearchPage> {
    return this.call(() => {
      this.requirePackProvider(q.provider);
      const text = q.text.trim().toLowerCase();
      const hits = this.packs
        .filter((p) => p.provider === q.provider && (!text || p.name.toLowerCase().includes(text) || p.summary.toLowerCase().includes(text)))
        .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
      return { total: hits.length, hits: hits.slice(q.offset, q.offset + q.limit).map(({ versions: _v, modCount: _m, ...hit }) => hit) };
    });
  }

  packVersions(provider: PackProviderId, packId: string): Promise<PackVersion[]> {
    return this.call(() => {
      this.requirePackProvider(provider);
      const pack = this.packs.find((p) => p.provider === provider && p.packId === packId);
      if (!pack) throw new BackendError('rejected', 'Unknown modpack');
      return pack.versions;
    });
  }

  installPack(request: InstallPackRequest): Promise<Accepted> {
    return this.call(() => {
      this.requirePackProvider(request.provider);
      const pack = this.packs.find((p) => p.provider === request.provider && p.packId === request.packId);
      const version = pack?.versions.find((v) => v.id === request.versionId);
      if (!pack || !version) throw new BackendError('rejected', 'Unknown modpack version');
      return this.startOperation('install-pack', request.idempotencyKey, undefined, undefined, () => {
        const id = `inst-${++this.seq}`;
        const mods = buildInventory(this.catalog, Math.min(pack.modCount, 300), this.seq, version.minecraftVersion);
        this.instances.push({
          id, name: request.instanceName, minecraftVersion: version.minecraftVersion, loader: { kind: version.loader ?? 'forge' },
          modCount: mods.length, status: 'ready', manageable: true, revision: 'r1',
          pack: { provider: pack.provider, packId: pack.packId, packName: pack.name, versionId: version.id, versionName: version.name },
        });
        this.inventories.set(id, mods);
        return { revision: 'r1', instanceId: id };
      });
    });
  }

  /* ----- plans ----- */

  validateDraft(draft: Draft): Promise<ResolvedPlan> {
    return this.call(() => {
      const inst = this.instance(draft.instanceId);
      if (inst.revision !== draft.baseRevision) throw new BackendError('stale-revision', 'The instance changed since this draft was made.');
      if (!inst.manageable) throw new BackendError('instance-busy', inst.blockedReason ?? 'Instance cannot be managed now.');
      const plan = this.resolve(draft);
      this.plans.set(plan.planId, { plan, draft });
      return plan;
    });
  }

  preparePlan(planId: string): Promise<ResolvedPlan> {
    return this.call(() => {
      const stored = this.plans.get(planId);
      if (!stored) throw new BackendError('plan-expired', 'This plan is no longer available. Review it again.');
      const inst = this.instance(stored.draft.instanceId);
      if (inst.revision !== stored.plan.baseRevision) throw new BackendError('stale-revision', 'The instance changed after review.');
      if (stored.drifted) return stored.plan;
      let plan = this.resolve(stored.draft, planId);
      if (this.opts.driftOnPrepare) {
        this.opts.driftOnPrepare = false;
        const first = plan.items.find((i) => i.to);
        if (first?.to) first.to = { ...first.to, id: `${first.to.id}-new`, name: `${first.to.name}.1` };
        plan = { ...plan, planHash: hash(plan.items) };
        this.plans.set(planId, { plan, draft: stored.draft, drifted: true });
        return plan;
      }
      this.plans.set(planId, { plan, draft: stored.draft });
      return plan;
    });
  }

  private resolve(draft: Draft, planId = `plan-${++this.seq}`): ResolvedPlan {
    const mods = this.inventories.get(draft.instanceId) ?? [];
    const byKey = new Map(mods.map((m) => [m.key, m]));
    const installedProjects = new Set(mods.map((m) => m.projectId).filter(Boolean));
    const pinned = new Set(draft.pinnedKeys);
    const items: PlanItem[] = [];
    const issues: PlanIssue[] = [];
    const optional = new Map<string, { provider: CatalogProject['provider']; projectId: string; name: string; suggestedBy: string[] }>();
    const planned = new Set<string>();
    const removing = new Set(draft.changes.filter((c) => c.kind === 'remove').map((c) => (c as { modKey: string }).modKey));

    const addInstall = (project: CatalogProject, reason: PlanItem['reason'], requiredBy?: string) => {
      if (installedProjects.has(project.projectId) || planned.has(project.projectId)) {
        const existing = items.find((i) => i.modKey === project.projectId);
        if (existing && requiredBy) existing.requiredBy = [...(existing.requiredBy ?? []), requiredBy];
        return;
      }
      planned.add(project.projectId);
      items.push({ action: 'install', modKey: project.projectId, name: project.name, from: null, to: project.versions[0], reason, requiredBy: requiredBy ? [requiredBy] : undefined });
      for (const dep of project.requires) {
        const d = this.catalog.find((c) => c.projectId === dep);
        if (d) addInstall(d, 'required-dependency', project.name);
        else issues.push({ severity: 'warning', code: 'unknown-dependency', message: `${project.name} needs a dependency the provider could not identify.`, modKeys: [project.projectId] });
      }
      for (const opt of project.optional) {
        const o = this.catalog.find((c) => c.projectId === opt);
        if (o && !installedProjects.has(o.projectId)) {
          const s = optional.get(o.projectId) ?? { provider: o.provider, projectId: o.projectId, name: o.name, suggestedBy: [] };
          s.suggestedBy.push(project.name);
          optional.set(o.projectId, s);
        }
      }
      for (const bad of project.incompatibleWith) {
        if (installedProjects.has(bad) || planned.has(bad)) {
          issues.push({ severity: 'error', code: 'incompatible', message: `${project.name} declares itself incompatible with another mod in this plan.`, modKeys: [project.projectId, bad] });
        }
      }
    };

    for (const change of draft.changes) {
      if (change.kind === 'install') {
        const project = this.catalog.find((c) => c.projectId === change.projectId);
        if (project) addInstall(project, 'requested');
        continue;
      }
      const mod = byKey.get(change.modKey);
      if (!mod) continue;
      if (change.kind === 'update') {
        if (pinned.has(mod.key)) {
          issues.push({ severity: 'info', code: 'pinned-skipped', message: `${mod.name} is pinned and was left at its current version.`, modKeys: [mod.key] });
          continue;
        }
        const to = mod.available ?? undefined;
        if (!to || to.id === mod.installed?.id) continue;
        items.push({ action: 'update', modKey: mod.key, name: mod.name, from: mod.installed, to, reason: 'requested', destructive: mod.locallyModified });
        if (mod.locallyModified) issues.push({ severity: 'warning', code: 'locally-modified', message: `${mod.name} was changed locally. Updating replaces that file.`, modKeys: [mod.key] });
      } else if (change.kind === 'remove') {
        items.push({ action: 'remove', modKey: mod.key, name: mod.name, from: mod.installed, reason: 'requested', destructive: mod.source === 'manual' || mod.locallyModified });
        const dependents = mods.filter((m) => !removing.has(m.key) && (m.dependencies ?? []).some((d) => d.kind === 'required' && d.projectId && d.projectId === mod.projectId));
        if (dependents.length) issues.push({ severity: 'warning', code: 'missing-dependency', message: `${dependents.length} installed mods require ${mod.name}.`, modKeys: [mod.key, ...dependents.map((d) => d.key)] });
      } else if (change.kind === 'enable' || change.kind === 'disable') {
        if (mod.enabled === (change.kind === 'enable')) continue;
        items.push({ action: change.kind, modKey: mod.key, name: mod.name, from: mod.installed, reason: 'requested' });
      }
    }

    const manual = mods.filter((m) => m.source === 'manual');
    if (manual.length) issues.push({ severity: 'info', code: 'unknown-file', message: `${manual.length} files are not linked to a provider and will be kept unchanged.`, modKeys: manual.map((m) => m.key) });

    return {
      planId,
      planHash: hash(items),
      instanceId: draft.instanceId,
      baseRevision: draft.baseRevision,
      items,
      issues,
      optional: [...optional.values()],
      blocked: issues.some((i) => i.severity === 'error'),
    };
  }

  applyPlan(request: ApplyRequest): Promise<Accepted> {
    return this.call(() => {
      const existing = this.byIdempotency.get(request.idempotencyKey);
      if (existing) return { operationId: existing };
      const stored = this.plans.get(request.planId);
      if (!stored) throw new BackendError('plan-expired', 'This plan is no longer available.');
      if (stored.plan.planHash !== request.planHash) throw new BackendError('plan-expired', 'The plan changed since it was reviewed.');
      if (stored.plan.blocked) throw new BackendError('rejected', 'The plan has blocking issues.');
      const inst = this.instance(stored.plan.instanceId);
      // The real coordinator re-checks the baseline under its exclusive instance gate.
      if (inst.revision !== stored.plan.baseRevision) throw new BackendError('stale-revision', 'The instance changed after review.');
      const plan = stored.plan;
      return this.startOperation('apply-plan', request.idempotencyKey, plan.instanceId, plan.planHash, () => {
        this.commitPlan(plan);
        return { revision: this.instance(plan.instanceId).revision };
      });
    });
  }

  private commitPlan(plan: ResolvedPlan) {
    const inst = this.instance(plan.instanceId);
    const mods = this.inventories.get(plan.instanceId) ?? [];
    for (const item of plan.items) {
      const mod = mods.find((m) => m.key === item.modKey);
      if (item.action === 'install' && item.to) {
        const project = this.catalog.find((c) => c.projectId === item.modKey);
        mods.push({ key: item.modKey, fileName: `${item.name.toLowerCase().replace(/\s+/g, '-')}-${item.to.name}.jar`, name: item.name, source: project?.provider ?? 'modrinth', projectId: item.modKey, installed: item.to, available: item.to, enabled: true, dependencies: [] });
      } else if (mod && item.action === 'update' && item.to) {
        mod.installed = item.to;
        mod.locallyModified = false;
      } else if (mod && item.action === 'remove') {
        mods.splice(mods.indexOf(mod), 1);
      } else if (mod && (item.action === 'enable' || item.action === 'disable')) {
        mod.enabled = item.action === 'enable';
      }
    }
    inst.modCount = mods.length;
    inst.revision = `r${Number.parseInt(inst.revision.slice(1), 10) + 1 || 2}`;
  }

  /* ----- operations ----- */

  private startOperation(kind: OperationKind, idempotencyKey: string, instanceId: string | undefined, planHash: string | undefined, commit: () => OperationStatus['result']): Accepted {
    const existing = this.byIdempotency.get(idempotencyKey);
    if (existing) return { operationId: existing };
    const operationId = `op-${++this.seq}`;
    const status: OperationStatus = { operationId, kind, instanceId, planHash, state: 'preparing', progress: 0, startedAt: now(), updatedAt: now(), cancellable: true };
    this.operations.set(operationId, status);
    this.byIdempotency.set(idempotencyKey, operationId);
    if (instanceId) this.instance(instanceId).status = 'busy';
    void this.runOperation(status, commit);
    return { operationId };
  }

  private async runOperation(status: OperationStatus, commit: () => OperationStatus['result']) {
    const steps: [OperationState, number, string][] = [['waiting', 0.05, 'gate'], ['applying', 0.3, 'download'], ['applying', 0.6, 'stage'], ['applying', 0.85, 'swap'], ['verifying', 0.95, 'verify']];
    const fail = this.opts.failApply;
    for (const [state, progress, step] of steps) {
      await this.delay(this.opts.stepMs);
      if (status.state === 'cancelled') return this.finish(status);
      if (state === 'verifying') status.cancellable = false;
      this.update(status, { state, progress, step });
    }
    await this.delay(this.opts.stepMs);
    if (fail) {
      this.update(status, { state: 'recovering', step: 'restore', error: { code: 'verify-failed', message: 'A downloaded file did not match its expected hash.' } });
      await this.delay(this.opts.stepMs);
      this.update(status, { state: 'rolled_back', recovery: { backupId: `bk-${status.operationId}`, restored: true, message: 'The instance was restored to how it was before this change.' } });
    } else {
      const result = commit();
      this.update(status, { state: 'completed', progress: 1, step: 'done', result });
    }
    this.finish(status);
  }

  private finish(status: OperationStatus) {
    if (status.instanceId) {
      const inst = this.instances.find((i) => i.id === status.instanceId);
      if (inst && inst.status === 'busy') inst.status = 'ready';
    }
  }

  private update(status: OperationStatus, patch: Partial<OperationStatus>) {
    Object.assign(status, patch, { updatedAt: now() });
    // Events are only delivered while connected; a reconnecting client must re-read status.
    if (this.connection !== 'connected') return;
    for (const l of this.watchers.get(status.operationId) ?? []) l(structuredClone(status));
  }

  getOperation(operationId: string): Promise<OperationStatus> {
    return this.call(() => {
      const op = this.operations.get(operationId);
      if (!op) throw new BackendError('rejected', `Unknown operation ${operationId}`);
      return op;
    });
  }

  findOperationByIdempotencyKey(key: string): Promise<OperationStatus | null> {
    return this.call(() => {
      const id = this.byIdempotency.get(key);
      return id ? this.operations.get(id) ?? null : null;
    });
  }

  listOperations(instanceId?: string): Promise<OperationStatus[]> {
    return this.call(() => [...this.operations.values()].filter((o) => !instanceId || o.instanceId === instanceId).reverse());
  }

  watchOperation(operationId: string, listener: (s: OperationStatus) => void) {
    const set = this.watchers.get(operationId) ?? new Set();
    set.add(listener);
    this.watchers.set(operationId, set);
    return () => set.delete(listener);
  }

  cancelOperation(operationId: string): Promise<void> {
    return this.call(() => {
      const op = this.operations.get(operationId);
      if (!op) throw new BackendError('rejected', 'Unknown operation');
      if (TERMINAL_STATES.includes(op.state)) return;
      if (!op.cancellable) throw new BackendError('rejected', 'This operation can no longer be cancelled.');
      this.update(op, { state: 'cancelled', cancellable: false, step: 'cancelled' });
    });
  }

  getRecoveryStatus(instanceId: string): Promise<RecoveryStatus> {
    return this.call(() => ({
      instanceId,
      pending: false,
      backups: [...this.operations.values()].filter((o) => o.instanceId === instanceId && o.recovery?.backupId).map((o) => ({ backupId: o.recovery!.backupId!, createdAt: o.startedAt, label: o.operationId })),
    }));
  }

  /* ----- files & export ----- */

  listContent(instanceId: string, area: ContentArea): Promise<ContentEntry[]> {
    return this.call(() => {
      const mods = (this.inventories.get(instanceId) ?? []).slice(0, area === 'config' ? 40 : 6);
      const ext: Record<ContentArea, string> = { config: '.toml', defaultconfigs: '.toml', kubejs: '.js', scripts: '.zs', resourcepacks: '.zip', shaderpacks: '.zip' };
      return mods.map((m, i) => ({ path: `${area}/${m.name.toLowerCase().replace(/\s+/g, '_')}${ext[area]}`, kind: 'file' as const, sizeBytes: 800 + i * 137, modifiedAt: '2026-10-30T12:00:00Z' }));
    });
  }

  checkExport(instanceId: string, format: ExportFormat): Promise<ExportReport> {
    return this.call(() => ({
      format,
      entries: (this.inventories.get(instanceId) ?? []).map((m) => {
        if (m.source === 'manual') return { modKey: m.key, name: m.name, status: 'needs-permission' as const, note: 'manual' };
        if (format === 'mrpack' && m.source === 'curseforge') return { modKey: m.key, name: m.name, status: 'needs-permission' as const, note: 'cross-provider' };
        if (format === 'curseforge' && m.source === 'modrinth') return { modKey: m.key, name: m.name, status: 'needs-permission' as const, note: 'cross-provider' };
        if (m.source === 'curseforge' && Number(m.projectId?.split('-')[1]) % 13 === 0) return { modKey: m.key, name: m.name, status: 'blocked' as const, note: 'distribution-disabled' };
        return { modKey: m.key, name: m.name, status: 'provider-reference' as const };
      }),
    }));
  }

  startExport(request: ExportRequest): Promise<Accepted> {
    return this.call(() => this.startOperation('export', request.idempotencyKey, request.instanceId, undefined, () => ({ exportPath: `C:\\Users\\Player\\Documents\\${request.name}-${request.version}.${request.format === 'mrpack' ? 'mrpack' : 'zip'}` })));
  }

  requestLaunch(instanceId: string): Promise<void> {
    return this.call(() => { this.instance(instanceId); });
  }
}
