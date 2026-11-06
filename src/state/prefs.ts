import { ref, watch } from 'vue';
import { load, save } from '../domain/storage';

/** Manager-only display preferences, shared by the shell, settings and views. */
function pref<T>(key: string, fallback: T) {
  const r = ref<T>(load(key, fallback));
  watch(r, (v) => save(key, v));
  return r;
}

export const reducedMotion = pref('reducedMotion', false);
export const compactRows = pref('compactRows', false);
export const systemReducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
