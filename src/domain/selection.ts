/**
 * Immutable multi-selection over row keys. Every operation returns a new Set so Vue sees one
 * reference change instead of tracking hundreds of entries.
 */
export interface Selection {
  keys: ReadonlySet<string>;
  anchor: string | null;
}

export const emptySelection = (): Selection => ({ keys: new Set(), anchor: null });

export function toggle(sel: Selection, key: string): Selection {
  const keys = new Set(sel.keys);
  if (keys.has(key)) keys.delete(key); else keys.add(key);
  return { keys, anchor: key };
}

/** Shift-click: select everything between the anchor and `key` in the current visible order. */
export function selectRange(sel: Selection, key: string, visibleOrder: readonly string[]): Selection {
  const from = sel.anchor ? visibleOrder.indexOf(sel.anchor) : -1;
  const to = visibleOrder.indexOf(key);
  if (from < 0 || to < 0) return toggle(sel, key);
  const keys = new Set(sel.keys);
  const [lo, hi] = from < to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) keys.add(visibleOrder[i]!);
  return { keys, anchor: sel.anchor };
}

export function selectAll(sel: Selection, visible: readonly string[]): Selection {
  return { keys: new Set([...sel.keys, ...visible]), anchor: sel.anchor };
}

/** Drop keys that no longer exist (after a refresh) so bulk actions never target ghosts. */
export function prune(sel: Selection, existing: ReadonlySet<string>): Selection {
  const keys = new Set([...sel.keys].filter((k) => existing.has(k)));
  return keys.size === sel.keys.size ? sel : { keys, anchor: sel.anchor && existing.has(sel.anchor) ? sel.anchor : null };
}
