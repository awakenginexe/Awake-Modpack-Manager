<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { ArrowLeft, ChevronRight, CircleAlert, Code, Copy, FileCode, FileCog, FilePlus, FileText, Folder, FolderOpen, Image, Lock, PackageCheck, Pencil, RefreshCw, Save, Search, Settings2, Sun, Trash2, TriangleAlert } from '@lucide/vue';
import { confirmDialog, copyText, openMenu, separator, toast } from '../ui/desktop';
import type { ContentArea, ContentEntry } from '../backend/contract';
import { formatDate, t, type MessageKey } from '../i18n';
import { filesArea, leaveGuard } from '../state/nav';
import { asError, useSession } from '../state/session';
import { formatBytes } from '../ui/labels';
import type { ViewId } from '../App.vue';

const emit = defineEmits<{ navigate: [ViewId] }>();
const session = useSession();
const areas: { id: ContentArea; label: MessageKey }[] = [
  { id: 'config', label: 'areaConfig' }, { id: 'defaultconfigs', label: 'areaDefaultconfigs' }, { id: 'kubejs', label: 'areaKubejs' },
  { id: 'scripts', label: 'areaScripts' }, { id: 'resourcepacks', label: 'areaResourcepacks' }, { id: 'shaderpacks', label: 'areaShaderpacks' },
];
const areaIcon: Record<ContentArea, Component> = { config: Settings2, defaultconfigs: FileCog, kubejs: Code, scripts: FileCode, resourcepacks: Image, shaderpacks: Sun };
const area = filesArea;
/** The folder on screen, relative to the area ('' is its top). */
const folder = ref('');
const entries = ref<ContentEntry[]>([]);
const filter = ref('');
const loading = ref(false);
const error = ref('');
let listing = 0;

const id = computed(() => session.state.instanceId);
const canRead = computed(() => session.can('files.read'));
const canWrite = computed(() => canRead.value && session.can('files.write') && !!session.backend.writeContentText);
/** A Launcher instance that is not managed here yet: its files open once it is. */
const needsManage = computed(() => !canRead.value && session.source.value === 'launcher' && !session.instance.value?.shared);
const running = computed(() => session.instance.value?.status === 'running');
/** Only the Launcher's own export uses a hand-picked file list; Manager exports take the folders whole. */
const picksExport = computed(() => session.instanceSource.value !== 'helper');
const included = computed(() => new Set(id.value ? session.exportIncludes.value[id.value] ?? [] : []));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const crumbs = computed(() => folder.value.split('/').filter(Boolean).map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') })));
const shown = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  return needle ? entries.value.filter((e) => nameOf(e.path).toLowerCase().includes(needle)) : entries.value;
});

async function load() {
  if (!id.value || !canRead.value) { entries.value = []; return; }
  const request = ++listing;
  loading.value = true;
  error.value = '';
  try {
    const list = await session.backend.listContent(id.value, area.value, folder.value);
    if (request === listing) entries.value = list;
  } catch (e) {
    if (request === listing) { error.value = asError(e).message; entries.value = []; }
  } finally {
    if (request === listing) loading.value = false;
  }
}
function setIncluded(path: string, on: boolean) {
  if (!id.value) return;
  const set = new Set(included.value);
  if (on) set.add(path); else set.delete(path);
  session.exportIncludes.value = { ...session.exportIncludes.value, [id.value]: [...set] };
}

/* ----- the editor: one text file at a time ----- */

