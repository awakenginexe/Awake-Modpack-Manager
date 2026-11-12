<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { Download, ExternalLink, FolderOpen, Loader } from '@lucide/vue';
import type { ManualDownload } from '../backend/contract';
import { t } from '../i18n';
import { openExternal } from '../state/appUpdate';
import { useSession } from '../state/session';
import { toast } from '../ui/desktop';

/** How many downloads are still waited for; the Review page shows this panel instead of the bare error. */
const pending = defineModel<number>('pending', { default: 0 });
const session = useSession();
const wanted = ref<ManualDownload[]>([]);
const POLL_MS = 2500;
let busy = false;
let timer: ReturnType<typeof setInterval> | undefined;

function setWanted(list: ManualDownload[]) {
  wanted.value = list;
  pending.value = list.length;
  clearInterval(timer);
  // The Downloads folder is watched only while something is waited for.
  timer = list.length ? setInterval(() => void claim(false), POLL_MS) : undefined;
}
onBeforeUnmount(() => clearInterval(timer));

// The helper refused a CurseForge download: find out which draft installs are the restricted ones.
watch(() => session.review.error, async (error) => {
  const id = session.state.instanceId;
  const backend = session.backend;
  if (error?.code !== 'provider-restricted' || !id || !backend.manualDownloads) return;
  const items = (session.draft.value?.changes ?? []).flatMap((c) => (c.kind === 'install' && c.provider === 'curseforge' ? [{ projectId: c.projectId, versionId: c.versionId }] : []));
  if (!items.length) return;
  try { setWanted(await backend.manualDownloads(id, items)); } catch { /* the error itself stays on the page */ }
}, { immediate: true });

// An install undone in the draft is no longer waited for.
watch(() => session.draft.value?.changes, (changes) => {
  const drafted = new Set((changes ?? []).flatMap((c) => (c.kind === 'install' && c.provider === 'curseforge' ? [c.projectId] : [])));
  if (wanted.value.some((w) => !drafted.has(w.projectId))) setWanted(wanted.value.filter((w) => drafted.has(w.projectId)));
});

async function claim(pick: boolean) {
  const id = session.state.instanceId;
  const draft = session.draft.value;
  if (busy || !id || !draft || !session.backend.claimManualDownloads) return;
  busy = true;
  try {
    const got = await session.backend.claimManualDownloads(id, wanted.value, pick);
    if (!got) return;
    const placed = wanted.value.filter((w) => got.includes(w.projectId));
    if (!placed.length) { if (pick) toast(t('manualNoMatch'), 'error'); return; }
    // The files are in the pack now, so their installs leave the draft; the rest is checked again as usual.
    session.setDraft({ ...draft, changes: draft.changes.filter((c) => !(c.kind === 'install' && c.provider === 'curseforge' && got.includes(c.projectId))) });
    setWanted(wanted.value.filter((w) => !got.includes(w.projectId)));
    toast(t('manualAdded', { names: placed.map((w) => w.name).join(', ') }), 'ok');
    await session.rebaseDraft();
  } catch (e) {
    if (pick) toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    busy = false;
  }
}
const openAll = () => { for (const w of wanted.value) void openExternal(w.url); };
</script>

<template>
  <div v-if="wanted.length" class="notice warn manual" role="status">
    <Download :size="18" />
    <div class="grow">
      <strong>{{ t('manualTitle', { count: wanted.length }) }}</strong>
      <p class="small">{{ t('manualHint') }}</p>
      <ul class="files">
        <li v-for="w in wanted" :key="w.projectId">
          <span class="grow"><span class="name">{{ w.name }}</span><span class="muted small waiting"><Loader :size="12" class="spin" />{{ t('manualWaiting', { file: w.fileName }) }}</span></span>
          <button class="btn btn-small" type="button" @click="openExternal(w.url)"><ExternalLink :size="14" />{{ t('manualOpen') }}</button>
        </li>
      </ul>
      <div class="toolbar">
        <button v-if="wanted.length > 1" class="btn btn-small btn-primary" type="button" @click="openAll"><ExternalLink :size="14" />{{ t('manualOpenAll') }}</button>
        <button class="btn btn-small" type="button" @click="claim(true)"><FolderOpen :size="14" />{{ t('manualPick') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.manual { align-items: flex-start; }
.grow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.files li { display: flex; align-items: center; gap: var(--space-3); padding: 6px 10px; border-radius: var(--radius-control); background: rgba(255, 255, 255, 0.04); }
.files .grow { gap: 0; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.waiting { display: inline-flex; align-items: center; gap: 4px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
