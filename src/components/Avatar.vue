<script setup lang="ts">
import { computed, ref, watch } from 'vue';

/** Project/instance icon. Falls back to a monogram with a stable per-name color. */
const props = withDefaults(defineProps<{ name: string; src?: string; size?: number }>(), { size: 40 });
const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });

const hue = computed(() => {
  let h = 0;
  for (const ch of props.name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
});
const initials = computed(() => {
  const words = props.name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
});
</script>

<template>
  <img v-if="src && !failed" :src="src" alt="" class="avatar" :style="{ width: `${size}px`, height: `${size}px` }" @error="failed = true" />
  <span
    v-else
    class="avatar mono"
    aria-hidden="true"
    :style="{
      width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px`,
      background: `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 40) % 360} 60% 26%))`,
    }"
  >{{ initials }}</span>
</template>

<style scoped>
.avatar { border-radius: 22%; flex-shrink: 0; object-fit: cover; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1); }
.mono { display: inline-grid; place-items: center; font-weight: 700; color: rgba(255, 255, 255, 0.95); letter-spacing: 0.02em; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); }
</style>
