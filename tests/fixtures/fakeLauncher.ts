/**
 * Fixture Awake Launcher speaking protocol 1.0 behind the PipeTransport interface.
 * It validates requests against the pinned schema rules so the client is tested against the
 * contract, not against itself. Pure in-memory: no files, no pipes.
 */
import type { LauncherProfile, PipeTransport } from '../../src/backend/launcher/transport';
import { TransportError } from '../../src/backend/launcher/transport';
import type { InventoryItem, WireInstance, WireWarning } from '../../src/backend/launcher/protocol';

export interface FakeOptions {
  instances?: WireInstance[];
  inventories?: Record<string, InventoryItem[]>;
  warnings?: WireWarning[];
  running?: boolean;
  drive?: LauncherProfile['drive'];
  capabilities?: Record<string, boolean>;
}

const hex = (n: number) => n.toString(16).padStart(64, '0');

export function instance(i: number, over: Partial<WireInstance> = {}): WireInstance {
  return {
    instanceId: `inst${i}`, uuid: `uuid-${i}`, physicalId: `phys-${String(i).padStart(4, '0')}`, canonicalPath: `C:\\Temp\\fixture\\instances\\inst${i}`,
    name: `Instance ${i}`, loaded: true, nativeRunning: false, gameState: 'unknown', gamePhysicalId: `g${i}`, modsPhysicalId: `m${i}`,
    identityStatus: 'verified', nativeActivity: 'idle', ...over,
  };
}

export function mods(count: number): InventoryItem[] {
  return Array.from({ length: count }, (_, i) => {
    const indexed = i % 4 !== 0;
    return {
      fileName: `mod-${String(i).padStart(4, '0')}.jar${i % 10 === 3 ? '.disabled' : ''}`,
      enabled: i % 10 !== 3,
      size: String(1000 + i),
      modifiedMs: String(1_790_000_000_000 + i),
      kind: 'jar',
      linked: false,
      metadataState: indexed ? 'indexed' : 'unindexed',
      metadata: indexed ? { name: `Mod ${i}`, provider: i % 2 ? 'modrinth' : 'curseforge', projectId: `p${i}`, versionId: `v${i}`, version: `1.${i}.0`, updateLocked: i % 7 === 0 } : null,
    } satisfies InventoryItem;
  });
}

const ENVELOPE = ['protocol', 'requestId', 'method', 'params'];

/** Every draft operation method enabled (protocol.md "Reserved operation contract"). */
export const DRAFT_CAPABILITIES: Record<string, boolean> = {
  hello: true, 'launcher.info': true, 'instances.list': true, 'mods.list': true,
  'operations.get': true, 'operations.cancel': true, 'launch.request': true, 'instances.create': true, 'transactions.apply': true, 'plans.prepare': false,
};
const DRAFT_PARAMS: Record<string, { required: string[]; optional?: string[] }> = {
  'launch.request': { required: ['idempotencyKey', 'physicalId'] },
  'instances.create': { required: ['idempotencyKey', 'name', 'minecraftVersion'], optional: ['loader'] },
  'transactions.apply': { required: ['idempotencyKey', 'operationId', 'planDigest', 'instanceRevision'] },
  'operations.get': { required: ['operationId'] },
  'operations.cancel': { required: ['operationId'] },
};
const TERMINAL = ['completed', 'cancelled', 'failed', 'rolled_back'];
interface FakeOp { id: string; method: string; states: string[]; at: number; cancelRequested: boolean; error?: { code: string; message: string; retryable: boolean } }
const LIST = ['offset', 'limit', 'instanceRevision'];

export class FakeLauncher implements PipeTransport {
  readonly descriptor = { protocol: { major: 1, minor: 0 }, serverName: 'awake-manager-v1-0c8e6f9a-2b1d-4c3e-9f00-112233445566', pid: '4242', installationId: 'inst-id', profileId: 'prof-id', sessionId: 'sess-1' };
  instances: WireInstance[];
  inventories: Record<string, InventoryItem[]>;
  warnings: WireWarning[];
  running: boolean;
  drive: LauncherProfile['drive'];
  capabilities: Record<string, boolean>;
  /** Revision per listing; bump to simulate a change between pages. */
  revision = 1;
  log: { method: string; params: Record<string, unknown> }[] = [];
  violations: string[] = [];
  hellos = 0;
  inFlight = 0;
  maxInFlight = 0;
  /** Hooks for scenarios. */
  closeAfterNextRequest = false;
  staleOnceAtOffset: number | null = null;
  helloSessionOverride: string | null = null;
  malformedNext = false;
  busyNext = false;
  /** Process the next request, then lose its reply (connection drops). */
  dropReplyNext = false;
  /** Make the next launch end in INTERACTION_REQUIRED instead of process-started. */
  launchNeedsInteraction = false;
  /** Break the next operation record (terminal flag disagrees with state). */
  badOperationNext = false;
  /** Durable operation records: they survive stop()/start(), like the Launcher's journal. */
  ops = new Map<string, FakeOp>();
  private idem = new Map<string, { body: string; id: string }>();
  private conns = new Map<number, { helloDone: boolean; version: { major: number; minor: number } | null }>();
  private seq = 0;

