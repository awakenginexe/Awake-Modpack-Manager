import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHelperClient } from '../../src/backend/helper/HelperClient';
import { addChanges } from '../../src/domain/draft';
import { createSession } from '../../src/state/session';
import { nodeHelperTransport } from './nodeTransport';

const exe = process.env.AWAKE_SHARED_HELPER, profile = process.env.AWAKE_SHARED_PROFILE;
// Explicit opt-in: creates one disposable workspace, never opens existing instances.
describe.skipIf(!exe || !profile)('shared workspace real Manager preparation', () => {
  it('creates Forge 1.20.1 and installs two real Modrinth mods through the Manager client', async () => {
    const transport = nodeHelperTransport(exe!, profile!);
    const backend = createHelperClient({ transport, clientVersion: '0.2.0-beta.1', pollMs: 200, requestTimeoutMs: 120_000, heartbeatMs: 0 });
    const session = createSession(backend, { pollMs: 200 });
    try {
      await session.connect();
      expect(session.state.connectError).toBeNull();
      const catalog = await backend.versionCatalog!({ minecraftVersion: '1.20.1', loader: 'forge' });
      expect(catalog.loaderVersions.length).toBeGreaterThan(0);
      const loaderVersion = catalog.loaderVersions.includes('47.4.28') ? '47.4.28' : catalog.loaderVersions[0]!;
      if (!session.state.instances.length) {
        const created = await session.createInstance({ name: 'Shared Forge beta acceptance', minecraftVersion: '1.20.1', loader: 'forge', loaderVersion });
        expect(created?.state, JSON.stringify(created?.error)).toBe('completed');
      }
      await session.refreshInstances();
      expect(session.state.instances).toHaveLength(1);
      const instance = session.state.instances[0]!;
      expect(instance.name).toBe('Shared Forge beta acceptance');
      await session.selectInstance(instance.id);
      const projects = [{ projectId: 'uXXizFIs', name: 'FerriteCore' }, { projectId: 'u6dRKJwZ', name: 'JEI' }];
      const changes = [];
      for (const project of projects) {
        if (session.inventory.value!.mods.some((mod) => mod.projectId === project.projectId)) continue;
        const versions = await backend.projectVersions!(instance.id, 'modrinth', project.projectId);
        expect(versions.length).toBeGreaterThan(0);
        changes.push({ kind: 'install' as const, provider: 'modrinth' as const, ...project, versionId: versions[0]!.id });
      }
      if (changes.length) {
        session.setDraft(addChanges(session.draft.value!, changes));
        await session.validate();
        expect(session.review.phase, session.review.error?.message).toBe('reviewed');
        await session.apply();
        expect(session.review.phase, session.review.error?.message).toBe('done');
      }
      await session.loadInventory();
      expect(session.inventory.value!.mods.map((mod) => mod.projectId)).toEqual(expect.arrayContaining(projects.map((p) => p.projectId)));
      const [workspaceId] = readdirSync(join(profile!, 'workspaces'));
      const root = realpathSync(join(profile!, 'workspaces', workspaceId!));
      const mods = readdirSync(join(root, '.minecraft/mods')).filter((n) => n.endsWith('.jar'));
      expect(mods.length).toBe(session.inventory.value!.mods.length);
      expect(mods.length).toBeLessThanOrEqual(5);
      const hashes = Object.fromEntries(mods.map((name) => [name, createHash('sha256').update(readFileSync(join(root, '.minecraft/mods', name))).digest('hex')]));
      writeFileSync(join(profile!, '..', 'shared-workspace-evidence.json'), JSON.stringify({ root, workspaceId, instanceId: instance.id,
        minecraftVersion: '1.20.1', loaderVersion, hashes, inventory: session.inventory.value }, null, 2));
    } finally { transport.kill(); }
  }, 240_000);
});
