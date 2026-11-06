/**
 * Read-only import of Modrinth .mrpack and CurseForge modpack ZIPs into a Manager project preview.
 * Nothing is downloaded or extracted; only the manifest is read. Invalid manifests are rejected
 * with a reason; recoverable oddities become warnings the user sees before saving.
 */
import type { LoaderKind } from '../backend/contract';
import { MRPACK_HOSTS, modKey, newProject, type EnvSupport, type ModpackProject, type PackFormat, type ProjectMod } from './project';
import { readEntry, readZip, unsafePathReason, type ByteSource, type ZipEntry } from './zip';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export type ImportWarningCode = 'download-host' | 'unexpected-entry' | 'unknown-loader' | 'optional-mod' | 'duplicate-path';
export interface ImportPreview {
  format: PackFormat;
  project: ModpackProject;
  warnings: { code: ImportWarningCode; detail: string }[];
  /** Archive size and counts for the preview screen. */
  stats: { archiveBytes: number; entries: number; overrideBytes: number };
}

const MANIFEST_MAX = 16 * 2 ** 20;
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA512 = /^[0-9a-f]{128}$/i;
const ENV: readonly EnvSupport[] = ['required', 'optional', 'unsupported'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ImportError(`The manifest has no valid ${what}.`);
  return v;
};

async function readJson(src: ByteSource, e: ZipEntry): Promise<unknown> {
  const bytes = await readEntry(src, e, MANIFEST_MAX);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new ImportError(`${e.path} is not valid JSON.`); }
}

export async function importPack(src: ByteSource, fileName: string): Promise<ImportPreview> {
  const entries = await readZip(src);
  const find = (p: string) => entries.find((e) => e.path === p);
  const mr = find('modrinth.index.json');
  const cf = find('manifest.json');
  const preview = mr ? await importMrpack(src, entries, mr, fileName) : cf ? await importCurseForge(src, entries, cf, fileName) : null;
  if (preview) { preview.stats.archiveBytes = src.size; return preview; }
  throw new ImportError('This archive is not a Modrinth .mrpack or a CurseForge modpack (no modrinth.index.json or manifest.json).');
}

function overridesUnder(entries: ZipEntry[], roots: string[]) {
  return entries.filter((e) => !e.directory && roots.some((r) => e.path.startsWith(`${r}/`))).map((e) => ({ path: e.path, size: e.size }));
}

