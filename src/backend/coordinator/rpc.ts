import { ALL_CAPABILITIES, BackendError, type Accepted, type Capability, type OperationKind, type OperationStatus } from '../contract';
import { load, save } from '../../domain/storage';
import {
  assertPage, buildRequest, negotiated, parseOperation, parseResponse, PAGE_LIMIT, ProtocolError, SUPPORTED_VERSIONS, validIdempotencyKey, WireViolation,
  type DraftMethod, type HelloResult, type Method, type ProtocolVersion, type WireOperation,
} from '../launcher/protocol';
import { TransportError, type PipeTransport } from '../launcher/transport';

/**
 * Shared client for any process that speaks the Awake integration protocol: the Awake Launcher
 * and the Manager's own native helper. Owns the connection, one-in-flight serialization,
 * reconnect-once, paging, error mapping and the durable-operation calls. Each backend supplies
 * only how to find and verify its endpoint (`open`).
 */
export interface RpcOptions {
  transport: () => Pick<PipeTransport, 'request' | 'close'>;
  /** Locate the endpoint, open the pipe and return its connection id. */
  locate: () => Promise<{ conn: number; expect: { installationId: string; profileId: string; sessionId: string } }>;
  /** Extra hello checks (e.g. role); throw BackendError to refuse. */
  checkHello?: (hello: HelloResult & Record<string, unknown>) => void;
  clientVersion: string;
  timeoutMs: number;
  pageLimit?: number;
  /** Who is on the other end, for messages: "Awake Launcher" or "the Manager helper". */
  peer: string;
  /** Where submitted operations are remembered (no operations.list on the wire yet). */
  storePrefix: string;
  onLost: () => void;
}

/** What the Manager knows about an operation it submitted; the wire record has none of this. */
interface KnownOperation { operationId: string; kind: OperationKind; instanceId?: string; startedAt: string }

