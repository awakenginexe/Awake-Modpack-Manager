import { BackendError } from './contract';
import type { ManagerBackend } from './ManagerBackend';

/**
 * Placeholder for the real Awake Launcher coordinator adapter.
 *
 * BLOCKED: the integration contract is being defined by Codex on
 * `feat/modpack-manager-integration`. Until it exists this client refuses every call, so the UI
 * shows "not connected" rather than pretending. Do not add a direct filesystem fallback here.
 */
const blocked = () => Promise.reject(new BackendError('unsupported', 'Awake Launcher integration is not available in this build yet.'));

export function createLauncherClient(): ManagerBackend {
  return {
    kind: 'launcher',
    connect: blocked,
    onConnectionChange: () => () => {},
    listInstallations: blocked,
    listInstances: blocked,
    createInstance: blocked,
    getInventory: blocked,
    search: blocked,
    validateDraft: blocked,
    preparePlan: blocked,
    applyPlan: blocked,
    getOperation: blocked,
    findOperationByIdempotencyKey: blocked,
    listOperations: blocked,
    watchOperation: () => () => {},
    cancelOperation: blocked,
    getRecoveryStatus: blocked,
    listContent: blocked,
    checkExport: blocked,
    startExport: blocked,
    requestLaunch: blocked,
  };
}
