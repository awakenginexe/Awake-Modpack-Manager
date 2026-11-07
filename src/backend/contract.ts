/**
 * PROVISIONAL integration types.
 *
 * These describe what the Manager needs from the Awake Launcher coordinator. They are NOT the
 * final contract: Codex owns that on `feat/modpack-manager-integration`. When it lands, adapt
 * LauncherClient to it and change these types to match, not the other way round.
 * See docs/INTEGRATION.md for the assumptions behind every type here.
 */

export const PROVISIONAL_CONTRACT = '0.0-provisional';

export type Capability =
  | 'installations.discover'
  | 'instances.list'
  | 'instances.create'
  | 'mods.inventory'
  | 'providers.search'
  | 'plan.validate'
  | 'plan.prepare'
  | 'plan.apply'
  | 'operations.watch'
  | 'operations.cancel'
  | 'operations.reconnect'
  | 'recovery.status'
  | 'files.read'
  | 'export.mrpack'
  | 'export.curseforge'
  | 'launch.request'
  | 'packs.search'
  | 'packs.install'
  /** Helper-owned pins and update exclusions (policies.v1). */
  | 'mods.policies'
  /** Native .mrpack / CurseForge ZIP import through bounded uploads (imports.* + inbox.*). */
  | 'packs.import';

/** Every capability this Manager build knows how to use. */
export const ALL_CAPABILITIES: Capability[] = [
  'installations.discover', 'instances.list', 'instances.create', 'mods.inventory', 'providers.search',
  'plan.validate', 'plan.prepare', 'plan.apply', 'operations.watch', 'operations.cancel', 'operations.reconnect',
  'recovery.status', 'files.read', 'export.mrpack', 'export.curseforge', 'launch.request', 'packs.search', 'packs.install',
  'mods.policies', 'packs.import',
];

export type ProviderId = 'modrinth' | 'curseforge';
export type ModSource = ProviderId | 'manual';
export type LoaderKind = 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'vanilla';
export type ReleaseType = 'release' | 'beta' | 'alpha';

export interface ProviderInfo {
  id: ProviderId;
  available: boolean;
  /** Why the provider cannot be used right now (e.g. CurseForge API not authorized). */
  unavailableReason?: string;
}

export interface Handshake {
  contract: string;
  /** The Manager's test helper: nothing it reports is a real installation. */
  stub?: boolean;
  launcherVersion: string;
  capabilities: Capability[];
  providers: ProviderInfo[];
  /** Modpack sources. The Launcher's pack catalog already supports all of these. */
  packProviders: PackProviderInfo[];
}

/* ---------- Modpacks (install someone else's pack as a new instance) ---------- */

export type PackProviderId = 'modrinth' | 'curseforge' | 'ftb' | 'atlauncher' | 'technic';

export interface PackProviderInfo {
  id: PackProviderId;
  available: boolean;
  unavailableReason?: string;
}

export interface PackSearchQuery {
  provider: PackProviderId;
  text: string;
  offset: number;
  limit: number;
}

export interface PackHit {
  provider: PackProviderId;
  packId: string;
  name: string;
  author: string;
  summary: string;
  iconUrl?: string;
  downloads?: number;
  minecraftVersion?: string;
  loader?: LoaderKind;
}

export interface PackSearchPage {
  hits: PackHit[];
  total: number;
}

export interface PackVersion {
  id: string;
  name: string;
  minecraftVersion: string;
  loader?: LoaderKind;
  releaseType?: ReleaseType;
  publishedAt?: string;
}

/** Link from an instance to the pack it was installed from; the basis for upstream updates. */
export interface PackLink {
  provider: PackProviderId;
  packId: string;
  packName: string;
  versionId: string;
  versionName: string;
}

export interface InstallPackRequest {
  provider: PackProviderId;
  packId: string;
  versionId: string;
  instanceName: string;
  idempotencyKey: string;
}

export interface Installation {
  id: string;
  displayName: string;
  path: string;
  launcherVersion: string;
  portable: boolean;
  /** False when no running Launcher endpoint was found for this profile. */
  available?: boolean;
}

