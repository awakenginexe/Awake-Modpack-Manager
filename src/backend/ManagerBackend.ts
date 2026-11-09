import type {
  Accepted, ImportInspection, LoaderKind, WorkspaceSnapshot, ProjectVersion, ProviderId, VersionCatalog, ApplyRequest, ContentArea, ContentEntry, CreateInstanceRequest, Draft, ExportFormat,
  ExportReport, ExportRequest, Handshake, InstallPackRequest, PackSearchPage, PackSearchQuery, PackVersion, InstanceSummary, InstanceWarning, Installation, ModInventory,
  OperationStatus, RecoveryStatus, ResolvedPlan, SearchPage, SearchQuery, DependencyResolution, VersionRef, WorkspaceExportItem, ExportFileMatch, ExportRestriction, InstanceZipResult } from './contract';
import type { LauncherProfile } from './launcher/transport';
import type { ProjectDetail } from './host';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/**
 * The only surface Vue code talks to. Implementations: MockBackend (development and tests)
 * and LauncherClient (real Awake Launcher over its integration pipe, read-only protocol 1.0).
 * Transport framing lives inside implementations, never in components.
 */
export interface ManagerBackend {
  readonly kind: 'mock' | 'launcher' | 'helper' | 'composite';
  connect(): Promise<Handshake>;
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;

  listInstallations(): Promise<Installation[]>;
  /** Launcher profiles the user can choose between (desktop only). */
  launcherProfiles?(): LauncherProfile[];
  /** Remember extra Launcher folders (installation or data folder) to look in. */
  setAddedFolders?(folders: string[]): void;
  /** Whether the selected profile has a known installation that `startLauncher` can start. */
  canStartLauncher?(): boolean;
  /** Start the Launcher normally for the selected profile, on an explicit user action only. */
  startLauncher?(): Promise<void>;
  /** Give the selected Launcher data folder a normal install's permissions, on an explicit user action only. */
  makeProfilePrivate?(): Promise<void>;
  /** Link and select this workspace in Launcher. Minecraft still starts from Launcher. */
  openInLauncher?(instanceId: string): Promise<void>;
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
  /** `resolutions` answers dependency conflicts a previous attempt reported (helpers with dependencies.resolutions.v1). */
  validateDraft(draft: Draft, resolutions?: DependencyResolution[]): Promise<ResolvedPlan>;
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

  /** Versions this side can create (standalone helper). Absent when it cannot say. */
  versionCatalog?(query: { minecraftVersion?: string; loader?: LoaderKind }): Promise<VersionCatalog>;
  /** Provider versions of a project compatible with the instance, newest first. */
  projectVersions?(instanceId: string, provider: ProviderId, projectId: string): Promise<ProjectVersion[]>;
  /** Ask the coordinator to roll back an operation that is waiting for recovery. */
  runRecovery?(operationId: string, idempotencyKey: string): Promise<Accepted>;

  /**
   * Native modpack import (helper with manager.v0.2, imports.* and inbox.*). Absent or rejecting
   * with `unsupported` otherwise. The archive travels through bounded upload chunks, never as a path.
   */
  canImport?(): boolean;
  /** Upload and commit an archive; resolves to its transfer token. */
  uploadImport?(file: Blob, onProgress?: (sent: number, total: number) => void, signal?: AbortSignal): Promise<string>;
  inspectImport?(token: string, format: ImportInspection['format']): Promise<ImportInspection>;
  /** Resolve, download and stage the import for a matching workspace; resolves to the full reviewable plan. */
  prepareImport?(instanceId: string, token: string, format: ImportInspection['format'], includeOptional: boolean, resolutions?: DependencyResolution[]): Promise<ResolvedPlan>;
  /** True when the helper accepts reviewed dependency resolutions (manager.v0.2.1). */
  canResolveDependencies?(): boolean;
  /** Remove the uploaded bytes (idempotent). Workspaces and prepared plans are not touched. */
  discardImport?(token: string): Promise<void>;
  /** Provider identity of every verified file in a workspace, for a Manager-built export. */
  snapshotWorkspace?(instanceId: string, onProgress?: (done: number, total: number) => void): Promise<WorkspaceSnapshot>;

  /** Permanently delete a project the Manager owns: its files and its catalog entry. Follow the operation. */
  deleteInstance?(instanceId: string, idempotencyKey: string): Promise<Accepted>;
  renameInstance?(instanceId: string, name: string): Promise<void>;
  /** Newest compatible stable version per provider-identified mod, in batches. */
  checkUpdates?(instanceId: string): Promise<{ modKey: string; available: VersionRef | null }[]>;
  /** Fetch a pack version and resolve it against this project; the plan goes to Review. */
  preparePackUpdate?(instanceId: string, versionId: string, onStep?: (step: string) => void): Promise<ResolvedPlan>;
  /** Called once a reviewed pack update has been applied. */
  finishPackUpdate?(instanceId: string): Promise<void>;
  /** Author, statistics and links of a provider project, for its details panel. */
  projectDetail?(provider: ProviderId, projectId: string): Promise<ProjectDetail>;
  /** The identical file on `target`, for installed mods of the given names. No answer means no identical file. */
  exportMatches?(instanceId: string, target: ProviderId, fileNames: string[]): Promise<ExportFileMatch[]>;
  /** Which of these CurseForge projects players must download by hand. */
  exportRestricted?(instanceId: string, projectIds: string[]): Promise<ExportRestriction[]>;
  /** Describe exactly these mods for a provider format, asking the provider only for what that format needs. */
  prepareExport?(instanceId: string, format: 'mrpack' | 'curseforge', entries: WorkspaceExportItem[], onProgress?: (done: number, total: number) => void): Promise<WorkspaceSnapshot>;
  /** Save the whole pack, mod files included, where the user chooses. Null when they cancel. */
  exportInstanceZip?(instanceId: string, meta: { name: string; version: string }, onProgress?: (written: number, total: number) => void): Promise<InstanceZipResult | null>;
  /** Cancel this instance's checked plan, if one is waiting to be applied. */
  discardPlan?(instanceId: string): Promise<void>;
  /** Stop the helper so an installer can replace its files, and keep it stopped. Rejects if it has work it must finish. */
  shutdownHelper?(): Promise<void>;
  /** The update did not go ahead after all: the helper may start again. */
  resumeHelper?(): void;
  /** Move non-mod project content to the Recycle Bin. */
  recycleContent?(instanceId: string, area: ContentArea, paths: string[]): Promise<void>;
  openFolder?(instanceId: string, area?: ContentArea): Promise<void>;

  /** Helper: connect a Launcher instance in place, keeping its files where they are. Resolves once finished. */
  adoptInstance?(path: string): Promise<void>;
  releaseInstance?(instanceId: string): Promise<void>;
  canAdopt?(): boolean;
  /** Launcher: hold, then reload, an instance while the helper connects or disconnects it. */
  enrollInstance?(instanceId: string, phase: 'begin' | 'finish' | 'abort'): Promise<void>;
  canEnroll?(): boolean;
  /** Whether both sides can connect Launcher instances, so edits can go through the Manager. */
  canShareInstances?(): boolean;
  shareInstance?(instanceId: string): Promise<void>;
  stopSharingInstance?(instanceId: string): Promise<void>;

  /** Accepting is not "started": follow the operation until the Launcher reports process-started. */
  requestLaunch(instanceId: string, idempotencyKey: string): Promise<Accepted>;
}
