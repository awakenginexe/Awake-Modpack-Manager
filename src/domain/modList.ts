import type { InstalledMod, ModSource } from '../backend/contract';

export type StatusFilter = 'all' | 'updates' | 'disabled' | 'pinned' | 'manual' | 'issues';
export type SortKey = 'name' | 'source' | 'installed' | 'status';

export interface ModFilter {
  text: string;
  status: StatusFilter;
  source: ModSource | 'all';
}

export const emptyFilter = (): ModFilter => ({ text: '', status: 'all', source: 'all' });

export const hasUpdate = (m: InstalledMod) => !!m.available && !!m.installed && m.available.id !== m.installed.id;
export const hasIssue = (m: InstalledMod) => (m.dependencies ?? []).some((d) => d.kind === 'required' && (d.state === 'missing' || d.state === 'conflict'));
export const depState = (m: InstalledMod): 'ok' | 'missing' | 'conflict' | 'unknown' => {
  if (!m.dependencies) return 'unknown'; // not reported (e.g. Launcher protocol 1.0)
  const req = m.dependencies.filter((d) => d.kind === 'required' || d.kind === 'incompatible');
  if (req.some((d) => d.state === 'conflict')) return 'conflict';
  if (req.some((d) => d.state === 'missing')) return 'missing';
  if (req.some((d) => d.state === 'unknown')) return 'unknown';
  return 'ok';
};

export function filterMods(mods: readonly InstalledMod[], filter: ModFilter, pinned: ReadonlySet<string>): InstalledMod[] {
  const text = filter.text.trim().toLowerCase();
  return mods.filter((m) => {
    if (filter.source !== 'all' && m.source !== filter.source) return false;
    switch (filter.status) {
      case 'updates': if (!hasUpdate(m)) return false; break;
      case 'disabled': if (m.enabled) return false; break;
      case 'pinned': if (!pinned.has(m.key)) return false; break;
      case 'manual': if (m.source !== 'manual') return false; break;
      case 'issues': if (depState(m) === 'ok') return false; break;
    }
    return !text || m.name.toLowerCase().includes(text) || m.fileName.toLowerCase().includes(text);
  });
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const statusRank = (m: InstalledMod) => (hasIssue(m) ? 0 : hasUpdate(m) ? 1 : !m.enabled ? 2 : 3);

export function sortMods(mods: InstalledMod[], key: SortKey, descending = false): InstalledMod[] {
  const cmp: Record<SortKey, (a: InstalledMod, b: InstalledMod) => number> = {
    name: (a, b) => collator.compare(a.name, b.name),
    source: (a, b) => collator.compare(a.source, b.source) || collator.compare(a.name, b.name),
    installed: (a, b) => collator.compare(a.installed?.name ?? '', b.installed?.name ?? '') || collator.compare(a.name, b.name),
    status: (a, b) => statusRank(a) - statusRank(b) || collator.compare(a.name, b.name),
  };
  const sorted = [...mods].sort(cmp[key]);
  return descending ? sorted.reverse() : sorted;
}
