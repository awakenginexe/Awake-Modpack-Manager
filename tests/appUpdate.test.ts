import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagerBackend } from '../src/backend/ManagerBackend';
import { appUpdate, installAppUpdate } from '../src/state/appUpdate';

const calls: string[] = [];
let failing: string | null = null;
vi.mock('../src/backend/host', () => ({ hostInvoke: async (name: string) => { calls.push(name); if (failing === name) throw new Error(`${name} failed`); } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ destroy: async () => { calls.push('close'); } }) }));

const release = { tag: 'v9.0.0', version: '9.0.0', name: '', notes: '', url: 'https://example.test', publishedAt: '', prerelease: false, installerSize: 10 };
const backend = (stop: () => Promise<void> = async () => undefined) => ({
  shutdownHelper: async () => { calls.push('stop'); await stop(); },
  resumeHelper: () => { calls.push('resume'); },
}) as unknown as ManagerBackend;

beforeEach(() => {
  calls.length = 0;
  failing = null;
  Object.assign(appUpdate, { installing: false, installError: null, info: { current: '1.0.0', latest: release, updateAvailable: true, canInstall: true } });
});
afterEach(() => { appUpdate.info = null; });

describe('installing an update', () => {
  it('downloads, then stops the helper, then starts the installer', async () => {
    await installAppUpdate(backend());
    expect(calls).toEqual(['update_download', 'stop', 'update_run', 'close']);
  });

  it('leaves the helper running when the download fails', async () => {
    failing = 'update_download';
    await installAppUpdate(backend());
    expect(calls).toEqual(['update_download']);
    expect(appUpdate.installError).toContain('update_download failed');
    expect(appUpdate.installing).toBe(false);
  });

  it('stays open and explains when the helper will not stop', async () => {
    await installAppUpdate(backend(async () => { throw new Error('BUSY'); }));
    expect(calls).toEqual(['update_download', 'stop']);
    expect(appUpdate.installError).toContain('did not start');
  });

  it('lets the helper start again when the installer cannot run', async () => {
    failing = 'update_run';
    await installAppUpdate(backend());
    expect(calls).toEqual(['update_download', 'stop', 'update_run', 'resume']);
    expect(appUpdate.installing).toBe(false);
  });
});
