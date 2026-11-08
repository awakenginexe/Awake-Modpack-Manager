import { expect, it, vi } from 'vitest';
import { createHelperClient } from '../src/backend/helper/HelperClient';
import { FakeCore } from './fixtures/fakeCore';

it('opens the selected Manager workspace by its registration, without exporting or launching it', async () => {
  const core = new FakeCore();
  const workspace = core.addWorkspace('Shared Forge');
  const openInLauncher = vi.fn(async (_workspaceId: string) => {});
  const client = createHelperClient({ transport: core, clientVersion: 'test', heartbeatMs: 0, openInLauncher });
  await client.connect();
  const [instance] = await client.listInstances('manager');
  expect(instance!.path).toBe(`C:/Temp/core-fixture/workspaces/${workspace.ws.workspaceId}`);
  await client.openInLauncher!(instance!.id);
  expect(openInLauncher).toHaveBeenCalledExactlyOnceWith(workspace.ws.workspaceId);
  await expect(client.openInLauncher!('unknown')).rejects.toThrow();
  expect(openInLauncher).toHaveBeenCalledTimes(1);
});