  constructor(o: FakeOptions = {}) {
    this.instances = o.instances ?? [instance(1), instance(2)];
    this.inventories = o.inventories ?? Object.fromEntries(this.instances.map((i, n) => [i.physicalId, mods(n === 0 ? 305 : 12)]));
    this.warnings = o.warnings ?? [];
    this.running = o.running ?? true;
    this.drive = o.drive ?? 'fixed';
    this.capabilities = o.capabilities ?? { hello: true, 'launcher.info': true, 'instances.list': true, 'mods.list': true, 'transactions.apply': false, 'plans.prepare': false, 'instances.create': false };
  }

  async discover(): Promise<LauncherProfile[]> {
    return [{ source: 'default', installDir: null, dataRoot: 'C:\\Temp\\fixture-profile', resolvedBy: 'Persistent data path', exists: true, drive: this.drive, endpoint: this.running ? this.descriptor : null, endpointError: null }];
  }

  async open(serverName: string, pid: string): Promise<number> {
    if (!this.running) throw new TransportError('not-running', 'pipe not found');
    if (serverName !== this.descriptor.serverName || pid !== this.descriptor.pid) throw new TransportError('identity', 'wrong server');
    const id = ++this.seq;
    this.conns.set(id, { helloDone: false, version: null });
    return id;
  }

  async close(id: number): Promise<void> {
    this.conns.delete(id);
  }

  /** Simulate the Launcher exiting (all pipes gone, descriptor removed). */
  stop() { this.running = false; this.conns.clear(); }
  start() { this.running = true; this.descriptor.sessionId = `sess-${++this.seq}`; }

  async request(id: number, body: string): Promise<string> {
    const c = this.conns.get(id);
    if (!c) throw new TransportError('closed', 'connection closed');
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await Promise.resolve();
    try {
      const reply = this.handle(c, body);
      if (this.dropReplyNext) { this.dropReplyNext = false; this.conns.delete(id); throw new TransportError('closed', 'reply lost'); }
      if (this.closeAfterNextRequest) { this.closeAfterNextRequest = false; this.conns.delete(id); }
      if (this.malformedNext) { this.malformedNext = false; return '{"protocol":{"major":1,"minor":0},"requestId":"x"}'; }
      return reply;
    } finally {
      this.inFlight--;
    }
  }

  private violation(msg: string) { this.violations.push(msg); }
  private reply(requestId: string | null, payload: { result: unknown } | { error: { code: string; message: string; retryable: boolean } }) {
    return JSON.stringify({ protocol: { major: 1, minor: 0 }, requestId, ...payload });
  }
  private err(requestId: string | null, code: string, retryable = false) {
    return this.reply(requestId, { error: { code, message: code, retryable } });
  }

