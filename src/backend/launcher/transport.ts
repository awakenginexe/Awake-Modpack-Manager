import type { EndpointDescriptor } from './protocol';

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
  };
}
