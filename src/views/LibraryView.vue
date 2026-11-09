<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { ArrowRight, ArrowUpCircle, Boxes, CircleAlert, Copy, Ellipsis, Loader, Pencil, RefreshCw, Trash2, TriangleAlert, Download, FolderOpen, Gamepad2, Info, Layers, Lock, Play, Plus, Search, X } from '@lucide/vue';
import type { InstanceSummary, LoaderKind, PackVersion, VersionCatalog } from '../backend/contract';
import { confirmDialog, copyText, openMenu, promptDialog, separator, toast, type MenuItem } from '../ui/desktop';
import Avatar from '../components/Avatar.vue';
import ProviderLogo from '../components/ProviderLogo.vue';
import SearchSelect from '../components/SearchSelect.vue';
import { formatNumber, t, type MessageKey } from '../i18n';
import { asError, useSession } from '../state/session';
import { confirmShare } from '../ui/shareInstance';
import { blockedText, connectErrorHint, connectErrorTitle, loaderLabel } from '../ui/labels';
import { preferredProfile } from '../state/prefs';

const emit = defineEmits<{ manage: []; getPack: []; navigate: ['review'] }>();
const session = useSession();
const { state } = session;
const query = ref('');
/** The selected list is the Manager's own standalone projects (helper), not a Launcher profile. */
const helper = computed(() => session.source.value === 'helper');
const notice = ref('');
const showCreate = ref(false);
const creating = ref(false);
const createError = ref('');
const form = ref({ name: '', minecraftVersion: '1.21.1', loader: 'fabric' as LoaderKind, loaderVersion: '' });
const ALL_LOADERS: LoaderKind[] = ['fabric', 'quilt', 'forge', 'neoforge', 'vanilla'];
/** Real choices from the side that will create it (standalone helper); fixed lists otherwise. */
const catalog = ref<VersionCatalog | null>(null);
const catalogError = ref('');
const catalogLoading = ref(false);
async function loadCatalog() {
  const backend = session.backend;
  if (!backend.versionCatalog || session.source.value !== 'helper') { catalog.value = null; return; }
  catalogLoading.value = true;
  catalogError.value = '';
  try {
    const loader = form.value.loader;
    const c = await backend.versionCatalog({ minecraftVersion: form.value.minecraftVersion || undefined, loader: loader === 'vanilla' ? undefined : loader });
    catalog.value = c;
    // The catalog has no release/snapshot types; plain dotted numbers (1.21.1, 26.3) are releases.
    if (!c.minecraftVersions.includes(form.value.minecraftVersion)) form.value.minecraftVersion = c.minecraftVersions.find((v) => /^\d+(\.\d+)+$/.test(v)) ?? c.minecraftVersions[0] ?? '';
    if (!c.loaders.includes(form.value.loader)) form.value.loader = c.loaders.find((l) => l !== 'vanilla') ?? c.loaders[0] ?? 'vanilla';
    if (form.value.loader !== 'vanilla' && !c.loaderVersions.includes(form.value.loaderVersion)) form.value.loaderVersion = c.loaderVersions[0] ?? '';
  } catch (e) {
    catalogError.value = asError(e).message;
  } finally {
    catalogLoading.value = false;
  }
}
watch(showCreate, (open) => { if (open) void loadCatalog(); });
watch(() => [form.value.minecraftVersion, form.value.loader], () => { if (showCreate.value && catalog.value) void loadCatalog(); });
const minecraftChoices = computed(() => catalog.value?.minecraftVersions ?? ['1.21.1', '1.20.1', '1.19.2', '1.18.2']);
const loaderChoices = computed(() => catalog.value?.loaders ?? ALL_LOADERS);
const loaderOptions = computed(() => loaderChoices.value.map((value) => ({ value, label: loaderLabel(value) })));
const needsLoaderVersion = computed(() => !!catalog.value && form.value.loader !== 'vanilla');
/** The helper validated this pair and has no loader build for it: say so instead of an empty list. */
const incompatible = computed(() => needsLoaderVersion.value && !catalogLoading.value && !catalog.value!.loaderVersions.length);

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? state.instances.filter((i) => i.name.toLowerCase().includes(q)) : state.instances;
});
const statusKey: Record<InstanceSummary['status'], MessageKey> = { ready: 'statusReady', running: 'statusRunning', busy: 'statusBusy', broken: 'statusBroken', unknown: 'statusUnknown' };
const statusTone: Record<InstanceSummary['status'], string> = { ready: 'ok', running: 'info', busy: 'warn', broken: 'error', unknown: '' };

