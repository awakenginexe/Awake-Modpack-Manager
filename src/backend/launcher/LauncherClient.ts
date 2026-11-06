import {
  ALL_CAPABILITIES, BackendError,
  type Capability, type Handshake, type InstalledMod, type InstanceStatus, type InstanceSummary, type InstanceWarning,
  type Installation, type ModInventory,
} from '../contract';
import type { ConnectionState, ManagerBackend } from '../ManagerBackend';
import {
  assertPage, buildRequest, negotiated, parseResponse, PAGE_LIMIT, ProtocolError, SUPPORTED_VERSIONS, WireViolation,
  type HelloResult, type InstanceListResult, type InventoryItem, type InventoryResult, type LauncherInfoResult,
  type ProtocolVersion, type ReadMethod, type WireInstance,
} from './protocol';
import { TransportError, type LauncherProfile, type PipeTransport } from './transport';

export interface LauncherClientOptions {
  transport: PipeTransport | null;
  clientVersion: string;
  /** Folders the user added (installation or data folder). */
  addedFolders?: string[];
  /** Preferred profile data root, if the user chose one. */
  preferredProfile?: string | null;
  requestTimeoutMs?: number;
  /** Liveness check interval while connected. 0 disables (tests). */
  heartbeatMs?: number;
}

/**
 * Read-only Manager backend for the real Awake Launcher (protocol 1.0, pinned in protocol.ts).
 * Only hello, launcher.info, instances.list and mods.list exist; every write-side method rejects
 * with `unsupported`. This client never reads or writes instance files itself.
 */
