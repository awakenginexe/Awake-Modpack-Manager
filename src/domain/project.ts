/**
 * Manager-owned modpack projects: a modpack *source* (what should be in the pack), never a
 * playable Launcher instance. Projects live in Manager storage only; nothing here touches
 * instance files. See docs/ARCHITECTURE-STANDALONE.md.
 */
import type { LoaderKind } from '../backend/contract';
import { unsafePathReason, writeZip } from './zip';

export type ProjectProvider = 'modrinth' | 'curseforge' | 'manual';
export type EnvSupport = 'required' | 'optional' | 'unsupported';
export type DependencyType = 'required' | 'optional' | 'incompatible' | 'embedded';

/** A file whose identity came from a pack manifest or provider: exact path, size and hashes. */
export interface ProjectFile {
  path: string;
  size?: number;
  sha1?: string;
  sha512?: string;
  downloads: string[];
}

export interface ProjectMod {
  /** `mr:<project>`, `cf:<project>` or `file:<path>`. */
  key: string;
  name: string;
  provider: ProjectProvider;
  projectId?: string;
  versionId?: string;
  versionName?: string;
  file?: ProjectFile;
  env?: { client: EnvSupport; server: EnvSupport };
  /** CurseForge `required`; a non-required mod is optional for players. */
  required: boolean;
  /** Pinned mods keep their exact version when updates are planned. */
  pinned: boolean;
  /** Declared dependencies when a provider reported them; undefined = not checked. */
  dependencies?: { projectId: string; type: DependencyType }[];
  /** True when the identity came from a manifest/provider; false for user-typed plans. */
  verified: boolean;
  origin: 'import' | 'planned';
}

export interface ModpackProject {
  id: string;
  name: string;
  version: string;
  summary: string;
  author: string;
  minecraftVersion: string;
  loader: { kind: LoaderKind; version: string };
  mods: ProjectMod[];
  /** Override files listed by an import. Their contents are not stored yet (workspace pending). */
  overrides: { path: string; size: number }[];
  source: { kind: 'new' } | { kind: 'import'; format: PackFormat; fileName: string };
  createdAt: string;
  updatedAt: string;
}

export type PackFormat = 'mrpack' | 'curseforge';

export function newProject(init: Pick<ModpackProject, 'name' | 'minecraftVersion' | 'loader'> & Partial<ModpackProject>): ModpackProject {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), version: '1.0.0', summary: '', author: '', mods: [], overrides: [], source: { kind: 'new' }, createdAt: now, updatedAt: now, ...init };
}

export const modKey = (provider: ProjectProvider, idOrPath: string) => `${provider === 'modrinth' ? 'mr' : provider === 'curseforge' ? 'cf' : 'file'}:${idOrPath}`;

/* ---------- analysis ---------- */

export type IssueCode = 'duplicate-project' | 'duplicate-file' | 'dependency-missing' | 'incompatible' | 'unverified' | 'manual-file';
export interface ProjectIssue { code: IssueCode; severity: 'error' | 'warning' | 'info'; modKeys: string[]; detail?: string }

/** Problems the Manager can prove from project data alone. Unknown dependencies are not issues. */
export function analyzeProject(p: ModpackProject): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const byProject = new Map<string, string[]>();
  const byPath = new Map<string, string[]>();
  for (const m of p.mods) {
    if (m.projectId) {
      const k = `${m.provider}:${m.projectId}`;
      byProject.set(k, [...(byProject.get(k) ?? []), m.key]);
    }
    if (m.file) {
      const k = m.file.path.toLowerCase();
      byPath.set(k, [...(byPath.get(k) ?? []), m.key]);
    }
    if (!m.verified) issues.push({ code: 'unverified', severity: 'info', modKeys: [m.key] });
    if (m.provider === 'manual') issues.push({ code: 'manual-file', severity: 'warning', modKeys: [m.key] });
  }
  for (const keys of byProject.values()) if (keys.length > 1) issues.push({ code: 'duplicate-project', severity: 'error', modKeys: keys });
  for (const [path, keys] of byPath) if (keys.length > 1) issues.push({ code: 'duplicate-file', severity: 'error', modKeys: keys, detail: path });
  const present = new Set(p.mods.map((m) => m.projectId).filter(Boolean));
  for (const m of p.mods) {
    for (const d of m.dependencies ?? []) {
      if (d.type === 'required' && !present.has(d.projectId)) issues.push({ code: 'dependency-missing', severity: 'error', modKeys: [m.key], detail: d.projectId });
      if (d.type === 'incompatible' && present.has(d.projectId)) issues.push({ code: 'incompatible', severity: 'error', modKeys: [m.key], detail: d.projectId });
    }
  }
  return issues;
}

/* ---------- export planning ---------- */

/** Hosts the Modrinth .mrpack format allows in `downloads`. */
export const MRPACK_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
const MRPACK_LOADER: Partial<Record<LoaderKind, string>> = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' };

export type ExportBlocker =
  | 'no-hashes' | 'no-download' | 'download-host' | 'no-size' | 'not-curseforge' | 'no-file-id'
  | 'no-loader-version' | 'no-minecraft-version' | 'nothing-to-export';
export interface ExportPlan {
  format: PackFormat;
  included: string[];
  excluded: string[];
  blockers: { modKey?: string; code: ExportBlocker }[];
  /** Override contents are not stored in drafts, so exports never contain them yet. */
  overridesOmitted: number;
  ready: boolean;
}

