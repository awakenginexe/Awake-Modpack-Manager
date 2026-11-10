import { ref, shallowRef } from 'vue';
import type { ContentArea, ContentKind } from '../backend/contract';

/** What Browse is showing: mods go through a reviewed plan, resource packs and shaders install directly. */
export type BrowseKind = 'mod' | ContentKind;
export const browseKind = ref<BrowseKind>('mod');

/**
 * Set by a screen that may hold unsaved work (the file editor). Asked before another screen
 * replaces it; resolving false keeps the user where they are.
 */
export const leaveGuard = shallowRef<(() => Promise<boolean>) | null>(null);

/** The folder the Files page opens on; set by "Show in Files" elsewhere. */
export const filesArea = ref<ContentArea>('config');
