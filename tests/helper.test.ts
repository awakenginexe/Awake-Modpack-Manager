import { afterEach, describe, expect, it } from 'vitest';
import { BackendError } from '../src/backend/contract';
import { createCompositeBackend } from '../src/backend/composite';
import { check, CORE_CONTRACT_COMMIT, paramsError } from '../src/backend/core/schema';
import { createHelperClient } from '../src/backend/helper/HelperClient';
import { createLauncherClient } from '../src/backend/launcher/LauncherClient';
import { addChange, addChanges } from '../src/domain/draft';
import { createSession } from '../src/state/session';
import { FakeCore } from './fixtures/fakeCore';
import { FakeLauncher } from './fixtures/fakeLauncher';

const helper = (core: FakeCore, extra: { heartbeatMs?: number } = {}) => createHelperClient({ transport: core, clientVersion: 'test', pollMs: 1, ...extra });
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let core: FakeCore;
afterEach(() => expect(core?.violations ?? []).toEqual([]));

/** Session over the helper, with one Fabric workspace selected. */
async function standalone(c = new FakeCore()) {
  core = c;
  if (!core.workspaces.size) core.addWorkspace('My pack');
  const session = createSession(helper(core), { pollMs: 1 });
  await session.connect();
  await session.selectInstance(session.state.instances[0]!.id);
  return session;
}

describe('core protocol 2.0 schema (pinned)', () => {
  it('is pinned to the committed contract and enforces it', () => {
    expect(CORE_CONTRACT_COMMIT).toMatch(/^861cebc1a/);
    expect(paramsError('workspaces.create', { idempotencyKey: 'k', name: 'x', minecraftVersion: '1.21.1', loader: { id: 'forge', version: '1' } })).toMatch(/loader\.id/);
    expect(paramsError('workspaces.create', { idempotencyKey: 'k', name: 'x', minecraftVersion: '1.21.1', loader: { id: 'fabric', version: '0.16.9' }, extra: 1 })).toMatch(/not allowed/);
    expect(paramsError('plans.prepare', { idempotencyKey: 'k', physicalId: 'p', instanceRevision: 'a'.repeat(64), changes: [] })).toMatch(/too few/);
    expect(check({ $ref: '#/$defs/accepted' }, { operationId: '00000000-0000-4000-8000-000000000000', state: 'completed', terminal: false, replayed: false })).toMatch(/terminal/);
  });
});

