/** Protocol 2.0 wire shapes (core.schema.json $defs), as the Manager reads them after validation. */
import type { OperationState } from '../contract';

export type CoreCapabilities = Record<
  | 'hello' | 'core.info' | 'core.shutdown' | 'catalog.versions' | 'workspaces.create' | 'workspaces.list'
  | 'providers.search' | 'providers.versions' | 'plans.prepare' | 'plans.get' | 'transactions.apply'
  | 'mods.list' | 'updates.check' | 'operations.get' | 'operations.list' | 'operations.cancel' | 'events.poll'
  | 'recovery.list' | 'recovery.run' | 'inbox.begin' | 'inbox.write' | 'inbox.commit' | 'inbox.status' | 'outbox.read',
  boolean
> & Partial<Record<CoreExtensionCapability, boolean>>;

/** Present only when hello negotiated `manager.v0.2`. */
export type CoreExtensionCapability =
  | 'loaders.forge.v1' | 'loaders.neoforge.v1' | 'loaders.quilt.v1' | 'policies.v1' | 'providers.curseforge.v1'
  | 'imports.inspect' | 'imports.prepare' | 'inbox.discard' | 'inbox.discard.v1'
  | 'providers.project' | 'outbox.configs.v1' | 'outbox.list'
  | 'workspaces.delete' | 'workspaces.rename' | 'imports.packAuthoritative.v1'
  /** manager.v0.2.1 only. */
  | 'dependencies.resolutions.v1' | 'loaders.connector.v1';

export type CoreLoaderId = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt';
export type CoreProvider = 'modrinth' | 'curseforge';

export interface CoreHello {
  protocol: { major: 2; minor: 0 };
  role: 'modpack-core';
  coreVersion: string;
  storageVersion: 1;
  profileId: string;
  sessionId: string;
  capabilities: CoreCapabilities;
  limits: { frameBytes: number; clients: number; pageItems: number };
  /** Echo of the accepted hello extensions; absent when none were offered (or an older helper). */
  extensions?: string[];
}

export interface CoreInfo {
  role: 'modpack-core';
  coreVersion: string;
  profileId: string;
  dataRoot: string;
  workspaceRoot: string;
  state: 'ready' | 'recovery_required';
  supportedLoaders: CoreLoaderId[];
}

export interface CoreWorkspace {
  workspaceId: string;
  physicalId: string;
  name: string;
  minecraftVersion: string;
  loader: { id: CoreLoaderId; version: string };
  instanceRevision: string;
  ownership: 'manager-owned';
  recoveryRequired: boolean;
}

/** sha512 is absent only for CurseForge files. */
export interface CoreArtifact { fileName: string; size: string; sha512?: string; sha1: string; url: string }
export interface CoreDependency { projectId: string | null; versionId: string | null; type: 'required' | 'optional' | 'incompatible' | 'embedded' | 'unknown' | 'tool' | 'include'; provider?: CoreProvider }

export interface CoreVersion {
  projectId: string;
  versionId: string;
  versionNumber: string;
  name: string;
  releaseType: 'release' | 'beta' | 'alpha';
  gameVersions: string[];
  loaders: string[];
  files: CoreArtifact[];
  dependencies: CoreDependency[];
  provider?: CoreProvider;
}

export interface CoreProject { projectId: string; slug: string; title: string; description: string; iconUrl: string | null; gameVersions: string[]; loaders: string[]; provider?: CoreProvider }

export interface CoreInstalled {
  inventoryId: string;
  fileName: string;
  enabled: boolean;
  size: string;
  sha256: string;
  projectId: string | null;
  versionId: string | null;
  versionNumber: string | null;
  metadataState: 'verified' | 'modified' | 'unknown';
  /** Aggregate: nativeLock OR policy.excluded OR a pin. Never show it as a pin. */
  updateLocked: boolean;
  provider?: CoreProvider;
  /** manager.v0.2 only: the Manager policy, independent of native locks. */
  policy?: { pinnedVersion: string | null; excluded: boolean };
  /** manager.v0.2 only: Packwiz update=false; a policy change cannot clear it. */
  nativeLock?: boolean;
  /** manager.v0.2.1 only: a Fabric mod loaded through Sinytra Connector. */
  loaderBridge?: 'sinytra-connector';
}