async function importMrpack(src: ByteSource, entries: ZipEntry[], indexEntry: ZipEntry, fileName: string): Promise<ImportPreview> {
  const index = await readJson(src, indexEntry);
  if (!isObj(index)) throw new ImportError('modrinth.index.json is not an object.');
  if (index.formatVersion !== 1) throw new ImportError(`Unsupported .mrpack formatVersion ${String(index.formatVersion)}.`);
  if (index.game !== 'minecraft') throw new ImportError('This .mrpack is not for Minecraft.');
  const deps = index.dependencies;
  if (!isObj(deps)) throw new ImportError('The .mrpack has no dependencies.');
  const minecraftVersion = str(deps.minecraft, 'Minecraft version');
  const loaders: [string, LoaderKind][] = [['fabric-loader', 'fabric'], ['quilt-loader', 'quilt'], ['forge', 'forge'], ['neoforge', 'neoforge']];
  const present = loaders.filter(([k]) => k in deps);
  if (present.length > 1) throw new ImportError('The .mrpack declares more than one mod loader.');
  const warnings: ImportPreview['warnings'] = [];
  for (const k of Object.keys(deps)) if (k !== 'minecraft' && !loaders.some(([l]) => l === k)) warnings.push({ code: 'unknown-loader', detail: k });
  const [loaderKey, loaderKind] = present[0] ?? ['', 'vanilla' as LoaderKind];
  const loader = { kind: loaderKind, version: loaderKey ? str(deps[loaderKey], `${loaderKey} version`) : '' };

  if (!Array.isArray(index.files)) throw new ImportError('The .mrpack has no file list.');
  const mods: ProjectMod[] = [];
  const paths = new Set<string>();
  index.files.forEach((f, i) => {
    if (!isObj(f)) throw new ImportError(`File #${i + 1} is malformed.`);
    const path = str(f.path, `path for file #${i + 1}`);
    const reason = unsafePathReason(path);
    if (reason) throw new ImportError(`Unsafe file path "${path}": ${reason}.`);
    if (paths.has(path.toLowerCase())) { warnings.push({ code: 'duplicate-path', detail: path }); return; }
    paths.add(path.toLowerCase());
    const hashes = f.hashes;
    if (!isObj(hashes) || typeof hashes.sha1 !== 'string' || !SHA1.test(hashes.sha1) || typeof hashes.sha512 !== 'string' || !SHA512.test(hashes.sha512)) {
      throw new ImportError(`"${path}" has no valid sha1 and sha512 hashes.`);
    }
    if (!Number.isSafeInteger(f.fileSize) || (f.fileSize as number) < 0) throw new ImportError(`"${path}" has no valid fileSize.`);
    if (!Array.isArray(f.downloads) || !f.downloads.length || !f.downloads.every((u) => typeof u === 'string' && /^https:\/\//.test(u))) {
      throw new ImportError(`"${path}" has no https download URL.`);
    }
    const downloads = f.downloads as string[];
    for (const u of downloads) if (!MRPACK_HOSTS.includes(new URL(u).hostname)) warnings.push({ code: 'download-host', detail: u });
    let env: ProjectMod['env'];
    if (f.env !== undefined) {
      if (!isObj(f.env) || !ENV.includes(f.env.client as EnvSupport) || !ENV.includes(f.env.server as EnvSupport)) throw new ImportError(`"${path}" has an invalid env.`);
      env = { client: f.env.client as EnvSupport, server: f.env.server as EnvSupport };
    }
    // Modrinth CDN URLs name the project and version: cdn.modrinth.com/data/<project>/versions/<version>/<file>
    const cdn = downloads.map((u) => /^https:\/\/cdn\.modrinth\.com\/data\/([A-Za-z0-9]+)\/versions\/([A-Za-z0-9]+)\//.exec(u)).find(Boolean);
    const file = { path, size: f.fileSize as number, sha1: (hashes.sha1 as string).toLowerCase(), sha512: (hashes.sha512 as string).toLowerCase(), downloads };
    const name = path.split('/').pop()!.replace(/\.(jar|zip)$/i, '');
    mods.push({
      key: cdn ? modKey('modrinth', cdn[1]!) : modKey('manual', path), name,
      provider: cdn ? 'modrinth' : 'manual', projectId: cdn?.[1], versionId: cdn?.[2], file, env,
      required: env?.client !== 'optional', pinned: false, verified: true, origin: 'import',
    });
  });
  const roots = ['overrides', 'client-overrides', 'server-overrides'];
  const overrides = overridesUnder(entries, roots);
  for (const e of entries) {
    if (e === indexEntry || e.directory || roots.some((r) => e.path.startsWith(`${r}/`))) continue;
    warnings.push({ code: 'unexpected-entry', detail: e.path });
  }
  const project = newProject({
    name: str(index.name, 'name'), version: typeof index.versionId === 'string' ? index.versionId : '1.0.0',
    summary: typeof index.summary === 'string' ? index.summary : '', minecraftVersion, loader, mods, overrides,
    source: { kind: 'import', format: 'mrpack', fileName },
  });
  return { format: 'mrpack', project, warnings, stats: { archiveBytes: 0, entries: entries.length, overrideBytes: overrides.reduce((n, o) => n + o.size, 0) } };
}

async function importCurseForge(src: ByteSource, entries: ZipEntry[], manifestEntry: ZipEntry, fileName: string): Promise<ImportPreview> {
  const m = await readJson(src, manifestEntry);
  if (!isObj(m)) throw new ImportError('manifest.json is not an object.');
  if (m.manifestType !== 'minecraftModpack') throw new ImportError('manifest.json is not a CurseForge Minecraft modpack manifest.');
  if (m.manifestVersion !== 1) throw new ImportError(`Unsupported CurseForge manifestVersion ${String(m.manifestVersion)}.`);
  const mc = m.minecraft;
  if (!isObj(mc)) throw new ImportError('manifest.json has no minecraft section.');
  const minecraftVersion = str(mc.version, 'Minecraft version');
  const warnings: ImportPreview['warnings'] = [];
  let loader = { kind: 'vanilla' as LoaderKind, version: '' };
  const modLoaders = Array.isArray(mc.modLoaders) ? mc.modLoaders : [];
  const primary = modLoaders.find((l) => isObj(l) && l.primary === true) ?? modLoaders[0];
  if (primary !== undefined) {
    const id = isObj(primary) && typeof primary.id === 'string' ? primary.id : '';
    const match = /^(forge|neoforge|fabric|quilt)-(.+)$/.exec(id);
    if (match) loader = { kind: match[1] as LoaderKind, version: match[2]! };
    else warnings.push({ code: 'unknown-loader', detail: id || '(missing id)' });
  }
  if (!Array.isArray(m.files)) throw new ImportError('manifest.json has no file list.');
  const seen = new Set<number>();
  const mods: ProjectMod[] = [];
  m.files.forEach((f, i) => {
    if (!isObj(f) || !Number.isSafeInteger(f.projectID) || !Number.isSafeInteger(f.fileID) || (f.projectID as number) <= 0 || (f.fileID as number) <= 0) {
      throw new ImportError(`File #${i + 1} has no valid projectID and fileID.`);
    }
    const projectID = f.projectID as number;
    if (seen.has(projectID)) { warnings.push({ code: 'duplicate-path', detail: `CurseForge project ${projectID}` }); return; }
    seen.add(projectID);
    const required = f.required !== false;
    if (!required) warnings.push({ code: 'optional-mod', detail: `CurseForge project ${projectID}` });
    mods.push({
      key: modKey('curseforge', String(projectID)), name: `CurseForge project ${projectID}`, provider: 'curseforge',
      projectId: String(projectID), versionId: String(f.fileID), required, pinned: false, verified: true, origin: 'import',
    });
  });
  const root = typeof m.overrides === 'string' && m.overrides ? m.overrides : 'overrides';
  if (unsafePathReason(root)) throw new ImportError(`Unsafe overrides folder "${root}".`);
  const overrides = overridesUnder(entries, [root]);
  for (const e of entries) {
    if (e === manifestEntry || e.directory || e.path.startsWith(`${root}/`) || e.path === 'modlist.html') continue;
    warnings.push({ code: 'unexpected-entry', detail: e.path });
  }
  const project = newProject({
    name: str(m.name, 'name'), version: typeof m.version === 'string' ? m.version : '1.0.0', author: typeof m.author === 'string' ? m.author : '',
    minecraftVersion, loader, mods, overrides, source: { kind: 'import', format: 'curseforge', fileName },
  });
  return { format: 'curseforge', project, warnings, stats: { archiveBytes: 0, entries: entries.length, overrideBytes: overrides.reduce((n, o) => n + o.size, 0) } };
}