function manage(inst: InstanceSummary) {
  void session.selectInstance(inst.id); // Mods view shows its own loading state
  emit('manage');
}

const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 5000);
onUnmounted(() => clearInterval(clock));
/** No endpoint 45 s after starting: it may be waiting on a Launcher dialog, or be a version without the Manager integration. */
const launcherSlow = computed(() => !!state.launcherStartedAt && now.value - state.launcherStartedAt > 45_000);

async function startLauncher() {
  try { await session.startLauncher(); } catch (e) { notice.value = asError(e).message; }
}

/** Launcher is refusing this folder, so starting it again would not help until the folder changes. */
const folderBlocked = computed(() => state.connectError?.code === 'profile-not-private' || state.connectError?.code === 'profile-not-owned');
const makingPrivate = ref(false);
async function makeFolderPrivate() {
  const ok = await confirmDialog({
    title: t('profilePrivateTitle'), body: t('profilePrivateBody'),
    details: [state.connectError?.detail ?? '', t('profilePrivateDetailOthers'), t('profilePrivateDetailData')],
    confirm: t('makeFolderPrivate'), cancel: t('cancel'),
  });
  if (!ok) return;
  makingPrivate.value = true;
  try {
    await session.makeProfilePrivate();
    notice.value = t('profilePrivateDone');
  } catch (e) { notice.value = asError(e).message; } finally { makingPrivate.value = false; }
}

async function launch(inst: InstanceSummary) {
  try {
    notice.value = t('launchRequested', { name: inst.name });
    const final = await session.launch(inst.id);
    if (final?.state === 'completed') notice.value = t('launchStarted', { name: inst.name });
    else if (final) notice.value = final.error?.message ?? t('launchFailed', { name: inst.name });
  } catch (e) {
    notice.value = asError(e).message;
  }
}

async function openInLauncher(inst: InstanceSummary) {
  try {
    await session.backend.openInLauncher!(inst.id);
    notice.value = t('workspaceOpened');
  } catch (e) { notice.value = asError(e).message; }
}