const editing = ref<{ area: ContentArea; path: string; modifiedMs: number; original: string } | null>(null);
const draft = ref('');
const saving = ref(false);
const saveError = ref('');
const opening = ref('');
const editor = ref<HTMLTextAreaElement | null>(null);
/** The picture on screen instead of the editor. Pictures are only shown, never changed. */
const viewing = ref<{ area: ContentArea; path: string; dataUrl: string; sizeBytes: number } | null>(null);
const pixels = ref<{ width: number; height: number } | null>(null);
const broken = ref(false);
// SVG is text: it opens in the editor like any other.
const isImage = (path: string) => /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path);
/** Textures are tiny: show them enlarged, in whole steps so every pixel stays square. */
const zoom = computed(() => {
  const longest = pixels.value ? Math.max(pixels.value.width, pixels.value.height) : 0;
  return longest > 0 && longest <= 256 ? Math.max(1, Math.min(8, Math.floor(384 / longest))) : 1;
});
function imageLoaded(e: Event) {
  const img = e.target as HTMLImageElement;
  pixels.value = { width: img.naturalWidth, height: img.naturalHeight };
}
// A text box always hands back plain line breaks, so compare like with like.
const dirty = computed(() => !!editing.value && draft.value !== editing.value.original.replace(/\r\n/g, '\n'));

/** True when there is nothing unsaved, or the user agreed to lose it. */
async function leaveEditor(): Promise<boolean> {
  viewing.value = null;
  if (!editing.value) return true;
  if (dirty.value && !await confirmDialog({ title: t('filesDiscardTitle', { name: nameOf(editing.value.path) }), body: t('filesDiscardBody'), confirm: t('filesDiscard'), cancel: t('cancel'), danger: true })) return false;
  editing.value = null;
  saveError.value = '';
  return true;
}
// Going to another screen asks the same question.
onMounted(() => { leaveGuard.value = leaveEditor; });
onBeforeUnmount(() => { if (leaveGuard.value === leaveEditor) leaveGuard.value = null; });
async function openFile(e: ContentEntry) {
  if (!id.value || opening.value) return;
  const asImage = isImage(e.path) && !!session.backend.readContentImage;
  if (!asImage && !session.backend.readContentText) return;
  opening.value = e.path;
  try {
    if (asImage) {
      const image = await session.backend.readContentImage!(id.value, area.value, e.path);
      pixels.value = null;
      broken.value = false;
      viewing.value = { area: area.value, path: e.path, ...image };
      return;
    }
    if (!session.backend.readContentText) return;
    const file = await session.backend.readContentText(id.value, area.value, e.path);
    editing.value = { area: area.value, path: e.path, modifiedMs: file.modifiedMs, original: file.text };
    draft.value = file.text.replace(/\r\n/g, '\n');
    saveError.value = '';
    void nextTick(() => editor.value?.focus());
  } catch (err) {
    toast(asError(err).message, ['not-text', 'not-image', 'too-large'].includes(asError(err).detail ?? '') ? 'info' : 'error');
  } finally {
    opening.value = '';
  }
}
async function save() {
  const file = editing.value;
  if (!file || !id.value || !dirty.value || saving.value || !session.backend.writeContentText) return;
  saving.value = true;
  saveError.value = '';
  try {
    const modifiedMs = await session.backend.writeContentText(id.value, file.area, file.path, draft.value, file.modifiedMs);
    editing.value = { ...file, modifiedMs, original: draft.value };
    toast(t('filesSaved', { name: nameOf(file.path) }), 'ok');
  } catch (e) {
    saveError.value = asError(e).message;
  } finally {
    saving.value = false;
  }
}
/** After a refused save: read the file as it is now, dropping what was typed. */
async function reopen() {
  const file = editing.value;
  if (!file || !await leaveEditor()) return;
  await openFile({ path: file.path, kind: 'file' });
}
function editorKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
}

/* ----- moving around ----- */

async function go(next: string) {
  if (!await leaveEditor()) return;
  filter.value = '';
  if (folder.value === next) void load(); else folder.value = next;
}
async function pickArea(next: ContentArea) {
  if (next === area.value) { void go(''); return; }
  if (!await leaveEditor()) return;
  filter.value = '';
  folder.value = '';
  area.value = next;
}
watch([area, folder, canRead], load, { immediate: true });
function activate(e: ContentEntry) {
  if (e.kind === 'directory') void go(e.path); else void openFile(e);
}

/* ----- changing things ----- */

