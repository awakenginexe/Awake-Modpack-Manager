import { BackendError, TERMINAL_STATES, type OperationStatus } from '../backend/contract';
import type { ManagerBackend } from '../backend/ManagerBackend';

export const isTerminal = (s: OperationStatus) => TERMINAL_STATES.includes(s.state);
/** Nothing more will happen without the user: terminal, or waiting for recovery. */
export const isSettled = (s: OperationStatus) => isTerminal(s) || s.state === 'recovery_required';

export interface FollowOptions {
  /** Safety-net poll interval. Events can be lost across disconnects, so status is re-read. */
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Follow an accepted operation until the coordinator reports a terminal state (or recovery_required).
 * Survives disconnects: watch events are a fast path, polling plus a re-read on reconnect
 * are the source of truth. It never resubmits anything.
 */
export function followOperation(
  backend: ManagerBackend,
  operationId: string,
  onUpdate: (s: OperationStatus) => void,
  { pollMs = 1500, signal }: FollowOptions = {},
): Promise<OperationStatus> {
  return new Promise((resolve, reject) => {
    let done = false;
    let last: OperationStatus | null = null;
    const finish = (s: OperationStatus) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(s);
    };
    const seen = (s: OperationStatus) => {
      if (done || s.operationId !== operationId) return;
      if (last && s.updatedAt < last.updatedAt) return; // ignore out-of-order event
      last = s;
      onUpdate(s);
      if (isSettled(s)) finish(s);
    };
    const refresh = () => backend.getOperation(operationId).then(seen, (e: unknown) => {
      // Disconnects and timeouts are expected while following; anything else is a real failure.
      if (e instanceof BackendError && (e.code === 'disconnected' || e.code === 'timeout')) return;
      if (!done) { done = true; cleanup(); reject(e); }
    });
    const unwatch = backend.watchOperation(operationId, seen);
    const unconn = backend.onConnectionChange((state) => { if (state === 'connected') void refresh(); });
    const timer = setInterval(() => void refresh(), pollMs);
    const onAbort = () => { if (!done) { done = true; cleanup(); reject(new DOMException('Stopped following', 'AbortError')); } };
    signal?.addEventListener('abort', onAbort);
    function cleanup() {
      unwatch();
      unconn();
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    void refresh();
  });
}