/* Everything that can be done to a project, on its right-click menu and its "more" button. */
const owned = (inst: InstanceSummary) => session.can('instances.delete') && helper.value && !!inst.path;
function deleteDetails(inst: InstanceSummary) {
  return [t('deleteDetailFiles'), ...(inst.modCount ? [t('instanceMods', { count: formatNumber(inst.modCount) })] : []), ...(inst.pack ? [t('deleteDetailPack', { pack: inst.pack.packName })] : []), t('deleteDetailLauncher')];
}
async function removeInstances(list: InstanceSummary[]) {
  if (!list.length) return;
  const one = list.length === 1 ? list[0]! : null;
  const ok = await confirmDialog({
    title: one ? t('deleteProjectTitle', { name: one.name }) : t('deleteProjectsTitle', { count: list.length }),
    body: t('deleteProjectBody'), details: one ? deleteDetails(one) : list.map((i) => i.name),
    confirm: t('deleteConfirm'), cancel: t('cancel'), danger: true, requireText: one ? one.name : String(list.length),
  });
  if (!ok) return;
  for (const inst of list) {
    try {
      const final = await session.deleteInstance(inst.id);
      if (final?.state === 'completed') toast(t('deletedProject', { name: inst.name }), 'ok');
      else toast(final?.error?.message ?? t('deleteFailed', { name: inst.name }), 'error');
    } catch (e) { toast(asError(e).message, 'error'); }
  }
  picked.value = new Set();
}
async function rename(inst: InstanceSummary) {
  const name = await promptDialog({ title: t('renameProject'), input: { label: t('createName'), value: inst.name, maxLength: 80 }, confirm: t('renameConfirm'), cancel: t('cancel') });
  if (!name || name === inst.name) return;
  try { await session.renameInstance(inst.id, name); toast(t('renamedProject', { name }), 'ok'); } catch (e) { toast(asError(e).message, 'error'); }
}
const sharing = ref<string | null>(null);
async function shareInstance(inst: InstanceSummary) {
  if (!await confirmShare(inst.name)) return;
  sharing.value = inst.id;
  try { await session.shareInstance(inst.id); toast(t('shareDone', { name: inst.name }), 'ok'); emit('manage'); }
  catch (e) { toast(asError(e).message, 'error'); } finally { sharing.value = null; }
}
async function stopSharing(inst: InstanceSummary) {
  const ok = await confirmDialog({ title: t('shareStopTitle', { name: inst.name }), body: t('shareStopBody'), confirm: t('shareStopConfirm'), cancel: t('cancel') });
  if (!ok) return;
  sharing.value = inst.id;
  try { await session.stopSharingInstance(inst.id); toast(t('shareStopped', { name: inst.name }), 'ok'); }
  catch (e) { toast(asError(e).message, 'error'); } finally { sharing.value = null; }
}
function instanceMenu(inst: InstanceSummary): MenuItem[] {
  const update = packUpdates.value[inst.id];
  const canDelete = owned(inst);
  return [
    { label: t('manage'), icon: ArrowRight, disabled: !inst.manageable, action: () => manage(inst) },
    helper.value ? { label: t('openInLauncher'), icon: Play, disabled: !inst.manageable, action: () => openInLauncher(inst) } : { label: t('play'), icon: Play, disabled: !session.can('launch.request'), action: () => launch(inst) },
    ...(update ? [{ label: t('packUpdateTo', { version: update.name }), icon: ArrowUpCircle, action: () => updatePack(inst, update) }] : []),
    ...(inst.shared ? [{ label: t('shareStopAction'), icon: Lock, disabled: sharing.value === inst.id, action: () => stopSharing(inst) }]
      : !helper.value && session.canShare.value ? [{ label: t('shareAction'), icon: Pencil, disabled: !inst.manageable || sharing.value === inst.id, action: () => shareInstance(inst) }] : []),
    separator,
    { label: t('openFolder'), icon: FolderOpen, disabled: !helper.value, action: () => session.backend.openFolder?.(inst.id) },
    ...(inst.path ? [{ label: t('copyPath'), icon: Copy, action: () => copyText(inst.path!) }] : []),
    { label: t('renameProject'), icon: Pencil, disabled: !helper.value || !session.can('instances.rename'), hint: helper.value ? undefined : t('launcherOwnedHint'), action: () => rename(inst) },
    separator,
    { label: t('deleteProject'), icon: Trash2, danger: true, disabled: !canDelete, hint: canDelete ? undefined : t('launcherOwnedHint'), action: () => removeInstances([inst]) },
  ];
}
/* Bulk selection of projects. */
const picked = ref<Set<string>>(new Set());
function togglePicked(id: string) {
  const next = new Set(picked.value);
  if (!next.delete(id)) next.add(id);
  picked.value = next;
}
const pickedInstances = computed(() => shown.value.filter((i) => picked.value.has(i.id)));

