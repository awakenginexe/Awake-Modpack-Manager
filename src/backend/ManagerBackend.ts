import type {
  Accepted, ApplyRequest, ContentArea, ContentEntry, CreateInstanceRequest, Draft, ExportFormat,
  ExportReport, ExportRequest, Handshake, InstallPackRequest, PackSearchPage, PackSearchQuery, PackVersion, InstanceSummary, InstanceWarning, Installation, ModInventory,
  OperationStatus, RecoveryStatus, ResolvedPlan, SearchPage, SearchQuery,
} from './contract';
import type { LauncherProfile } from './launcher/transport';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/**
 * The only surface Vue code talks to. Implementations: MockBackend (development and tests)
 * and LauncherClient (real Awake Launcher over its integration pipe, read-only protocol 1.0).
 * Transport framing lives inside implementations, never in components.
 */
export interface ManagerBackend {
  readonly kind: 'mock' | 'launcher';
  connect(): Promise<Handshake>;
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;

  listInstallations(): Promise<Installation[]>;
  /** Launcher profiles the user can choose between (desktop only). */
  launcherProfiles?(): LauncherProfile[];
  /** Remember extra Launcher folders (installation or data folder) to look in. */
  setAddedFolders?(folders: string[]): void;
  /** Prefer this Launcher data profile on the next connect. */
  setPreferredProfile?(dataRoot: string | null): void;
  listInstances(installationId: string): Promise<InstanceSummary[]>;
  createInstance(request: CreateInstanceRequest): Promise<Accepted>;
  /** Loads the full inventory; `onProgress` reports paged loading for large instances. */
  getInventory(instanceId: string, onProgress?: (loaded: number, total: number) => void): Promise<ModInventory>;
  /** Warnings from the last instance listing (collisions, aliased/shared roots). */
  instanceWarnings?(): InstanceWarning[];

  search(query: SearchQuery): Promise<SearchPage>;

  /** Modpack catalog. Provider calls and API keys stay in the Launcher. */
  searchPacks(query: PackSearchQuery): Promise<PackSearchPage>;
  packVersions(provider: PackSearchQuery['provider'], packId: string): Promise<PackVersion[]>;
  /** Download and install a pack as a new instance. The result carries the new instance id. */
  installPack(request: InstallPackRequest): Promise<Accepted>;

  /** Resolve a draft against the authoritative baseline. Rejects with `stale-revision` if the base moved. */
  validateDraft(draft: Draft): Promise<ResolvedPlan>;
  /** Re-resolve right before apply. The returned hash may differ; the UI must then ask again. */
  preparePlan(planId: string): Promise<ResolvedPlan>;
  /** Accepting is not success: follow the operation to a terminal state. */
  applyPlan(request: ApplyRequest): Promise<Accepted>;

  /** A lost reply is recovered by resending the same request with the same idempotencyKey. */
  getOperation(operationId: string): Promise<OperationStatus>;
  listOperations(instanceId?: string): Promise<OperationStatus[]>;
  watchOperation(operationId: string, listener: (status: OperationStatus) => void): () => void;
  cancelOperation(operationId: string): Promise<void>;
  getRecoveryStatus(instanceId: string): Promise<RecoveryStatus>;

  listContent(instanceId: string, area: ContentArea): Promise<ContentEntry[]>;
  checkExport(instanceId: string, format: ExportFormat): Promise<ExportReport>;
  startExport(request: ExportRequest): Promise<Accepted>;

  /** Accepting is not "started": follow the operation until the Launcher reports process-started. */
  requestLaunch(instanceId: string, idempotencyKey: string): Promise<Accepted>;
}
