import { computed, ref, shallowRef } from 'vue';
import { importPack, type ImportPreview } from '../domain/packFormats';
import { buildExport, modKey, newProject, planExport, type ModpackProject, type OverrideFile, type PackFormat, type ProjectMod, type ProjectProvider } from '../domain/project';
import { load, save } from '../domain/storage';
import { blobSource } from '../domain/zip';

/** Where the project store lives: the Manager's own file (desktop) or browser storage. */
export interface ProjectPersistence {
  kind: 'file' | 'local';
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export const STORE_FORMAT = 'awake-mm-projects';
export const STORE_VERSION = 1;

export interface ParsedStore { projects: ModpackProject[]; version: number }

/**
 * Accepts the current format and the original (version 0: a bare array in browser storage).
 * Throws on anything else, so an unreadable store is never overwritten.
 */
export function parseStore(text: string): ParsedStore {
  const v: unknown = JSON.parse(text);
  if (Array.isArray(v)) return { projects: v as ModpackProject[], version: 0 };
  if (!v || typeof v !== 'object') throw new Error('The project store is not a JSON object.');
  const o = v as { format?: unknown; schemaVersion?: unknown; projects?: unknown };
  if (o.format !== STORE_FORMAT || typeof o.schemaVersion !== 'number' || !Array.isArray(o.projects)) throw new Error('This is not an Awake Modpack Manager project store.');
  return { projects: o.projects as ModpackProject[], version: o.schemaVersion };
}

export const serializeStore = (projects: ModpackProject[]) => JSON.stringify({ format: STORE_FORMAT, schemaVersion: STORE_VERSION, projects });

/** Browser storage persistence (also the test double). */
export function localPersistence(storage: Pick<Storage, 'getItem' | 'setItem'> | null, key: string): ProjectPersistence {
  return {
    kind: 'local',
    read: async () => storage?.getItem(key) ?? null,
    write: async (text) => { storage?.setItem(key, text); },
  };
}

/** The desktop host's atomic file store: %LOCALAPPDATA%\AwakeModpackManager\projects\projects.json. */
export function filePersistence(): ProjectPersistence {
  const invoke = async <T>(cmd: string, args: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
  return { kind: 'file', read: () => invoke<string | null>('projects_read', {}), write: (json) => invoke('projects_write', { json }) };
}

/** Projects saved by Manager builds before the versioned store, in browser storage. */
export const LEGACY_KEY = 'awake-mm:projects';

/**
 * Manager-owned modpack projects (drafts). Nothing here creates, reads or writes a Minecraft
 * instance. A failed save is reported, never swallowed. A store written by a newer Manager, or one
 * that cannot be read, is shown read-only and never overwritten. Projects found only in the old
 * location are used where they are until the user moves them; the old copy is never deleted.
 */
export function createProjectStore(primary: ProjectPersistence, legacy: ProjectPersistence | null = null) {
  const projects = shallowRef<ModpackProject[]>([]);
  const selectedId = ref<string | null>(load('project', null));
  const saveError = ref<string | null>(null);
  /** Why the store is read-only (newer format, unreadable file), or null. */
  const readOnly = ref<string | null>(null);
  /** Projects are being used from the old location; `moveLegacy` copies them to the new one. */
  const legacyPending = ref(false);
  const loaded = ref(false);
  const selected = computed(() => projects.value.find((p) => p.id === selectedId.value) ?? null);
  let target: ProjectPersistence = primary;
  let writes: Promise<void> = Promise.resolve();

  const ready = (async () => {
    try {
      const text = await primary.read();
      if (text !== null) {
        const parsed = parseStore(text);
        projects.value = parsed.projects;
        if (parsed.version > STORE_VERSION) readOnly.value = 'newer';
        return;
      }
      const old = legacy ? await legacy.read() : null;
      if (old !== null && legacy) {
        const parsed = parseStore(old);
        if (parsed.projects.length) { projects.value = parsed.projects; target = legacy; legacyPending.value = true; }
      }
    } catch (e) {
      readOnly.value = 'unreadable';
      saveError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loaded.value = true;
    }
  })();

  const text = (list: ModpackProject[]) => (target === legacy ? JSON.stringify(list) : serializeStore(list));
  function persist(list: ModpackProject[]) {
    const body = text(list);
    const to = target;
    writes = writes.then(() => to.write(body)).then(
      () => { saveError.value = null; },
      // Quota, a locked file, a full disk: keep the change on screen, but say it is not saved.
      (e) => { saveError.value = e instanceof Error ? e.message : String(e); },
    );
    return writes;
  }
  function commit(next: ModpackProject[]) {
    if (readOnly.value) { saveError.value = readOnly.value === 'newer' ? 'These projects were saved by a newer Awake Modpack Manager. Update the Manager to change them.' : saveError.value; return; }
    projects.value = next;
    void persist(next);
  }
  function select(id: string | null) {
    selectedId.value = id;
    save('project', id);
  }
  function update(id: string, change: (p: ModpackProject) => ModpackProject) {
    commit(projects.value.map((p) => (p.id === id ? { ...change(p), updatedAt: new Date().toISOString() } : p)));
  }
  const mapMods = (id: string, keys: ReadonlySet<string>, f: (m: ProjectMod) => ProjectMod) =>
    update(id, (p) => ({ ...p, mods: p.mods.map((m) => (keys.has(m.key) ? f(m) : m)) }));

  /** Override bytes taken from a Manager workspace for a project's next export (not persisted). */
  const attached = new Map<string, { source: string; files: OverrideFile[] }>();

  return {
    projects, selected, selectedId, saveError, readOnly, legacyPending, loaded, ready,
    // shortcut: kept in memory only; after a restart the user re-runs the workspace export or picks the pack archive.
    attachOverrides: (id: string, source: string, files: OverrideFile[]) => attached.set(id, { source, files }),
    attachedOverrides: (id: string) => attached.get(id),
    /** Wait for pending writes (tests, before closing). */
    flush: () => writes,
    select,

    /** Copy projects from the old location into the versioned store. The old copy stays as it was. */
    async moveLegacy() {
      if (!legacyPending.value) return;
      try {
        await primary.write(serializeStore(projects.value));
        target = primary;
        legacyPending.value = false;
        saveError.value = null;
      } catch (e) {
        saveError.value = e instanceof Error ? e.message : String(e);
      }
    },

    create(init: Parameters<typeof newProject>[0]) {
      const p = newProject(init);
      commit([p, ...projects.value]);
      select(p.id);
      return p;
    },

    remove(id: string) {
      commit(projects.value.filter((p) => p.id !== id));
      if (selectedId.value === id) select(projects.value[0]?.id ?? null);
    },

    rename(id: string, fields: Partial<Pick<ModpackProject, 'name' | 'version' | 'summary' | 'author' | 'minecraftVersion' | 'loader'>>) {
      update(id, (p) => ({ ...p, ...fields }));
    },

    /** Read an archive and return a preview. Nothing is saved until `adopt`. */
    preview: (file: Blob, fileName: string): Promise<ImportPreview> => importPack(blobSource(file), fileName),

    adopt(preview: ImportPreview) {
      commit([preview.project, ...projects.value]);
      select(preview.project.id);
    },

    /** A project built elsewhere in the Manager (e.g. from a workspace snapshot). */
    addProject(p: ModpackProject) {
      commit([p, ...projects.value]);
      select(p.id);
    },

    /** A mod the user plans to add, typed by provider ID. It stays unverified until a provider confirms it. */
    addPlanned(id: string, mod: { provider: ProjectProvider; projectId: string; versionId?: string; name?: string }) {
      const projectId = mod.projectId.trim();
      const key = modKey(mod.provider, projectId);
      update(id, (p) => p.mods.some((m) => m.key === key) ? p : ({
        ...p,
        mods: [...p.mods, {
          key, name: mod.name?.trim() || projectId, provider: mod.provider, projectId,
          versionId: mod.versionId?.trim() || undefined, required: true, pinned: !!mod.versionId?.trim(), verified: false, origin: 'planned',
        }],
      }));
    },

    removeMods: (id: string, keys: ReadonlySet<string>) => update(id, (p) => ({ ...p, mods: p.mods.filter((m) => !keys.has(m.key)) })),
    setPinned: (id: string, keys: ReadonlySet<string>, pinned: boolean) => mapMods(id, keys, (m) => ({ ...m, pinned })),
    setRequired: (id: string, keys: ReadonlySet<string>, required: boolean) => mapMods(id, keys, (m) => ({ ...m, required })),

    /** Choosing another version invalidates the verified file data, which belonged to the old version. */
    setVersion(id: string, key: string, versionId: string) {
      mapMods(id, new Set([key]), (m) => (m.versionId === versionId ? m : { ...m, versionId: versionId.trim() || undefined, versionName: undefined, file: undefined, verified: false, pinned: true }));
    },

    plan: (p: ModpackProject, format: PackFormat, exclude: ReadonlySet<string>) => planExport(p, format, exclude),

    /** Build the archive for a ready plan; the caller saves it where the user chooses. */
    exportArchive(p: ModpackProject, format: PackFormat, exclude: ReadonlySet<string>, overrides: OverrideFile[] = []): Blob {
      return new Blob([buildExport(p, planExport(p, format, exclude), overrides) as BlobPart], { type: format === 'mrpack' ? 'application/x-modrinth-modpack+zip' : 'application/zip' });
    },
  };
}

export type ProjectStore = ReturnType<typeof createProjectStore>;
let store: ProjectStore | null = null;
/** One store per window: the host's file store in the desktop app, browser storage otherwise. */
export const useProjects = () => (store ??= (() => {
  const local = typeof localStorage === 'undefined' ? null : localStorage;
  const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  return createProjectStore(desktop ? filePersistence() : localPersistence(local, 'awake-mm:projects.v1'), localPersistence(local, LEGACY_KEY));
})());