/* Newer versions of the pack a project came from. */
const packUpdates = ref<Record<string, PackVersion>>({});
const packChecked = new Set<string>();
const packUpdating = ref<string | null>(null);
watch(() => state.instances, async (list) => {
  for (const inst of list) {
    if (!inst.pack || !helper.value || packChecked.has(`${inst.id}:${inst.pack.versionId}`)) continue;
    packChecked.add(`${inst.id}:${inst.pack.versionId}`);
    try {
      const versions = await session.backend.packVersions(inst.pack.provider, inst.pack.packId);
      // Updates stay on the project's Minecraft version; moving to another one is a new project.
      const same = versions.filter((v) => !inst.minecraftVersion || v.minecraftVersion === inst.minecraftVersion);
      const newest = same.find((v) => v.releaseType !== 'beta' && v.releaseType !== 'alpha') ?? same[0];
      if (newest && newest.id !== inst.pack.versionId && same.findIndex((v) => v.id === inst.pack!.versionId) !== 0) packUpdates.value = { ...packUpdates.value, [inst.id]: newest };
      else { const { [inst.id]: _, ...rest } = packUpdates.value; packUpdates.value = rest; }
    } catch { /* an unreachable provider just means no update badge */ }
  }
}, { immediate: true });
async function updatePack(inst: InstanceSummary, version: PackVersion) {
  packUpdating.value = inst.id;
  try {
    await session.preparePackUpdate(inst.id, version.id, t('packUpdateOrigin', { pack: inst.pack!.packName, version: version.name }));
    emit('navigate', 'review');
  } catch (e) { toast(asError(e).message, 'error'); } finally { packUpdating.value = null; }
}

