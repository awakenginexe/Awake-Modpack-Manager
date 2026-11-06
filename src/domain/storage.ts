/** Manager-local persistence (drafts, pins, preferences). Never used for live instance data. */
const PREFIX = 'awake-mm:';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, quota): drafts then live only for this session.
  }
}