export type InstanceStatus = 'ready' | 'running' | 'busy' | 'broken' | 'unknown';

export interface InstanceSummary {
  /** For Launcher data this is the opaque physicalId, the only key mods.list accepts. */
  id: string;
  name: string;
  iconUrl?: string;
  /** Not reported by Launcher protocol 1.0; absent means unknown. */
  minecraftVersion?: string;
  loader?: { kind: LoaderKind; version?: string };
  /** Absent while unknown (e.g. unloaded instances, or not counted yet). */
  modCount?: number;
  status: InstanceStatus;
  path?: string;
  /** False when the coordinator cannot manage this instance; `blockedReason` says why. */
  manageable: boolean;
  blockedReason?: string;
  /** Opaque authoritative revision. Any change to the instance's content changes it. */
  revision: string;
  pack?: PackLink;
  /** Launcher protocol identity details (absent for demo data). */
  launcher?: {
    instanceId: string;
    uuid: string | null;
    loaded: boolean;
    identityStatus: 'verified' | 'conflict';
    nativeActivity: 'idle' | 'launch_preparing' | 'launch_active' | 'deleting' | 'unknown' | null;
  };
}

/** Discovery warning reported by the Launcher (e.g. duplicate IDs, aliased or shared roots). */
export interface InstanceWarning {
  code: string;
  path: string;
}

export type DependencyKind = 'required' | 'optional' | 'incompatible' | 'embedded';

export interface DependencyRef {
  kind: DependencyKind;
  projectId?: string;
  name: string;
  versionRange?: string;
  /** Whether the dependency is satisfied in the current instance. `unknown` when undeterminable. */
  state: 'satisfied' | 'missing' | 'conflict' | 'unknown';
}

export interface VersionRef {
  id: string;
  name: string;
  /** Unknown for Launcher-indexed metadata. */
  releaseType?: ReleaseType;
  publishedAt?: string;
}

export interface InstalledMod {
  /** Stable key within the instance. Manual files are keyed by file name. */
  key: string;
  fileName: string;
  name: string;
  iconUrl?: string;
  source: ModSource;
  projectId?: string;
  installed: VersionRef | null;
  /** Latest compatible version reported by the provider, if any. */
  available?: VersionRef;
  enabled: boolean;
  /** Absent when dependencies are unknown (Launcher protocol 1.0 does not report them). */
  dependencies?: DependencyRef[];
  /** File differs from what the provider metadata says was installed. */
  locallyModified?: boolean;
  sizeBytes?: number;
  modifiedMs?: number;
  /** Launcher inventory details. `conflict` = several .index entries claim this file. */
  metadataState?: 'indexed' | 'unindexed' | 'conflict';
  kind?: 'jar' | 'directory' | 'other';
  linked?: boolean;
  /** Pinned by policy or locked by native metadata (helper: OR of both). */
  updateLocked?: boolean;
  /** Excluded from update checks by the helper's policy (policies.v1). */
  updateExcluded?: boolean;
}

export interface ModInventory {
  instanceId: string;
  revision: string;
  mods: InstalledMod[];
}

export interface SearchQuery {
  text: string;
  provider: ProviderId;
  minecraftVersion: string;
  loader: LoaderKind;
  releaseTypes: ReleaseType[];
  compatibleOnly: boolean;
  offset: number;
  limit: number;
}

export interface SearchHit {
  provider: ProviderId;
  projectId: string;
  name: string;
  author: string;
  summary: string;
  iconUrl?: string;
  /** Absent when the provider adapter does not report it. */
  downloads?: number;
  compatible: boolean;
  latest?: VersionRef;
}

export interface SearchPage {
  hits: SearchHit[];
  total: number;
}

/* ---------- Draft & plan ---------- */

export type DraftChange =
  | { kind: 'install'; provider: ProviderId; projectId: string; name: string; versionId?: string }
  | { kind: 'update'; modKey: string; targetVersionId: string }
  | { kind: 'remove'; modKey: string }
  | { kind: 'enable'; modKey: string }
  | { kind: 'disable'; modKey: string }
  /** Helper-owned update policy (policies.v1): pin the installed version and/or exclude from updates. */
  | { kind: 'policy'; modKey: string; pinned: boolean; excluded: boolean };

