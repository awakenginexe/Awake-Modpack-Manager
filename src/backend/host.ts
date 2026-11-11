import { BackendError, type AddedContent, type ContentEntry, type ContentImage, type ContentKind, type ContentSearchPage, type ContentSearchQuery, type ContentTextFile, type ContentVersion, type InstalledContent, type ExportFileMatch, type InstanceZipResult, type PackHit, type PackProviderId, type PackProviderInfo, type PackVersion, type ProviderId } from './contract';

/** A pack the desktop host downloaded and verified, ready to upload to the helper. */
export interface FetchedPack { token: string; format: 'mrpack' | 'curseforge'; size: number; sha256: string; notes: string[] }
export interface ProjectMeta { provider: ProviderId; projectId: string; name: string; iconUrl?: string; restricted?: boolean; pageUrl?: string }
export interface ModUpdate { provider: ProviderId; projectId: string; installedVersionId: string; candidate: { id: string; name: string; releaseType: 'release' | 'beta' | 'alpha' } | null }
export interface ProjectDetail { author: string; summary: string; downloads: number | null; updatedAt: string | null; license: string | null; categories: string[]; pageUrl: string | null }
export interface ProjectRef { provider: ProviderId; projectId: string; versionId?: string }

/**
 * The desktop host's provider and file services (src-tauri/src/{providers,desktop}.rs). Provider keys
 * stay in the host: only results cross into the web view.
 */
export interface HostApi {
  packProviders(): Promise<PackProviderInfo[]>;
  packSearch(provider: PackProviderId, text: string, offset: number, limit: number): Promise<{ hits: PackHit[]; total: number }>;
  packVersions(provider: PackProviderId, packId: string): Promise<PackVersion[]>;
  packFetch(provider: PackProviderId, packId: string, versionId: string, job: string, onProgress?: (done: number, total: number) => void): Promise<FetchedPack>;
  packCancel(job: string): Promise<void>;
  packRead(token: string, offset: number, length: number): Promise<Uint8Array>;
  packDiscard(token: string): Promise<void>;
  projectMeta(items: ProjectRef[]): Promise<ProjectMeta[]>;
  projectDetail(provider: ProviderId, projectId: string): Promise<ProjectDetail>;
  modUpdates(items: ProjectRef[], minecraftVersion: string, loader: string): Promise<ModUpdate[]>;
  workspaceList(workspace: string, area: string, folder?: string): Promise<(ContentEntry & { modifiedMs?: number })[]>;
  workspaceRecycle(workspace: string, area: string, paths: string[]): Promise<void>;
  workspaceOpen(workspace: string, area?: string, folder?: string): Promise<void>;
  workspaceReadText(workspace: string, area: string, path: string): Promise<ContentTextFile>;
  workspaceReadImage(workspace: string, area: string, path: string): Promise<ContentImage>;
  workspaceWriteText(workspace: string, area: string, path: string, text: string, expectedModifiedMs: number): Promise<number>;
  workspaceAddFiles(workspace: string, area: string, folder: string): Promise<AddedContent | null>;
  contentSearch(query: ContentSearchQuery): Promise<ContentSearchPage>;
  contentVersions(provider: ProviderId, projectId: string, minecraftVersion: string): Promise<ContentVersion[]>;
  contentInstall(workspace: string, kind: ContentKind, provider: ProviderId, projectId: string, versionId: string, onProgress?: (done: number, total: number) => void): Promise<InstalledContent>;
  /** Drop the helper's records of mods whose file is gone. Resolves with the file names forgotten. */
  workspaceForgetMissing(workspace: string): Promise<string[]>;
  exportMatch(workspace: string, target: ProviderId, fileNames: string[]): Promise<ExportFileMatch[]>;
  exportInstance(workspace: string, meta: { fileName: string; name: string; version: string; minecraft: string; loader: string }, onProgress?: (written: number, total: number) => void): Promise<InstanceZipResult | null>;
}

