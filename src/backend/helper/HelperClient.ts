import {
  BackendError, TERMINAL_STATES,
  type Accepted, type Capability, type DraftChange, type Handshake, type ImportInspection, type InstalledMod, type InstanceSummary, type Installation,
  type LoaderKind, type ModInventory, type OperationStatus, type PlanIssue, type PlanItem, type ProjectVersion, type ProviderId, type ResolvedPlan, type VersionRef, type WorkspaceSnapshot,
} from '../contract';
import { load, save } from '../../domain/storage';
import { createRpc } from '../coordinator/rpc';
import { CORE_VERSION, descriptorError, MANAGER_EXTENSION, paramsError, resultError, type CoreMethod } from '../core/schema';
import type {
  CoreAccepted, CoreCapabilities, CoreChange, CoreHello, CoreImportInspection, CoreInfo, CoreInstalled, CoreLoaderId, CoreOperation, CorePlanPage,
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
    extensions: [MANAGER_EXTENSION],
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
  /** Extension features need both the negotiated extension and the capability flag. */
  const ext = (m: keyof CoreCapabilities, write = false) => rpc.extensions().includes(MANAGER_EXTENSION) && has(m, write);
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
      if (titles[k]?.name !== h.name || titles[k]?.iconUrl !== h.iconUrl) { titles = { ...titles, [k]: { name: h.name, iconUrl: h.iconUrl } }; changed = true; }
    }
    // shortcut: grows with the projects the user browses; prune if it ever reaches a few MB.
    if (changed) save(TITLES, titles);
  }
  /**
   * Friendly names for provider-identified files the user never met in search (imports): one
   * providers.project read each, remembered. shortcut: serial and time-boxed per inventory load, so a
   * large first import names the rest on later refreshes; batch it if the helper gains a bulk read.
   */
  async function lookupTitles(items: CoreInstalled[], budgetMs = 4000) {
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
    const map: Record<string, BackendError['code']> = {
      STALE_INSTANCE: 'stale-revision', STALE_PLAN: 'plan-expired', BUSY: 'instance-busy', RECOVERY_REQUIRED: 'recovery-required',
      INVALID_ARCHIVE: 'invalid-archive', PROVIDER_RESTRICTED: 'provider-restricted', PROVIDER_UNAVAILABLE: 'provider-restricted', UNSUPPORTED_CAPABILITY: 'unsupported',
    };
    return new BackendError(e ? map[e.code] ?? 'rejected' : 'rejected', e?.message ?? fallback, e?.code);
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
    const issues: PlanIssue[] = [
      // Optional dependencies are listed as suggestions below; the helper also words them as warnings.
      ...head.warnings.filter((w) => !/^optional dependency/i.test(w)).map((w) => ({ severity: 'warning' as const, code: 'coordinator-warning' as const, message: w.trim(), modKeys: [] })),
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
  const canImport = () => ['imports.inspect', 'imports.prepare', 'inbox.begin', 'inbox.write', 'inbox.commit', 'inbox.discard'].every((m) => ext(m as keyof CoreCapabilities, true));
  async function discard(token: string) {
    await call('inbox.discard', { token });
    save(uploadsKey(), uploads().filter((t) => t !== token));
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
      // A prepared plan never expires and keeps the helper (and so upgrades) waiting. Plans left
      // by an earlier Manager run can't be applied from this one, so cancel them once at start.
      if (!startupCleaned && has('operations.list') && has('operations.cancel', true)) {
        startupCleaned = true;
        const { items } = await all<CoreOperation, { operations: CoreOperation[]; nextOffset: number | null }>('operations.list', {}, (p) => p.operations).catch(() => ({ items: [] as CoreOperation[] }));
        for (const op of items) if (op.state === 'prepared') await call('operations.cancel', { operationId: op.operationId }).catch(() => undefined);
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
      await lookupTitles(items);
      const mods = items.map(toMod);
      if (has('updates.check')) {
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

    async validateDraft(d) {
      if (!has('plans.prepare', true) || !has('plans.get')) return notYet('reviewing changes');
      const w = workspaceOf(d.instanceId);
      await replacePrepared(d.instanceId);
      const acc = await submit('plans.prepare', { idempotencyKey: crypto.randomUUID(), physicalId: w.physicalId, instanceRevision: d.baseRevision, changes: await toChanges(d.instanceId, d.changes) });
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

    canImport,
    async uploadImport(file, onProgress, signal) {
      if (!canImport()) return notYet('modpack import');
      // shortcut: the archive is read into memory once (contract limit 1 GiB); stream it if large packs become common.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      let t = await call<CoreTransfer>('inbox.begin', { idempotencyKey: crypto.randomUUID(), purpose: 'import', size: String(bytes.length), sha256 });
      save(uploadsKey(), [...uploads().filter((x) => x !== t.token), t.token]);
      try {
        for (let offset = Number(t.received); offset < bytes.length; offset = Number(t.received)) {
          if (signal?.aborted) throw new BackendError('rejected', 'Upload cancelled.', 'CANCELLED');
          t = await call<CoreTransfer>('inbox.write', { token: t.token, offset: String(offset), bytesBase64: toBase64(bytes.subarray(offset, offset + CHUNK)) });
          if (Number(t.received) <= offset) throw new BackendError('protocol', 'The helper did not accept the upload chunk.');
          onProgress?.(Number(t.received), bytes.length);
        }
        t = await call<CoreTransfer>('inbox.commit', { token: t.token });
        if (!t.complete || t.sha256 !== sha256) throw new BackendError('protocol', 'The helper did not confirm the uploaded archive.');
        return t.token;
      } catch (e) {
        await discard(t.token).catch(() => undefined);
        throw rpc.toBackendError(e);
      }
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
    async prepareImport(instanceId, token, format, includeOptional) {
      if (!canImport()) return notYet('modpack import');
      const w = workspaceOf(instanceId);
      // The plan is bound to the workspace's current content, not to the possibly older list entry.
      const { instanceRevision } = await call<{ instanceRevision: string }>('mods.list', { physicalId: w.physicalId, limit: 1 });
      await replacePrepared(instanceId);
      const acc = await submit('imports.prepare', { idempotencyKey: crypto.randomUUID(), physicalId: w.physicalId, instanceRevision, token, format, includeOptional });
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
        let found: CoreVersion | undefined;
        // providers.versions is newest first; an older installed version can sit a few pages down.
        for (let offset = 0; !found && offset < 1000; offset += PAGE) {
          const page = await call<{ versions: CoreVersion[] }>('providers.versions', { provider, minecraftVersion: w.minecraftVersion, loader: coreLoader(w.loader.id), projectId: it.projectId, offset, limit: PAGE });
          found = page.versions.find((v) => v.versionId === it.versionId);
          if (page.versions.length < PAGE) break;
        }
        const file = found && (found.files.find((f) => f.fileName === it.fileName.replace(/\.disabled$/i, '')) ?? found.files[0]);
        if (!found || !file) { snap.skipped.push({ fileName: it.fileName, reason: 'not-found' }); continue; }
        snap.mods.push({
          provider, projectId: it.projectId, versionId: it.versionId, versionName: found.versionNumber, name: titles[`${provider}:${it.projectId}`]?.name ?? fileStem(it.fileName),
          fileName: file.fileName, size: Number(file.size), sha1: file.sha1, sha512: file.sha512, url: file.url, enabled: it.enabled,
        });
      }
      onProgress?.(items.length, items.length);
      snap.configs = await readConfigs(w);
      return snap;
    },

    // Not in this helper slice (core-protocol.md): modpack catalogs, content listing, export (outbox.read).
    searchPacks: () => notYet('modpack search'), packVersions: () => notYet('modpack search'), installPack: () => notYet('modpack installs'),
    listContent: () => notYet('file listing'), checkExport: () => notYet('export'), startExport: () => notYet('export'),
    // The helper never launches Minecraft or signs in; playing goes through Awake Launcher.
    requestLaunch: () => Promise.reject(new BackendError('unsupported', 'Playing needs Awake Launcher.')),
  };
}
