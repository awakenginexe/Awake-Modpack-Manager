import type { EndpointDescriptor } from './protocol';
import type { CoreDescriptor } from '../core/types';

/** A Launcher data profile found by the desktop host (src-tauri/src/discovery.rs). */
export interface LauncherProfile {
  source: 'registry' | 'environment' | 'default' | 'added';
  installDir: string | null;
  dataRoot: string;
  resolvedBy: string;
  exists: boolean;
  drive: 'fixed' | 'removable' | 'remote' | 'other' | 'unknown';
  endpoint: EndpointDescriptor | null;
  endpointError: string | null;
  /** Why the Launcher will refuse to share this folder (src-tauri/src/profile_access.rs). */
  shareBlocked?: 'public-write' | 'foreign-owner' | null;
}

/** Transport failure from the host (pipe.rs IpcError codes). */
export class TransportError extends Error {
  constructor(readonly code: 'not-running' | 'busy' | 'identity' | 'timeout' | 'closed' | 'frame' | 'invalid' | 'io' | 'no-host', message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * Byte transport to the Launcher pipe. The desktop host implements it; tests use a fixture.
 * Requests on one connection must be sequential (the protocol allows one in flight).
 */
export interface PipeTransport {
  discover(added: string[]): Promise<LauncherProfile[]>;
  open(serverName: string, pid: string): Promise<number>;
  request(connection: number, body: string, timeoutMs: number): Promise<string>;
  close(connection: number): Promise<void>;
  /** Start the Manager's bundled native helper if needed and report its endpoint (desktop host only). */
  ensureHelper?(): Promise<HelperStatus>;
  /** Open the helper pipe; the host verifies the server is the bundled helper executable. */
  openHelper?(serverName: string, pid: string): Promise<number>;
  /** Start awakelauncher.exe of the installation discovery resolved to this data root. */
  startLauncher?(dataRoot: string, added: string[], workspaceId?: string): Promise<void>;
  /** Give a discovered data folder the Windows permissions a normal install has. */
  makeProfilePrivate?(dataRoot: string, added: string[]): Promise<void>;
}

/** src-tauri/src/helper.rs HelperStatus. */
export interface HelperStatus {
  state: 'not_installed' | 'starting' | 'ready' | 'failed';
  /** Protocol 2.0 descriptor (core.schema.json $defs/descriptor); validated again by the client. */
  descriptor: CoreDescriptor | null;
  /** Bundled build is the Manager's test stub, not the real native core. */
  stub: boolean;
  dataRoot: string | null;
  message: string | null;
}

export const isDesktopHost = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function asTransportError(e: unknown): TransportError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    return new TransportError((e as { code: TransportError['code'] }).code, String((e as { message: unknown }).message));
  }
  return new TransportError('io', e instanceof Error ? e.message : String(e));
}

/** Transport backed by the Tauri host commands. Loaded lazily so browser builds never touch it. */
export function createHostTransport(): PipeTransport {
  const invoke = async <T>(cmd: string, args: Record<string, unknown>): Promise<T> => {
    const { invoke: call } = await import('@tauri-apps/api/core');
    try { return await call<T>(cmd, args); } catch (e) { throw asTransportError(e); }
  };
  return {
    discover: (added) => invoke('discover_profiles', { added }),
    open: (serverName, pid) => invoke('ipc_open', { serverName, pid }),
    request: (connection, body, timeoutMs) => invoke('ipc_request', { id: connection, body, timeoutMs }),
    close: (connection) => invoke('ipc_close', { id: connection }),
    startLauncher: (dataRoot, added, workspaceId) => invoke('start_launcher', { dataRoot, added, workspaceId }),
    makeProfilePrivate: (dataRoot, added) => invoke('make_profile_private', { dataRoot, added }),
    ensureHelper: () => invoke('helper_ensure', {}),
    openHelper: (serverName, pid) => invoke('helper_open', { serverName, pid }),
  };
}