  private handle(c: { helloDone: boolean }, body: string): string {
    let req: Record<string, unknown>;
    try { req = JSON.parse(body); } catch { this.violation('not JSON'); return this.err(null, 'INVALID_REQUEST'); }
    const keys = Object.keys(req);
    if (keys.length !== 4 || !ENVELOPE.every((k) => keys.includes(k))) { this.violation(`envelope keys ${keys}`); return this.err(null, 'INVALID_REQUEST'); }
    const rid = req.requestId as string;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(rid)) this.violation(`requestId ${rid}`);
    const p = req.protocol as { major: number; minor: number };
    if (p?.major !== 1 || p?.minor !== 0 || Object.keys(p).length !== 2) this.violation('protocol');
    const method = req.method as string;
    const params = req.params as Record<string, unknown>;
    this.log.push({ method, params });
    if (method === 'hello') {
      const versions = params.versions as { major: number; minor: number }[];
      const client = params.client as { name: string; version: string };
      if (!Array.isArray(versions) || !versions.length || !client?.name || typeof client.version !== 'string' || Object.keys(params).length !== 2) this.violation('hello params');
      c.helloDone = true;
      this.hellos++;
      return this.reply(rid, { result: { protocol: { major: 1, minor: 0 }, installationId: this.descriptor.installationId, profileId: this.descriptor.profileId, sessionId: this.helloSessionOverride ?? this.descriptor.sessionId, capabilities: this.capabilities, limits: { frameBytes: 1048576, clients: 8, pageItems: 500 } } });
    }
    if (!c.helloDone) { this.violation(`${method} before hello`); return this.err(rid, 'HANDSHAKE_REQUIRED'); }
    if (this.busyNext) { this.busyNext = false; return this.err(rid, 'BUSY', true); }
    if (method === 'launcher.info') {
      if (Object.keys(params).length) this.violation('launcher.info params');
      return this.reply(rid, { result: { protocol: { major: 1, minor: 0 }, installationId: 'inst-id', profileId: 'prof-id', sessionId: this.descriptor.sessionId, serverName: this.descriptor.serverName, pid: '4242', installRoot: 'C:\\Temp\\fixture-install', dataRoot: 'C:\\Temp\\fixture-profile', executable: 'C:\\Temp\\fixture-install\\awakelauncher.exe', portable: false, backgroundStartup: false, launcherState: 'ready', instanceRoots: ['C:\\Temp\\fixture-profile\\instances'] } });
    }
    if (method === 'instances.list' || method === 'mods.list') {
      const allowed = method === 'mods.list' ? [...LIST, 'physicalId'] : LIST;
      for (const k of Object.keys(params)) if (!allowed.includes(k)) this.violation(`${method} param ${k}`);
      const offset = (params.offset as number | undefined) ?? 0;
      const limit = (params.limit as number | undefined) ?? 200;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) this.violation(`limit ${limit}`);
      if (offset >= 1 && typeof params.instanceRevision !== 'string') this.violation('continuation without instanceRevision');
      if (this.staleOnceAtOffset !== null && offset === this.staleOnceAtOffset) { this.staleOnceAtOffset = null; this.revision++; return this.err(rid, 'STALE_INSTANCE'); }
      if (offset >= 1 && params.instanceRevision !== hex(this.revision)) return this.err(rid, 'STALE_INSTANCE');
      if (method === 'instances.list') {
        const list = [...this.instances].sort((a, b) => a.physicalId.localeCompare(b.physicalId));
        const page = list.slice(offset, offset + limit);
        const next = offset + limit < list.length ? offset + limit : null;
        return this.reply(rid, { result: { total: list.length, nextOffset: next, instanceRevision: hex(this.revision), revisionKind: 'observation', instances: page, warnings: offset === 0 ? this.warnings : [] } });
      }
      const physicalId = params.physicalId as string;
      const inst = this.instances.find((i) => i.physicalId === physicalId);
      if (!inst || !inst.loaded) return this.err(rid, 'NOT_FOUND');
      const items = this.inventories[physicalId] ?? [];
      const next = offset + limit < items.length ? offset + limit : null;
      return this.reply(rid, { result: { total: items.length, nextOffset: next, instanceRevision: hex(this.revision), revisionKind: 'observation', items: items.slice(offset, offset + limit) } });
    }
    if (this.capabilities[method] === true && DRAFT_PARAMS[method]) return this.draft(rid, method, params);
    return this.err(rid, 'UNSUPPORTED_CAPABILITY');
  }

  private opRecord(op: FakeOp) {
    const state = op.states[op.at]!;
    const terminal = TERMINAL.includes(state);
    const rec: Record<string, unknown> = { operationId: op.id, state, terminal: this.badOperationNext ? !terminal : terminal };
    this.badOperationNext = false;
    if (op.error && terminal) rec.error = op.error;
    return rec;
  }

  private draft(rid: string, method: string, params: Record<string, unknown>): string {
    const spec = DRAFT_PARAMS[method]!;
    for (const k of Object.keys(params)) if (![...spec.required, ...(spec.optional ?? [])].includes(k)) this.violation(`${method} param ${k}`);
    for (const k of spec.required) if (typeof params[k] !== 'string' || !params[k]) this.violation(`${method} missing ${k}`);
    if (method === 'operations.get' || method === 'operations.cancel') {
      const op = this.ops.get(params.operationId as string);
      if (!op) return this.err(rid, 'NOT_FOUND');
      if (method === 'operations.cancel') {
        // Only a request: honoured before the instance gate is acquired.
        if (op.states.findIndex((st) => st === 'acquiring' || st === 'applying') > op.at) op.cancelRequested = true;
        return this.reply(rid, { result: { cancellationRequested: true } });
      }
      if (op.cancelRequested) { op.states = [...op.states.slice(0, op.at + 1), 'cancelled']; op.cancelRequested = false; }
      if (op.at < op.states.length - 1) op.at++;
      return this.reply(rid, { result: this.opRecord(op) });
    }
    const key = params.idempotencyKey as string;
    const bodyKey = JSON.stringify([method, params]);
    const seen = this.idem.get(key);
    if (seen) return seen.body === bodyKey ? this.reply(rid, { result: this.opRecord(this.ops.get(seen.id)!) }) : this.err(rid, 'IDEMPOTENCY_CONFLICT');
    if (method === 'launch.request' && !this.instances.some((i) => i.physicalId === params.physicalId && i.loaded)) return this.err(rid, 'NOT_FOUND');
    const id = `00000000-0000-4000-8000-${String(this.ops.size + 1).padStart(12, '0')}`;
    let states = ['queued', 'resolving', 'downloading', 'applying', 'verifying', 'completed'];
    let error: FakeOp['error'];
    if (method === 'launch.request') {
      states = ['queued', 'acquiring', 'applying', 'completed'];
      if (this.launchNeedsInteraction) {
        this.launchNeedsInteraction = false;
        states = ['queued', 'acquiring', 'failed'];
        error = { code: 'INTERACTION_REQUIRED', message: 'Sign in to Awake Launcher to continue.', retryable: false };
      }
    }
    if (method === 'transactions.apply') states = ['queued', 'acquiring', 'revalidating', 'backing_up', 'applying', 'verifying', 'completed'];
    this.ops.set(id, { id, method, states, at: 0, cancelRequested: false, error });
    this.idem.set(key, { body: bodyKey, id });
    return this.reply(rid, { result: this.opRecord(this.ops.get(id)!) });
  }
}
