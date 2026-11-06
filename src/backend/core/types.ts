/** Protocol 2.0 wire shapes (core.schema.json $defs), as the Manager reads them after validation. */
import type { OperationState } from '../contract';

export type CoreCapabilities = Record<
  | 'hello' | 'core.info' | 'core.shutdown' | 'catalog.versions' | 'workspaces.create' | 'workspaces.list'
  | 'providers.search' | 'providers.versions' | 'plans.prepare' | 'plans.get' | 'transactions.apply'
  | 'mods.list' | 'updates.check' | 'operations.get' | 'operations.list' | 'operations.cancel' | 'events.poll'
  | 'recovery.list' | 'recovery.run' | 'inbox.begin' | 'inbox.write' | 'inbox.commit' | 'inbox.status' | 'outbox.read',
  boolean
>;

export interface CoreHello {
  protocol: { major: 2; minor: 0 };
  role: 'modpack-core';
  coreVersion: string;
  storageVersion: 1;
  profileId: string;
  sessionId: string;
  capabilities: CoreCapabilities;
  limits: { frameBytes: number; clients: number; pageItems: number };
}

export interface CoreInfo {
  role: 'modpack-core';
  coreVersion: string;
  profileId: string;
  dataRoot: string;
  workspaceRoot: string;
  state: 'ready' | 'recovery_required';
  supportedLoaders: ('vanilla' | 'fabric')[];
}

export interface CoreWorkspace {
  workspaceId: string;
  physicalId: string;
  name: string;
  minecraftVersion: string;
  loader: { id: 'vanilla' | 'fabric'; version: string };
  instanceRevision: string;
  ownership: 'manager-owned';
  recoveryRequired: boolean;
}

export interface CoreArtifact { fileName: string; size: string; sha512: string; sha1: string; url: string }
export interface CoreDependency { projectId: string | null; versionId: string | null; type: 'required' | 'optional' | 'incompatible' | 'embedded' | 'unknown' }

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
}

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
  updateLocked: boolean;
}

export type CoreChange =
  | { action: 'install' | 'replace'; projectId: string; versionId: string }
  | { action: 'remove' | 'enable' | 'disable'; inventoryId: string };

export interface CoreAccepted { operationId: string; state: OperationState; terminal: boolean; replayed: boolean }

export interface CoreError { code: string; message: string; retryable: boolean }

export interface CoreOperation {
  operationId: string;
  kind: 'workspace-create' | 'modpack-change';
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
  files: { path: string; action: 'install' | 'replace' | 'remove'; beforeSha256: string; afterSha256: string; size: string }[];
  total: number;
  nextOffset: number | null;
  warnings: string[];
  dependencies: CoreDependency[];
}

export interface CoreDescriptor {
  protocol: { major: 2; minor: 0 };
  role: 'modpack-core';
  serverName: string;
  pid: string;
  profileId: string;
  sessionId: string;
}
