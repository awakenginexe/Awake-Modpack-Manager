<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Download, ExternalLink, Scale, X } from '@lucide/vue';
import type { ProviderId } from '../backend/contract';
import type { ProjectDetail } from '../backend/host';
import { formatDate, formatNumber, t } from '../i18n';
import { openExternal } from '../state/appUpdate';
import { useSession } from '../state/session';
import { confirmDialog } from '../ui/desktop';
import { renderRich } from '../ui/richText';
import Avatar from './Avatar.vue';
import ProviderLogo from './ProviderLogo.vue';

/**
 * One project (mod, resource pack or shader) in a window of its own: its page from the site on the left,
 * what you can do with it on the right (the default slot: versions and the install button of the calling screen).
 */
const props = defineProps<{
  project: { provider: ProviderId; projectId: string; name: string; iconUrl?: string; author?: string; summary?: string; downloads?: number };
  pageUrl: string;
}>();
const emit = defineEmits<{ close: [] }>();
const session = useSession();

const detail = ref<ProjectDetail | null>(null);
const loading = ref(true);
const shot = ref(0);
const body = ref<HTMLElement | null>(null);
const overlay = ref<HTMLElement | null>(null);
const gallery = computed(() => detail.value?.gallery ?? []);
const url = computed(() => detail.value?.pageUrl ?? props.pageUrl);

onMounted(async () => {
  overlay.value?.focus();
  try { detail.value = await session.backend.projectDetail?.(props.project.provider, props.project.projectId) ?? null; } catch { /* the summary from the search still shows */ }
  loading.value = false;
});
watch([detail, body], () => {
  if (body.value && detail.value?.body) body.value.replaceChildren(renderRich(detail.value.body, detail.value.bodyFormat ?? 'markdown'));
}, { flush: 'post' });
/** Links in a description open in the browser, never inside the Manager's window. */
function onBodyClick(event: MouseEvent) {
  const link = (event.target as HTMLElement).closest('a');
  if (!link) return;
  event.preventDefault();
  if (link.dataset.embed === undefined) { void openExternal(link.href); return; }
  const host = new URL(link.href).host;
  void confirmDialog({ title: t('detailEmbedTitle'), body: t('detailEmbedBody', { host }), details: [link.href], confirm: t('detailEmbedConfirm'), cancel: t('cancel') })
    .then((ok) => { if (ok) void openExternal(link.href); });
}
</script>