/** A Manager-owned draft. It never touches the instance until a confirmed plan is applied. */
export interface Draft {
  instanceId: string;
  /** Revision the user was looking at when they built the draft. */
  baseRevision: string;
  changes: DraftChange[];
  /** Policies the resolver must respect (pins are Manager-owned). */
  pinnedKeys: string[];
}

export type PlanAction = 'install' | 'update' | 'remove' | 'enable' | 'disable' | 'keep' | 'override' | 'policy';

export interface PlanItem {
  action: PlanAction;
  modKey: string;
  name: string;
  from?: VersionRef | null;
  to?: VersionRef;
  /** Why this item is in the plan: requested by the user, or pulled in as a dependency. */
  reason: 'requested' | 'required-dependency' | 'optional-dependency';
  requiredBy?: string[];
  /** The item deletes or replaces something the user may have customised. */
  destructive?: boolean;
}

export interface PlanIssue {
  severity: 'error' | 'warning' | 'info';
  code:
    | 'version-conflict'
    | 'incompatible'
    | 'pinned-skipped'
    | 'unknown-file'
    | 'locally-modified'
    | 'missing-dependency'
    | 'loader-mismatch'
    | 'unknown-dependency'
    /** A required dependency the coordinator added and verified. */
    | 'dependency-included'
    /** Free-text warning from the coordinator's plan. */
    | 'coordinator-warning';
  message: string;
  modKeys: string[];
}

export interface OptionalSuggestion {
  provider: ProviderId;
  projectId: string;
  name: string;
  suggestedBy: string[];
}

export interface ResolvedPlan {
  planId: string;
  /** Hash of the resolved content. Review and Apply must refer to the same hash. */
  planHash: string;
  instanceId: string;
  baseRevision: string;
  items: PlanItem[];
  issues: PlanIssue[];
  optional: OptionalSuggestion[];
  /** Apply is refused while any blocking issue exists. */
  blocked: boolean;
}

/* ---------- Operations ---------- */

/** Exactly the Launcher contract's operation states (requests.schema.json $defs/operation). */
export type OperationState =
  | 'queued' | 'resolving' | 'downloading' | 'prepared'
  | 'acquiring' | 'revalidating' | 'backing_up' | 'applying' | 'verifying'
  /** Nonterminal: the Launcher is undoing a failed apply. */
  | 'rolling_back'
  | 'completed' | 'cancelled' | 'failed' | 'rolled_back'
  /** Nonterminal: blocks unsafe use until the Launcher's recovery has run. */
  | 'recovery_required';

export const TERMINAL_STATES: readonly OperationState[] = ['completed', 'cancelled', 'failed', 'rolled_back'];

export type OperationKind = 'apply-plan' | 'create-instance' | 'install-pack' | 'export' | 'launch';

export interface OperationStatus {
  operationId: string;
  kind: OperationKind;
  instanceId?: string;
  planHash?: string;
  state: OperationState;
  /** 0..1 when known. */
  progress?: number;
  step?: string;
  startedAt: string;
  updatedAt: string;
  cancellable: boolean;
  error?: { code: string; message: string; detail?: string };
  recovery?: { backupId?: string; restored?: boolean; message: string };
  /** `instanceId` is set when the operation created an instance. */
  result?: { revision?: string; exportPath?: string; instanceId?: string };
}

export interface ApplyRequest {
  planId: string;
  planHash: string;
  /** The prepared plan's baseline revision; the Launcher re-checks it under its instance gate. */
  baseRevision: string;
  /** Client-generated; lets the coordinator de-duplicate a resent Apply. */
  idempotencyKey: string;
}

export interface Accepted {
  operationId: string;
}

export interface CreateInstanceRequest {
  name: string;
  minecraftVersion: string;
  loader: LoaderKind;
  /** Exact loader version; required by the standalone helper for non-vanilla loaders. */
  loaderVersion?: string;
  idempotencyKey: string;
}