describe('HelperClient protocol 2.0 (fixture)', () => {
  it('handshakes, maps advertised capabilities, and reads every page of a 300-mod workspace', async () => {
    core = new FakeCore({ mods: 300 });
    const c = helper(core);
    const hs = await c.connect();
    expect(hs.contract).toBe('2.0');
    expect(hs.capabilities).toEqual(expect.arrayContaining(['instances.list', 'instances.create', 'providers.search', 'plan.validate', 'plan.apply', 'operations.cancel', 'recovery.status']));
    expect(hs.providers).toEqual([{ id: 'modrinth', available: true, unavailableReason: undefined }, { id: 'curseforge', available: false, unavailableReason: 'helper-modrinth-only' }]);
    const [ws] = await c.listInstances('manager');
    expect(ws).toMatchObject({ name: 'Big pack', minecraftVersion: '1.21.1', loader: { kind: 'fabric', version: '0.16.9' } });
    let progress = 0;
    const inv = await c.getInventory(ws!.id, (n) => { progress = n; });
    expect(inv.mods).toHaveLength(300);
    expect(progress).toBe(300);
    expect(core.log.filter((l) => l.method === 'mods.list')).toHaveLength(2); // 200 + 100
  });

  it('gives a stub helper reads only, whatever it advertises', async () => {
    core = new FakeCore();
    core.stub = true;
    const hs = await helper(core).connect();
    expect(hs.stub).toBe(true);
    expect(hs.capabilities).not.toEqual(expect.arrayContaining(['instances.create']));
    expect(hs.capabilities.some((c) => c.startsWith('plan.'))).toBe(false);
  });

  it('refuses a wrong role, an invalid descriptor, and a reply with fields outside the contract', async () => {
    core = new FakeCore();
    core.helloRole = 'launcher';
    await expect(helper(core).connect()).rejects.toMatchObject({ code: 'protocol' }); // role is a schema const
    core = new FakeCore();
    core.sessionId = 'not-a-uuid';
    await expect(helper(core).connect()).rejects.toMatchObject({ code: 'helper-unavailable', detail: 'descriptor' });
    core = new FakeCore();
    const c = helper(core);
    await c.connect();
    core.extraFieldNext = true;
    await expect(c.listInstances('manager')).rejects.toMatchObject({ code: 'protocol' });
    core.violations = [];
  });

  it('never sends a request the contract forbids', async () => {
    core = new FakeCore();
    const c = helper(core);
    await c.connect();
    await expect(c.createInstance({ name: 'x', minecraftVersion: '1.21.1', loader: 'forge', idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'unsupported' });
    expect(core.log.some((l) => l.method === 'workspaces.create')).toBe(false);
  });

  it('creates a workspace from the catalog and selects nothing until it is completed', async () => {
    core = new FakeCore();
    const session = createSession(helper(core), { pollMs: 1 });
    await session.connect();
    const cat = await session.backend.versionCatalog!({ minecraftVersion: '1.21.1', loader: 'fabric' });
    expect(cat).toEqual({ minecraftVersions: ['1.21.1', '1.20.1'], loaderVersions: ['0.16.9', '0.16.5'], loaders: ['vanilla', 'fabric'] });
    const final = await session.createInstance({ name: 'Fresh', minecraftVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.9' });
    expect(final?.state).toBe('completed');
    expect(final?.result?.instanceId).toMatch(/^core\|phys-/);
    await session.refreshInstances();
    expect(session.state.instances.map((i) => i.name)).toEqual(['Fresh']);
    expect(core.log.find((l) => l.method === 'workspaces.create')?.params.loader).toEqual({ id: 'fabric', version: '0.16.9' });
  });

  it('searches Modrinth, reviews the exact plan with its required dependency, applies it and shows the new inventory', async () => {
    const session = await standalone();
    const page = await session.backend.search({ text: 'sod', provider: 'modrinth', minecraftVersion: '1.21.1', loader: 'fabric', releaseTypes: ['release'], compatibleOnly: true, offset: 0, limit: 20 });
    expect(page.hits.map((h) => h.name)).toEqual(['Sodium']);
    const versions = await session.backend.projectVersions!(session.state.instanceId!, 'modrinth', 'sodium');
    expect(versions.map((v) => v.versionNumber)).toEqual(['0.6.0', '0.5.0']);
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'sodium', name: 'Sodium', versionId: 'sodV1' }));

    await session.validate();
    expect(session.review.phase).toBe('reviewed');
    const plan = session.review.plan!;
    expect(plan.items.map((i) => [i.action, i.name])).toEqual([['install', 'sodium-0.5.0.jar'], ['install', 'fabricapi-0.100.0.jar']]);
    expect(plan.issues.some((i) => i.code === 'dependency-included' && i.message.includes('fabricapi'))).toBe(true);
    expect(core.log.find((l) => l.method === 'plans.prepare')?.params.changes).toEqual([{ action: 'install', projectId: 'sodium', versionId: 'sodV1' }]);

    await session.apply();
    expect(session.review.phase).toBe('done');
    await wait();
    expect(session.inventory.value!.mods.map((m) => m.name).sort()).toEqual(['fabricapi-0.100.0', 'sodium-0.5.0']);
    // The update check now offers sodium 0.6.0.
    expect(session.inventory.value!.mods.find((m) => m.projectId === 'sodium')?.available?.id).toBe('sodV2');
  });

  it('updates, disables and removes through new reviewed plans', async () => {
    const c = new FakeCore();
    const e = c.addWorkspace('Pack');
    e.mods = [c.installed('a', 'sodium', 'sodV1', '0.5.0'), c.installed('b', 'fabricapi', 'fapiV1', '0.100.0'), c.installed('c', null, null, null)];
    const session = await standalone(c);
    const sodium = session.inventory.value!.mods.find((m) => m.projectId === 'sodium')!;
    session.setDraft(addChanges(session.draft.value!, [
      { kind: 'update', modKey: sodium.key, targetVersionId: 'sodV2' },
      { kind: 'disable', modKey: 'b' },
      { kind: 'remove', modKey: 'c' },
    ]));
    await session.validate();
    expect(core.log.find((l) => l.method === 'plans.prepare')?.params.changes).toEqual([
      { action: 'replace', projectId: 'sodium', versionId: 'sodV2' }, { action: 'disable', inventoryId: 'b' }, { action: 'remove', inventoryId: 'c' },
    ]);
    await session.apply();
    expect(session.review.phase).toBe('done');
    await wait();
    const mods = session.inventory.value!.mods;
    expect(mods.find((m) => m.projectId === 'sodium')?.installed?.id).toBe('sodV2');
    expect(mods.find((m) => m.key === 'b')?.enabled).toBe(false);
    expect(mods.some((m) => m.key === 'c')).toBe(false);
  });

  it('stops on a stale revision instead of preparing against changed files', async () => {
    const session = await standalone();
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'lithium', name: 'Lithium' }));
    [...core.workspaces.values()][0]!.ws.instanceRevision = 'f'.repeat(64);
    await session.validate();
    expect(session.review.phase).toBe('stale');
  });

  it('chooses the newest release when no version was picked, and the plan shows it before anything is applied', async () => {
    const session = await standalone();
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'lithium', name: 'Lithium' }));
    await session.validate();
    expect(core.log.find((l) => l.method === 'plans.prepare')?.params.changes).toEqual([{ action: 'install', projectId: 'lithium', versionId: 'litV1' }]); // beta litV2 skipped
    expect(session.review.plan!.items[0]!.name).toBe('lithium-0.12.0.jar');
    expect([...core.workspaces.values()][0]!.mods).toHaveLength(0);
  });

  it('resends a lost Apply with the same key and gets one operation', async () => {
    const session = await standalone();
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'fabricapi', name: 'Fabric API', versionId: 'fapiV1' }));
    await session.validate();
    core.dropReplyFor = 'transactions.apply';
    await session.apply();
    expect(session.review.phase).toBe('done');
    const applies = core.log.filter((l) => l.method === 'transactions.apply');
    expect(applies.length).toBe(2);
    expect(applies[0]!.params).toEqual(applies[1]!.params);
  });

  it('reports a rolled-back apply as failed with the helper message and leaves the inventory unchanged', async () => {
    const session = await standalone();
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'fabricapi', name: 'Fabric API', versionId: 'fapiV1' }));
    await session.validate();
    core.failApplyNext = true;
    await session.apply();
    expect(session.review.phase).toBe('failed');
    expect(session.review.operation?.state).toBe('rolled_back');
    expect(session.review.operation?.error?.message).toMatch(/nothing was changed/);
    expect(session.inventory.value!.mods).toHaveLength(0);
  });

  it('surfaces recovery and runs the rollback the helper allows', async () => {
    const session = await standalone();
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'fabricapi', name: 'Fabric API', versionId: 'fapiV1' }));
    await session.validate();
    core.recoveryNext = true;
    await session.apply();
    const op = session.review.operation!;
    expect(op.state).toBe('recovery_required');
    expect((await session.backend.getRecoveryStatus(session.state.instanceId!)).pending).toBe(true);
    const { operationId } = await session.backend.runRecovery!(op.operationId, crypto.randomUUID());
    let s = await session.backend.getOperation(operationId);
    while (!['rolled_back', 'failed'].includes(s.state)) s = await session.backend.getOperation(operationId);
    expect(s.state).toBe('rolled_back');
  });

  it('cancels a superseded prepared plan instead of leaving it pending', async () => {
    const session = await standalone();
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'fabricapi', name: 'Fabric API', versionId: 'fapiV1' }));
    await session.validate();
    const first = session.review.plan!.planId;
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'lithium', name: 'Lithium', versionId: 'litV1' }));
    await session.validate();
    expect(core.log.some((l) => l.method === 'operations.cancel' && l.params.operationId === first)).toBe(true);
  });

  it('restarts a crashed helper on the heartbeat', async () => {
    core = new FakeCore();
    const c = helper(core, { heartbeatMs: 5 });
    await c.connect();
    core.crash();
    await wait(60);
    expect(core.log.filter((l) => l.method === 'hello').length).toBeGreaterThanOrEqual(2);
    expect(await c.listInstances('manager')).toEqual([]);
  });

  it('waits while the helper starts and reports a missing helper clearly', async () => {
    core = new FakeCore();
    core.states = ['starting', 'starting'];
    await helper(core).connect();
    core.states = ['not_installed'];
    await expect(helper(core).connect()).rejects.toMatchObject({ code: 'helper-unavailable', detail: 'not_installed' });
    await expect(createHelperClient({ transport: null, clientVersion: 't' }).connect()).rejects.toBeInstanceOf(BackendError);
  });
});

