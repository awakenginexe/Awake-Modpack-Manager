<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { TriangleAlert } from '@lucide/vue';
import type { BackendError, DependencyResolution } from '../backend/contract';
import { chosenResolutions, conflictReport, type Text, type Tone } from '../domain/conflicts';
import { t } from '../i18n';

/**
 * Dependency problems the helper found while preparing a plan, shown with friendly project names,
 * the requesting mods, requested and selected versions, the loader-metadata evidence and the affected
 * files. Only choices the helper accepts are offered, none is preselected, and nothing is retried
 * until every problem has an explicit decision.
 */
const props = defineProps<{ error: BackendError; canResolve: boolean; busy?: boolean }>();
const emit = defineEmits<{ retry: [resolutions: DependencyResolution[]] }>();

const report = computed(() => conflictReport(props.error));
const choices = reactive<Record<string, string | undefined>>({});
watch(() => props.error, () => { for (const k of Object.keys(choices)) delete choices[k]; });
const resolutions = computed(() => (report.value ? chosenResolutions(report.value.views, choices) : null));
const resolvable = computed(() => !!report.value?.structured && !report.value.blocked && props.canResolve);
const tt = (x: Text) => t(x.key, x.params);
const kindTone: Record<string, string> = { version_pin: 'warn', missing_dependency: 'warn', incompatible: 'error', loader_bridge: 'error' };
const toneClass = (tone: Tone) => ({ ok: 'ok', warn: 'warn', bad: 'error', neutral: 'info' })[tone];
</script>

<template>
  <section v-if="report" class="conflicts notice warn" role="alert" data-testid="dependency-conflicts">
    <TriangleAlert :size="18" />
    <div class="grow">
      <strong>{{ t('conflictHeading', { count: report.views.length || 1 }) }}</strong>
      <p class="small">{{ t('conflictIntro') }}</p>
      <p v-if="!report.structured" class="small">{{ t('conflictUnstructured') }}</p>

      <article v-for="v in report.views" :key="v.id" class="conflict" :data-conflict="v.id">
        <div class="conflict-head">
          <span class="badge" :class="kindTone[v.kind]">{{ tt(v.badge) }}</span>
          <h3>{{ v.title }}</h3>
        </div>
        <p class="small">{{ tt(v.explanation) }}</p>
        <p v-if="v.selected" class="small muted">{{ tt(v.selected) }}</p>
        <table v-if="v.rows.length" class="small requests">
          <thead><tr><th>{{ t('conflictColMod') }}</th><th>{{ t('conflictColRequest') }}</th><th>{{ t('conflictColEvidence') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in v.rows" :key="r.file">
              <td><span class="mod">{{ r.mod }}</span> <span class="muted">{{ r.version }}</span></td>
              <td>{{ tt(r.requested) }}</td>
              <td><span class="badge" :class="toneClass(r.evidence.tone)">{{ tt(r.evidence) }}</span></td>
            </tr>
          </tbody>
        </table>
        <details class="small">
          <summary>{{ t('conflictAffected') }} ({{ v.affectedFiles.length }})</summary>
          <ul class="files"><li v-for="f in v.affectedFiles" :key="f"><code>{{ f }}</code></li></ul>
        </details>
        <fieldset v-if="v.options.length && canResolve" class="options" :disabled="busy">
          <label v-for="o in v.options" :key="o.id" class="radio">
            <input v-model="choices[v.id]" type="radio" :name="v.id" :value="o.id" /> {{ tt(o.label) }}
          </label>
        </fieldset>
        <p v-else-if="v.blocked" class="small blocked">{{ tt(v.blocked) }}</p>
      </article>

      <p v-if="report.truncated" class="small muted">{{ t('conflictTruncated') }}</p>
      <p v-if="!canResolve && report.views.some((v) => v.options.length)" class="small muted">{{ t('conflictNoReview') }}</p>
      <div v-if="resolvable" class="retry">
        <span v-if="!resolutions" class="small muted">{{ t('conflictChooseAll') }}</span>
        <button class="btn btn-primary" type="button" :disabled="!resolutions || busy" @click="resolutions && emit('retry', resolutions)">{{ t('conflictRetry') }}</button>
      </div>
      <details><summary class="small">{{ t('technicalDetails') }}</summary><code class="small">{{ error.detail ?? error.code }}: {{ error.message }}</code></details>
    </div>
  </section>
</template>

<style scoped>
.conflicts { align-items: flex-start; }
.conflict { border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08)); margin-top: 10px; padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.conflict-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.conflict-head h3 { margin: 0; font-size: 1rem; }
.requests { width: 100%; border-collapse: collapse; }
.requests th { text-align: left; font-weight: 600; color: var(--text-muted); padding: 2px 6px 2px 0; }
.requests td { padding: 3px 6px 3px 0; vertical-align: top; overflow-wrap: anywhere; }
.mod { font-weight: 600; }
.files { margin: 4px 0 0; padding-left: 18px; max-height: 120px; overflow-y: auto; }
.options { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.radio { display: flex; gap: 8px; align-items: center; }
.blocked { color: #fca5a5; }
.retry { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
</style>
