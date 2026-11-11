import {
  BackendError, TERMINAL_STATES,
  type Accepted, type Capability, type ContentArea, type DependencyResolution, type DraftChange, type Handshake, type ImportInspection, type InstalledMod, type InstanceSummary, type Installation, type InstallPackRequest,
  type LoaderKind, type ModInventory, type OperationStatus, type PackProviderInfo, type PlanIssue, type PlanItem, type ProjectVersion, type ProviderId, type ResolvedPlan, type StoredPackLink, type VersionRef, type WorkspaceSnapshot,
} from '../contract';
import type { FetchedPack, HostApi } from '../host';
import { load, save } from '../../domain/storage';
import { createRpc } from '../coordinator/rpc';
import { CORE_VERSION, descriptorError, EVIDENCE_EXTENSION, MANAGER_EXTENSION, paramsError, resultError, type CoreMethod } from '../core/schema';
import type {
  CoreAccepted, CoreCapabilities, CoreChange, CoreDependencyResolution, CoreError, CoreHello, CoreImportInspection, CoreInfo, CoreInstalled, CoreLoaderId, CoreOperation, CorePlanPage,
  CoreOutboxChunk, CoreOutboxList, CoreProject, CoreTransfer, CoreVersion, CoreWorkspace,
} from '../core/types';
import type { ConnectionState, ManagerBackend } from '../ManagerBackend';
import type { HelperStatus, PipeTransport } from '../launcher/transport';

export const HELPER_INSTALLATION = 'manager';
const PAGE = 200; // core hello limits.pageItems
/** Loaders beyond the 0.1 pair exist only when hello negotiated manager.v0.2 and advertised them. */
const LOADER_CAPABILITY: Record<CoreLoaderId, keyof CoreCapabilities | null> = {
  vanilla: null, fabric: null, forge: 'loaders.forge.v1', neoforge: 'loaders.neoforge.v1', quilt: 'loaders.quilt.v1',
};
/** inbox.write: at most 262144 decoded bytes per chunk (core-protocol.md). */
const CHUNK = 262_144;