describe('composite backend: standalone helper + optional Launcher', () => {
  it('works without the Launcher, waits for it on its own installation, and routes each call to one side', async () => {
    core = new FakeCore();
    core.addWorkspace('Standalone');
    const launcher = new FakeLauncher({ running: false });
    const session = createSession(createCompositeBackend(helper(core), createLauncherClient({ transport: launcher, clientVersion: 't', heartbeatMs: 0 }), { retryMs: 5 }), { pollMs: 1 });
    await session.connect();
    expect(session.state.installations.map((i) => [i.id, i.available])).toEqual([['manager', true], ['C:\\Temp\\fixture-profile', false]]);
    expect(session.source.value).toBe('helper');
    expect(session.can('plan.apply')).toBe(true);
    expect(session.state.instances.map((i) => i.name)).toEqual(['Standalone']);

    session.state.installationId = 'C:\\Temp\\fixture-profile';
    await session.refreshInstances();
    expect(session.source.value).toBe('launcher');
    expect(session.state.waitingForLauncher).toBe(true);
    expect(session.can('plan.apply')).toBe(false);

    launcher.start();
    await wait(80);
    expect(session.state.waitingForLauncher).toBe(false);
    await session.refreshInstances();
    expect(session.state.instances.length).toBe(2);
    const before = core.log.length;
    await session.selectInstance(session.state.instances[0]!.id);
    expect(launcher.log.at(-1)?.method).toBe('mods.list');
    expect(core.log.length).toBe(before); // the helper never saw the Launcher instance
  });

  it('reports the helper error when neither side is reachable', async () => {
    core = new FakeCore();
    core.states = ['not_installed'];
    const backend = createCompositeBackend(helper(core), createLauncherClient({ transport: new FakeLauncher({ running: false }), clientVersion: 't', heartbeatMs: 0 }), { retryMs: 100000 });
    await expect(backend.connect()).rejects.toMatchObject({ code: 'helper-unavailable' });
  });
});