export function createRpc(o: RpcOptions) {
  const pageLimit = Math.min(Math.max(o.pageLimit ?? PAGE_LIMIT, 1), PAGE_LIMIT);
  let conn: number | null = null;
  let version: ProtocolVersion = SUPPORTED_VERSIONS[0];
  let hello: (HelloResult & Record<string, unknown>) | null = null;
  let seq = 0;
  let queue: Promise<unknown> = Promise.resolve();

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
        STALE_PLAN: 'plan-expired', INTERACTION_REQUIRED: 'interaction-required', RECOVERY_REQUIRED: 'recovery-required',
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

  async function exchange(method: Method, params: Record<string, unknown>, v = version): Promise<Record<string, unknown>> {
    if (conn === null) throw new TransportError('closed', 'Not connected.');
    const requestId = `r${++seq}`;
    try {
      return parseResponse(await o.transport().request(conn, buildRequest(requestId, method, params, v), o.timeoutMs), requestId, v);
    } catch (e) {
      // A broken exchange leaves the stream unusable; the host already dropped it.
      if (e instanceof TransportError || e instanceof WireViolation) conn = null;
      throw e;
    }
  }

  /** Locate, open the pipe, hello, verify identity. */
  async function open(): Promise<void> {
    if (conn !== null) { await o.transport().close(conn).catch(() => undefined); conn = null; }
    const { conn: c, expect } = await o.locate();
    conn = c;
    const result = await exchange('hello', { versions: [...SUPPORTED_VERSIONS], client: { name: 'Awake Modpack Manager', version: o.clientVersion } }, SUPPORTED_VERSIONS[0]) as HelloResult & Record<string, unknown>;
    version = negotiated(result.protocol);
    try {
      // The descriptor is only a hint: hello must name the same installation, profile and session.
      if (result.installationId !== expect.installationId || result.profileId !== expect.profileId || result.sessionId !== expect.sessionId) {
        throw new BackendError('identity', `The ${o.peer} endpoint does not match its descriptor. It may be stale; restart it.`);
      }
      o.checkHello?.(result);
    } catch (e) {
      await o.transport().close(c).catch(() => undefined);
      conn = null;
      throw e;
    }
    hello = result;
  }

  /**
   * Reconnect once (hello first) if the pipe dropped, e.g. after an idle timeout. Resending is
   * safe: reads have no effects, and side-effect requests carry their original idempotencyKey.
   */
  function call<T>(method: Method, params: Record<string, unknown>): Promise<T> {
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
        if (['disconnected', 'not-running', 'timeout', 'identity', 'unsupported-profile', 'helper-unavailable'].includes(err.code)) o.onLost();
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
          const params = offset === 0 ? { ...base, limit: pageLimit } : { ...base, limit: pageLimit, offset, instanceRevision: revision };
          const page = await call<Record<string, unknown>>(method, params);
          assertPage(page, listKey);
          const r = page as unknown as R;
          revision ??= r.instanceRevision;
          items.push(...(page[listKey] as I[]));
          pages.push(r);
          onPage?.(items.length, r.total, r);
          if (r.nextOffset === null) return { items, revision, pages };
          if (r.nextOffset <= offset) throw new BackendError('protocol', `${o.peer} pagination did not advance.`);
          offset = r.nextOffset;
        }
      } catch (e) {
        if (e instanceof BackendError && e.code === 'stale-revision') continue; // changed while paging: restart
        throw e;
      }
    }
    throw new BackendError('stale-revision', 'The instance kept changing while it was being read. Try again in a moment.');
  }

  /* ----- durable operations (sent only when hello reports the method true) ----- */

  const enabled = (m: DraftMethod) => hello?.capabilities[m] === true;
  const unsupported = (): Promise<never> => Promise.reject(new BackendError('unsupported', `${o.peer} does not support this yet.`));
  const storeKey = () => `${o.storePrefix}:${hello?.profileId ?? 'none'}`;
  const known = (): KnownOperation[] => load<KnownOperation[]>(storeKey(), []);
  const remember = (op: KnownOperation) => {
    const list = known().filter((k) => k.operationId !== op.operationId);
    save(storeKey(), [op, ...list].slice(0, 200)); // shortcut: local history cap; no operations.list on the wire yet
  };

  function toStatus(w: WireOperation, k: KnownOperation): OperationStatus {
    return {
      operationId: w.operationId,
      kind: k.kind,
      instanceId: k.instanceId,
      planHash: w.planDigest,
      state: w.state,
      startedAt: k.startedAt,
      updatedAt: new Date().toISOString(),
      // Cancel is only a request; the coordinator refuses it inside critical sections.
      cancellable: !w.terminal && enabled('operations.cancel'),
      error: w.error ? { code: w.error.code, message: w.error.message } : undefined,
      result: w.instanceRevision ? { revision: w.instanceRevision } : undefined,
    };
  }

  /** Submit a side-effect request; the accepted record must be a nonterminal operation. */
  async function submit(method: DraftMethod, params: Record<string, unknown>, kind: OperationKind, instanceId?: string): Promise<Accepted> {
    if (!enabled(method)) return unsupported();
    if (!validIdempotencyKey(String(params.idempotencyKey))) throw new BackendError('protocol', 'Invalid idempotency key.');
    let op: WireOperation;
    try { op = parseOperation(await call<Record<string, unknown>>(method, params)); } catch (e) { throw toBackendError(e); }
    remember({ operationId: op.operationId, kind, instanceId, startedAt: known().find((k) => k.operationId === op.operationId)?.startedAt ?? new Date().toISOString() });
    return { operationId: op.operationId };
  }

  async function readOperation(operationId: string): Promise<OperationStatus> {
    if (!enabled('operations.get')) return unsupported();
    const k = known().find((x) => x.operationId === operationId) ?? { operationId, kind: 'apply-plan' as const, startedAt: new Date().toISOString() };
    const raw = await call<Record<string, unknown>>('operations.get', { operationId });
    let w: WireOperation;
    try { w = parseOperation(raw); } catch (e) { throw toBackendError(e); }
    if (w.operationId !== operationId) throw new BackendError('protocol', `${o.peer} returned a different operation.`);
    return toStatus(w, k);
  }

  async function listOperations(instanceId?: string): Promise<OperationStatus[]> {
    if (!enabled('operations.get')) return [];
    const out: OperationStatus[] = [];
    for (const k of known().filter((x) => !instanceId || x.instanceId === instanceId)) {
      try { out.push(await readOperation(k.operationId)); } catch { /* unknown to this coordinator: skip */ }
    }
    return out;
  }

  async function cancelOperation(operationId: string): Promise<void> {
    if (!enabled('operations.cancel')) return unsupported();
    // The reply only acknowledges the request; the state comes from operations.get.
    await call('operations.cancel', { operationId });
  }

  /**
   * Capabilities this client implements. Write-side ones need operations.get first; plan.prepare
   * stays off because its review result has no schema yet.
   */
  function capabilities(writes = true): Capability[] {
    const c = hello?.capabilities ?? {};
    const caps: Capability[] = ['installations.discover'];
    if (c['instances.list'] === true) caps.push('instances.list');
    if (c['mods.list'] === true) caps.push('mods.inventory');
    if (writes && c['operations.get'] === true) {
      caps.push('operations.watch');
      if (c['launch.request'] === true) caps.push('launch.request');
      if (c['operations.cancel'] === true) caps.push('operations.cancel');
      if (c['instances.create'] === true) caps.push('instances.create');
      if (c['transactions.apply'] === true) caps.push('plan.apply');
    }
    return caps.filter((x) => ALL_CAPABILITIES.includes(x));
  }

  return {
    serial, open, call, paged, toBackendError, exchange,
    hello: () => hello,
    version: () => version,
    connected: () => conn !== null,
    enabled, unsupported, submit, readOperation, listOperations, cancelOperation, capabilities,
    async close() { if (conn !== null) { const c = conn; conn = null; await o.transport().close(c).catch(() => undefined); } },
  };
}

export type Rpc = ReturnType<typeof createRpc>;