async function create() {
  if (!form.value.name.trim()) return;
  creating.value = true;
  createError.value = '';
  try {
    const result = await session.createInstance({ ...form.value, name: form.value.name.trim() });
    if (result?.state === 'completed') {
      showCreate.value = false;
      notice.value = helper.value ? t('createDoneHelper', { name: form.value.name.trim() }) : t('createDone');
      form.value.name = '';
    } else if (result) createError.value = result.error?.message ?? t('applyFailed');
  } catch (e) {
    createError.value = asError(e).message;
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section class="view">
    <header class="view-header">
      <div>
        <h1>{{ t('libraryTitle') }}</h1>
        <p>{{ helper ? t('libraryHelperSubtitle') : t('librarySubtitle') }}</p>
      </div>
      <div class="toolbar">
        <button class="btn" type="button" @click="emit('getPack')"><Download :size="16" />{{ t('installModpack') }}</button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!session.can('instances.create')"
          :title="session.can('instances.create') ? undefined : t('capabilityMissing')"
          @click="showCreate = true"
        ><Plus :size="16" />{{ helper ? t('projNew') : t('createInstance') }}</button>
      </div>
    </header>

    <div class="toolbar">
      <label class="search-field">
        <Search :size="16" />
        <input v-model="query" class="input" type="search" :placeholder="t('librarySearch')" :aria-label="t('librarySearch')" />
      </label>
      <label v-if="state.installations.length > 1" class="field inline">
        <span>{{ session.backend.kind === 'composite' ? t('libraryShowing') : t('libraryInstallation') }}</span>
        <select v-model="state.installationId" class="select" @change="state.installationId !== 'manager' && (preferredProfile = state.installationId); session.refreshInstances()">
          <option v-for="inst in state.installations" :key="inst.id" :value="inst.id">{{ inst.id === 'manager' ? t('managerInstallation') : inst.displayName }}{{ inst.available === false ? ` (${t('profileNotRunning')})` : '' }}</option>
        </select>
      </label>
      <span class="muted small count">{{ t('instanceCount', { count: shown.length }) }}</span>
    </div>

    <div v-if="notice" class="notice" role="status">
      <Info :size="18" /><span class="grow">{{ notice }}</span>
      <button class="icon-btn" type="button" :aria-label="t('dismiss')" @click="notice = ''"><X :size="16" /></button>
    </div>
    <div v-if="state.connectError" class="notice" :class="state.waitingForLauncher ? 'warn' : 'error'" role="alert">
      <TriangleAlert v-if="folderBlocked" :size="18" />
      <Loader v-else-if="state.waitingForLauncher" :size="18" class="spin" />
      <CircleAlert v-else :size="18" />
      <div class="grow">
        <strong>{{ t(connectErrorTitle(state.connectError.code)) }}</strong>
        <p class="small">{{ state.launcherStartedAt && !folderBlocked ? t(launcherSlow ? 'launcherStartSlow' : 'launcherStarting') : t(connectErrorHint(state.connectError.code)) }}</p>
        <details><summary class="small">{{ t('technicalDetails') }}</summary><code class="small">{{ state.connectError.message }}<template v-if="state.connectError.detail"> ({{ state.connectError.detail }})</template></code></details>
      </div>
      <button v-if="!state.waitingForLauncher" class="btn btn-small" type="button" @click="session.connect()">{{ t('retry') }}</button>
      <button v-else-if="state.connectError.code === 'profile-not-private'" class="btn btn-small btn-primary" type="button" :disabled="makingPrivate" @click="makeFolderPrivate">{{ t('makeFolderPrivate') }}</button>
      <button v-else-if="!folderBlocked && !state.launcherStartedAt && session.backend.canStartLauncher?.()" class="btn btn-small btn-primary" type="button" @click="startLauncher">{{ t('startLauncher') }}</button>
    </div>

    <div v-if="session.source.value === 'helper' && state.handshake?.stub" class="notice warn" role="note">
      <TriangleAlert :size="18" /><span class="grow"><strong>{{ t('helperStubTitle') }}</strong> {{ t('helperStubNotice') }}</span>
    </div>
    <div v-else-if="session.source.value === 'helper' && state.handshake && !session.can('instances.create')" class="notice" role="note">
      <Info :size="18" /><span class="grow">{{ t('helperPendingNotice') }}</span>
    </div>

    <details v-if="state.instanceWarnings.length" class="notice warn warnings">
      <summary><TriangleAlert :size="18" /><strong>{{ t('discoveryWarnings', { count: state.instanceWarnings.length }) }}</strong></summary>
      <p class="small">{{ t('discoveryWarningsHint') }}</p>
      <ul>
        <li v-for="(w, i) in state.instanceWarnings" :key="i" class="small"><code>{{ w.code }}</code> <span class="muted">{{ w.path }}</span></li>
      </ul>
    </details>

    <ul v-if="state.instancesLoading && !state.instances.length" class="grid" aria-busy="true">
      <li v-for="n in 6" :key="n" class="card skeleton-card"><span class="skeleton" style="width: 52px; height: 52px; border-radius: 12px"></span><span class="skeleton" style="height: 14px; width: 60%"></span><span class="skeleton" style="height: 12px; width: 40%"></span></li>
    </ul>
    <div v-else-if="!shown.length && !state.connectError" class="empty card">
      <span class="empty-icon"><Gamepad2 :size="28" /></span>
      <h2>{{ helper ? t('helperEmptyTitle') : t('libraryEmpty') }}</h2>
      <p>{{ helper ? t('helperEmptyHint') : t('libraryEmptyHint') }}</p>
      <button class="btn btn-primary" type="button" @click="emit('getPack')"><Download :size="16" />{{ t('installModpack') }}</button>
    </div>

    <ul v-else class="grid">
      <li v-for="(inst, i) in shown" :key="inst.id" class="card instance rise" :style="{ '--i': i }" :class="{ selected: inst.id === state.instanceId, picked: picked.has(inst.id), interactive: inst.manageable }" @contextmenu="openMenu($event, instanceMenu(inst))" @dblclick="inst.manageable && manage(inst)">
        <input v-if="owned(inst)" class="pick" type="checkbox" :checked="picked.has(inst.id)" :aria-label="t('selectRow', { name: inst.name })" @click.stop @change="togglePicked(inst.id)" @dblclick.stop />
        <button class="icon-btn more" type="button" :aria-label="t('moreActions')" :title="t('moreActions')" @click.stop="openMenu($event, instanceMenu(inst))" @dblclick.stop><Ellipsis :size="18" /></button>
        <div class="card-top">
          <Avatar :name="inst.name" :src="inst.iconUrl" :size="52" />
          <div class="card-copy">
            <h2 :title="inst.name">{{ inst.name }}</h2>
            <span class="badges">
              <span class="badge" :class="statusTone[inst.status]"><span class="dot"></span>{{ t(statusKey[inst.status]) }}</span>
              <span v-if="inst.shared" class="badge info" :title="t('shareBadgeHint')"><Pencil :size="12" />{{ t('shareBadge') }}</span>
              <span v-if="inst.launcher?.identityStatus === 'conflict'" class="badge warn" :title="t('blockedConflict')"><TriangleAlert :size="12" />{{ t('identityConflict') }}</span>
            </span>
          </div>
        </div>

        <div class="meta">
          <span v-if="inst.minecraftVersion" :title="t('createVersion')"><Gamepad2 :size="15" />{{ inst.minecraftVersion }}</span>
          <span v-if="inst.loader" :title="t('createLoader')"><Layers :size="15" />{{ inst.loader.version ? `${loaderLabel(inst.loader.kind)} ${inst.loader.version}` : loaderLabel(inst.loader.kind) }}</span>
          <span v-if="!inst.minecraftVersion && !inst.loader" class="unknown" :title="t('versionUnknownHint')"><Gamepad2 :size="15" />{{ t('versionUnknown') }}</span>
          <span><Boxes :size="15" />{{ inst.modCount === undefined ? t('modsUnknown') : t('instanceMods', { count: formatNumber(inst.modCount) }) }}</span>
        </div>
        <div v-if="inst.pack" class="pack-row">
          <div class="pack-link chip" :title="t('packLinked', { pack: inst.pack.packName, version: inst.pack.versionName, provider: inst.pack.provider })">
            <ProviderLogo :provider="inst.pack.provider" :size="15" />
            <span class="ellipsis">{{ inst.pack.packName }} · {{ inst.pack.versionName }}</span>
          </div>
          <button v-if="packUpdates[inst.id]" class="btn btn-small" type="button" :disabled="packUpdating === inst.id" :title="t('packUpdateTo', { version: packUpdates[inst.id]!.name })" @click.stop="updatePack(inst, packUpdates[inst.id]!)" @dblclick.stop>
            <RefreshCw v-if="packUpdating === inst.id" :size="14" class="spin" /><ArrowUpCircle v-else :size="14" />{{ t('packUpdate') }}
          </button>
        </div>
        <p v-if="inst.path" class="path small" :title="inst.path"><FolderOpen :size="14" /><span class="ellipsis">{{ inst.path }}</span></p>
        <p v-if="!inst.manageable" class="blocked small"><CircleAlert :size="15" />{{ blockedText(inst) }}</p>

        <div class="card-actions">
          <button class="btn btn-primary grow" type="button" :disabled="!inst.manageable" @click="manage(inst)">
            {{ inst.id === state.instanceId ? t('managing') : t('manage') }}<ArrowRight :size="16" />
          </button>
          <button
            v-if="helper"
            class="btn" type="button" :disabled="!inst.manageable"
            @click="openInLauncher(inst)"
          ><Play :size="16" />{{ t('openInLauncher') }}</button>
          <button
            v-else
            class="btn"
            type="button"
            :disabled="!session.can('launch.request')"
            :title="session.can('launch.request') ? t('openInLauncher') : t('capabilityMissing')"
            :aria-label="t('openInLauncher')"
            @click="launch(inst)"
          ><Play :size="16" />{{ t('play') }}</button>
        </div>
      </li>
    </ul>

    <Transition name="bar">
      <div v-if="pickedInstances.length" class="floating-bar bulkbar" role="toolbar">
        <strong>{{ t('selectedCount', { count: formatNumber(pickedInstances.length) }) }}</strong>
        <span class="divider"></span>
        <button class="btn btn-small btn-ghost btn-danger" type="button" @click="removeInstances(pickedInstances)"><Trash2 :size="15" />{{ t('deleteSelected') }}</button>
        <button class="icon-btn end" type="button" :aria-label="t('clearSelection')" @click="picked = new Set()"><X :size="16" /></button>
      </div>
    </Transition>

    <Transition name="modal">
      <div v-if="showCreate" class="dialog-overlay" @click.self="showCreate = false" @keydown.esc="showCreate = false">
        <form class="dialog glass" role="dialog" aria-modal="true" aria-labelledby="create-title" @submit.prevent="create">
          <header><h2 id="create-title">{{ helper ? t('projNew') : t('createTitle') }}</h2><p class="muted small">{{ helper ? t('createHelperHint') : t('createHint') }}</p></header>
          <div class="dialog-body">
            <label class="field"><span>{{ t('createName') }}</span><input v-model="form.name" class="input" required autofocus /></label>
            <label class="field"><span>{{ t('createVersion') }}</span>
              <SearchSelect v-model="form.minecraftVersion" :options="minecraftChoices" :disabled="catalogLoading && !catalog" :aria-label="t('createVersion')" />
            </label>
            <label class="field"><span>{{ t('createLoader') }}</span>
              <SearchSelect v-model="form.loader" :options="loaderOptions" :searchable="false" :aria-label="t('createLoader')" />
            </label>
            <label v-if="needsLoaderVersion" class="field"><span>{{ t('createLoaderVersion') }}</span>
              <SearchSelect v-model="form.loaderVersion" :options="catalog!.loaderVersions" :disabled="catalogLoading" :aria-label="t('createLoaderVersion')" />
            </label>
            <p v-if="incompatible" class="notice warn" role="alert"><TriangleAlert :size="18" />{{ t('createIncompatible', { loader: loaderLabel(form.loader), version: form.minecraftVersion }) }}</p>
            <p v-if="catalogLoading" class="muted small" role="status"><Loader :size="14" class="spin" /> {{ t('catalogLoading') }}</p>
            <p v-if="catalogError" class="notice error" role="alert"><CircleAlert :size="18" />{{ catalogError }}</p>
            <p v-if="createError" class="notice error" role="alert"><CircleAlert :size="18" />{{ createError }}</p>
          </div>
          <footer>
            <button class="btn" type="button" @click="showCreate = false">{{ t('cancel') }}</button>
            <button class="btn btn-primary" type="submit" :disabled="creating || catalogLoading || incompatible || !form.name.trim() || (needsLoaderVersion && !form.loaderVersion)">{{ creating ? t('creating') : t('createSubmit') }}</button>
          </footer>
        </form>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.view { overflow-y: auto; padding-right: 4px; }
.inline { flex-direction: row; align-items: center; gap: var(--space-2); }
.count { margin-left: auto; }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-4); }
.instance { position: relative; display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.instance.picked { border-color: rgba(96, 165, 250, 0.6); }
.more { position: absolute; top: 8px; right: 8px; opacity: 0.55; }
.instance:hover .more, .more:focus-visible { opacity: 1; }
.pick { position: absolute; top: 12px; left: 12px; z-index: 1; opacity: 0; }
.instance:hover .pick, .pick:checked, .pick:focus-visible { opacity: 1; }
.pack-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-width: 0; }
.bulkbar { position: sticky; bottom: 8px; align-self: center; display: flex; align-items: center; gap: var(--space-2); }
.bulkbar .divider { width: 1px; height: 20px; background: rgba(255, 255, 255, 0.15); }
.skeleton-card { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); min-height: 200px; }
.card-top { display: flex; align-items: center; gap: var(--space-3); }
.card-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.card-copy { padding-right: 22px; }
.card-copy h2 { font-size: 1.08rem; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pack-link { align-self: flex-start; max-width: 100%; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.path { display: flex; align-items: center; gap: 6px; color: var(--text-muted); min-width: 0; }
.badges { display: flex; gap: 6px; flex-wrap: wrap; }
.unknown { color: var(--text-muted); }
.warnings summary { display: flex; align-items: center; gap: var(--space-3); cursor: pointer; list-style: none; }
.warnings summary::-webkit-details-marker { display: none; }
.warnings { display: block; }
.warnings > p, .warnings ul { margin: 8px 0 0 30px; }
.warnings ul { padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow-y: auto; }
.spin { animation: spin 1.2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.blocked { display: flex; align-items: center; gap: 6px; color: #fcd34d; }
.card-actions { display: flex; gap: var(--space-2); margin-top: auto; padding-top: var(--space-1); }
.grow { flex: 1; }
</style>
