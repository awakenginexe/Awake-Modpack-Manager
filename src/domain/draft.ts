import type { Draft, DraftChange, InstalledMod } from '../backend/contract';

export const newDraft = (instanceId: string, baseRevision: string): Draft => ({ instanceId, baseRevision, changes: [], pinnedKeys: [] });

const keyOf = (c: DraftChange) => (c.kind === 'install' ? `install:${c.projectId}` : c.modKey);
/** Content changes (update/remove) and state changes (enable/disable) are tracked separately per mod. */
const slot = (c: DraftChange) => (c.kind === 'enable' || c.kind === 'disable' ? 'state' : c.kind === 'policy' ? 'policy' : 'content');

/** Add a change, replacing any earlier change it supersedes. Removing a mod drops its other changes. */
export function addChange(draft: Draft, change: DraftChange): Draft {
  const key = keyOf(change);
  const changes = draft.changes.filter((c) => !(keyOf(c) === key && (change.kind === 'remove' || c.kind === 'remove' || slot(c) === slot(change))));
  return { ...draft, changes: [...changes, change] };
}

export function addChanges(draft: Draft, changes: DraftChange[]): Draft {
  return changes.reduce(addChange, draft);
}

export function removeChange(draft: Draft, change: DraftChange): Draft {
  return { ...draft, changes: draft.changes.filter((c) => c !== change) };
}

export function changeFor(draft: Draft, modKey: string): DraftChange[] {
  return draft.changes.filter((c) => keyOf(c) === modKey || keyOf(c) === `install:${modKey}`);
}

export const isStale = (draft: Draft, currentRevision: string) => draft.baseRevision !== currentRevision;

/**
 * Move a stale draft onto the current revision: keep changes whose targets still exist and
 * drop no-ops. The caller must send the user back through review; this never auto-applies.
 */
export function rebase(draft: Draft, revision: string, mods: readonly InstalledMod[]): { draft: Draft; dropped: DraftChange[] } {
  const byKey = new Map(mods.map((m) => [m.key, m]));
  const installed = new Set(mods.map((m) => m.projectId).filter(Boolean));
  const kept: DraftChange[] = [];
  const dropped: DraftChange[] = [];
  for (const c of draft.changes) {
    const mod = c.kind === 'install' ? undefined : byKey.get(c.modKey);
    const ok = c.kind === 'install'
      ? !installed.has(c.projectId)
      : !!mod && (c.kind === 'remove' || (c.kind === 'update' && mod.installed?.id !== c.targetVersionId) || (c.kind === 'enable' && !mod.enabled) || (c.kind === 'disable' && mod.enabled)
        || (c.kind === 'policy' && ((!!mod.updateLocked && !mod.updateExcluded) !== c.pinned || !!mod.updateExcluded !== c.excluded)));
    (ok ? kept : dropped).push(c);
  }
  return { draft: { ...draft, baseRevision: revision, changes: kept }, dropped };
}