async function addFiles() {
  if (!id.value || !session.backend.addContentFiles) return;
  try {
    const result = await session.backend.addContentFiles(id.value, area.value, folder.value);
    if (!result) return;
    if (result.added.length) toast(t('filesAdded', { count: result.added.length }), 'ok');
    if (result.skipped.length) toast(t('filesAddSkipped', { names: result.skipped.join(', ') }), 'warn');
    await load();
  } catch (e) {
    toast(asError(e).message, 'error');
  }
}
async function recycle(e: ContentEntry) {
  const name = nameOf(e.path);
  if (!id.value || !await confirmDialog({ title: t('recycleTitle', { name }), body: t('recycleBody'), confirm: t('recycleConfirm'), cancel: t('cancel'), danger: true })) return;
  try { await session.backend.recycleContent!(id.value, area.value, [e.path]); toast(t('recycled', { name }), 'ok'); await load(); } catch (err) { toast(asError(err).message, 'error'); }
}
const openFolder = () => session.backend.openFolder?.(id.value!, area.value, folder.value).catch((e) => toast(asError(e).message, 'error'));
function entryMenu(event: MouseEvent, e: ContentEntry) {
  openMenu(event, [
    e.kind === 'directory' ? { label: t('filesOpen'), icon: FolderOpen, action: () => go(e.path) } : isImage(e.path) && session.backend.readContentImage ? { label: t('filesView'), icon: Image, action: () => openFile(e) } : { label: t('filesEdit'), icon: Pencil, disabled: !session.backend.readContentText, action: () => openFile(e) },
    { label: t('copyPath'), icon: Copy, action: () => copyText(`${area.value}/${e.path}`) },
    separator,
    { label: t('recycleAction'), icon: Trash2, danger: true, disabled: !canWrite.value || !session.backend.recycleContent, action: () => recycle(e) },
  ]);
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('filesTitle') }}</h1>
        <p>{{ t('filesSubtitle') }}</p>
      </div>
      <span v-if="picksExport" class="chip"><PackageCheck :size="15" />{{ t('filesIncluded', { count: included.size }) }}</span>
    </header>
    <div v-if="needsManage" class="notice">
      <Lock :size="18" /><span class="grow">{{ t('filesNeedManage') }}</span>
      <button class="btn btn-small" type="button" @click="emit('navigate', 'mods')">{{ t('navMods') }}</button>
    </div>
    <div v-else-if="!canRead" class="notice warn"><TriangleAlert :size="18" />{{ t('capabilityMissing') }}</div>
    <p v-else-if="running" class="notice warn small"><TriangleAlert :size="18" />{{ t('filesRunning') }}</p>

    <div class="columns">
      <nav class="areas card" :aria-label="t('filesTitle')">
        <button v-for="a in areas" :key="a.id" type="button" class="area" :class="{ active: area === a.id }" :aria-current="area === a.id ? 'true' : undefined" @click="pickArea(a.id)">
          <component :is="areaIcon[a.id]" :size="17" />{{ t(a.label) }}
        </button>
      </nav>

      <section v-if="editing" class="card panel editor" :aria-label="t('filesEdit')">
        <div class="panel-head">
          <button class="icon-btn" type="button" :aria-label="t('filesBack')" :title="t('filesBack')" @click="leaveEditor"><ArrowLeft :size="18" /></button>
          <h2 class="panel-title file-title"><FileText :size="18" /><span class="path" :title="`${editing.area}/${editing.path}`">{{ editing.path }}</span></h2>
          <span v-if="dirty" class="badge warn">{{ t('filesUnsaved') }}</span>
          <button class="btn btn-primary btn-small" type="button" :disabled="!dirty || saving || !canWrite" @click="save"><Save :size="15" />{{ t('save') }}</button>
        </div>
        <div v-if="saveError" class="notice error small" role="alert">
          <CircleAlert :size="18" /><span class="grow">{{ saveError }}</span>
          <button class="btn btn-small" type="button" @click="reopen">{{ t('filesReload') }}</button>
        </div>
        <textarea
          ref="editor" v-model="draft" class="code" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"
          :readonly="!canWrite" :aria-label="editing.path" @keydown="editorKey"
        ></textarea>
      </section>

      <section v-else-if="viewing" class="card panel viewer" :aria-label="t('filesImage')">
        <div class="panel-head">
          <button class="icon-btn" type="button" :aria-label="t('filesBack')" :title="t('filesBack')" @click="leaveEditor"><ArrowLeft :size="18" /></button>
          <h2 class="panel-title file-title"><Image :size="18" /><span class="path" :title="`${viewing.area}/${viewing.path}`">{{ viewing.path }}</span></h2>
          <span class="muted small count"><template v-if="pixels">{{ pixels.width }} × {{ pixels.height }} · </template>{{ formatBytes(viewing.sizeBytes) }}</span>
        </div>
        <p v-if="broken" class="notice error" role="alert"><CircleAlert :size="18" />{{ t('filesImageBroken') }}</p>
        <div v-else class="stage">
          <img
            :src="viewing.dataUrl" :alt="nameOf(viewing.path)" :class="{ pixelated: zoom > 1 }" draggable="false"
            :style="zoom > 1 && pixels ? { width: `${pixels.width * zoom}px` } : undefined" @load="imageLoaded" @error="broken = true"
          />
        </div>
      </section>

      <section v-else class="card panel">
        <div class="panel-head">
          <nav class="crumbs" :aria-label="t('filesFolder')">
            <button type="button" class="crumb" :class="{ here: !crumbs.length }" @click="go('')"><component :is="areaIcon[area]" :size="17" />{{ t(areas.find((a) => a.id === area)!.label) }}</button>
            <template v-for="(c, i) in crumbs" :key="c.path">
              <ChevronRight :size="15" class="muted" aria-hidden="true" />
              <button type="button" class="crumb" :class="{ here: i === crumbs.length - 1 }" @click="go(c.path)">{{ c.name }}</button>
            </template>
          </nav>
          <span class="muted small count">{{ t('fileCount', { count: shown.length }) }}</span>
        </div>
        <div class="toolbar">
          <label class="search-field">
            <Search :size="16" />
            <input v-model="filter" class="input" type="search" :placeholder="t('filesFilter')" :aria-label="t('filesFilter')" />
          </label>
          <button class="btn btn-small" type="button" :disabled="!canRead || loading" @click="load"><RefreshCw :size="15" />{{ t('refresh') }}</button>
          <button v-if="session.backend.addContentFiles" class="btn btn-small" type="button" :disabled="!canWrite" @click="addFiles"><FilePlus :size="15" />{{ t('filesAdd') }}</button>
          <button v-if="session.backend.openFolder" class="btn btn-small" type="button" :disabled="!canRead" @click="openFolder"><FolderOpen :size="15" />{{ t('openFolder') }}</button>
        </div>
        <div v-if="loading && !entries.length" class="rows" aria-busy="true"><span v-for="n in 6" :key="n" class="skeleton" style="height: 36px"></span></div>
        <p v-else-if="error" class="notice error" role="alert"><CircleAlert :size="18" />{{ error }}</p>
        <div v-else-if="!shown.length" class="empty"><span class="empty-icon"><FolderOpen :size="26" /></span><p>{{ entries.length ? t('filesNoMatch') : t('filesEmpty') }}</p></div>
        <ul v-else class="entries">
          <li v-for="(e, i) in shown" :key="e.path" class="rise" :class="{ on: included.has(`${area}/${e.path}`), busy: opening === e.path }" :style="{ '--i': i % 30 }" @contextmenu="entryMenu($event, e)">
            <button type="button" class="open" :title="e.kind === 'directory' ? t('filesOpen') : isImage(e.path) ? t('filesView') : t('filesEdit')" @click="activate(e)">
              <component :is="e.kind === 'directory' ? Folder : isImage(e.path) ? Image : FileText" :size="16" :class="e.kind === 'directory' ? 'folder-icon' : 'muted'" />
              <span class="path">{{ nameOf(e.path) }}</span>
            </button>
            <span v-if="e.modifiedAt" class="muted small when">{{ formatDate(e.modifiedAt) }}</span>
            <span class="muted small size">{{ formatBytes(e.sizeBytes) }}</span>
            <label v-if="picksExport && e.kind === 'file'" class="check small"><input type="checkbox" :checked="included.has(`${area}/${e.path}`)" @change="setIncluded(`${area}/${e.path}`, ($event.target as HTMLInputElement).checked)" />{{ t('includeInExport') }}</label>
            <button v-if="canWrite && session.backend.recycleContent" class="icon-btn row-action" type="button" :aria-label="t('recycleTitle', { name: nameOf(e.path) })" :title="t('recycleAction')" @click="recycle(e)"><Trash2 :size="16" /></button>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.columns { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: var(--space-4); flex: 1; min-height: 0; }
