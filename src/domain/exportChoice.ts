import type { ExportFileMatch, InstalledMod, ProviderId } from '../backend/contract';

/** How a pack leaves the Manager. An Instance zip carries the mod files; the others name them. */
export type PackTarget = 'mrpack' | 'curseforge' | 'instance';

export const targetProvider = (target: PackTarget): ProviderId | null => (target === 'mrpack' ? 'modrinth' : target === 'curseforge' ? 'curseforge' : null);

export interface ExportCandidate {
  key: string;
  fileName: string;
  name: string;
  source: InstalledMod['source'];
  projectId?: string;
  versionId?: string;
  enabled: boolean;
  modified: boolean;
  dependencies: InstalledMod['dependencies'];
}

export function toCandidates(mods: readonly InstalledMod[]): ExportCandidate[] {
  return mods.filter((m) => !m.kind || m.kind === 'jar').map((m) => ({
    key: m.key, fileName: m.fileName, name: m.name, source: m.source, projectId: m.projectId, versionId: m.installed?.id,
    enabled: m.enabled, modified: !!m.locallyModified, dependencies: m.dependencies,
  }));
}

/** The format can name this exact file on its own provider. */
export function fits(c: ExportCandidate, target: PackTarget): boolean {
  if (target === 'instance') return true;
  return c.source === targetProvider(target) && !!c.projectId && !!c.versionId && !c.modified;
}

export function fitCount(list: readonly ExportCandidate[], target: PackTarget): number {
  return list.filter((c) => fits(c, target)).length;
}

/** A format that holds the whole pack; a mixed pack needs the one that carries its files. */
export function recommend(list: readonly ExportCandidate[]): PackTarget {
  if (list.length && fitCount(list, 'curseforge') === list.length) return 'curseforge';
  if (list.length && fitCount(list, 'mrpack') === list.length) return 'mrpack';
  return 'instance';
}

export type Decision =
  | { kind: 'same-file'; match: ExportFileMatch }
  | { kind: 'replaced'; provider: ProviderId; projectId: string; versionId: string; name: string; versionName: string; missingDependencies: number }
  | { kind: 'leave-out' };

/** Only the listed mods are exported; a mod that is left out must have been decided on. */
export function undecided(list: readonly ExportCandidate[], target: PackTarget, decisions: Readonly<Record<string, Decision>>): ExportCandidate[] {
  return list.filter((c) => !fits(c, target) && !decisions[c.key]);
}

/** Another mod that stays in the pack needs this one. Empty when the provider did not report dependencies. */
export function neededBy(c: ExportCandidate, list: readonly ExportCandidate[], decisions: Readonly<Record<string, Decision>>): ExportCandidate[] {
  if (!c.projectId) return [];
  return list.filter((o) => o.key !== c.key && decisions[o.key]?.kind !== 'leave-out' && o.dependencies?.some((d) => d.kind === 'required' && d.projectId === c.projectId));
}
