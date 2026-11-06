import type {
  Accepted, ApplyRequest, ContentArea, ContentEntry, CreateInstanceRequest, Draft, ExportFormat,
  ExportReport, ExportRequest, Handshake, InstallPackRequest, PackSearchPage, PackSearchQuery, PackVersion, InstanceSummary, Installation, ModInventory,
  OperationStatus, RecoveryStatus, ResolvedPlan, SearchPage, SearchQuery,
} from './contract';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/**
 * The only surface Vue code talks to. Implementations: MockBackend (development and tests)
 * and LauncherClient (real coordinator, blocked on the Codex contract). Transport framing
 * lives inside implementations, never in components.
 */
export interface ManagerBackend {
  readonly kind: 'mock' | 'launcher';
  connect(): Promise<Handshake>;
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;

  listInstallations(): Promise<Installation[]>;
  listInstances(installationId: string): Promise<InstanceSummary[]>;
  createInstance(request: CreateInstanceRequest): Promise<Accepted>;
  getInventory(instanceId: string): Promise<ModInventory>;

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

  getOperation(operationId: string): Promise<OperationStatus>;
  /** Look up an operation created by a request whose reply was lost. */
  findOperationByIdempotencyKey(key: string): Promise<OperationStatus | null>;
  listOperations(instanceId?: string): Promise<OperationStatus[]>;
  watchOperation(operationId: string, listener: (status: OperationStatus) => void): () => void;
  cancelOperation(operationId: string): Promise<void>;
  getRecoveryStatus(instanceId: string): Promise<RecoveryStatus>;

  listContent(instanceId: string, area: ContentArea): Promise<ContentEntry[]>;
  checkExport(instanceId: string, format: ExportFormat): Promise<ExportReport>;
  startExport(request: ExportRequest): Promise<Accepted>;

  requestLaunch(instanceId: string): Promise<void>;
}
