import { createApp } from 'vue';
import App from './App.vue';
import { createLauncherClient } from './backend/LauncherClient';
import { MockBackend } from './backend/mock/MockBackend';
import type { ManagerBackend } from './backend/ManagerBackend';
import { createSession, SessionKey } from './state/session';
import './styles/tokens.css';
import './styles/base.css';

/**
 * Backend selection. Default is the mock: no live Launcher integration exists yet.
 * Dev scenarios: ?mock=drift (plan changes on prepare), ?mock=fail (apply rolls back),
 * ?mock=cf (CurseForge available). Combine with commas.
 */
function pickBackend(): ManagerBackend {
  if (import.meta.env.VITE_BACKEND === 'launcher') return createLauncherClient();
  const flags = new Set((new URLSearchParams(location.search).get('mock') ?? '').split(','));
  return new MockBackend({
    driftOnPrepare: flags.has('drift'),
    failApply: flags.has('fail'),
    providers: flags.has('cf') ? [{ id: 'modrinth', available: true }, { id: 'curseforge', available: true }] : undefined,
  });
}

const session = createSession(pickBackend());
createApp(App).provide(SessionKey, session).mount('#app');
void session.connect();