.areas { display: flex; flex-direction: column; gap: 2px; padding: var(--space-2); align-self: start; }
.area { display: flex; align-items: center; gap: var(--space-3); text-align: left; padding: 9px 12px; border-radius: var(--radius-control); border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 0.93rem; }
.area:hover { background: var(--surface-hover); color: var(--text); }
.area.active { background: var(--surface-selected); color: #fff; }
.panel { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.panel-head { display: flex; align-items: center; gap: var(--space-3); }
.crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; flex: 1; min-width: 0; }
.crumb { display: inline-flex; align-items: center; gap: var(--space-2); padding: 4px 8px; border: none; border-radius: var(--radius-control); background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 0.98rem; }
.crumb:hover { background: var(--surface-hover); color: var(--text); }
.crumb.here { color: var(--text); font-weight: 600; }
.count { white-space: nowrap; }
.rows { display: flex; flex-direction: column; gap: 6px; }
.entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.entries li { display: flex; align-items: center; gap: var(--space-3); padding: 0 4px 0 0; border-radius: var(--radius-control); font-size: 0.9rem; min-height: 38px; }
.entries li:hover, .entries li:focus-within { background: var(--surface-hover); }
.entries li.on { background: rgba(59, 130, 246, 0.08); }
.entries li.busy { opacity: 0.6; }
.open { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-3); padding: 8px; border: none; border-radius: var(--radius-control); background: transparent; color: inherit; cursor: pointer; text-align: left; }
.folder-icon { color: #93c5fd; }
.path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Consolas, monospace; font-size: 0.85rem; }
.when { white-space: nowrap; }
.size { width: 72px; text-align: right; white-space: nowrap; }
.row-action { width: 30px; height: 30px; opacity: 0; }
.entries li:hover .row-action, .row-action:focus-visible { opacity: 1; }
.row-action:hover:not(:disabled) { color: #fca5a5; }
.editor { overflow: hidden; }
.file-title { flex: 1; min-width: 0; }
.code {
  flex: 1; min-height: 240px; width: 100%; resize: none; padding: var(--space-3); border-radius: var(--radius-control);
  border: 1px solid var(--control-border); background: rgba(3, 8, 16, 0.5); color: var(--text);
  font-family: ui-monospace, Consolas, monospace; font-size: 0.86rem; line-height: 1.55; tab-size: 4;
}
.viewer { overflow: hidden; }
/* A quiet checkerboard, so transparent parts of a texture read as transparent. */
.stage {
  position: relative; flex: 1; min-height: 240px; border-radius: var(--radius-control); border: 1px solid var(--control-border);
  background: repeating-conic-gradient(rgba(255, 255, 255, 0.045) 0% 25%, rgba(3, 8, 16, 0.5) 0% 50%) 0 0 / 20px 20px;
}
.stage img { position: absolute; inset: 0; margin: auto; max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; }
.stage img.pixelated { image-rendering: pixelated; }
.code:focus { border-color: rgba(147, 197, 253, 0.78); outline: none; box-shadow: 0 0 0 3px var(--accent-subtle); }
@media (max-width: 800px) { .columns { grid-template-columns: 1fr; } .areas { flex-direction: row; flex-wrap: wrap; } .when { display: none; } }
</style>
