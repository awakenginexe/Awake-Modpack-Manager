/**
 * Awake Launcher integration protocol 1.0 (experimental), read-only subset.
 *
 * Source of truth: Awake Launcher docs/modpack-manager/{protocol.md, wire.schema.json,
 * requests.schema.json} at commit 058714ec72ce2db19913f8540b6c4784a9d6ccd2 (branch
 * feat/modpack-manager-integration). Types below mirror those schemas; do not add fields or
 * methods that are not in them.
 */

export const CONTRACT_COMMIT = '058714ec72ce2db19913f8540b6c4784a9d6ccd2';
export const SUPPORTED_VERSIONS = [{ major: 1, minor: 0 }] as const;
export const PAGE_LIMIT = 500;

export interface ProtocolVersion { major: number; minor: number }

/** Methods implemented by the Launcher at the pinned commit. Everything else is UNSUPPORTED_CAPABILITY. */
export type ReadMethod = 'hello' | 'launcher.info' | 'instances.list' | 'mods.list';

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

export function buildRequest(requestId: string, method: ReadMethod, params: Record<string, unknown>, version: ProtocolVersion): string {
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
