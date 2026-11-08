import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHelperClient } from '../../src/backend/helper/HelperClient';
import { addChanges } from '../../src/domain/draft';
import { createSession } from '../../src/state/session';
import { nodeHelperTransport } from './nodeTransport';

const exe = process.env.AWAKE_SHARED_HELPER, profile = process.env.AWAKE_SHARED_PROFILE;
const phase = process.env.AWAKE_SHARED_PHASE;
describe.skipIf(!exe || !profile || !phase)('shared workspace runtime coordination', () => {
  it('blocks Manager during launch/game and changes the original files after normal game exit', async () => {
    const evidencePath = join(dirname(profile!), 'shared-workspace-evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    expect(realpathSync(join(profile!, 'workspaces', evidence.workspaceId))).toBe(evidence.root);
    const transport = nodeHelperTransport(exe!, profile!);
    const backend = createHelperClient({ transport, clientVersion: '0.2.0-beta.1', pollMs: 200, heartbeatMs: 0 });
    await backend.connect();
    if (phase === 'busy') {
      await expect(backend.listInstances('manager')).rejects.toMatchObject({ code: 'instance-busy' });
      evidence.gameOrLaunchExclusionVerified = true;
    } else {
      expect(phase).toBe('disable');
      const session = createSession(backend, { pollMs: 200 });
      await session.connect();
      expect(session.state.connectError, session.state.connectError?.message).toBeNull();
      expect(session.state.instances).toHaveLength(1);
      expect(session.state.instances[0]!.name).toBe('Shared Forge beta acceptance');
      await session.selectInstance(evidence.instanceId);
      const mod = session.inventory.value!.mods.find((m) => m.projectId === 'uXXizFIs')!;
      expect(mod.enabled).toBe(true);
      session.setDraft(addChanges(session.draft.value!, [{ kind: 'disable', modKey: mod.key }]));
      await session.validate();
      expect(session.review.phase, session.review.error?.message).toBe('reviewed');
      await session.apply();
      expect(session.review.phase, session.review.error?.message).toBe('done');
      const fileName = 'ferritecore-6.0.1-forge.jar';
      const file = join(evidence.root, '.minecraft/mods', fileName);
      expect(existsSync(file)).toBe(false);
      expect(createHash('sha256').update(readFileSync(file + '.disabled')).digest('hex')).toBe(evidence.hashes[fileName]);
      evidence.disabledMod = fileName;
      evidence.sameDirectoryMutationVerified = true;
    }
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  }, 90_000);
});