export type CoreChange =
  | { action: 'install' | 'replace'; projectId: string; versionId: string; provider?: CoreProvider; artifactSha512?: string }
  | { action: 'remove' | 'enable' | 'disable'; inventoryId: string }
  | { action: 'policy'; inventoryId: string; pinnedVersion: string | null; excluded: boolean };

/** inbox.* result: sizes are decimal strings. */
export interface CoreTransfer { token: string; size: string; received: string; sha256: string; complete: boolean }

export type CoreImportFormat = 'mrpack' | 'curseforge';
export interface CoreImportInspection {
  minecraftVersion: string;
  loader: { id: CoreLoaderId; version: string };
  files: { path: string; sha256: string; size: string }[];
  projects: { provider: CoreProvider; projectId: string; versionId: string; required: boolean }[];
  downloadCount: number;
  warnings: string[];
}

export interface CoreAccepted { operationId: string; state: OperationState; terminal: boolean; replayed: boolean }

export interface CoreError { code: string; message: string; retryable: boolean; details?: CoreConflictDetails }

/** manager.v0.2.1 DEPENDENCY_CONFLICT details ($defs/conflictDetails). */
export interface CoreConflictDetails { conflicts: CoreDependencyConflict[]; truncated: boolean }
export interface CoreDependencyEvidence {
  result: 'satisfied' | 'violated' | 'not_declared' | 'unknown';
  modId: string | null;
  declaredRange: string | null;
  mandatory: boolean | null;
  selectedModVersion: string | null;
}
export interface CoreDependencyConflict {
  kind: 'version_pin' | 'missing_dependency' | 'incompatible' | 'loader_bridge';
  provider: CoreProvider;
  projectId: string;
  title: string;
  selected: { versionId: string; versionNumber: string; fileName: string } | null;
  requests: {
    provider: CoreProvider; projectId: string; title: string; versionId: string; versionNumber: string; fileName: string;
    requestedVersionId: string | null; requestedVersionNumber: string | null; evidence: CoreDependencyEvidence;
  }[];
  candidates: { versionId: string; versionNumber: string }[];
  resolutions: ('use_version' | 'proceed_without')[];
  message: string;
}
/** A reviewed answer sent with plans.prepare / imports.prepare (manager.v0.2.1). */
export interface CoreDependencyResolution { projectId: string; provider?: CoreProvider; versionId: string | null }
export interface CoreReviewedResolution {
  projectId: string; provider?: CoreProvider; title: string; versionId: string | null;
  requestedBy: { projectId: string; title: string; requestedVersionId: string | null; evidence: 'satisfied' | 'not_declared' | 'unknown' }[];
}

export interface CoreOperation {
  operationId: string;
  kind: 'workspace-create' | 'workspace-delete' | 'modpack-change';
  state: OperationState;
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
  sequence: string;
  physicalId?: string;
  cancellationRequested: boolean;
  progress?: { phase: string; completed: string; total: string | null; unit: 'steps' | 'files' | 'bytes' };
  result?: { workspace?: CoreWorkspace; planDigest?: string; instanceRevision?: string; expectedInstanceRevision?: string; fileCount?: number; verified?: boolean };
  error?: CoreError;
}

export interface CorePlanPage {
  operationId: string;
  planDigest: string;
  instanceRevision: string;
  expectedInstanceRevision: string;
  files: { path: string; action: 'install' | 'replace' | 'remove'; beforeSha256: string; afterSha256: string; size: string; kind?: 'mod' | 'override' | 'bookkeeping' }[];
  total: number;
  nextOffset: number | null;
  warnings: string[];
  dependencies: CoreDependency[];
  /** manager.v0.2.1 only: resolutions accepted for this reviewed plan (bound into planDigest). */
  dependencyResolutions?: CoreReviewedResolution[];
}

export interface CoreDescriptor {
  protocol: { major: 2; minor: 0 };
  role: 'modpack-core';
  serverName: string;
  pid: string;
  profileId: string;
  sessionId: string;
}

/** outbox.list / outbox.read (manager.v0.2): unchanged, policy-tracked config/ text overrides only. */
export interface CoreOutboxList { instanceRevision: string; files: { path: string; size: string; sha256: string }[]; total: number; nextOffset: number | null }
export interface CoreOutboxChunk { path: string; instanceRevision: string; offset: string; size: string; bytesBase64: string; eof: boolean; sha256: string }