/** Minecraft and loader choices a coordinator can create. */
export interface VersionCatalog {
  minecraftVersions: string[];
  loaders: LoaderKind[];
  /** Loader versions for the requested Minecraft version and loader. */
  loaderVersions: string[];
}

/** One provider version of a project, compatible with an instance. */
export interface ProjectVersion extends VersionRef {
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  fileName?: string;
  sizeBytes?: number;
  dependencies: { projectId: string | null; versionId: string | null; type: DependencyKind | 'unknown' }[];
}

/** What the helper read from a committed modpack archive (imports.inspect). Nothing is applied. */
export interface ImportInspection {
  format: 'mrpack' | 'curseforge';
  minecraftVersion: string;
  loader: { kind: LoaderKind; version: string };
  /** Override files with the helper-computed hash; they are installed only through a reviewed plan. */
  files: { path: string; sha256: string; size: number }[];
  projects: { provider: ProviderId; projectId: string; versionId: string; required: boolean }[];
  downloadCount: number;
  warnings: string[];
}

/** A workspace's provider files with full download identity, for building an export in the Manager. */
export interface WorkspaceSnapshot {
  name: string;
  minecraftVersion: string;
  loader: { kind: LoaderKind; version: string };
  mods: {
    provider: ProviderId; projectId: string; versionId: string; versionName: string; name: string;
    fileName: string; size: number; sha1: string; sha512?: string; url: string; enabled: boolean;
  }[];
  /** Files that cannot be described by a provider reference, and why. They are never exported silently. */
  skipped: { fileName: string; reason: 'manual' | 'modified' | 'provider' | 'not-found' }[];
}

export interface RecoveryStatus {
  instanceId: string;
  pending: boolean;
  message?: string;
  backups: { backupId: string; createdAt: string; label: string }[];
}

/* ---------- Files & export ---------- */

export type ContentArea = 'config' | 'defaultconfigs' | 'kubejs' | 'scripts' | 'resourcepacks' | 'shaderpacks';

export interface ContentEntry {
  path: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
}

export type ExportFormat = 'mrpack' | 'curseforge';

export type DistributionStatus =
  /** Referenced by provider URL; the file itself is not redistributed. */
  | 'provider-reference'
  /** File must be bundled; author permission is required and not proven. */
  | 'needs-permission'
  /** Provider disallows third-party distribution. */
  | 'blocked'
  | 'unknown';

export interface ExportEntry {
  modKey: string;
  name: string;
  status: DistributionStatus;
  note?: string;
}

export interface ExportReport {
  format: ExportFormat;
  entries: ExportEntry[];
}

export interface ExportRequest {
  instanceId: string;
  format: ExportFormat;
  name: string;
  version: string;
  includePaths: string[];
  excludeModKeys: string[];
  idempotencyKey: string;
}

export type BackendErrorCode =
  | 'disconnected'
  | 'timeout'
  | 'protocol'
  | 'unsupported'
  | 'stale-revision'
  | 'plan-expired'
  | 'instance-busy'
  | 'rejected'
  /** No running Launcher endpoint for the selected profile. */
  | 'not-running'
  /** Profile location the Launcher cannot publish an endpoint for (removable, network...). */
  | 'unsupported-profile'
  /** The pipe or hello did not match the descriptor / current user. */
  | 'identity'
  /** The Launcher needs the user to act in its own window first (sign-in, a dialog). */
  | 'interaction-required'
  /** An interrupted change must be recovered in the Launcher before this instance is used. */
  | 'recovery-required'
  /** The Manager's native helper is not installed, failed to start, or is incompatible. */
  | 'helper-unavailable'
  /** Unsupported or unsafe archive (ZIP64, encryption, traversal...): the helper's INVALID_ARCHIVE. */
  | 'invalid-archive'
  /** A file must be downloaded manually or its host is not allowed (PROVIDER_RESTRICTED / PROVIDER_UNAVAILABLE). */
  | 'provider-restricted';

export class BackendError extends Error {
  constructor(readonly code: BackendErrorCode, message: string, readonly detail?: string) {
    super(message);
    this.name = 'BackendError';
  }
}
