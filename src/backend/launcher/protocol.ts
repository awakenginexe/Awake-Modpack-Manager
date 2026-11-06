/**
 * Awake Launcher integration protocol 1.0 (experimental), read-only subset.
 *
 * Source of truth: Awake Launcher docs/modpack-manager/{protocol.md, wire.schema.json,
 * requests.schema.json} at commit d3e6731a8a3d9a668ad6509eb795eb73030c0823 (branch
 * feat/modpack-manager-integration). Types below mirror those schemas; do not add fields or
 * methods that are not in them.
 */

export const CONTRACT_COMMIT = 'd3e6731a8a3d9a668ad6509eb795eb73030c0823';
export const SUPPORTED_VERSIONS = [{ major: 1, minor: 0 }] as const;
export const PAGE_LIMIT = 500;

export interface ProtocolVersion { major: number; minor: number }

/** Methods implemented by the Launcher at the pinned commit. Everything else is UNSUPPORTED_CAPABILITY. */
export type ReadMethod = 'hello' | 'launcher.info' | 'instances.list' | 'mods.list';

/**
 * Draft 1.0 extensions (protocol.md "Reserved operation contract (not enabled)"). The Launcher
 * reports them false at the pin. The client sends one only when hello's capability map says true.
 * Only methods whose request and reply fields the draft fully defines are listed here.
 */
export type DraftMethod = 'operations.get' | 'operations.cancel' | 'launch.request' | 'transactions.apply' | 'instances.create';
export type Method = ReadMethod | DraftMethod;

export const OPERATION_STATES = [
  'queued', 'resolving', 'downloading', 'prepared', 'acquiring', 'revalidating', 'backing_up', 'applying', 'verifying', 'rolling_back',
  'completed', 'cancelled', 'failed', 'rolled_back', 'recovery_required',
] as const;
export type WireOperationState = (typeof OPERATION_STATES)[number];
const TERMINAL: readonly WireOperationState[] = ['completed', 'cancelled', 'failed', 'rolled_back'];

/** requests.schema.json $defs/operation. `result` has no schema yet, so it stays opaque. */
export interface WireOperation {
  operationId: string;
  state: WireOperationState;
  terminal: boolean;
  planDigest?: string;
  instanceRevision?: string;
  result?: Record<string, unknown>;
  error?: WireError;
}

