import { computed, reactive } from 'vue';
import { isDesktopHost } from '../backend/launcher/transport';
import { hostInvoke } from '../backend/host';
import type { ManagerBackend } from '../backend/ManagerBackend';
import { includePrereleases } from './prefs';
import type { Session } from './session';

export interface AppRelease { tag: string; version: string; name: string; notes: string; url: string; publishedAt: string; prerelease: boolean; installerSize: number | null }
export interface AppUpdateInfo { current: string; latest: AppRelease | null; updateAvailable: boolean; canInstall: boolean }

export const appUpdate = reactive({
  checking: false,
  info: null as AppUpdateInfo | null,
  error: null as string | null,
  checkedAt: null as number | null,
  installing: false,
  progress: null as { done: number; total: number } | null,
  installError: null as string | null,
  dialogOpen: false,
});
export const updateAvailable = computed(() => !!appUpdate.info?.updateAvailable);
/** An installed copy with a published installer updates itself; a portable copy goes to the release page. */
export const canSelfUpdate = computed(() => !!appUpdate.info?.canInstall && !!appUpdate.info.latest?.installerSize);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function checkAppUpdate() {
  if (!isDesktopHost() || appUpdate.checking) return;
  appUpdate.checking = true;
  appUpdate.error = null;
  try {
    appUpdate.info = await hostInvoke<AppUpdateInfo>('update_check', { includePrereleases: includePrereleases.value });
    appUpdate.checkedAt = Date.now();
  } catch (e) {
    appUpdate.error = message(e);
  } finally {
    appUpdate.checking = false;
  }
}

export function startUpdateChecks() {
  if (!isDesktopHost()) return;
  setTimeout(() => void checkAppUpdate(), 4000);
  setInterval(() => void checkAppUpdate(), 6 * 3600_000);
}

export async function openExternal(url: string) {
  if (isDesktopHost()) await hostInvoke('open_url', { url });
  else window.open(url, '_blank', 'noopener');
}

const FINISHED_STATES = ['completed', 'failed', 'cancelled', 'rolled_back', 'prepared'];
export function workInProgress(session: Session) {
  return session.state.operations.some((o) => !FINISHED_STATES.includes(o.state));
}

/** What every update button does. The dialog stays up to show progress, an error, or the work that has to finish first. */
export async function updateNow(session: Session) {
  const release = appUpdate.info?.latest;
  if (!release || appUpdate.installing) return;
  if (!canSelfUpdate.value) {
    await openExternal(release.url);
    return;
  }
  appUpdate.dialogOpen = true;
  if (!workInProgress(session)) await installAppUpdate(session.backend);
}

/** Verify and start the installer, then close. The installer reopens the Manager when it finishes. */
export async function installAppUpdate(backend: ManagerBackend) {
  const release = appUpdate.info?.latest;
  if (!release || appUpdate.installing) return;
  appUpdate.installing = true;
  appUpdate.installError = null;
  appUpdate.progress = null;
  const { listen } = await import('@tauri-apps/api/event');
  const stop = await listen<{ done: number; total: number }>('update-progress', (e) => { appUpdate.progress = e.payload; });
  try {
    // The installer cannot replace a running helper's files.
    await backend.shutdownHelper?.();
    await hostInvoke('update_install', { tag: release.tag });
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().destroy();
  } catch (e) {
    appUpdate.installError = message(e);
    appUpdate.installing = false;
  } finally {
    stop();
  }
}
