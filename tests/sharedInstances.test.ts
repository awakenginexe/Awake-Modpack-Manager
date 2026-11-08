import { describe, expect, it, vi } from 'vitest';
import { createCompositeBackend } from '../src/backend/composite';
import { BackendError, type InstanceSummary } from '../src/backend/contract';
import type { ManagerBackend } from '../src/backend/ManagerBackend';

const hello = { contract: '1.0', launcherVersion: '', capabilities: [], providers: [], packProviders: [] };
const summary = (o: Partial<InstanceSummary>): InstanceSummary => ({ id: 'x', name: 'x', status: 'ready', manageable: true, revision: 'r', ...o });

function parts() {
  const steps: string[] = [];
  const helper = {
    kind: 'helper',
    connect: async () => hello,
    onConnectionChange: () => () => {},
    listInstallations: async () => [],
    listInstances: async () => [
      summary({ id: 'project', name: 'Own project' }),
      summary({ id: 'helper-pack', name: 'Pack', sharedRoot: 'E:\\Launcher\\instances\\Pack', modCount: 392 }),
    ],
    canAdopt: () => true,
    adoptInstance: vi.fn(async () => { steps.push('adopt'); }),
    releaseInstance: vi.fn(async () => { steps.push('release'); }),
    requestLaunch: vi.fn(),
    search: vi.fn(async () => ({ hits: [], total: 0 })),
  };
  const launcher = {
    kind: 'launcher',
    connect: async () => hello,
    onConnectionChange: () => () => {},
    listInstallations: async () => [],
    listInstances: async () => [
      summary({ id: 'launcher-pack', name: 'Pack', path: 'E:/launcher/instances/Pack', iconUrl: 'data:image/png;base64,AA==' }),
      summary({ id: 'launcher-other', name: 'Other', path: 'E:/launcher/instances/Other' }),
    ],
    canEnroll: () => true,
    enrollInstance: vi.fn(async (_id: string, phase: string) => { steps.push(phase); }),
    requestLaunch: vi.fn(async () => ({ operationId: 'launch-op' })),
    search: vi.fn(async () => { throw new BackendError('unsupported', 'no'); }),
  };
  const composite = createCompositeBackend(helper as unknown as ManagerBackend, launcher as unknown as ManagerBackend);
  return { helper, launcher, composite, steps };
}

async function connected() {
  const p = parts();
  await p.composite.connect();
  (p.composite.parts.launcher as { handshake: unknown }).handshake = hello;
  (p.composite.parts.helper as { handshake: unknown }).handshake = hello;
  return p;
}
const listOn = (c: ReturnType<typeof createCompositeBackend>, side: 'helper' | 'launcher') => {
  const id = side === 'helper' ? 'manager' : 'E:/launcher';
  Object.assign(c, { partFor: () => c.parts[side] });
  return c.listInstances(id);
};

describe('connected Launcher instances', () => {
  it('shows a connected instance once, on the Launcher list, with the Launcher image', async () => {
    const { composite } = await connected();
    const list = await listOn(composite, 'launcher');
    expect(list.map((i) => i.id)).toEqual(['helper-pack', 'launcher-other']);
    expect(list[0]).toMatchObject({ shared: true, modCount: 392, iconUrl: 'data:image/png;base64,AA==', path: 'E:/launcher/instances/Pack' });
  });

  it('keeps connected instances off the Manager projects list', async () => {
    const { composite } = await connected();
    expect((await listOn(composite, 'helper')).map((i) => i.id)).toEqual(['project']);
  });

  it('plays a connected instance through the Launcher, not the helper', async () => {
    const { composite, launcher, helper } = await connected();
    await listOn(composite, 'launcher');
    await expect(composite.requestLaunch('helper-pack', 'key')).resolves.toEqual({ operationId: 'launch-op' });
    expect(launcher.requestLaunch).toHaveBeenCalledWith('launcher-pack', 'key');
    expect(helper.requestLaunch).not.toHaveBeenCalled();
  });

  it('browses a connected instance through the helper', async () => {
    const { composite, helper, launcher } = await connected();
    await listOn(composite, 'launcher');
    await composite.search({ instanceId: 'helper-pack', text: '', provider: 'modrinth', minecraftVersion: '1.21.1', loader: 'fabric', releaseTypes: ['release'], compatibleOnly: true, offset: 0, limit: 20 });
    expect(helper.search).toHaveBeenCalledOnce();
    expect(launcher.search).not.toHaveBeenCalled();
  });

  it('holds the Launcher around connecting, and releases it if connecting fails', async () => {
    const ok = await connected();
    await listOn(ok.composite, 'launcher');
    await ok.composite.shareInstance!('launcher-other');
    expect(ok.steps).toEqual(['begin', 'adopt', 'finish']);

    const bad = await connected();
    await listOn(bad.composite, 'launcher');
    bad.helper.adoptInstance.mockRejectedValueOnce(new BackendError('rejected', 'no'));
    await expect(bad.composite.shareInstance!('launcher-other')).rejects.toThrow('no');
    expect(bad.steps).toEqual(['begin', 'abort']);
  });

  it('holds the Launcher around disconnecting', async () => {
    const { composite, steps } = await connected();
    await listOn(composite, 'launcher');
    await composite.stopSharingInstance!('helper-pack');
    expect(steps).toEqual(['begin', 'release', 'finish']);
  });
});