export interface HelperClientOptions {
  openInLauncher?: (workspaceId: string) => Promise<void>;
  transport: PipeTransport | null;
  clientVersion: string;
  requestTimeoutMs?: number;
  /** How long to wait for a freshly started helper to publish its endpoint. */
  startTimeoutMs?: number;
  pollMs?: number;
  /** Liveness check while connected; a failed check reconnects once, restarting a crashed helper. 0 disables. */
  heartbeatMs?: number;
  /** Provider catalogs and file access of the desktop host. Absent in browser builds and most tests. */
  host?: HostApi;
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
    // 0.2.1 first (structured dependency review); an older helper refuses it and gets manager.v0.2.
    extensions: [EVIDENCE_EXTENSION, MANAGER_EXTENSION],
    storePrefix: 'core-ops',
    onLost: () => setState('disconnected'),
    async locate() {
      if (stopping) throw new BackendError('helper-unavailable', 'The Manager helper is stopping for an update.', 'stopping');
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
  /** Extension features need both the negotiated extension and the capability flag (manager.v0.2.1 implies v0.2). */
  const extended = () => rpc.extensions().includes(MANAGER_EXTENSION) || rpc.extensions().includes(EVIDENCE_EXTENSION);
  const ext = (m: keyof CoreCapabilities, write = false) => extended() && has(m, write);
  /** Reviewed dependency resolutions and structured conflicts (manager.v0.2.1). */
  const evidence = () => rpc.extensions().includes(EVIDENCE_EXTENSION) && has('dependencies.resolutions.v1', true);
  const wireResolutions = (list?: DependencyResolution[]): { dependencyResolutions?: CoreDependencyResolution[] } => {
    if (!list?.length) return {};
    if (!evidence()) throw new BackendError('unsupported', 'This Manager helper cannot accept reviewed dependency decisions. Update Awake Modpack Manager.');
    return { dependencyResolutions: list.map((r) => ({ projectId: r.projectId, versionId: r.versionId, ...(r.provider === 'curseforge' ? { provider: r.provider } : {}) })) };
  };
  const notYet = (what = 'this'): Promise<never> => Promise.reject(new BackendError('unsupported', `The Manager helper in this build does not support ${what} yet.`));

  /** Set while an update replaces the helper: connecting now would start it again and hold its files. */
  let stopping = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function startHeartbeat() {
    clearInterval(heartbeat);
    if (!options.heartbeatMs) return;
    heartbeat = setInterval(() => {
      if (state === 'connected' && has('core.info')) call('core.info', {}).catch(() => undefined);
    }, options.heartbeatMs);
  }

  async function cancelPreparedPlans() {
    if (!has('operations.list') || !has('operations.cancel', true)) return;
    const { items } = await all<CoreOperation, { operations: CoreOperation[]; nextOffset: number | null }>('operations.list', {}, (p) => p.operations).catch(() => ({ items: [] as CoreOperation[] }));
    for (const op of items) if (op.state === 'prepared') await call('operations.cancel', { operationId: op.operationId }).catch(() => undefined);
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
  let startupCleaned = false;

  /** Loaders this connection may use: listed by core.info and, beyond vanilla/Fabric, advertised in hello. */
  const loaders = (): CoreLoaderId[] => (info?.supportedLoaders ?? ['vanilla', 'fabric']).filter((l) => { const c = LOADER_CAPABILITY[l]; return c === null || ext(c); });
  const coreLoader = (l: LoaderKind | undefined): CoreLoaderId => {
    if (l && (loaders() as string[]).includes(l)) return l as CoreLoaderId;
    throw new BackendError('unsupported', `This Manager helper cannot work with the ${l ?? 'selected'} loader. Supported here: ${loaders().join(', ')}.`);
  };
  const providerOk = (p: ProviderId) => p === 'modrinth' || (p === 'curseforge' && ext('providers.curseforge.v1'));
  const needProvider = (p: ProviderId) => {
    if (!providerOk(p)) throw new BackendError('unsupported', 'CurseForge is not enabled in this Manager helper. It needs separately authorized CurseForge API access.', 'PROVIDER_UNAVAILABLE');
    return p;
  };

  /* Friendly names: the helper does not read titles from JARs, so remember what search showed. */
  type Title = { name: string; iconUrl?: string };
  const TITLES = 'core-titles';
  let titles = load<Record<string, Title>>(TITLES, {});
  function rememberTitles(list: { provider: ProviderId; projectId: string; name: string; iconUrl?: string }[]) {
    let changed = false;
    for (const h of list) {
      const k = `${h.provider}:${h.projectId}`;
      if (titles[k]?.name !== h.name || (h.iconUrl && titles[k]?.iconUrl !== h.iconUrl)) { titles = { ...titles, [k]: { name: h.name, iconUrl: h.iconUrl ?? titles[k]?.iconUrl } }; changed = true; }
    }
    // shortcut: grows with the projects the user browses; prune if it ever reaches a few MB.
    if (changed) save(TITLES, titles);
  }
  /** Projects whose icon a provider has no record of: asked once per run. */
  const iconAsked = new Set<string>();
  /**
   * Friendly names and icons for provider-identified files, including entries remembered before
   * they had an icon. The desktop host reads hundreds in one request; otherwise one read each, time-boxed.
   */
  async function lookupTitles(items: CoreInstalled[], budgetMs = 4000) {
    if (options.host) {
      const refs = new Map<string, { provider: ProviderId; projectId: string }>();
      for (const it of items) {
        const provider = it.provider ?? 'modrinth';
        const k = `${provider}:${it.projectId}`;
        if (it.projectId && (!titles[k] || (!titles[k].iconUrl && !iconAsked.has(k))) && providerOk(provider)) refs.set(k, { provider, projectId: it.projectId });
      }
      if (!refs.size) return;
      for (const k of refs.keys()) iconAsked.add(k);
      try { rememberTitles(await options.host.projectMeta([...refs.values()])); } catch { /* names are cosmetic: keep the file name */ }
      return;
    }
    if (!ext('providers.project')) return;
    const until = Date.now() + budgetMs;
    const seen = new Set<string>();
    for (const it of items) {
      const provider = it.provider ?? 'modrinth';
      const k = `${provider}:${it.projectId}`;
      if (!it.projectId || titles[k] || seen.has(k) || !providerOk(provider)) continue;
      if (Date.now() > until) break;
      seen.add(k);
      try {
        const { project } = await call<{ project: CoreProject }>('providers.project', { provider, projectId: it.projectId });
        rememberTitles([{ provider, projectId: it.projectId, name: project.title, iconUrl: project.iconUrl ?? undefined }]);
      } catch { /* names are cosmetic: keep the file name */ }
    }
  }
  const time = (ms: string) => { const n = Number(ms); return new Date(n < 1e12 ? n * 1000 : n).toISOString(); };
  const fileStem = (f: string) => f.replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, '');

  /* Which pack each project came from, by workspace ID. */
  const PACK_LINKS = 'core-pack-links';
  const packLinks = () => load<Record<string, StoredPackLink>>(PACK_LINKS, {});
  function setPackLink(workspaceId: string, link: StoredPackLink | null) {
    const { [workspaceId]: _, ...rest } = packLinks();
    save(PACK_LINKS, link ? { ...rest, [workspaceId]: link } : rest);
  }

  function toInstance(w: CoreWorkspace): InstanceSummary {
    const id = key(w.physicalId);
    workspaces.set(id, w);
    return {
        id, name: w.name, minecraftVersion: w.minecraftVersion,
        path: w.sharedRoot ?? (status?.dataRoot ? `${status.dataRoot.replace(/\\/g, '/')}/workspaces/${w.workspaceId}` : undefined),
        ...(w.sharedRoot ? { sharedRoot: w.sharedRoot } : {}),
      loader: { kind: w.loader.id, version: w.loader.version || undefined },
      status: w.recoveryRequired ? 'broken' : 'ready',
      manageable: !w.recoveryRequired, blockedReason: w.recoveryRequired ? 'recovery' : undefined,
      revision: w.instanceRevision,
      ...(inventories.has(id) ? { modCount: inventories.get(id)!.size } : packLinks()[w.workspaceId] ? { modCount: packLinks()[w.workspaceId]!.managed.length } : {}),
      ...(packLinks()[w.workspaceId] ? { pack: packLinks()[w.workspaceId], iconUrl: packLinks()[w.workspaceId]!.iconUrl } : {}),
    };
  }

  function toMod(it: CoreInstalled): InstalledMod {
    const source = it.projectId ? it.provider ?? 'modrinth' : 'manual';
    const title = it.projectId ? titles[`${source}:${it.projectId}`] : undefined;
    return {
      key: it.inventoryId, fileName: it.fileName, name: title?.name ?? fileStem(it.fileName), iconUrl: title?.iconUrl,
      source, projectId: it.projectId ?? undefined,
      installed: it.versionId ? { id: it.versionId, name: it.versionNumber ?? it.versionId } : null,
      enabled: it.enabled, sizeBytes: Number.isSafeInteger(Number(it.size)) ? Number(it.size) : undefined,
      metadataState: it.metadataState === 'unknown' ? 'unindexed' : 'indexed',
      locallyModified: it.metadataState === 'modified', kind: 'jar', updateLocked: it.updateLocked,
      // manager.v0.2 reports the pin, the exclusion and a native lock separately; older replies only the aggregate.
      ...(it.policy ? { pinned: it.policy.pinnedVersion !== null, updateExcluded: it.policy.excluded, nativeLock: !!it.nativeLock } : {}),
      ...(it.loaderBridge ? { loaderBridge: it.loaderBridge } : {}),
    };
  }

  const toVersion = (v: CoreVersion): ProjectVersion => ({
    id: v.versionId, name: v.name, versionNumber: v.versionNumber, releaseType: v.releaseType,
    gameVersions: v.gameVersions, loaders: v.loaders, fileName: v.files[0]?.fileName,
    sizeBytes: v.files[0] ? Number(v.files[0].size) : undefined,
    // tool/include (CurseForge) are build-time or bundled relations, not runtime requirements.
    dependencies: v.dependencies.map((d) => ({ projectId: d.projectId, versionId: d.versionId, type: d.type === 'tool' || d.type === 'include' ? 'embedded' : d.type })),
  });

  function toStatus(op: CoreOperation): OperationStatus {
    const ws = op.result?.workspace;
    if (ws) toInstance(ws);
    const digest = op.result?.planDigest ?? digests.get(op.operationId);
    const total = op.progress?.total ? Number(op.progress.total) : 0;
    return {
      operationId: op.operationId,
      kind: op.kind === 'workspace-create' ? 'create-instance' : op.kind === 'workspace-delete' ? 'delete-instance' : 'apply-plan',
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

  const coreError = (e: CoreError | undefined, fallback: string): BackendError => {
    const map: Record<string, BackendError['code']> = {
      STALE_INSTANCE: 'stale-revision', STALE_PLAN: 'plan-expired', BUSY: 'instance-busy', RECOVERY_REQUIRED: 'recovery-required',
      INVALID_ARCHIVE: 'invalid-archive', PROVIDER_RESTRICTED: 'provider-restricted', PROVIDER_UNAVAILABLE: 'provider-restricted', UNSUPPORTED_CAPABILITY: 'unsupported',
      DEPENDENCY_CONFLICT: 'dependency-conflict',
    };
    // Structured conflicts come from the (schema-validated) helper reply, never from parsing its message.
    const conflicts = e?.details?.conflicts;
    if (conflicts) rememberTitles([...conflicts, ...conflicts.flatMap((c) => c.requests)].map((x) => ({ provider: x.provider, projectId: x.projectId, name: x.title, iconUrl: titles[`${x.provider}:${x.projectId}`]?.iconUrl })));
    return new BackendError(e ? map[e.code] ?? 'rejected' : 'rejected', e?.message ?? fallback, e?.code, conflicts, e?.details?.truncated ?? false);
  };

  /** Draft changes in the helper's terms. Installs without a chosen version get the newest compatible release. */
  async function toChanges(id: string, changes: DraftChange[]): Promise<CoreChange[]> {
    const inv = inventories.get(id) ?? new Map<string, CoreInstalled>();
    const out: CoreChange[] = [];
    for (const c of changes) {
      if (c.kind === 'install') {
        const provider = needProvider(c.provider);
        const versionId = c.versionId ?? (await newestRelease(id, c.projectId, provider))?.id;
        if (!versionId) throw new BackendError('rejected', `${c.name} has no version for this Minecraft version and loader.`);
        // provider defaults to modrinth on the wire; name it only for CurseForge so 0.1 helpers see unchanged requests.
        out.push({ action: 'install', projectId: c.projectId, versionId, ...(provider === 'curseforge' ? { provider } : {}) });
      } else if (c.kind === 'update') {
        const m = inv.get(c.modKey);
        if (!m?.projectId) throw new BackendError('rejected', 'This file has no provider project, so it cannot be updated.');
        const provider = needProvider(m.provider ?? 'modrinth');
        out.push({ action: 'replace', projectId: m.projectId, versionId: c.targetVersionId, ...(provider === 'curseforge' ? { provider } : {}) });
      } else if (c.kind === 'policy') {
        if (!ext('policies.v1', true)) throw new BackendError('unsupported', 'Pins and update exclusions need a Manager helper with policies (0.2 or newer).');
        const m = inv.get(c.modKey);
        if (c.pinned && !m?.versionId) throw new BackendError('rejected', `${m?.fileName ?? 'This file'} has no provider version to pin.`);
        // Keep an existing pin's version; pinning newly pins the installed version.
        out.push({ action: 'policy', inventoryId: c.modKey, pinnedVersion: c.pinned ? m!.policy?.pinnedVersion ?? m!.versionId : null, excluded: c.excluded });
      } else {
        out.push({ action: c.kind, inventoryId: c.modKey });
      }
    }
    return out;
  }

  async function versionsOf(id: string, projectId: string, provider: ProviderId = 'modrinth'): Promise<ProjectVersion[]> {
    const w = workspaceOf(id);
    const page = await call<{ versions: CoreVersion[] }>('providers.versions', {
      provider: needProvider(provider), minecraftVersion: w.minecraftVersion, loader: coreLoader(w.loader.id), projectId, limit: 50,
    });
    return page.versions.map(toVersion);
  }
  async function newestRelease(id: string, projectId: string, provider: ProviderId = 'modrinth'): Promise<VersionRef | undefined> {
    const list = await versionsOf(id, projectId, provider);
    return list.find((v) => v.releaseType === 'release') ?? list[0];
  }

  /** The full reviewed plan: every page, all with the same digest. */
  async function readPlan(id: string, operationId: string, extra: PlanItem[] = []): Promise<ResolvedPlan> {
    const { items: files, first } = await all<CorePlanPage['files'][number], CorePlanPage>('plans.get', { operationId }, (p) => p.files);
    const head = first!;
    digests.set(operationId, head.planDigest);
    // Mod files (directly in mods/) are the review items; the rest is the helper's bookkeeping
    // (Packwiz .index, policies), listed in one note so every change is still shown.
    // manager.v0.2 plans name each file's kind; older plans are classified by path.
    const isMod = (f: { path: string; kind?: string }) => f.kind ? f.kind === 'mod' : /(^|\/)mods\/[^/]+$/.test(f.path);
    const isMeta = (f: { path: string; kind?: string }) => f.kind ? f.kind === 'bookkeeping' : /(^|\/)(\.index|\.awake-integration)\//.test(f.path) || /(^|\/)(instance\.cfg|mmc-pack\.json)$/.test(f.path);
    const mods = files.filter(isMod);
    const meta = files.filter((f) => !isMod(f) && isMeta(f));
    // Imported configs and other overrides: every one is listed, and replacing or removing one is destructive.
    const overrides: PlanItem[] = files.filter((f) => !isMod(f) && !isMeta(f)).map((f) => ({
      // Shown relative to the game folder, as pack authors write them.
      action: 'override', modKey: f.path, name: f.path.replace(/^\.minecraft\//, ''), reason: 'requested', destructive: f.action !== 'install',
      to: { id: f.afterSha256 || f.action, name: f.action },
    }));
    const paths = new Set(mods.map((f) => `${f.action}:${f.path}`));
    const items: PlanItem[] = [...extra];
    for (const f of mods) {
      const name = f.path.split('/').pop() ?? f.path;
      // Disable = remove x.jar + install x.jar.disabled; enable is the reverse. Show each as one item.
      if (f.action === 'install' && /\.disabled$/i.test(f.path) && paths.has(`remove:${f.path.replace(/\.disabled$/i, '')}`)) {
        items.push({ action: 'disable', modKey: f.path, name: name.replace(/\.disabled$/i, ''), reason: 'requested' });
      } else if (f.action === 'install' && paths.has(`remove:${f.path}.disabled`)) {
        items.push({ action: 'enable', modKey: f.path, name, reason: 'requested' });
      } else if (f.action === 'remove' && (paths.has(`install:${f.path}.disabled`) || (/\.disabled$/i.test(f.path) && paths.has(`install:${f.path.replace(/\.disabled$/i, '')}`)))) {
        continue;
      } else {
        items.push({ action: f.action === 'replace' ? 'update' : f.action, modKey: f.path, name, reason: 'requested', destructive: f.action !== 'install' });
      }
    }
    const reviewed = head.dependencyResolutions ?? [];
    const issues: PlanIssue[] = [
      // Reviewed dependency decisions are part of the digest: show each one prominently with its evidence.
      ...reviewed.map((r) => ({
        severity: 'warning' as const, code: 'dependency-reviewed' as const, modKeys: [],
        message: r.versionId === null
          ? `Installed without ${r.title}: ${r.requestedBy.map((b) => `${b.title} (${evidenceText(b.evidence)})`).join(', ')}`
          : `${r.title} kept at the selected version for ${r.requestedBy.map((b) => `${b.title} (${evidenceText(b.evidence)})`).join(', ')}`,
      })),
      // Optional dependencies are listed as suggestions below; the helper also words them as warnings.
      ...head.warnings.filter((w) => !/^optional dependency/i.test(w) && !(reviewed.length && /^Reviewed: /.test(w))).map((w) => ({ severity: 'warning' as const, code: 'coordinator-warning' as const, message: w.trim(), modKeys: [] })),
      ...(meta.length ? [{ severity: 'info' as const, code: 'coordinator-warning' as const, message: `Also updates ${meta.length} metadata file(s): ${meta.map((f) => f.path).join(', ')}`, modKeys: [] }] : []),
      ...head.dependencies.filter((d) => d.type === 'incompatible').map((d) => ({ severity: 'warning' as const, code: 'incompatible' as const, message: `Declared incompatible: ${d.projectId ?? 'unknown project'}`, modKeys: [] })),
      ...head.dependencies.filter((d) => d.type === 'required').map((d) => ({ severity: 'info' as const, code: 'dependency-included' as const, message: `Required dependency included and verified: ${d.projectId ?? 'unknown project'}${d.versionId ? ` (${d.versionId})` : ''}`, modKeys: [] })),
    ];
    const depName = (d: { projectId: string | null; provider?: ProviderId }) => (d.projectId && titles[`${d.provider ?? 'modrinth'}:${d.projectId}`]?.name) ?? d.projectId ?? 'unknown project';
    for (const i of issues) if (i.code === 'dependency-included' || i.code === 'incompatible') i.message = i.message.replace(/: (\S+)/, (_, pid: string) => `: ${depName({ projectId: pid, provider: head.dependencies.find((d) => d.projectId === pid)?.provider })}`);
    return {
      planId: operationId, planHash: head.planDigest, instanceId: id, baseRevision: head.instanceRevision,
      items: [...items, ...overrides], issues,
      // Optional dependencies are reported, never downloaded silently; the user may add them.
      optional: head.dependencies.filter((d) => d.type === 'optional' && d.projectId).map((d) => ({ provider: d.provider ?? 'modrinth', projectId: d.projectId!, name: depName(d), suggestedBy: [] })),
      blocked: false,
    };
  }

  const evidenceText = (e: 'satisfied' | 'not_declared' | 'unknown') =>
    e === 'satisfied' ? 'its loader metadata accepts this version' : e === 'not_declared' ? 'its loader metadata does not declare it' : 'no loader metadata evidence';

  /** Resolve, download and verify happen in the helper; the plan exists once the operation is prepared. */
  async function awaitPrepared(operationId: string): Promise<CoreOperation> {
    let op = await readOp(operationId);
    while (op.state !== 'prepared' && !TERMINAL_STATES.includes(op.state) && op.state !== 'recovery_required') {
      await sleep(poll);
      op = await readOp(operationId);
    }
    if (op.state !== 'prepared') throw coreError(op.error, 'The helper could not prepare these changes.');
    return op;
  }
  async function replacePrepared(instanceId: string) {
    const old = prepared.get(instanceId);
    if (old && has('operations.cancel', true)) await call('operations.cancel', { operationId: old }).catch(() => undefined);
    prepared.delete(instanceId);
  }

  /* Uploads not yet discarded, per helper profile, so an abandoned import is cleaned up on the next start. */
  const uploadsKey = () => `core-inbox:${hello()?.profileId ?? 'none'}`;
  const uploads = () => load<string[]>(uploadsKey(), []);
  async function readUpload(size: number, sha256: string, read: (offset: number, length: number) => Promise<Uint8Array>, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<string> {
    let t = await call<CoreTransfer>('inbox.begin', { idempotencyKey: crypto.randomUUID(), purpose: 'import', size: String(size), sha256 });
    save(uploadsKey(), [...uploads().filter((x) => x !== t.token), t.token]);
    try {
      for (let offset = Number(t.received); offset < size; offset = Number(t.received)) {
        if (signal?.aborted) throw new BackendError('rejected', 'Upload cancelled.', 'CANCELLED');
        t = await call<CoreTransfer>('inbox.write', { token: t.token, offset: String(offset), bytesBase64: toBase64(await read(offset, CHUNK)) });
        if (Number(t.received) <= offset) throw new BackendError('protocol', 'The helper did not accept the upload chunk.');
        onProgress?.(Number(t.received), size);
      }
      t = await call<CoreTransfer>('inbox.commit', { token: t.token });
      if (!t.complete || t.sha256 !== sha256) throw new BackendError('protocol', 'The helper did not confirm the uploaded archive.');
      return t.token;
    } catch (e) {
      await discard(t.token).catch(() => undefined);
      throw rpc.toBackendError(e);
    }
  }
  const canImport = () => ['imports.inspect', 'imports.prepare', 'inbox.begin', 'inbox.write', 'inbox.commit', 'inbox.discard'].every((m) => ext(m as keyof CoreCapabilities, true));
  async function discard(token: string) {
    await call('inbox.discard', { token });
    save(uploadsKey(), uploads().filter((t) => t !== token));
  }
  /** One installed file's provider record. A reason instead when it cannot be described. */
  async function lookUpFile(w: CoreWorkspace, provider: ProviderId, projectId: string, versionId: string, fileName: string) {
    let found: CoreVersion | undefined;
    try {
      // providers.versions is newest first; an older installed version can sit a few pages down.
      for (let offset = 0; !found && offset < 1000; offset += PAGE) {
        const page = await call<{ versions: CoreVersion[] }>('providers.versions', { provider, minecraftVersion: w.minecraftVersion, loader: coreLoader(w.loader.id), projectId, offset, limit: PAGE });
        found = page.versions.find((v) => v.versionId === versionId);
        if (page.versions.length < PAGE) break;
      }
    } catch (e) {
      if (e instanceof BackendError && e.code === 'provider-restricted') return 'restricted' as const;
      throw e;
    }
    const file = found && (found.files.find((f) => f.fileName === fileName.replace(/\.disabled$/i, '')) ?? found.files[0]);
    if (!found || !file) return 'not-found' as const;
    return { versionName: found.versionNumber, fileName: file.fileName, size: Number(file.size), sha1: file.sha1, sha512: file.sha512, url: file.url };
  }
  /** Unchanged, helper-tracked config/ overrides, all read at one revision and hash-checked. */
  async function readConfigs(w: CoreWorkspace): Promise<{ path: string; data: Uint8Array }[]> {
    if (!ext('outbox.list') || !ext('outbox.read') || !ext('outbox.configs.v1')) return [];
    const { instanceRevision } = await call<{ instanceRevision: string }>('mods.list', { physicalId: w.physicalId, limit: 1 });
    const { items } = await all<CoreOutboxList['files'][number], CoreOutboxList>('outbox.list', { physicalId: w.physicalId, instanceRevision }, (p) => p.files);
    const out: { path: string; data: Uint8Array }[] = [];
    for (const f of items) {
      const data = new Uint8Array(Number(f.size));
      for (let offset = 0; ;) {
        const c = await call<CoreOutboxChunk>('outbox.read', { physicalId: w.physicalId, instanceRevision, path: f.path, offset: String(offset), length: CHUNK });
        const bytes = Uint8Array.from(atob(c.bytesBase64), (ch) => ch.charCodeAt(0));
        if (c.path !== f.path || Number(c.offset) !== offset || offset + bytes.length > data.length) throw new BackendError('protocol', `The helper returned an unexpected chunk of ${f.path}.`);
        data.set(bytes, offset);
        offset += bytes.length;
        if (c.eof) { if (offset !== data.length) throw new BackendError('protocol', `${f.path} ended early.`); break; }
        if (!bytes.length) throw new BackendError('protocol', `Reading ${f.path} did not advance.`);
      }
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (sha !== f.sha256) throw new BackendError('protocol', `${f.path} did not match its tracked hash.`);
      // Paths are .minecraft-relative; pack overrides are relative to the game folder too.
      out.push({ path: f.path.replace(/^\.minecraft\//, ''), data });
    }
    return out;
  }
  const toBase64 = (b: Uint8Array) => { let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(bin); };

  /* ----- installing a catalog pack: one local operation over several helper operations ----- */

  interface PackJob { status: OperationStatus; cancelled: boolean; helperOp?: string }
  const packJobs = new Map<string, PackJob>();
  const pendingPackUpdate = new Map<string, { versionId: string; versionName: string; before: string[] }>();

  const settle = async (operationId: string, onUpdate?: (op: CoreOperation) => void, untilPrepared = true) => {
    for (;;) {
      const op = await readOp(operationId);
      onUpdate?.(op);
      if (op.terminal || (untilPrepared && op.state === 'prepared') || op.state === 'recovery_required') return op;
      await sleep(poll);
    }
  };

  async function runPackInstall(job: PackJob, r: InstallPackRequest) {
    const host = options.host!;
    const update = (patch: Partial<OperationStatus>) => { job.status = { ...job.status, ...patch, updatedAt: new Date().toISOString() }; };
    const checkCancelled = () => { if (job.cancelled) throw new BackendError('rejected', 'Cancelled.', 'CANCELLED'); };
    let fetched: FetchedPack | null = null;
    let token: string | null = null;
    let created: CoreWorkspace | null = null;
    let installed = false;
    const span = (from: number, to: number, done: number, total: number) => from + (to - from) * (total ? Math.min(1, done / total) : 0);
    try {
      update({ state: 'downloading', step: 'pack-download' });
      fetched = await host.packFetch(r.provider, r.packId, r.versionId, job.status.operationId, (d, t) => update({ progress: span(0, 0.2, d, t) }));
      checkCancelled();
      update({ step: 'pack-upload', progress: 0.2 });
      const ticket = fetched;
      token = await readUpload(ticket.size, ticket.sha256, (o, l) => host.packRead(ticket.token, o, l), (d, t) => update({ progress: span(0.2, 0.28, d, t) }));
      const inspected = await call<CoreImportInspection>('imports.inspect', { token, format: ticket.format });
      checkCancelled();

      update({ state: 'resolving', step: 'pack-create', progress: 0.28, cancellable: false });
      const createdOp = await submit('workspaces.create', { idempotencyKey: crypto.randomUUID(), name: r.instanceName.slice(0, 80), minecraftVersion: inspected.minecraftVersion, loader: { id: coreLoader(inspected.loader.id as LoaderKind), version: inspected.loader.version } });
      const done = await settle(createdOp.operationId);
      if (done.state !== 'completed' || !done.result?.workspace) throw coreError(done.error, 'The project could not be created for this pack.');
      created = done.result.workspace;
      const id = toInstance(created).id;

      update({ step: 'pack-resolve', progress: 0.32, instanceId: id, cancellable: true });
      const prep = await submit('imports.prepare', { idempotencyKey: crypto.randomUUID(), physicalId: created.physicalId, instanceRevision: created.instanceRevision, token, format: ticket.format, includeOptional: false, packAuthoritative: true });
      job.helperOp = prep.operationId;
      const ready = await settle(prep.operationId, (op) => {
        const total = Number(op.progress?.total ?? 0);
        update({ state: op.state === 'downloading' ? 'downloading' : 'resolving', step: op.state === 'downloading' ? 'pack-files' : 'pack-resolve', progress: span(0.32, 0.86, Number(op.progress?.completed ?? 0), total) });
      });
      if (ready.state !== 'prepared') throw coreError(ready.error, 'The pack could not be prepared.');
      checkCancelled();
      const head = await call<CorePlanPage>('plans.get', { operationId: prep.operationId, limit: 1 });

      update({ state: 'applying', step: 'pack-apply', progress: 0.88, cancellable: false });
      const applied = await submit('transactions.apply', { idempotencyKey: crypto.randomUUID(), operationId: prep.operationId, planDigest: head.planDigest, instanceRevision: head.instanceRevision });
      job.helperOp = applied.operationId;
      const finished = await settle(applied.operationId, (op) => update({ progress: span(0.88, 0.99, Number(op.progress?.completed ?? 0), Number(op.progress?.total ?? 0)) }), false);
      if (finished.state !== 'completed') throw coreError(finished.error, 'The pack could not be installed.');

      // From here the pack is installed: nothing below may undo it.
      installed = true;
      let items: CoreInstalled[] = [];
      for (let attempt = 0; attempt < 5 && !items.length; attempt++) {
        if (attempt) await sleep(2000);
        items = await rpc.paged<{ nextOffset: number | null; instanceRevision: string; total: number }, CoreInstalled>('mods.list', { physicalId: created.physicalId }, 'items').then((r) => r.items).catch(() => []);
      }
      const versions = await host.packVersions(r.provider, r.packId).catch(() => []);
      const hit = versions.find((v) => v.id === r.versionId);
      setPackLink(created.workspaceId, { provider: r.provider, packId: r.packId, packName: r.instanceName, versionId: r.versionId, versionName: hit?.name ?? r.versionId, iconUrl: r.iconUrl, managed: items.map((m) => m.inventoryId) });
      toInstance(created);
      update({ state: 'completed', progress: 1, step: undefined, cancellable: false, result: { instanceId: id }, notes: [...ticket.notes, ...head.warnings.filter((w) => /^Manual download required/.test(w))] });
    } catch (e) {
      const err = rpc.toBackendError(e);
      // An install that did not finish leaves no empty project behind.
      if (created && !installed && ext('workspaces.delete', true)) {
        const removal = await submit('workspaces.delete', { idempotencyKey: crypto.randomUUID(), physicalId: created.physicalId }).catch(() => null);
        if (removal) await settle(removal.operationId).catch(() => undefined);
        workspaces.delete(key(created.physicalId));
      }
      update({ state: job.cancelled ? 'cancelled' : 'failed', step: undefined, cancellable: false, instanceId: undefined, error: { code: err.detail ?? err.code, message: err.message } });
    } finally {
      if (token) await discard(token).catch(() => undefined);
      if (fetched) await host.packDiscard(fetched.token).catch(() => undefined);
    }
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
    if (caps.includes('plan.apply') && ext('policies.v1', true)) caps.push('mods.policies');
    if (caps.includes('plan.apply') && canImport()) caps.push('packs.import');
    if (options.host) {
      caps.push('files.read', 'files.write', 'content.browse', 'mods.updates');
      if (has('providers.search')) caps.push('packs.search');
      if (caps.includes('packs.import') && ext('imports.packAuthoritative.v1', true) && caps.includes('instances.create')) caps.push('packs.install');
    }
    if (ext('workspaces.delete', true) && has('operations.get')) caps.push('instances.delete');
    if (ext('workspaces.rename', true)) caps.push('instances.rename');
    return caps;
  }

  return {
    kind: 'helper',
    async openInLauncher(instanceId) {
      const workspace = workspaceOf(instanceId);
      if (!options.openInLauncher) throw new BackendError('unsupported', 'Install Awake Launcher 3.1.0 or newer, then link this workspace in Launcher.');
      await options.openInLauncher(workspace.workspaceId);
    },

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
      // A prepared plan never expires and keeps the helper (and so upgrades) waiting. Plans left
      // by an earlier Manager run can't be applied from this one, so cancel them once at start.
      if (!startupCleaned && has('operations.list') && has('operations.cancel', true)) {
        startupCleaned = true;
        await cancelPreparedPlans();
        if (has('inbox.discard', true)) for (const token of uploads()) await discard(token).catch(() => undefined);
      }
      const search = has('providers.search');
      const reason = stub() ? 'helper-stub' : 'helper-pending';
      return {
        contract: `${CORE_VERSION.major}.${CORE_VERSION.minor}`,
        launcherVersion: hello()?.coreVersion ?? '',
        stub: stub(),
        capabilities: capabilities(),
        providers: [
          { id: 'modrinth', available: search, unavailableReason: search ? undefined : reason },
          { id: 'curseforge', available: search && providerOk('curseforge'), unavailableReason: search && providerOk('curseforge') ? undefined : 'curseforge-disabled' },
        ],
        packProviders: options.host && capabilities().includes('packs.search')
          ? await options.host.packProviders().catch((): PackProviderInfo[] => [])
          : (['modrinth', 'curseforge', 'ftb', 'atlauncher', 'technic'] as const).map((id) => ({ id, available: false, unavailableReason: 'helper-packs-pending' })),
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
      await lookupTitles(items);
      const mods = items.map(toMod);
      // Excluded mods are known from their policy; availability arrives separately (checkUpdates), so the list shows at once.
      for (const m of mods) if (m.updateExcluded === undefined) m.updateExcluded = false;
      if (!options.host && has('updates.check')) {
        try {
          const { items: updates } = await all<{ projectId: string; installedVersionId: string; candidate: CoreVersion | null; excluded: boolean; provider?: ProviderId }, { updates: never[]; nextOffset: number | null }>(
            'updates.check', { physicalId: w.physicalId }, (p) => p.updates,
          );
          for (const u of updates) {
            const m = mods.find((x) => x.projectId === u.projectId && x.installed?.id === u.installedVersionId && x.source === (u.provider ?? 'modrinth'));
            if (u.excluded) { if (m) m.updateExcluded = true; continue; }
            // Checked with no newer stable version: shown as up to date (available = installed).
            if (m) m.available = u.candidate ? { id: u.candidate.versionId, name: u.candidate.versionNumber, releaseType: u.candidate.releaseType } : m.installed ?? undefined;
          }
        } catch { /* update availability is optional; the inventory stands on its own */ }
      }
      return { instanceId, revision, mods };
    },

    async createInstance(r) {
      if (!has('workspaces.create', true)) return notYet('creating projects');
      const loader = coreLoader(r.loader);
      if (loader !== 'vanilla' && !r.loaderVersion) throw new BackendError('rejected', 'Choose a loader version.');
      const acc = await submit('workspaces.create', { idempotencyKey: r.idempotencyKey, name: r.name, minecraftVersion: r.minecraftVersion, loader: { id: loader, version: loader === 'vanilla' ? '' : r.loaderVersion ?? '' } });
      return { operationId: acc.operationId };
    },

    async versionCatalog(q) {
      if (!has('catalog.versions')) return notYet('the version catalog');
      const params: Record<string, unknown> = {};
      if (q.minecraftVersion) params.minecraftVersion = q.minecraftVersion;
      if (q.loader) params.loader = coreLoader(q.loader);
      const r = await call<{ minecraftVersions: string[]; loaderVersions: string[] }>('catalog.versions', params);
      return { ...r, loaders: loaders() as LoaderKind[] };
    },

    async search(q) {
      if (!has('providers.search')) return notYet('mod search');
      const provider = needProvider(q.provider);
      const r = await call<{ projects: CoreProject[]; total: number }>('providers.search', {
        provider, minecraftVersion: q.minecraftVersion, loader: coreLoader(q.loader), query: q.text, offset: q.offset, limit: Math.min(Math.max(q.limit, 1), PAGE),
      });
      const hits = r.projects.map((p) => ({ provider: p.provider ?? provider, projectId: p.projectId, name: p.title, author: '', summary: p.description, iconUrl: p.iconUrl ?? undefined, compatible: true }));
      rememberTitles(hits);
      return { total: r.total, hits };
    },
    async projectVersions(instanceId, provider, projectId) {
      if (!has('providers.versions')) return notYet('version lists');
      return versionsOf(instanceId, projectId, provider);
    },

    discardPlan: replacePrepared,
    canResolveDependencies: () => evidence(),
    async validateDraft(d, resolutions) {
      if (!has('plans.prepare', true) || !has('plans.get')) return notYet('reviewing changes');
      const w = workspaceOf(d.instanceId);
      const decisions = wireResolutions(resolutions);
      await replacePrepared(d.instanceId);
      const acc = await submit('plans.prepare', { idempotencyKey: crypto.randomUUID(), physicalId: w.physicalId, instanceRevision: d.baseRevision, changes: await toChanges(d.instanceId, d.changes), ...decisions });
      const op = await awaitPrepared(acc.operationId);
      prepared.set(d.instanceId, op.operationId);
      // Policy edits change only the helper's policy file; show each as its own reviewed item.
      const inv = inventories.get(d.instanceId);
      const policy: PlanItem[] = d.changes.flatMap((c) => c.kind !== 'policy' ? [] : [{
        action: 'policy' as const, modKey: c.modKey, name: titles[`${inv?.get(c.modKey)?.provider ?? 'modrinth'}:${inv?.get(c.modKey)?.projectId}`]?.name ?? fileStem(inv?.get(c.modKey)?.fileName ?? c.modKey),
        reason: 'requested' as const, to: { id: `${c.pinned ? 'pinned' : 'unpinned'}|${c.excluded ? 'excluded' : 'included'}`, name: [c.pinned ? 'pinned' : 'not pinned', c.excluded ? 'excluded from updates' : 'included in updates'].join(', ') },
      }]);
      return readPlan(d.instanceId, op.operationId, policy);
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

    getOperation: async (id) => packJobs.get(id)?.status ?? toStatus(await readOp(id)),
    async listOperations(instanceId) {
      if (!has('operations.list')) return [];
      const { items } = await all<CoreOperation, { operations: CoreOperation[]; nextOffset: number | null }>('operations.list', {}, (p) => p.operations);
      return [...[...packJobs.values()].map((j) => j.status), ...items.map(toStatus)].filter((o) => !instanceId || o.instanceId === instanceId);
    },
    watchOperation: () => () => {},
    async cancelOperation(operationId) {
      const job = packJobs.get(operationId);
      if (job) { job.cancelled = true; await options.host?.packCancel(operationId).catch(() => undefined); if (job.helperOp) await call('operations.cancel', { operationId: job.helperOp }).catch(() => undefined); return; }
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

    canImport,
    async uploadImport(file, onProgress, signal) {
      if (!canImport()) return notYet('modpack import');
      // shortcut: the archive is read into memory once (contract limit 1 GiB); stream it if large packs become common.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      return readUpload(bytes.length, sha256, async (offset, length) => bytes.subarray(offset, offset + length), onProgress, signal);
    },
    async inspectImport(token, format): Promise<ImportInspection> {
      if (!canImport()) return notYet('modpack import');
      const r = await call<CoreImportInspection>('imports.inspect', { token, format });
      return {
        format, minecraftVersion: r.minecraftVersion, loader: { kind: r.loader.id, version: r.loader.version },
        files: r.files.map((f) => ({ path: f.path, sha256: f.sha256, size: Number(f.size) })),
        projects: r.projects, downloadCount: r.downloadCount, warnings: r.warnings,
      };
    },
    async prepareImport(instanceId, token, format, includeOptional, resolutions) {
      if (!canImport()) return notYet('modpack import');
      const w = workspaceOf(instanceId);
      const decisions = wireResolutions(resolutions);
      // The plan is bound to the workspace's current content, not to the possibly older list entry.
      const { instanceRevision } = await call<{ instanceRevision: string }>('mods.list', { physicalId: w.physicalId, limit: 1 });
      await replacePrepared(instanceId);
      const acc = await submit('imports.prepare', { idempotencyKey: crypto.randomUUID(), physicalId: w.physicalId, instanceRevision, token, format, includeOptional, ...decisions });
      const op = await awaitPrepared(acc.operationId);
      prepared.set(instanceId, op.operationId);
      return readPlan(instanceId, op.operationId);
    },
    discardImport: (token) => discard(token),

    // The helper has no archive export, so the Manager builds the pack from the helper's verified
    // inventory plus each installed version's provider record, and (manager.v0.2) its tracked configs.
    async snapshotWorkspace(instanceId, onProgress): Promise<WorkspaceSnapshot> {
      if (!has('mods.list') || !has('providers.versions')) return notYet('export');
      const w = workspaceOf(instanceId);
      const { items } = await rpc.paged<{ nextOffset: number | null; instanceRevision: string; total: number }, CoreInstalled>('mods.list', { physicalId: w.physicalId }, 'items');
      const snap: WorkspaceSnapshot = { name: w.name, minecraftVersion: w.minecraftVersion, loader: { kind: w.loader.id, version: w.loader.version }, mods: [], skipped: [] };
      let done = 0;
      for (const it of items) {
        onProgress?.(done++, items.length);
        const provider = it.provider ?? 'modrinth';
        if (!it.projectId || !it.versionId) { snap.skipped.push({ fileName: it.fileName, reason: 'manual' }); continue; }
        if (it.metadataState !== 'verified') { snap.skipped.push({ fileName: it.fileName, reason: 'modified' }); continue; }
        if (!providerOk(provider)) { snap.skipped.push({ fileName: it.fileName, reason: 'provider' }); continue; }
        const looked = await lookUpFile(w, provider, it.projectId, it.versionId, it.fileName);
        if (typeof looked === 'string') { snap.skipped.push({ fileName: it.fileName, reason: looked }); continue; }
        snap.mods.push({ ...looked, provider, projectId: it.projectId, versionId: it.versionId, name: titles[`${provider}:${it.projectId}`]?.name ?? fileStem(it.fileName), enabled: it.enabled });
      }
      onProgress?.(items.length, items.length);
      snap.configs = await readConfigs(w);
      return snap;
    },

    async exportMatches(instanceId, target, fileNames) {
      if (!options.host) return notYet('finding identical files');
      return options.host.exportMatch(workspaceOf(instanceId).workspaceId, target, fileNames);
    },
    async exportRestricted(_instanceId, projectIds) {
      if (!options.host) return [];
      const metas = await options.host.projectMeta(projectIds.map((projectId) => ({ provider: 'curseforge' as const, projectId })));
      return metas.filter((m) => m.restricted).map((m) => ({ projectId: m.projectId, name: m.name, pageUrl: m.pageUrl }));
    },
    async manualDownloads(instanceId, items) {
      if (!options.host) return [];
      const w = workspaceOf(instanceId);
      return options.host.manualSources(items, w.minecraftVersion, w.loader.id);
    },
    async claimManualDownloads(instanceId, wanted, pick) {
      if (!options.host) return [];
      return options.host.manualClaim(workspaceOf(instanceId).workspaceId, wanted, pick);
    },
    async prepareExport(instanceId, format, entries, onProgress) {
      if (!has('mods.list')) return notYet('export');
      const w = workspaceOf(instanceId);
      const { items } = await rpc.paged<{ nextOffset: number | null; instanceRevision: string; total: number }, CoreInstalled>('mods.list', { physicalId: w.physicalId }, 'items');
      const installed = new Map(items.map((it) => [it.fileName, it]));
      const snap: WorkspaceSnapshot = { name: w.name, minecraftVersion: w.minecraftVersion, loader: { kind: w.loader.id, version: w.loader.version }, mods: [], skipped: [] };
      let done = 0;
      for (const e of entries) {
        onProgress?.(done++, entries.length);
        const it = installed.get(e.fileName);
        if (!it) { snap.skipped.push({ fileName: e.fileName, reason: 'not-found' }); continue; }
        if (e.kind === 'matched') {
          const m = e.match;
          snap.mods.push({ provider: e.provider, projectId: m.projectId, versionId: m.versionId, versionName: m.versionName, name: titles[`${it.provider ?? 'modrinth'}:${it.projectId}`]?.name ?? fileStem(it.fileName), fileName: m.remoteFileName || e.fileName, size: m.size, sha1: m.sha1, sha512: m.sha512, url: m.url, enabled: it.enabled });
          continue;
        }
        const provider = e.kind === 'replaced' ? e.provider : it.provider ?? 'modrinth';
        const projectId = e.kind === 'replaced' ? e.projectId : it.projectId;
        const versionId = e.kind === 'replaced' ? e.versionId : it.versionId;
        if (!projectId || !versionId) { snap.skipped.push({ fileName: e.fileName, reason: 'manual' }); continue; }
        const name = e.kind === 'replaced' ? e.name : titles[`${provider}:${projectId}`]?.name ?? fileStem(it.fileName);
        // A CurseForge pack lists only project and file IDs, so nothing needs asking.
        if (format === 'curseforge' && provider === 'curseforge') {
          snap.mods.push({ provider, projectId, versionId, versionName: it.versionNumber ?? versionId, name, fileName: it.fileName.replace(/\.disabled$/i, ''), size: Number(it.size), sha1: '', url: '', enabled: it.enabled });
          continue;
        }
        if (!providerOk(provider)) { snap.skipped.push({ fileName: e.fileName, reason: 'provider' }); continue; }
        const looked = await lookUpFile(w, provider, projectId, versionId, it.fileName);
        if (typeof looked === 'string') { snap.skipped.push({ fileName: e.fileName, reason: looked }); continue; }
        snap.mods.push({ ...looked, provider, projectId, versionId, name, enabled: it.enabled });
      }
      onProgress?.(entries.length, entries.length);
      snap.configs = await readConfigs(w);
      return snap;
    },
    async exportInstanceZip(instanceId, meta, onProgress) {
      if (!options.host) return notYet('Instance zips');
      const w = workspaceOf(instanceId);
      const loader = w.loader.id === 'vanilla' ? '' : `${w.loader.id}-${w.loader.version}`;
      return options.host.exportInstance(w.workspaceId, { fileName: `${meta.name}-${meta.version}.zip`, name: meta.name, version: meta.version, minecraft: w.minecraftVersion, loader }, onProgress);
    },

    async searchPacks(q) {
      if (!options.host) return notYet('modpack search');
      return options.host.packSearch(q.provider, q.text, q.offset, q.limit);
    },
    async packVersions(provider, packId) {
      if (!options.host) return notYet('modpack search');
      return options.host.packVersions(provider, packId);
    },
    async installPack(r) {
      if (!options.host || !capabilities().includes('packs.install')) return notYet('modpack installs');
      const operationId = crypto.randomUUID();
      const now = new Date().toISOString();
      const job: PackJob = { cancelled: false, status: { operationId, kind: 'install-pack', state: 'queued', progress: 0, startedAt: now, updatedAt: now, cancellable: true } };
      packJobs.set(operationId, job);
      void runPackInstall(job, r);
      return { operationId };
    },
    async deleteInstance(instanceId, idempotencyKey) {
      if (!ext('workspaces.delete', true)) return notYet('deleting projects');
      const w = workspaceOf(instanceId);
      const acc = await submit('workspaces.delete', { idempotencyKey: idempotencyKey.replace(/[^A-Za-z0-9_-]/g, ''), physicalId: w.physicalId });
      setPackLink(w.workspaceId, null);
      return { operationId: acc.operationId };
    },
    async projectDetail(provider, projectId) {
      if (!options.host) return notYet('project details');
      return options.host.projectDetail(provider, projectId);
    },
    async renameInstance(instanceId, name) {
      if (!ext('workspaces.rename', true)) return notYet('renaming projects');
      const { workspace } = await call<{ workspace: CoreWorkspace }>('workspaces.rename', { physicalId: workspaceOf(instanceId).physicalId, name });
      toInstance(workspace);
    },
    async checkUpdates(instanceId) {
      if (!options.host) return [];
      const w = workspaceOf(instanceId);
      const inv = [...(inventories.get(instanceId)?.values() ?? [])];
      const eligible = inv.filter((m) => m.projectId && m.versionId && m.metadataState === 'verified' && !m.updateLocked && providerOk(m.provider ?? 'modrinth'));
      const results = await options.host.modUpdates(eligible.map((m) => ({ provider: m.provider ?? 'modrinth', projectId: m.projectId!, versionId: m.versionId! })), w.minecraftVersion, w.loader.id);
      const byVersion = new Map(results.map((r) => [`${r.provider}:${r.projectId}:${r.installedVersionId}`, r]));
      return eligible.flatMap((m) => {
        const r = byVersion.get(`${m.provider ?? 'modrinth'}:${m.projectId}:${m.versionId}`);
        return r ? [{ modKey: m.inventoryId, available: r.candidate ?? { id: m.versionId!, name: m.versionNumber ?? m.versionId! } }] : [];
      });
    },
    async preparePackUpdate(instanceId, versionId, onStep) {
      if (!options.host) return notYet('modpack updates');
      const w = workspaceOf(instanceId);
      const link = packLinks()[w.workspaceId];
      if (!link) throw new BackendError('rejected', 'This project does not remember which modpack it came from.');
      onStep?.('download');
      const fetched = await options.host.packFetch(link.provider, link.packId, versionId, crypto.randomUUID());
      let token: string | null = null;
      try {
        onStep?.('upload');
        token = await readUpload(fetched.size, fetched.sha256, (o, l) => options.host!.packRead(fetched.token, o, l));
        const inspected = await call<CoreImportInspection>('imports.inspect', { token, format: fetched.format });
        // A newer build of the same loader is part of a normal pack update; a different game or loader is a different project.
        if (inspected.minecraftVersion !== w.minecraftVersion || inspected.loader.id !== w.loader.id) {
          throw new BackendError('rejected', `This version needs Minecraft ${inspected.minecraftVersion} with ${inspected.loader.id} ${inspected.loader.version}, but this project uses ${w.minecraftVersion} with ${w.loader.id} ${w.loader.version}. Install it as a new project instead.`, 'LOADER_CHANGED');
        }
        onStep?.('prepare');
        const { instanceRevision } = await call<{ instanceRevision: string }>('mods.list', { physicalId: w.physicalId, limit: 1 });
        await replacePrepared(instanceId);
        const acc = await submit('imports.prepare', { idempotencyKey: crypto.randomUUID(), physicalId: w.physicalId, instanceRevision, token, format: fetched.format, includeOptional: false, packAuthoritative: true, allowLoaderUpdate: true, removeInventoryIds: link.managed });
        const op = await awaitPrepared(acc.operationId);
        prepared.set(instanceId, op.operationId);
        const name = (await options.host.packVersions(link.provider, link.packId)).find((v) => v.id === versionId)?.name ?? versionId;
        pendingPackUpdate.set(instanceId, { versionId, versionName: name, before: [...(inventories.get(instanceId)?.keys() ?? [])] });
        return await readPlan(instanceId, op.operationId);
      } finally {
        if (token) await discard(token).catch(() => undefined);
        await options.host.packDiscard(fetched.token).catch(() => undefined);
      }
    },
    async finishPackUpdate(instanceId) {
      const update = pendingPackUpdate.get(instanceId);
      const w = workspaceOf(instanceId);
      const link = packLinks()[w.workspaceId];
      if (!update || !link) return;
      pendingPackUpdate.delete(instanceId);
      // What the user added themselves stays theirs: it was there before and did not come from the pack.
      const own = new Set(update.before.filter((k) => !link.managed.includes(k)));
      const { items } = await rpc.paged<{ nextOffset: number | null; instanceRevision: string; total: number }, CoreInstalled>('mods.list', { physicalId: w.physicalId }, 'items');
      setPackLink(w.workspaceId, { ...link, versionId: update.versionId, versionName: update.versionName, managed: items.map((m) => m.inventoryId).filter((k) => !own.has(k)) });
    },
    async shutdownHelper() {
      if (!has('core.shutdown')) return;
      clearInterval(heartbeat);
      // An unapplied plan keeps the helper running, and the next start would cancel it anyway.
      await cancelPreparedPlans();
      stopping = true;
      // A read still in flight is enough for a refusal, so give those a moment to finish.
      for (let attempt = 1; ; attempt++) {
        try {
          await call('core.shutdown', {});
          return;
        } catch (e) {
          // Losing the pipe here just means it already stopped; only a refusal matters.
          if (!(e instanceof BackendError) || e.code !== 'instance-busy') return;
          if (attempt >= 6) {
            stopping = false;
            startHeartbeat();
            throw e;
          }
          await sleep(poll);
        }
      }
    },
    resumeHelper() {
      stopping = false;
      startHeartbeat();
    },
    canAdopt: () => ext('workspaces.adopt', true),
    async adoptInstance(path) {
      if (!ext('workspaces.adopt', true)) return notYet('connecting Launcher instances');
      const accepted = await submit('workspaces.adopt', { idempotencyKey: crypto.randomUUID(), path });
      const op = await settle(accepted.operationId, undefined, false);
      if (op.state !== 'completed') throw new BackendError('rejected', op.error?.message ?? 'This instance could not be connected.', op.error?.code);
    },
    async releaseInstance(instanceId) {
      if (!ext('workspaces.release', true)) return notYet('disconnecting Launcher instances');
      await call('workspaces.release', { physicalId: workspaceOf(instanceId).physicalId });
      workspaces.delete(instanceId);
    },
    async recycleContent(instanceId, area, paths) {
      if (!options.host) return notYet('removing files');
      await options.host.workspaceRecycle(workspaceOf(instanceId).workspaceId, area, paths);
    },
    async forgetMissingMods(instanceId) {
      if (!options.host) return notYet('cleaning up');
      return options.host.workspaceForgetMissing(workspaceOf(instanceId).workspaceId);
    },
    async openFolder(instanceId, area, folder) {
      await options.host?.workspaceOpen(workspaceOf(instanceId).workspaceId, area, folder);
    },

    // Non-mod content is the desktop host's: the helper only ever changes mods.
    async listContent(instanceId, area: ContentArea, folder) {
      if (!options.host) return notYet('file listing');
      return (await options.host.workspaceList(workspaceOf(instanceId).workspaceId, area, folder)).map(({ modifiedMs, ...e }) => ({ ...e, ...(modifiedMs ? { modifiedAt: new Date(modifiedMs).toISOString() } : {}) }));
    },
    async readContentText(instanceId, area, path) {
      if (!options.host) return notYet('editing files');
      return options.host.workspaceReadText(workspaceOf(instanceId).workspaceId, area, path);
    },
    async readContentImage(instanceId, area, path) {
      if (!options.host) return notYet('viewing images');
      return options.host.workspaceReadImage(workspaceOf(instanceId).workspaceId, area, path);
    },
    async writeContentText(instanceId, area, path, text, expectedModifiedMs) {
      if (!options.host) return notYet('editing files');
      return options.host.workspaceWriteText(workspaceOf(instanceId).workspaceId, area, path, text, expectedModifiedMs);
    },
    async addContentFiles(instanceId, area, folder) {
      if (!options.host) return notYet('adding files');
      return options.host.workspaceAddFiles(workspaceOf(instanceId).workspaceId, area, folder);
    },
    async contentProviders() {
      // Same two sites as mods, asked by the host; CurseForge needs this build's key.
      const packs = options.host ? await options.host.packProviders().catch((): PackProviderInfo[] => []) : [];
      return (['modrinth', 'curseforge'] as const).map((id) => {
        const p = packs.find((x) => x.id === id);
        return { id, available: !!p?.available, unavailableReason: p?.available ? undefined : id === 'curseforge' ? 'curseforge-disabled' : 'helper-pending' };
      });
    },
    async searchContent(q) {
      if (!options.host) return notYet('resource pack and shader search');
      return options.host.contentSearch(q);
    },
    async contentVersions(provider, projectId, minecraftVersion) {
      if (!options.host) return notYet('resource pack and shader search');
      return options.host.contentVersions(provider, projectId, minecraftVersion);
    },
    async installContent(instanceId, kind, provider, projectId, versionId, onProgress) {
      if (!options.host) return notYet('installing resource packs and shaders');
      return options.host.contentInstall(workspaceOf(instanceId).workspaceId, kind, provider, projectId, versionId, onProgress);
    },
    // Export is built in the Manager from snapshotWorkspace; these are the Launcher's own export path.
    checkExport: () => notYet('export'), startExport: () => notYet('export'),
    // The helper never launches Minecraft or signs in; playing goes through Awake Launcher.
    requestLaunch: () => Promise.reject(new BackendError('unsupported', 'Playing needs Awake Launcher.')),
  };
}