/** Host failures become BackendErrors with the host's own wording. */
function asBackendError(e: unknown): BackendError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const { code, message } = e as { code: string; message: string };
    const mapped = code === 'restricted' || code === 'manual-download' || code === 'curseforge-disabled' ? 'provider-restricted' : code === 'unsupported' ? 'unsupported' : code === 'network' || code === 'rate-limited' ? 'disconnected' : code === 'conflict' ? 'stale-revision' : 'rejected';
    return new BackendError(mapped, String(message), code);
  }
  return new BackendError('protocol', e instanceof Error ? e.message : String(e));
}

export async function hostInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try { return await invoke<T>(cmd, args); } catch (e) { throw asBackendError(e); }
}

export function createHostApi(): HostApi {
  return {
    packProviders: () => hostInvoke('pack_providers'),
    packSearch: (provider, text, offset, limit) => hostInvoke('pack_search', { provider, text, offset, limit }),
    packVersions: (provider, packId) => hostInvoke('pack_versions', { provider, packId }),
    async packFetch(provider, packId, versionId, job, onProgress) {
      const { listen } = await import('@tauri-apps/api/event');
      const stop = await listen<{ job: string; done: number; total: number }>('pack-progress', (e) => { if (e.payload.job === job) onProgress?.(e.payload.done, e.payload.total); });
      try { return await hostInvoke('pack_fetch', { provider, packId, versionId, job }); } finally { stop(); }
    },
    packCancel: (job) => hostInvoke('pack_cancel', { job }),
    packRead: async (token, offset, length) => new Uint8Array(await hostInvoke<ArrayBuffer>('pack_read', { token, offset, length })),
    packDiscard: (token) => hostInvoke('pack_discard', { token }),
    projectMeta: (items) => hostInvoke('project_meta', { items }),
    projectDetail: (provider, projectId) => hostInvoke('project_detail', { provider, projectId }),
    modUpdates: (items, minecraftVersion, loader) => hostInvoke('mod_updates', { items, minecraftVersion, loader }),
    workspaceList: (workspace, area, folder) => hostInvoke('workspace_list', { workspace, area, folder: folder || null }),
    workspaceReadText: (workspace, area, path) => hostInvoke('workspace_read_text', { workspace, area, path }),
    workspaceReadImage: (workspace, area, path) => hostInvoke('workspace_read_image', { workspace, area, path }),
    workspaceWriteText: (workspace, area, path, text, expectedModifiedMs) => hostInvoke('workspace_write_text', { workspace, area, path, text, expectedModifiedMs }),
    workspaceAddFiles: (workspace, area, folder) => hostInvoke('workspace_add_files', { workspace, area, folder }),
    contentSearch: ({ provider, kind, text, minecraftVersion, offset, limit }) => hostInvoke('content_search', { provider, kind, text, minecraftVersion, offset, limit }),
    contentVersions: (provider, projectId, minecraftVersion) => hostInvoke('content_versions', { provider, projectId, minecraftVersion }),
    async contentInstall(workspace, kind, provider, projectId, versionId, onProgress) {
      const { listen } = await import('@tauri-apps/api/event');
      const job = crypto.randomUUID();
      const stop = await listen<{ job: string; done: number; total: number }>('content-progress', (e) => { if (e.payload.job === job) onProgress?.(e.payload.done, e.payload.total); });
      try { return await hostInvoke('content_install', { workspace, provider, kind, projectId, versionId, job }); } finally { stop(); }
    },
    workspaceRecycle: (workspace, area, paths) => hostInvoke('workspace_recycle', { workspace, area, paths }),
    workspaceForgetMissing: (workspace) => hostInvoke('workspace_forget_missing', { workspace }),
    workspaceOpen: (workspace, area, folder) => hostInvoke('workspace_open', { workspace, area: area ?? null, folder: folder || null }),
    exportMatch: (workspace, target, fileNames) => hostInvoke('export_match', { workspace, target, fileNames }),
    async exportInstance(workspace, meta, onProgress) {
      const { listen } = await import('@tauri-apps/api/event');
      const stop = await listen<{ done: number; total: number }>('export-progress', (e) => onProgress?.(e.payload.done, e.payload.total));
      try { return await hostInvoke('export_instance', { workspace, ...meta }); } finally { stop(); }
    },
  };
}