export const ERROR_CODES = [
  'INVALID_REQUEST', 'UNSUPPORTED_PROTOCOL', 'HANDSHAKE_REQUIRED', 'UNSUPPORTED_CAPABILITY', 'LIMIT_EXCEEDED',
  'NOT_FOUND', 'IDENTITY_UNVERIFIABLE', 'IDENTITY_CONFLICT', 'BUSY', 'STALE_INSTANCE', 'STALE_PLAN',
  'IDEMPOTENCY_CONFLICT', 'PROVIDER_RESTRICTED', 'RATE_LIMITED', 'DOWNLOAD_FAILED', 'INTEGRITY_FAILED',
  'INTERACTION_REQUIRED', 'CANCELLED', 'RECOVERY_REQUIRED', 'RECOVERY_FAILED', 'EVENTS_GAP', 'IO_ERROR', 'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface WireError { code: string; message: string; retryable: boolean }

export interface EndpointDescriptor {
  protocol?: ProtocolVersion;
  serverName: string;
  pid: string;
  installationId: string;
  profileId: string;
  sessionId: string;
}

export interface HelloResult {
  protocol: ProtocolVersion;
  installationId: string;
  profileId: string;
  sessionId: string;
  capabilities: Record<string, boolean>;
  limits: { frameBytes: number; clients: number; pageItems: number };
}

export interface LauncherInfoResult {
  protocol: ProtocolVersion;
  installationId: string;
  profileId: string;
  sessionId: string;
  serverName: string;
  pid: string;
  installRoot: string;
  dataRoot: string;
  executable: string;
  portable: boolean;
  backgroundStartup: false;
  launcherState: 'ready';
  instanceRoots: string[];
}

export interface WireInstance {
  instanceId: string;
  uuid: string | null;
  physicalId: string;
  canonicalPath: string;
  name: string;
  loaded: boolean;
  nativeRunning: boolean | null;
  gameState: 'unknown';
  gamePhysicalId: string | null;
  modsPhysicalId: string | null;
  identityStatus: 'verified' | 'conflict';
  nativeActivity: 'idle' | 'launch_preparing' | 'launch_active' | 'deleting' | 'unknown' | null;
}

export interface WireWarning { code: string; path: string }

export interface PageResult { total: number; nextOffset: number | null; instanceRevision: string; revisionKind: 'observation' }

export interface InstanceListResult extends PageResult { instances: WireInstance[]; warnings: WireWarning[] }

export interface IndexedMetadata {
  name: string;
  provider: 'modrinth' | 'curseforge';
  projectId: string;
  versionId: string;
  version: string;
  updateLocked: boolean;
}

export interface InventoryItem {
  fileName: string;
  enabled: boolean;
  /** Decimal string. */
  size: string;
  /** Decimal string, may be negative. */
  modifiedMs: string;
  kind: 'jar' | 'directory' | 'other';
  linked: boolean;
  metadataState: 'indexed' | 'unindexed' | 'conflict';
  metadata: IndexedMetadata | null;
}

export interface InventoryResult extends PageResult { items: InventoryItem[] }

/** Thrown for a structured `error` response from the Launcher. */
export class ProtocolError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Thrown when a response breaks the wire contract. The connection must not be reused. */
export class WireViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireViolation';
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function buildRequest(requestId: string, method: Method, params: Record<string, unknown>, version: ProtocolVersion): string {
  if (!ID.test(requestId)) throw new WireViolation(`Invalid requestId ${requestId}`);
  return JSON.stringify({ protocol: { major: version.major, minor: version.minor }, requestId, method, params });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates the envelope (wire.schema.json#/$defs/response) and returns the result object. */
export function parseResponse(text: string, requestId: string, version: ProtocolVersion): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new WireViolation('Launcher reply is not valid JSON.'); }
  if (!isObject(value)) throw new WireViolation('Launcher reply is not a JSON object.');
  const keys = Object.keys(value);
  if (keys.some((k) => !['protocol', 'requestId', 'result', 'error'].includes(k))) throw new WireViolation('Launcher reply has unknown envelope fields.');
  const p = value.protocol;
  if (!isObject(p) || p.major !== version.major || p.minor !== version.minor) throw new WireViolation('Launcher reply uses an unexpected protocol version.');
  const hasResult = 'result' in value;
  const hasError = 'error' in value;
  if (hasResult === hasError) throw new WireViolation('Launcher reply must contain exactly one of result or error.');
  if (hasError) {
    const e = value.error;
    if (!isObject(e) || typeof e.code !== 'string' || typeof e.message !== 'string' || typeof e.retryable !== 'boolean') throw new WireViolation('Launcher error is malformed.');
    // requestId may be null when the Launcher could not read ours (invalid request).
    if (value.requestId !== requestId && value.requestId !== null) throw new WireViolation('Launcher reply does not match the request.');
    throw new ProtocolError(e.code, e.message, e.retryable);
  }
  if (value.requestId !== requestId) throw new WireViolation('Launcher reply does not match the request.');
  if (!isObject(value.result)) throw new WireViolation('Launcher result is not an object.');
  return value.result;
}

/** Choose the highest mutually supported minor within major 1 (protocol.md, hello). */
export function negotiated(server: ProtocolVersion): ProtocolVersion {
  const match = SUPPORTED_VERSIONS.find((v) => v.major === server.major && v.minor === server.minor);
  if (!match) throw new WireViolation(`Launcher negotiated unsupported protocol ${server.major}.${server.minor}.`);
  return match;
}

/* Minimal shape checks for the results the UI relies on. */
export function assertPage(r: Record<string, unknown>, listKey: 'instances' | 'items'): void {
  if (typeof r.total !== 'number' || !(r.nextOffset === null || typeof r.nextOffset === 'number')
    || typeof r.instanceRevision !== 'string' || !Array.isArray(r[listKey])) {
    throw new WireViolation(`Launcher ${listKey} page is malformed.`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION_KEYS = ['operationId', 'state', 'terminal', 'planDigest', 'instanceRevision', 'result', 'error'];

/** Strict check of an operation record (additionalProperties: false in the schema). */
export function parseOperation(r: Record<string, unknown>): WireOperation {
  if (Object.keys(r).some((k) => !OPERATION_KEYS.includes(k))) throw new WireViolation('Launcher operation has unknown fields.');
  if (typeof r.operationId !== 'string' || !UUID.test(r.operationId)) throw new WireViolation('Launcher operation id is malformed.');
  if (!OPERATION_STATES.includes(r.state as WireOperationState)) throw new WireViolation(`Launcher operation state ${String(r.state)} is unknown.`);
  if (typeof r.terminal !== 'boolean' || r.terminal !== TERMINAL.includes(r.state as WireOperationState)) throw new WireViolation('Launcher operation terminal flag does not match its state.');
  if (r.planDigest !== undefined && (typeof r.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(r.planDigest))) throw new WireViolation('Launcher plan digest is malformed.');
  if (r.instanceRevision !== undefined && typeof r.instanceRevision !== 'string') throw new WireViolation('Launcher operation revision is malformed.');
  if (r.result !== undefined && !isObject(r.result)) throw new WireViolation('Launcher operation result is malformed.');
  if (r.error !== undefined) {
    const e = r.error;
    if (!isObject(e) || typeof e.code !== 'string' || typeof e.message !== 'string' || typeof e.retryable !== 'boolean') throw new WireViolation('Launcher operation error is malformed.');
  }
  return r as unknown as WireOperation;
}

/** idempotencyKey: 1-128 ASCII safe characters (protocol.md). */
export const validIdempotencyKey = (k: string) => /^[A-Za-z0-9_.:-]{1,128}$/.test(k);
