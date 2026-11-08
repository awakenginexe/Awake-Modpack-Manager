import {
  BackendError,
  type Handshake, type InstalledMod, type InstanceStatus, type InstanceSummary, type InstanceWarning,
  type Installation, type ModInventory,
} from '../contract';
import { createRpc } from '../coordinator/rpc';
import type { ConnectionState, ManagerBackend } from '../ManagerBackend';
import type { InstanceListResult, InventoryItem, InventoryResult, LauncherInfoResult, WireInstance } from './protocol';
import type { LauncherProfile, PipeTransport } from './transport';

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
  /** Items per page, 1-500 (protocol maximum). Smaller values exercise paging in tests. */
  pageLimit?: number;
}

/**
 * Manager backend for the real Awake Launcher (protocol 1.0, pinned in protocol.ts).
 * Reads: hello, launcher.info, instances.list, mods.list. Draft operation methods are sent only
 * when hello reports them true (none are at the pin); everything else rejects with `unsupported`
 * without a request. This client never reads or writes instance files itself.
 */
export function createLauncherClient(options: LauncherClientOptions): ManagerBackend {
  const listeners = new Set<(s: ConnectionState) => void>();
  let state: ConnectionState = 'disconnected';
  let added = options.addedFolders ?? [];
  let preferred = options.preferredProfile ?? null;
  let profiles: LauncherProfile[] = [];
  let profile: LauncherProfile | null = null;
  let info: LauncherInfoResult | null = null;
  let warnings: InstanceWarning[] = [];
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

  function pickProfile(): LauncherProfile {
    const usable = profiles.filter((p) => p.exists);
    const chosen = usable.find((p) => p.dataRoot === preferred) ?? usable.find((p) => p.endpoint) ?? usable[0] ?? profiles[0];
    if (!chosen) throw new BackendError('not-running', 'No Awake Launcher data folder was found. Add your Launcher folder in Settings.');
    return chosen;
  }

  const rpc = createRpc({
    transport,
    clientVersion: options.clientVersion,
    timeoutMs: options.requestTimeoutMs ?? 15_000,
    pageLimit: options.pageLimit,
    peer: 'Awake Launcher',
    storePrefix: 'launcher-ops',
    // Older Launchers refuse this offer; rpc then connects without it and they stay read-only.
    extensions: ['launcher.v3.2'],
    onLost: () => setState('disconnected'),
    async locate() {
      profiles = await transport().discover(added);
      profile = pickProfile();
      const endpoint = profile.endpoint;
      if (!endpoint) {
        if (profile.drive === 'removable' || profile.drive === 'remote') {
          throw new BackendError('unsupported-profile', 'Awake Launcher can only share data from profiles on a local fixed drive. This profile is on a removable or network drive.', profile.dataRoot);
        }
        // The Launcher refuses to publish from such a folder even while it is open, so "not running" would be wrong.
        if (profile.shareBlocked === 'public-write') throw new BackendError('profile-not-private', 'Other Windows accounts can change this data folder, so Awake Launcher does not publish its endpoint here.', profile.dataRoot);
        if (profile.shareBlocked === 'foreign-owner') throw new BackendError('profile-not-owned', 'This data folder is not owned by the current Windows account, so Awake Launcher does not publish its endpoint here.', profile.dataRoot);
        throw new BackendError('not-running', profile.endpointError ?? 'Awake Launcher is not running for this profile.', profile.dataRoot);
      }
      const conn = await transport().open(endpoint.serverName, endpoint.pid);
      return { conn, expect: endpoint };
    },
    checkHello(h) {
      // A Manager helper must never be mistaken for the Launcher (handoff: no impersonation).
      if (h.role !== undefined && h.role !== 'launcher') throw new BackendError('identity', 'This endpoint is not Awake Launcher.');
    },
  });
  const { call, paged, toBackendError, enabled, unsupported } = rpc;
  /** Open, then stay with this profile across Launcher restarts instead of discovery order. */
  const open = async () => { await rpc.open(); preferred ??= profile?.dataRoot ?? null; };

  const statusOf = (i: WireInstance): InstanceStatus => {
    switch (i.nativeActivity) {
      case 'idle': return 'ready';
      case 'launch_preparing':
      case 'launch_active': return 'running';
      case 'deleting': return 'busy';
      default: return 'unknown';
    }
  };

  /** Manager-side instance key: profile + physicalId (handoff.md: never folder ID or UUID alone). */
  const physicalIds = new Map<string, string>();
  const instanceKey = (physicalId: string) => {
    const key = `${rpc.hello()?.profileId ?? 'profile'}|${physicalId}`;
    physicalIds.set(key, physicalId);
    return key;
  };
  const physicalIdOf = (key: string) => {
    const physicalId = physicalIds.get(key);
    if (!physicalId) throw new BackendError('rejected', 'This instance is not in the current Launcher profile. Refresh the library.', 'NOT_FOUND');
    return physicalId;
  };

  function toInstance(i: WireInstance, revision: string): InstanceSummary {
    const viewable = i.loaded && i.identityStatus === 'verified';
    return {
      id: instanceKey(i.physicalId),
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
    // Decimal strings: keep only values a JS number represents exactly (no silent precision loss).
    return {
      key: it.fileName,
      fileName: it.fileName,
      name: md?.name || displayName(it.fileName),
      source: md?.provider ?? 'manual',
      projectId: md?.projectId,
      installed: md ? { id: md.versionId, name: md.version || md.versionId } : null,
      enabled: it.enabled,
      sizeBytes: Number.isSafeInteger(size) ? size : undefined,
      modifiedMs: Number.isSafeInteger(modified) ? modified : undefined,
      metadataState: it.metadataState,
      kind: it.kind,
      linked: it.linked,
      updateLocked: md?.updateLocked,
    };
  }

  function startHeartbeat() {
    clearInterval(heartbeat);
    if (!options.heartbeatMs) return;
    heartbeat = setInterval(() => {
      if (state !== 'connected') return;
      call('launcher.info', {}).catch(() => undefined);
    }, options.heartbeatMs);
  }

  return {
    kind: 'launcher',

    async connect(): Promise<Handshake> {
      setState('connecting');
      try {
        await rpc.serial(open);
        info = await call<LauncherInfoResult>('launcher.info', {});
      } catch (e) {
        setState('disconnected');
        throw toBackendError(e);
      }
      setState('connected');
      startHeartbeat();
      return {
        contract: `${rpc.version().major}.${rpc.version().minor}`,
        launcherVersion: info.executable,
        capabilities: rpc.capabilities(),
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
    // Shown only while waiting; a crashed Launcher can leave a stale descriptor behind, so ignore it.
    canStartLauncher: () => !!profile?.installDir && !!options.transport?.startLauncher,
    async openInLauncher(workspaceId) {
      const target = profile?.installDir ? profile : profiles.find((p) => p.installDir && (!preferred || p.dataRoot === preferred));
      const t = transport();
      if (!target || !t.startLauncher) throw new BackendError('unsupported', 'Install Awake Launcher 3.1.0 or newer and add its installation folder in Settings → Launcher connection. You can also use Link Existing Manager Workspace in Launcher.');
      try { await t.startLauncher(target.dataRoot, added, workspaceId); } catch (e) { throw toBackendError(e); }
    },
    async startLauncher() {
      const t = transport();
      if (!profile?.installDir || !t.startLauncher) throw new BackendError('unsupported', 'No Awake Launcher installation is known for this profile. Add the installation folder in Settings.');
      try { await t.startLauncher(profile.dataRoot, added); } catch (e) { throw toBackendError(e); }
    },
    async makeProfilePrivate() {
      const t = transport();
      if (!profile || !t.makeProfilePrivate) throw new BackendError('unsupported', 'Folder permissions can only be changed from the desktop app.');
      try { await t.makeProfilePrivate(profile.dataRoot, added); } catch (e) { throw toBackendError(e); }
    },
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
        await rpc.serial(open).catch((e) => { throw toBackendError(e); });
      }
      const { items, revision, pages } = await paged<InstanceListResult, WireInstance>('instances.list', {}, 'instances');
      warnings = pages.flatMap((p) => p.warnings ?? []);
      const instances = items.map((i) => toInstance(i, revision));
      // Inventory counts: one small read per viewable instance (unloaded ones return NOT_FOUND).
      for (const inst of instances) {
        if (!inst.manageable) continue;
        try {
          const page = await call<InventoryResult>('mods.list', { physicalId: physicalIdOf(inst.id), limit: 1 });
          inst.modCount = page.total;
        } catch { /* count stays unknown */ }
        if (!enabled('instances.icon')) continue;
        try {
          const icon = await call<{ mimeType: string; base64: string }>('instances.icon', { physicalId: physicalIdOf(inst.id) });
          if (icon.mimeType === 'image/png' && /^[A-Za-z0-9+/]+=*$/.test(icon.base64)) inst.iconUrl = `data:image/png;base64,${icon.base64}`;
        } catch { /* the initials stand in */ }
      }
      return instances;
    },

    instanceWarnings: () => warnings,

    async getInventory(instanceId, onProgress): Promise<ModInventory> {
      const { items, revision } = await paged<InventoryResult, InventoryItem>('mods.list', { physicalId: physicalIdOf(instanceId) }, 'items', (loaded, total) => onProgress?.(loaded, total));
      return { instanceId, revision, mods: items.map(toMod) };
    },

    async createInstance(request) {
      // The draft defines `loader` only as a native component UID/version, with no wire shape yet.
      if (request.loader !== 'vanilla') throw new BackendError('unsupported', 'Awake Launcher can only create vanilla instances for the Manager so far.');
      return rpc.submit('instances.create', { idempotencyKey: request.idempotencyKey, name: request.name, minecraftVersion: request.minecraftVersion }, 'create-instance');
    },

    applyPlan: (request) => rpc.submit('transactions.apply', {
      idempotencyKey: request.idempotencyKey, operationId: request.planId, planDigest: request.planHash, instanceRevision: request.baseRevision,
    }, 'apply-plan'),

    canEnroll: () => enabled('instances.enroll'),
    async enrollInstance(instanceId, phase) {
      if (!enabled('instances.enroll')) return unsupported();
      await call('instances.enroll', { physicalId: physicalIdOf(instanceId), phase });
    },

    async requestLaunch(instanceId, idempotencyKey) {
      if (!enabled('launch.request')) return unsupported();
      return rpc.submit('launch.request', { idempotencyKey, physicalId: physicalIdOf(instanceId) }, 'launch', instanceId);
    },

    getOperation: rpc.readOperation,
    listOperations: rpc.listOperations,
    // No events.subscribe: followOperation polls operations.get, the source of truth anyway.
    watchOperation: () => () => {},
    cancelOperation: rpc.cancelOperation,

    // Not available: the draft gives these no result schema (docs/LAUNCHER-REQUESTS.md).
    search: unsupported,
    searchPacks: unsupported,
    packVersions: unsupported,
    installPack: unsupported,
    validateDraft: unsupported,
    preparePlan: unsupported,
    getRecoveryStatus: unsupported,
    listContent: unsupported,
    checkExport: unsupported,
    startExport: unsupported,
  };
}
