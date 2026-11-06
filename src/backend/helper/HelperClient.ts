import { BackendError, type Handshake, type InstalledMod, type InstanceSummary, type Installation, type ModInventory } from '../contract';
import { createRpc } from '../coordinator/rpc';
import type { ConnectionState, ManagerBackend } from '../ManagerBackend';
import type { InstanceListResult, InventoryItem, InventoryResult, WireInstance } from '../launcher/protocol';
import type { HelperStatus, PipeTransport } from '../launcher/transport';

export const HELPER_INSTALLATION = 'manager';

export interface HelperClientOptions {
  transport: PipeTransport | null;
  clientVersion: string;
  requestTimeoutMs?: number;
  /** How long to wait for a freshly started helper to publish its endpoint. */
  startTimeoutMs?: number;
  pollMs?: number;
}

/**
 * Manager backend for the Manager's own bundled native helper (shared native core), which owns
 * real modpack workspaces, downloads, transactions and recovery when Awake Launcher is absent.
 *
 * Wire: the same framing, hello and 1.0 reads as the Launcher; durable operations only when hello
 * advertises them. The helper's own contract (role, catalogs, workspaces) is not committed yet
 * (docs/LAUNCHER-REQUESTS.md H1-H4), so nothing else is sent. A stub build never gets write
 * capabilities, so no stub result can look like a real installation.
 */