export function planExport(p: ModpackProject, format: PackFormat, exclude: ReadonlySet<string> = new Set()): ExportPlan {
  const blockers: ExportPlan['blockers'] = [];
  const included: string[] = [];
  if (!p.minecraftVersion) blockers.push({ code: 'no-minecraft-version' });
  if (p.loader.kind !== 'vanilla' && !p.loader.version) blockers.push({ code: 'no-loader-version' });
  for (const m of p.mods) {
    if (exclude.has(m.key)) continue;
    const before = blockers.length;
    if (format === 'mrpack') {
      const f = m.file;
      if (!f?.sha1 || !f.sha512) blockers.push({ modKey: m.key, code: 'no-hashes' });
      if (f?.size === undefined) blockers.push({ modKey: m.key, code: 'no-size' });
      if (!f?.downloads.length) blockers.push({ modKey: m.key, code: 'no-download' });
      else if (!f.downloads.every(allowedHost)) blockers.push({ modKey: m.key, code: 'download-host' });
    } else {
      if (m.provider !== 'curseforge') blockers.push({ modKey: m.key, code: 'not-curseforge' });
      else if (!/^\d+$/.test(m.projectId ?? '') || !/^\d+$/.test(m.versionId ?? '')) blockers.push({ modKey: m.key, code: 'no-file-id' });
    }
    if (blockers.length === before) included.push(m.key);
  }
  if (!included.length && !blockers.length) blockers.push({ code: 'nothing-to-export' });
  return { format, included, excluded: [...exclude], blockers, overridesOmitted: p.overrides.length, ready: blockers.length === 0 };
}

function allowedHost(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && MRPACK_HOSTS.includes(u.hostname); } catch { return false; }
}

/** An override file to bundle, as it appears in its source archive (`overrides/...`, `client-overrides/...`). */
export interface OverrideFile { root: 'overrides' | 'client-overrides' | 'server-overrides'; path: string; data: Uint8Array }

/**
 * Files that must never travel in a shared pack: accounts, tokens, keys, logs, saves, caches.
 * Returns why, or null when the path is an ordinary pack file (configs, scripts, resource packs).
 */
export function privateOverrideReason(path: string): string | null {
  const p = path.toLowerCase();
  const name = p.split('/').pop() ?? p;
  if (/^(saves|logs|crash-reports|screenshots|backups|\.cache|cache|journeymap\/data|xaero.*\/(world-map|minimap)-?data?)\//.test(p)) return 'world, log or cache data';
  if (/^(launcher_accounts.*|accounts|usercache|usernamecache|launcher_profiles|realms_persistence)\.json$/.test(name)) return 'account data';
  if (/(^|[._-])(token|secret|password|credentials?)([._-]|$)/.test(name) || /\.(pem|key|p12|pfx|jks|keystore)$/.test(name) || name === '.env') return 'credential';
  return null;
}

/** Build the archive for a ready plan. Throws if the plan has blockers. */
export function buildExport(p: ModpackProject, plan: ExportPlan, overrides: OverrideFile[] = []): Uint8Array {
  if (!plan.ready) throw new Error('This export has unresolved blockers.');
  const mods = p.mods.filter((m) => plan.included.includes(m.key));
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));
  if (plan.format === 'mrpack') {
    const dependencies: Record<string, string> = { minecraft: p.minecraftVersion };
    const loaderKey = MRPACK_LOADER[p.loader.kind];
    if (loaderKey) dependencies[loaderKey] = p.loader.version;
    const index = {
      formatVersion: 1, game: 'minecraft', versionId: p.version, name: p.name, ...(p.summary ? { summary: p.summary } : {}),
      files: mods.map((m) => {
        const f = m.file!;
        if (unsafePathReason(f.path)) throw new Error(`Unsafe file path ${f.path}`);
        return { path: f.path, hashes: { sha1: f.sha1, sha512: f.sha512 }, ...(m.env ? { env: m.env } : {}), downloads: f.downloads, fileSize: f.size };
      }),
      dependencies,
    };
    return writeZip([{ path: 'modrinth.index.json', data: json(index) }, ...overrideEntries(overrides, 'mrpack')]);
  }
  const manifest = {
    minecraft: { version: p.minecraftVersion, modLoaders: p.loader.kind === 'vanilla' ? [] : [{ id: `${p.loader.kind}-${p.loader.version}`, primary: true }] },
    manifestType: 'minecraftModpack', manifestVersion: 1, name: p.name, version: p.version, author: p.author,
    files: mods.map((m) => ({ projectID: Number(m.projectId), fileID: Number(m.versionId), required: m.required })),
    overrides: 'overrides',
  };
  return writeZip([{ path: 'manifest.json', data: json(manifest) }, ...overrideEntries(overrides, 'curseforge')]);
}

/** CurseForge has one overrides folder: client files win over common ones, server-only files stay out. */
function overrideEntries(files: OverrideFile[], format: PackFormat): { path: string; data: Uint8Array }[] {
  const out = new Map<string, { path: string; data: Uint8Array }>();
  for (const f of [...files].sort((a, b) => (a.root === 'client-overrides' ? 1 : 0) - (b.root === 'client-overrides' ? 1 : 0))) {
    if (unsafePathReason(f.path) || privateOverrideReason(f.path)) throw new Error(`Refusing to export ${f.path}`);
    if (format === 'curseforge' && f.root === 'server-overrides') continue;
    const path = format === 'mrpack' ? `${f.root}/${f.path}` : `overrides/${f.path}`;
    out.set(path.toLowerCase(), { path, data: f.data });
  }
  return [...out.values()];
}