<template>
  <div ref="overlay" class="dialog-overlay" tabindex="-1" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="project glass" role="dialog" aria-modal="true" aria-labelledby="project-title">
      <button class="icon-btn close" type="button" :aria-label="t('close')" @click="emit('close')"><X :size="18" /></button>
      <article class="page">
        <header class="head">
          <Avatar :name="project.name" :src="project.iconUrl" :size="84" />
          <div class="head-copy">
            <h2 id="project-title">{{ project.name }}</h2>
            <p v-if="detail?.author || project.author" class="muted">{{ t('byAuthor', { author: detail?.author || project.author! }) }}</p>
            <div class="meta small facts">
              <span class="chip"><ProviderLogo :provider="project.provider" :size="15" />{{ project.provider === 'modrinth' ? 'Modrinth' : 'CurseForge' }}</span>
              <span v-if="(detail?.downloads ?? project.downloads) != null"><Download :size="14" />{{ formatNumber((detail?.downloads ?? project.downloads)!) }}</span>
              <span v-if="detail?.license"><Scale :size="14" />{{ detail.license }}</span>
              <span v-if="detail?.updatedAt">{{ t('detailUpdated', { date: formatDate(detail.updatedAt) }) }}</span>
            </div>
          </div>
        </header>
        <p class="summary selectable">{{ detail?.summary || project.summary }}</p>
        <div v-if="detail?.categories.length" class="tags"><span v-for="c in detail.categories.slice(0, 10)" :key="c" class="chip">{{ c }}</span></div>

        <section v-if="gallery.length" class="gallery" :aria-label="t('detailGallery')">
          <img class="hero" :src="gallery[shot]?.full" alt="" referrerpolicy="no-referrer" />
          <div v-if="gallery.length > 1" class="thumbs">
            <button v-for="(g, i) in gallery" :key="g.full" type="button" class="thumb" :class="{ active: i === shot }" :aria-label="t('detailShot', { n: i + 1 })" :aria-pressed="i === shot" @click="shot = i">
              <img :src="g.thumb" alt="" loading="lazy" referrerpolicy="no-referrer" />
            </button>
          </div>
        </section>

        <div v-if="loading" class="lines" aria-busy="true"><span v-for="n in 5" :key="n" class="skeleton" :style="{ height: '14px', width: `${95 - n * 9}%` }"></span></div>
        <!-- eslint-disable-next-line vuejs-accessibility/click-events-have-key-events -->
        <div v-else-if="detail?.body" ref="body" class="rich selectable" @click="onBodyClick"></div>
        <p v-else class="muted small">{{ t('detailNoBody') }}</p>
      </article>

      <aside class="side">
        <slot />
        <button class="btn btn-block" type="button" @click="openExternal(url)"><ExternalLink :size="15" />{{ t('openProviderPage') }}</button>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.project {
  position: relative; display: grid; grid-template-columns: minmax(0, 7fr) minmax(280px, 3fr);
  width: min(1240px, calc(100vw - 48px)); height: min(860px, calc(100vh - 64px));
  background: var(--glass-menu); border-radius: var(--radius-medium); overflow: hidden;
}
.close { position: absolute; top: 12px; right: 12px; z-index: 2; }
.page { overflow-y: auto; padding: var(--space-5) var(--space-5) var(--space-5) calc(var(--space-5) + 4px); display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.side { overflow-y: auto; padding: var(--space-5); padding-top: 52px; display: flex; flex-direction: column; gap: var(--space-3); border-left: 1px solid var(--border-subtle); background: rgba(255, 255, 255, 0.02); min-width: 0; }
.head { display: flex; gap: var(--space-4); align-items: center; }
.head-copy { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.head h2 { font-size: 1.6rem; overflow-wrap: anywhere; }
.facts { flex-wrap: wrap; }
.summary { font-size: 1.02rem; line-height: 1.55; color: var(--text-secondary); }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.gallery { display: flex; flex-direction: column; gap: var(--space-2); }
.hero { width: 100%; max-height: 420px; object-fit: contain; border-radius: var(--radius-control); background: rgba(0, 0, 0, 0.35); }
.thumbs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
.thumb { flex: 0 0 auto; width: 112px; height: 64px; padding: 0; border-radius: 8px; overflow: hidden; border: 2px solid transparent; background: rgba(0, 0, 0, 0.35); cursor: pointer; opacity: 0.7; }
.thumb:hover, .thumb.active { opacity: 1; }
.thumb.active { border-color: #60a5fa; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.lines { display: flex; flex-direction: column; gap: 10px; }
.rich { line-height: 1.65; color: var(--text-secondary); overflow-wrap: anywhere; }
.rich :deep(h1), .rich :deep(h2), .rich :deep(h3), .rich :deep(h4) { color: var(--text); margin: 1.2em 0 0.45em; line-height: 1.3; }
.rich :deep(h1) { font-size: 1.4rem; } .rich :deep(h2) { font-size: 1.22rem; } .rich :deep(h3) { font-size: 1.08rem; } .rich :deep(h4) { font-size: 1rem; }
.rich :deep(p), .rich :deep(ul), .rich :deep(ol), .rich :deep(blockquote), .rich :deep(pre), .rich :deep(table) { margin: 0 0 0.8em; }
.rich :deep(ul), .rich :deep(ol) { padding-left: 1.4em; }
.rich :deep(img) { max-width: 100%; height: auto; border-radius: 6px; }
.rich :deep(iframe.video) { display: block; width: 100%; max-width: 720px; aspect-ratio: 16 / 9; height: auto; border: 0; border-radius: 8px; background: rgba(0, 0, 0, 0.35); margin: 0 0 0.8em; }
.rich :deep(a.embed-link) { display: inline-flex; padding: 8px 12px; margin: 0 0 0.8em; border: 1px solid var(--border-subtle); border-radius: 8px; background: rgba(255, 255, 255, 0.04); text-decoration: none; }
.rich :deep(a) { color: #7dd3fc; text-decoration: underline; text-underline-offset: 2px; }
.rich :deep(code) { font-family: ui-monospace, Consolas, monospace; font-size: 0.88em; background: rgba(255, 255, 255, 0.08); padding: 1px 5px; border-radius: 4px; }
.rich :deep(pre) { background: rgba(0, 0, 0, 0.35); padding: 12px; border-radius: 8px; overflow-x: auto; }
.rich :deep(pre code) { background: none; padding: 0; }
.rich :deep(blockquote) { border-left: 3px solid rgba(147, 197, 253, 0.4); padding-left: 12px; }
.rich :deep(hr) { border: none; border-top: 1px solid var(--border-subtle); margin: 1em 0; }
.rich :deep(table) { border-collapse: collapse; display: block; overflow-x: auto; }
.rich :deep(th), .rich :deep(td) { border: 1px solid var(--border-subtle); padding: 6px 10px; }
@media (max-width: 900px) {
  .project { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) auto; }
  .side { border-left: none; border-top: 1px solid var(--border-subtle); padding-top: var(--space-4); max-height: 46vh; }
}
</style>