export function createHelperClient(options: HelperClientOptions): ManagerBackend {
  const listeners = new Set<(s: ConnectionState) => void>();
  let state: ConnectionState = 'disconnected';
  let status: HelperStatus | null = null;
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

  async function ensure(): Promise<HelperStatus> {
    const deadline = Date.now() + (options.startTimeoutMs ?? 15_000);
    for (;;) {
      status = await transport().ensureHelper();
      if (status.state === 'ready' && status.descriptor) return status;
      if (status.state === 'not_installed') throw new BackendError('helper-unavailable', status.message ?? 'The Manager helper is not installed. Reinstall Awake Modpack Manager.', 'not_installed');
      if (status.state === 'failed') throw new BackendError('helper-unavailable', status.message ?? 'The Manager helper could not start.', 'failed');
      if (Date.now() > deadline) throw new BackendError('helper-unavailable', 'The Manager helper did not become ready in time.', 'timeout');
      await sleep(options.pollMs ?? 250);
    }
  }

  const rpc = createRpc({
    transport,
    clientVersion: options.clientVersion,
    timeoutMs: options.requestTimeoutMs ?? 15_000,
    peer: 'The Manager helper',
    storePrefix: 'helper-ops',
    onLost: () => setState('disconnected'),
    async locate() {
      const s = await ensure();
      const d = s.descriptor!;
      return { conn: await transport().openHelper(d.serverName, d.pid), expect: d };
    },
    checkHello(h) {
      if (h.role !== undefined && h.role !== 'core-host') throw new BackendError('identity', 'The helper endpoint reported a different role.');
    },
  });
  const stub = () => !!status?.stub || rpc.hello()?.stub === true;

  const physicalIds = new Map<string, string>();
  const key = (physicalId: string) => { const k = `helper|${physicalId}`; physicalIds.set(k, physicalId); return k; };
  const physicalIdOf = (k: string) => {
    const id = physicalIds.get(k);
    if (!id) throw new BackendError('rejected', 'This project is not known to the Manager helper. Refresh the list.', 'NOT_FOUND');
    return id;
  };

  function toInstance(i: WireInstance, revision: string): InstanceSummary {
    const ok = i.loaded && i.identityStatus === 'verified';
    return {
      id: key(i.physicalId), name: i.name || i.instanceId,
      status: i.nativeActivity === 'idle' ? 'ready' : i.nativeActivity === 'deleting' ? 'busy' : 'unknown',
      path: i.canonicalPath, manageable: ok, blockedReason: !i.loaded ? 'unloaded' : i.identityStatus === 'conflict' ? 'conflict' : undefined,
      revision,
    };
  }
  function toMod(it: InventoryItem): InstalledMod {
    const md = it.metadataState === 'indexed' ? it.metadata : null;
    const size = Number(it.size);
    const modified = Number(it.modifiedMs);
    return {
      key: it.fileName, fileName: it.fileName,
      name: md?.name || it.fileName.replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, ''),
      source: md?.provider ?? 'manual', projectId: md?.projectId,
      installed: md ? { id: md.versionId, name: md.version || md.versionId } : null,
      enabled: it.enabled,
      sizeBytes: Number.isSafeInteger(size) ? size : undefined,
      modifiedMs: Number.isSafeInteger(modified) ? modified : undefined,
      metadataState: it.metadataState, kind: it.kind, linked: it.linked, updateLocked: md?.updateLocked,
    };
  }

  const notYet = (): Promise<never> => Promise.reject(new BackendError('unsupported', 'The Manager helper in this build does not support this yet.'));

  return {
    kind: 'helper',

    async connect(): Promise<Handshake> {
      setState('connecting');
      try {
        await rpc.serial(rpc.open);
      } catch (e) {
        setState('disconnected');
        throw rpc.toBackendError(e);
      }
      setState('connected');
      const reason = stub() ? 'helper-stub' : 'helper-pending';
      return {
        contract: `${rpc.version().major}.${rpc.version().minor}`,
        launcherVersion: '',
        stub: stub(),
        // A stub never gets write capabilities, whatever it advertises.
        capabilities: rpc.capabilities(!stub()),
        providers: [{ id: 'modrinth', available: false, unavailableReason: reason }, { id: 'curseforge', available: false, unavailableReason: reason }],
        packProviders: (['modrinth', 'curseforge', 'ftb', 'atlauncher', 'technic'] as const).map((id) => ({ id, available: false, unavailableReason: reason })),
      };
    },
    onConnectionChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    async listInstallations(): Promise<Installation[]> {
      return [{ id: HELPER_INSTALLATION, displayName: 'Manager projects', path: status?.dataRoot ?? '', launcherVersion: '', portable: false, available: state === 'connected' }];
    },
    async listInstances(): Promise<InstanceSummary[]> {
      if (rpc.hello()?.capabilities['instances.list'] !== true) return [];
      const { items, revision } = await rpc.paged<InstanceListResult, WireInstance>('instances.list', {}, 'instances');
      return items.map((i) => toInstance(i, revision));
    },
    async getInventory(instanceId, onProgress): Promise<ModInventory> {
      const { items, revision } = await rpc.paged<InventoryResult, InventoryItem>('mods.list', { physicalId: physicalIdOf(instanceId) }, 'items', (l, t) => onProgress?.(l, t));
      return { instanceId, revision, mods: items.map(toMod) };
    },

    async createInstance(request) {
      if (stub()) return notYet();
      if (request.loader !== 'vanilla') throw new BackendError('unsupported', 'Loader selection needs the helper version catalog, which is not available yet.');
      return rpc.submit('instances.create', { idempotencyKey: request.idempotencyKey, name: request.name, minecraftVersion: request.minecraftVersion }, 'create-instance');
    },
    applyPlan: (r) => (stub() ? notYet() : rpc.submit('transactions.apply', { idempotencyKey: r.idempotencyKey, operationId: r.planId, planDigest: r.planHash, instanceRevision: r.baseRevision }, 'apply-plan')),
    getOperation: rpc.readOperation,
    listOperations: rpc.listOperations,
    watchOperation: () => () => {},
    cancelOperation: rpc.cancelOperation,

    // Waiting on the committed helper contract (provider search/versions, plans, recovery, content, export).
    search: notYet, searchPacks: notYet, packVersions: notYet, installPack: notYet,
    validateDraft: notYet, preparePlan: notYet, getRecoveryStatus: notYet,
    listContent: notYet, checkExport: notYet, startExport: notYet,
    // The helper never launches Minecraft; that stays with Awake Launcher.
    requestLaunch: () => Promise.reject(new BackendError('unsupported', 'Playing needs Awake Launcher.')),
  };
}
