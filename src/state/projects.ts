import { computed, ref, shallowRef } from 'vue';
import { importPack, type ImportPreview } from '../domain/packFormats';
import { buildExport, modKey, newProject, planExport, type ModpackProject, type PackFormat, type ProjectMod, type ProjectProvider } from '../domain/project';
import { load, save } from '../domain/storage';
import { blobSource } from '../domain/zip';

const KEY = 'awake-mm:projects';

/**
 * Manager-owned modpack projects (drafts). Stored in the Manager's own storage only; nothing here
 * creates, reads or writes a Minecraft instance. A failed save is reported, never swallowed.
 */
export function createProjectStore(storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
  const projects = shallowRef<ModpackProject[]>(read());
  const selectedId = ref<string | null>(load('project', null));
  const saveError = ref<string | null>(null);
  const selected = computed(() => projects.value.find((p) => p.id === selectedId.value) ?? null);

  function read(): ModpackProject[] {
    try { return JSON.parse(storage?.getItem(KEY) ?? '[]') as ModpackProject[]; } catch { return []; }
  }
  function commit(next: ModpackProject[]) {
    try {
      storage?.setItem(KEY, JSON.stringify(next));
      saveError.value = null;
    } catch (e) {
      // Quota or blocked storage: keep the change on screen, but tell the user it is not saved.
      saveError.value = e instanceof Error ? e.message : String(e);
    }
    projects.value = next;
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

  return {
    projects, selected, selectedId, saveError,
    select,

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
    exportArchive(p: ModpackProject, format: PackFormat, exclude: ReadonlySet<string>): Blob {
      return new Blob([buildExport(p, planExport(p, format, exclude)) as BlobPart], { type: format === 'mrpack' ? 'application/x-modrinth-modpack+zip' : 'application/zip' });
    },
  };
}

export type ProjectStore = ReturnType<typeof createProjectStore>;
let store: ProjectStore | null = null;
/** One store per window. */
export const useProjects = () => (store ??= createProjectStore());
