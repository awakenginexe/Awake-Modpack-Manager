import { createApp } from 'vue';
import App from './App.vue';
import { createLauncherClient } from './backend/launcher/LauncherClient';
import { createHostTransport, isDesktopHost } from './backend/launcher/transport';
import { MockBackend } from './backend/mock/MockBackend';
import type { ManagerBackend } from './backend/ManagerBackend';
import { addedFolders, dataSource, preferredProfile } from './state/prefs';
import { createSession, SessionKey } from './state/session';
import pkg from '../package.json';
import './styles/tokens.css';
import './styles/base.css';

/**
 * Backend selection is explicit and never silent: the UI always labels demo data.
 * - Launcher: real Awake Launcher over its integration pipe (desktop app only).
 * - Demo: built-in sample data. Dev scenarios: ?mock=drift,fail,cf (forces demo).
 */
function pickBackend(): ManagerBackend {
  const flags = new URLSearchParams(location.search).get('mock');
  const demo = flags !== null || dataSource.value === 'demo' || (dataSource.value === 'auto' && !isDesktopHost());
  if (!demo) {
    return createLauncherClient({
      transport: isDesktopHost() ? createHostTransport() : null,
      clientVersion: pkg.version,
      addedFolders: addedFolders.value,
      preferredProfile: preferredProfile.value,
      heartbeatMs: 20_000,
    });
  }
  const set = new Set((flags ?? '').split(','));
  return new MockBackend({
    driftOnPrepare: set.has('drift'),
    failApply: set.has('fail'),
    providers: set.has('cf') ? [{ id: 'modrinth', available: true }, { id: 'curseforge', available: true }] : undefined,
  });
}

const session = createSession(pickBackend());
createApp(App).provide(SessionKey, session).mount('#app');
void session.connect();
