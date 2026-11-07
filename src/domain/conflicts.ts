import type { BackendError, DependencyConflict, DependencyEvidence, DependencyResolution } from '../backend/contract';
import type { MessageKey } from '../i18n';

/**
 * Presentation model for dependency conflicts the helper found while preparing a plan. It works only
 * on the helper's structured, schema-validated details (never on its message text), and it offers only
 * the choices the helper said it will accept. No choice is preselected: every decision is the user's.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';
export interface Text { key: MessageKey; params?: Record<string, string | number> }
export interface ConflictOption { id: string; label: Text; resolution: DependencyResolution }
export interface ConflictRow { mod: string; version: string; file: string; requested: Text; evidence: Text & { tone: Tone } }
export interface ConflictView {
  id: string;
  kind: DependencyConflict['kind'];
  badge: Text;
  title: string;
  explanation: Text;
  selected: Text | null;
  rows: ConflictRow[];
  affectedFiles: string[];
  options: ConflictOption[];
  blocked: Text | null;
}

const list = (names: string[]) => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`);
export const conflictId = (c: Pick<DependencyConflict, 'kind' | 'provider' | 'projectId'>) => `${c.kind}|${c.provider}:${c.projectId}`;

function evidenceText(kind: DependencyConflict['kind'], e: DependencyEvidence, selected: string): Text & { tone: Tone } {
  const range = e.declaredRange ?? '*';
  const version = e.selectedModVersion ?? selected;
  if (e.result === 'satisfied') return { key: 'evidenceSatisfied', params: { version, range }, tone: 'ok' };
  if (e.result === 'violated') return kind === 'missing_dependency' ? { key: 'evidenceDeclaredMandatory', params: { range }, tone: 'bad' } : { key: 'evidenceViolated', params: { version, range }, tone: 'bad' };
  if (e.result === 'not_declared') return { key: 'evidenceNotDeclared', tone: kind === 'missing_dependency' ? 'ok' : 'neutral' };
  return { key: 'evidenceUnknown', tone: 'warn' };
}

export function describeConflict(c: DependencyConflict): ConflictView {
  const mods = c.requests.map((r) => r.title);
  const selectedVersion = c.selected?.versionNumber ?? '';
  const badge: Text = { key: ({ version_pin: 'conflictKindPin', missing_dependency: 'conflictKindMissing', incompatible: 'conflictKindIncompatible', loader_bridge: 'conflictKindBridge' } as const)[c.kind] };
  const params = { mods: list(mods), dependency: c.title, selected: selectedVersion };
  const explanation: Text = { key: ({ version_pin: 'conflictExplainPin', missing_dependency: 'conflictExplainMissing', incompatible: 'conflictExplainIncompatible', loader_bridge: 'conflictExplainBridge' } as const)[c.kind], params };
  const options: ConflictOption[] = [];
  if (c.kind === 'version_pin' && c.resolutions.includes('use_version')) {
    for (const v of c.candidates) {
      const keep = v.versionId === c.selected?.versionId;
      options.push({ id: `use:${v.versionId}`, label: { key: keep ? 'conflictKeep' : 'conflictUse', params: { dependency: c.title, version: v.versionNumber } }, resolution: { provider: c.provider, projectId: c.projectId, versionId: v.versionId } });
    }
  }
  if (c.kind === 'missing_dependency' && c.resolutions.includes('proceed_without'))
    options.push({ id: 'without', label: { key: 'conflictWithout', params: { dependency: c.title } }, resolution: { provider: c.provider, projectId: c.projectId, versionId: null } });
  const files = [...c.requests.map((r) => r.fileName), ...(c.selected ? [c.selected.fileName] : [])];
  return {
    id: conflictId(c), kind: c.kind, badge, title: c.title, explanation,
    selected: c.selected ? { key: 'conflictSelected', params: { version: c.selected.versionNumber, file: c.selected.fileName } } : null,
    rows: c.requests.map((r) => ({
      mod: r.title, version: r.versionNumber, file: r.fileName,
      requested: r.requestedVersionNumber ? { key: 'conflictRequestsVersion', params: { version: r.requestedVersionNumber } } : { key: 'conflictRequestsAny' },
      evidence: evidenceText(c.kind, r.evidence, selectedVersion),
    })),
    affectedFiles: [...new Set(files)],
    options,
    blocked: options.length ? null : { key: c.kind === 'loader_bridge' ? 'conflictBlockedBridge' : 'conflictBlocked' },
  };
}

export interface ConflictReport { views: ConflictView[]; truncated: boolean; blocked: boolean; structured: boolean }
/** Everything the conflict panel shows for an error; `structured` is false for helpers without details. */
export function conflictReport(error: BackendError | null | undefined): ConflictReport | null {
  if (!error || error.code !== 'dependency-conflict') return null;
  const views = (error.conflicts ?? []).map(describeConflict);
  return { views, truncated: error.conflictsTruncated, blocked: views.some((v) => v.blocked), structured: !!error.conflicts?.length };
}

/** Resolutions for the chosen options, or null while any resolvable conflict is still undecided. */
export function chosenResolutions(views: ConflictView[], choices: Record<string, string | undefined>): DependencyResolution[] | null {
  const out: DependencyResolution[] = [];
  for (const v of views) {
    if (v.blocked) return null;
    const option = v.options.find((o) => o.id === choices[v.id]);
    if (!option) return null;
    if (!out.some((r) => r.provider === option.resolution.provider && r.projectId === option.resolution.projectId)) out.push(option.resolution);
  }
  return out;
}

/** Merge decisions from an earlier round with new ones (a later attempt can surface further conflicts). */
export function mergeResolutions(previous: DependencyResolution[], next: DependencyResolution[]): DependencyResolution[] {
  const key = (r: DependencyResolution) => `${r.provider}:${r.projectId}`;
  const map = new Map(previous.map((r) => [key(r), r]));
  for (const r of next) map.set(key(r), r);
  return [...map.values()];
}
