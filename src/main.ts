import { createApp } from 'vue';
import App from './App.vue';
import { createLauncherClient } from './backend/launcher/LauncherClient';
import { createHelperClient } from './backend/helper/HelperClient';
import { createCompositeBackend } from './backend/composite';
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
 * - Real: the Manager's own native helper (standalone projects) plus Awake Launcher when it is
 *   installed, as two separate connections (desktop app only).
 * - Demo: built-in sample data. Dev scenarios: ?mock=drift,fail,cf (forces demo).
 * - Dev only (`npm run dev`): ?mock=core runs the real helper client against the protocol 2.0 test
 *   fixture, to check the standalone screens. Never part of a production build.
 */
function pickBackend(): ManagerBackend {
  const flags = new URLSearchParams(location.search).get('mock');
  const demo = flags !== null || dataSource.value === 'demo' || (dataSource.value === 'auto' && !isDesktopHost());
  if (!demo) {
    const transport = isDesktopHost() ? createHostTransport() : null;
    return createCompositeBackend(
      // Startup recovery can take a while; the host never kills a slow helper, it only waits.
      createHelperClient({ transport, clientVersion: pkg.version, heartbeatMs: 10_000, startTimeoutMs: 60_000 }),
      createLauncherClient({
        transport,
        clientVersion: pkg.version,
        addedFolders: addedFolders.value,
        preferredProfile: preferredProfile.value,
        heartbeatMs: 20_000,
      }),
    );
  }
  const set = new Set((flags ?? '').split(','));
  return new MockBackend({
    driftOnPrepare: set.has('drift'),
    failApply: set.has('fail'),
    providers: set.has('cf') ? [{ id: 'modrinth', available: true }, { id: 'curseforge', available: true }] : undefined,
  });
}

async function devCoreBackend(): Promise<ManagerBackend> {
  const { FakeCore } = await import('../tests/fixtures/fakeCore');
  const core = new FakeCore({ mods: 240 });
  return createCompositeBackend(
    createHelperClient({ transport: core, clientVersion: pkg.version, pollMs: 120 }),
    createLauncherClient({ transport: null, clientVersion: pkg.version }),
  );
}

const devCore = import.meta.env.DEV && new URLSearchParams(location.search).get('mock') === 'core';
void (async () => {
  const session = createSession(devCore ? await devCoreBackend() : pickBackend());
  createApp(App).provide(SessionKey, session).mount('#app');
  void session.connect();
})();
