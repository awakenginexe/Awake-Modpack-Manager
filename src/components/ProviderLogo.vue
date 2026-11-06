<script setup lang="ts">
import { FileQuestion } from '@lucide/vue';
import type { ModSource, PackProviderId } from '../backend/contract';
import { t } from '../i18n';
import modrinth from '../assets/providers/modrinth.svg';
import curseforge from '../assets/providers/curseforge.svg';
import ftb from '../assets/providers/ftb.svg';
import atlauncher from '../assets/providers/atlauncher.svg';
import technic from '../assets/providers/technic.svg';

const props = withDefaults(defineProps<{ provider: PackProviderId | ModSource; size?: number; label?: boolean }>(), { size: 18, label: false });

const logos: Record<PackProviderId, string> = { modrinth, curseforge, ftb, atlauncher, technic };
const names: Record<PackProviderId, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge', ftb: 'FTB', atlauncher: 'ATLauncher', technic: 'Technic' };
const name = () => (props.provider === 'manual' ? t('sourceManual') : names[props.provider]);
</script>

<template>
  <span class="provider" :title="label ? undefined : name()">
    <span class="mark" :style="{ width: `${size}px`, height: `${size}px` }">
      <FileQuestion v-if="provider === 'manual'" :size="size - 2" aria-hidden="true" />
      <img v-else :src="logos[provider]" alt="" :width="size" :height="size" />
    </span>
    <span v-if="label">{{ name() }}</span>
    <span v-else class="sr-only">{{ name() }}</span>
  </span>
</template>

<style scoped>
.provider { display: inline-flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; }
.mark { display: inline-grid; place-items: center; flex-shrink: 0; color: var(--text-secondary); }
.mark img { width: 100%; height: 100%; object-fit: contain; }
</style>