export function createLauncherClient(options: LauncherClientOptions): ManagerBackend {
  const timeout = options.requestTimeoutMs ?? 15_000;
  const listeners = new Set<(s: ConnectionState) => void>();
  let state: ConnectionState = 'disconnected';
  let added = options.addedFolders ?? [];
  let preferred = options.preferredProfile ?? null;
  let profiles: LauncherProfile[] = [];
  let profile: LauncherProfile | null = null;
  let conn: number | null = null;
  let version: ProtocolVersion = SUPPORTED_VERSIONS[0];
  let hello: HelloResult | null = null;
  let info: LauncherInfoResult | null = null;
  let warnings: InstanceWarning[] = [];
  let seq = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const setState = (s: ConnectionState) => {
    if (s === state) return;
    state = s;
    for (const l of listeners) l(s);
  };
  const transport = () => {
    if (!options.transport) throw new BackendError('unsupported', 'Live Launcher data needs the Awake Modpack Manager desktop app. A web browser cannot open the Launcher pipe.');
    return options.transport;
  };
  /** Requests run one at a time: the protocol allows a single in-flight request per connection. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  function toBackendError(e: unknown): BackendError {
    if (e instanceof BackendError) return e;
    if (e instanceof ProtocolError) {
      const map: Record<string, BackendError['code']> = {
        UNSUPPORTED_CAPABILITY: 'unsupported', UNSUPPORTED_PROTOCOL: 'protocol', STALE_INSTANCE: 'stale-revision',
        BUSY: 'instance-busy', IDENTITY_UNVERIFIABLE: 'identity', IDENTITY_CONFLICT: 'identity',
      };
      return new BackendError(map[e.code] ?? 'rejected', e.message, e.code);
    }
    if (e instanceof WireViolation) return new BackendError('protocol', e.message);
    if (e instanceof TransportError) {
      const map: Partial<Record<TransportError['code'], BackendError['code']>> = { 'not-running': 'not-running', identity: 'identity', timeout: 'timeout', busy: 'instance-busy' };
      return new BackendError(map[e.code] ?? 'disconnected', e.message, e.code);
    }
    return new BackendError('protocol', e instanceof Error ? e.message : String(e));
  }

  async function exchange(method: ReadMethod, params: Record<string, unknown>, v = version): Promise<Record<string, unknown>> {
    if (conn === null) throw new TransportError('closed', 'Not connected.');
    const requestId = `r${++seq}`;
    try {
      return parseResponse(await transport().request(conn, buildRequest(requestId, method, params, v), timeout), requestId, v);
    } catch (e) {
      // A broken exchange leaves the stream unusable; the host already dropped it.
      if (e instanceof TransportError || e instanceof WireViolation) conn = null;
      throw e;
    }
  }

  function pickProfile(): LauncherProfile {
    const usable = profiles.filter((p) => p.exists);
    const chosen = usable.find((p) => p.dataRoot === preferred) ?? usable.find((p) => p.endpoint) ?? usable[0] ?? profiles[0];
    if (!chosen) throw new BackendError('not-running', 'No Awake Launcher data folder was found. Add your Launcher folder in Settings.');
    return chosen;
  }

  /** Discover, open the pipe, hello, verify identity. Throws BackendError. */
  async function open(): Promise<void> {
    if (conn !== null) { await transport().close(conn).catch(() => undefined); conn = null; }
    profiles = await transport().discover(added);
    profile = pickProfile();
    const endpoint = profile.endpoint;
    if (!endpoint) {
      if (profile.drive === 'removable' || profile.drive === 'remote') {
        throw new BackendError('unsupported-profile', 'Awake Launcher can only share data from profiles on a local fixed drive. This profile is on a removable or network drive.', profile.dataRoot);
      }
      throw new BackendError('not-running', profile.endpointError ?? 'Awake Launcher is not running for this profile.', profile.dataRoot);
    }
    conn = await transport().open(endpoint.serverName, endpoint.pid);
    const result = await exchange('hello', { versions: [...SUPPORTED_VERSIONS], client: { name: 'Awake Modpack Manager', version: options.clientVersion } }, SUPPORTED_VERSIONS[0]) as unknown as HelloResult;
    version = negotiated(result.protocol);
    // The descriptor is only a hint: hello must name the same installation, profile and session.
    if (result.installationId !== endpoint.installationId || result.profileId !== endpoint.profileId || result.sessionId !== endpoint.sessionId) {
      await transport().close(conn).catch(() => undefined);
      conn = null;
      throw new BackendError('identity', 'The Launcher endpoint does not match its descriptor. It may be stale; restart Awake Launcher.');
    }
    hello = result;
  }

  /** Run a read; reconnect once (hello first) if the pipe dropped, e.g. after the 30 s idle timeout. */
  function call<T>(method: ReadMethod, params: Record<string, unknown>): Promise<T> {
    return serial(async () => {
      try {
        if (conn === null) await open();
        try {
          return await exchange(method, params) as T;
        } catch (e) {
          if (!(e instanceof TransportError) && !(e instanceof ProtocolError && e.code === 'HANDSHAKE_REQUIRED')) throw e;
          await open();
          return await exchange(method, params) as T;
        }
      } catch (e) {
        const err = toBackendError(e);
        if (['disconnected', 'not-running', 'timeout', 'identity', 'unsupported-profile'].includes(err.code)) setState('disconnected');
        throw err;
      }
    });
  }

  /** Follow nextOffset, echoing the first page's instanceRevision; restart on STALE_INSTANCE. */
  async function paged<R extends { nextOffset: number | null; instanceRevision: string; total: number }, I>(
    method: 'instances.list' | 'mods.list', base: Record<string, unknown>, listKey: 'instances' | 'items',
    onPage?: (loaded: number, total: number, page: R) => void,
  ): Promise<{ items: I[]; revision: string; pages: R[] }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const items: I[] = [];
      const pages: R[] = [];
      let offset = 0;
      let revision: string | undefined;
      try {
        for (;;) {
          const params = offset === 0 ? { ...base, limit: PAGE_LIMIT } : { ...base, limit: PAGE_LIMIT, offset, instanceRevision: revision };
          const page = await call<Record<string, unknown>>(method, params);
          assertPage(page, listKey);
          const r = page as unknown as R;
          revision ??= r.instanceRevision;
          items.push(...(page[listKey] as I[]));
          pages.push(r);
          onPage?.(items.length, r.total, r);
          if (r.nextOffset === null) return { items, revision, pages };
          if (r.nextOffset <= offset) throw new BackendError('protocol', 'Launcher pagination did not advance.');
          offset = r.nextOffset;
        }
      } catch (e) {
        if (e instanceof BackendError && e.code === 'stale-revision') continue; // changed while paging: restart
        throw e;
      }
    }
    throw new BackendError('stale-revision', 'The instance kept changing while it was being read. Try again in a moment.');
  }

  const statusOf = (i: WireInstance): InstanceStatus => {
    switch (i.nativeActivity) {
      case 'idle': return 'ready';
      case 'launch_preparing':
      case 'launch_active': return 'running';
      case 'deleting': return 'busy';
      default: return 'unknown';
    }
  };

  function toInstance(i: WireInstance, revision: string): InstanceSummary {
    const viewable = i.loaded && i.identityStatus === 'verified';
    return {
      id: i.physicalId,
      name: i.name || i.instanceId,
      status: statusOf(i),
      path: i.canonicalPath,
      manageable: viewable,
      blockedReason: !i.loaded ? 'unloaded' : i.identityStatus === 'conflict' ? 'conflict' : undefined,
      revision,
      launcher: { instanceId: i.instanceId, uuid: i.uuid, loaded: i.loaded, identityStatus: i.identityStatus, nativeActivity: i.nativeActivity },
    };
  }

  const displayName = (file: string) => file.replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, '');

  function toMod(it: InventoryItem): InstalledMod {
    const md = it.metadataState === 'indexed' ? it.metadata : null;
    const size = Number(it.size);
    const modified = Number(it.modifiedMs);
    return {
      key: it.fileName,
      fileName: it.fileName,
      name: md?.name || displayName(it.fileName),
      source: md?.provider ?? 'manual',
      projectId: md?.projectId,
      installed: md ? { id: md.versionId, name: md.version || md.versionId } : null,
      enabled: it.enabled,
      sizeBytes: Number.isFinite(size) ? size : undefined,
      modifiedMs: Number.isFinite(modified) ? modified : undefined,
      metadataState: it.metadataState,
      kind: it.kind,
      linked: it.linked,
      updateLocked: md?.updateLocked,
    };
  }

  function mapCapabilities(c: Record<string, boolean>): Capability[] {
    // Read-only phase: only the reads this client implements. Write-side capabilities stay off even
    // if a future Launcher advertises them, until this client implements their contract.
    const caps: Capability[] = ['installations.discover'];
    if (c['instances.list'] === true) caps.push('instances.list');
    if (c['mods.list'] === true) caps.push('mods.inventory');
    return caps.filter((x) => ALL_CAPABILITIES.includes(x));
  }

  function startHeartbeat() {
    clearInterval(heartbeat);
    if (!options.heartbeatMs) return;
    heartbeat = setInterval(() => {
      if (state !== 'connected') return;
      call('launcher.info', {}).catch(() => undefined);
    }, options.heartbeatMs);
  }

  const unsupported = () => Promise.reject(new BackendError('unsupported', 'Awake Launcher does not support this yet (read-only integration).'));

  return {
    kind: 'launcher',

    async connect(): Promise<Handshake> {
      setState('connecting');
      try {
        await serial(open);
        info = await call<LauncherInfoResult>('launcher.info', {});
      } catch (e) {
        setState('disconnected');
        throw toBackendError(e);
      }
      setState('connected');
      startHeartbeat();
      return {
        contract: `${version.major}.${version.minor}`,
        launcherVersion: info.executable,
        capabilities: mapCapabilities(hello?.capabilities ?? {}),
        providers: [
          { id: 'modrinth', available: false, unavailableReason: 'launcher-read-only' },
          { id: 'curseforge', available: false, unavailableReason: 'launcher-read-only' },
        ],
        packProviders: (['modrinth', 'curseforge', 'ftb', 'atlauncher', 'technic'] as const).map((id) => ({ id, available: false, unavailableReason: 'launcher-read-only' })),
      };
    },

    onConnectionChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    launcherProfiles: () => profiles,
    setAddedFolders(folders) { added = folders; },
    setPreferredProfile(dataRoot) { preferred = dataRoot; },

    async listInstallations(): Promise<Installation[]> {
      // The connected profile first, so it is the default selection.
      return [...profiles].filter((p) => p.exists).sort((a, b) => Number(b === profile) - Number(a === profile)).map((p) => ({
        id: p.dataRoot,
        displayName: p === profile && info ? (info.portable ? 'Awake Launcher (portable)' : 'Awake Launcher') : p.dataRoot,
        path: p.dataRoot,
        launcherVersion: '',
        portable: p === profile && !!info?.portable,
        available: !!p.endpoint,
      }));
    },

    async listInstances(installationId: string): Promise<InstanceSummary[]> {
      if (profile && installationId !== profile.dataRoot) {
        preferred = installationId;
        await serial(open).catch((e) => { throw toBackendError(e); });
      }
      const { items, revision, pages } = await paged<InstanceListResult, WireInstance>('instances.list', {}, 'instances');
      warnings = pages.flatMap((p) => p.warnings ?? []);
      const instances = items.map((i) => toInstance(i, revision));
      // Inventory counts: one small read per viewable instance (unloaded ones return NOT_FOUND).
      for (const inst of instances) {
        if (!inst.manageable) continue;
        try {
          const page = await call<InventoryResult>('mods.list', { physicalId: inst.id, limit: 1 });
          inst.modCount = page.total;
        } catch { /* count stays unknown */ }
      }
      return instances;
    },

    instanceWarnings: () => warnings,

    async getInventory(instanceId, onProgress): Promise<ModInventory> {
      const { items, revision } = await paged<InventoryResult, InventoryItem>('mods.list', { physicalId: instanceId }, 'items', (loaded, total) => onProgress?.(loaded, total));
      return { instanceId, revision, mods: items.map(toMod) };
    },

    // Not available in Launcher protocol 1.0 (handoff.md "Unavailable; do not enable in Manager").
    createInstance: unsupported,
    search: unsupported,
    searchPacks: unsupported,
    packVersions: unsupported,
    installPack: unsupported,
    validateDraft: unsupported,
    preparePlan: unsupported,
    applyPlan: unsupported,
    getOperation: unsupported,
    findOperationByIdempotencyKey: async () => null,
    listOperations: async () => [],
    watchOperation: () => () => {},
    cancelOperation: unsupported,
    getRecoveryStatus: unsupported,
    listContent: unsupported,
    checkExport: unsupported,
    startExport: unsupported,
    requestLaunch: unsupported,
  };
}
