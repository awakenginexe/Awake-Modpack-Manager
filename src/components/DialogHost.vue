<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { CircleCheck, CircleAlert, Info, TriangleAlert, X, type LucideIcon } from '@lucide/vue';
import { t } from '../i18n';
import { dialog, dismissToast, settleDialog, toasts, type ToastTone } from '../ui/desktop';

const value = ref('');
const field = ref<HTMLInputElement | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);
watch(dialog, (d) => {
  value.value = d?.input?.value ?? '';
  if (d) void nextTick(() => { if (d.input || d.requireText) { field.value?.focus(); field.value?.select(); } else confirmButton.value?.focus(); });
});
const canConfirm = computed(() => {
  const d = dialog.value;
  if (!d) return false;
  if (d.requireText) return value.value.trim() === d.requireText.trim();
  if (d.input) return !!value.value.trim();
  return true;
});
function confirm() {
  if (!canConfirm.value) return;
  settleDialog(dialog.value?.input ? value.value.trim() : true);
}
const toastIcon: Record<ToastTone, LucideIcon> = { info: Info, ok: CircleCheck, warn: TriangleAlert, error: CircleAlert };
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="dialog" class="dialog-overlay" @mousedown.self="settleDialog(null)" @keydown.esc.stop="settleDialog(null)">
        <form class="dialog glass" role="alertdialog" aria-modal="true" @submit.prevent="confirm">
          <header><h2>{{ dialog.title }}</h2></header>
          <div class="dialog-body">
            <p v-if="dialog.body" class="body">{{ dialog.body }}</p>
            <ul v-if="dialog.details?.length" class="details"><li v-for="line in dialog.details" :key="line">{{ line }}</li></ul>
            <label v-if="dialog.input" class="field"><span>{{ dialog.input.label }}</span><input ref="field" v-model="value" class="input" :maxlength="dialog.input.maxLength" /></label>
            <label v-if="dialog.requireText" class="field"><span>{{ dialog.requireLabel ?? t('dialogTypeToConfirm', { text: dialog.requireText }) }}</span><input ref="field" v-model="value" class="input" autocomplete="off" spellcheck="false" /></label>
          </div>
          <footer>
            <button class="btn" type="button" @click="settleDialog(null)">{{ dialog.cancel }}</button>
            <button ref="confirmButton" class="btn" :class="dialog.danger ? 'btn-danger-solid' : 'btn-primary'" type="submit" :disabled="!canConfirm">{{ dialog.confirm }}</button>
          </footer>
        </form>
      </div>
    </Transition>
    <TransitionGroup name="toast" tag="div" class="toasts" aria-live="polite">
      <div v-for="item in toasts" :key="item.id" class="toast" :class="item.tone" role="status">
        <component :is="toastIcon[item.tone]" :size="17" class="toast-icon" />
        <span class="toast-text">{{ item.message }}</span>
        <button class="icon-btn" type="button" :aria-label="t('dismiss')" @click="dismissToast(item.id)"><X :size="14" /></button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.body { color: var(--text-secondary); line-height: 1.55; }
.details { margin: 0; padding-left: 18px; color: var(--text-secondary); font-size: 0.92rem; display: flex; flex-direction: column; gap: 4px; }
.btn-danger-solid { background: #b91c1c; border-color: #dc2626; color: #fff; }
.btn-danger-solid:hover:not(:disabled) { background: #dc2626; }
.btn-danger-solid:disabled { opacity: 0.45; }
.toasts { position: fixed; right: 18px; bottom: 18px; z-index: 150; display: flex; flex-direction: column; gap: 8px; width: min(380px, calc(100vw - 36px)); pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; border-radius: 10px; border: 1px solid var(--glass-border); background: rgba(12, 22, 39, 0.96); box-shadow: var(--shadow-medium); }
.toast-text { flex: 1; min-width: 0; font-size: 0.92rem; overflow-wrap: anywhere; user-select: text; }
.toast-icon { color: #93c5fd; flex-shrink: 0; }
.toast.ok .toast-icon { color: var(--ok); }
.toast.warn .toast-icon { color: var(--warning); }
.toast.error .toast-icon { color: #f87171; }
.toast-enter-active, .toast-leave-active { transition: opacity 180ms var(--ease), transform 180ms var(--ease); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(16px); }
</style>
