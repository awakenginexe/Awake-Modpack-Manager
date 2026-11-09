import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(CORE_CONTRACT_COMMIT).toMatch(/^4ec20f38/);
    expect(paramsError('workspaces.create', { idempotencyKey: 'k', name: 'x', minecraftVersion: '1.21.1', loader: { id: 'liteloader', version: '1' } })).toMatch(/loader\.id/);
    // 0.2 methods are in x-methods at this pin, including the new lookup and config outbox.
    expect(paramsError('providers.project', { provider: 'modrinth', projectId: 'AANobbMI' })).toBeNull();
    expect(paramsError('outbox.list', { physicalId: 'p', instanceRevision: 'a'.repeat(64), path: 'x' })).toMatch(/not allowed/);
    expect(paramsError('imports.inspect', { token: '00000000-0000-4000-8000-000000000000', format: 'zip' })).toMatch(/format/);
    expect(paramsError('inbox.discard', { token: '00000000-0000-4000-8000-000000000000' })).toBeNull();
    expect(paramsError('hello', { versions: [{ major: 2, minor: 0 }], client: { name: 'x', version: '1' }, extensions: ['manager.v0.3'] })).toMatch(/extensions/);
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
    expect(hs.providers).toEqual([{ id: 'modrinth', available: true, unavailableReason: undefined }, { id: 'curseforge', available: false, unavailableReason: 'curseforge-disabled' }]);
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
    // A loader version is required for every loader but vanilla; never sent empty.
    await expect(c.createInstance({ name: 'x', minecraftVersion: '1.21.1', loader: 'forge', idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'rejected' });
    expect(core.log.some((l) => l.method === 'workspaces.create')).toBe(false);
    // A loader the helper does not advertise is refused before anything is sent.
    core = new FakeCore();
    core.extCaps['loaders.quilt.v1'] = false;
    const d = helper(core);
    await d.connect();
    await expect(d.createInstance({ name: 'x', minecraftVersion: '1.21.1', loader: 'quilt', loaderVersion: '0.26.0', idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'unsupported' });
    expect(core.log.some((l) => l.method === 'workspaces.create')).toBe(false);
  });

  it('creates a workspace from the catalog and selects nothing until it is completed', async () => {
    core = new FakeCore();
    const session = createSession(helper(core), { pollMs: 1 });
    await session.connect();
    const cat = await session.backend.versionCatalog!({ minecraftVersion: '1.21.1', loader: 'fabric' });
    expect(cat).toEqual({ minecraftVersions: ['1.21.1', '1.20.1'], loaderVersions: ['0.16.9', '0.16.5'], loaders: ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'] });
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
    // Friendly names: remembered from search, and looked up with providers.project for the dependency.
    expect(session.inventory.value!.mods.map((m) => m.name).sort()).toEqual(['Fabric API', 'Sodium']);
    expect(core.log.filter((l) => l.method === 'providers.project').map((l) => l.params.projectId)).toEqual(['fabricapi']);
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
    // File-level remove+install of a renamed JAR is shown as one disable; bookkeeping is one note.
    expect(session.review.plan!.items.map((i) => [i.action, i.name])).toEqual([['update', 'sodium-0.6.0.jar'], ['disable', 'fabricapi-0.100.0.jar'], ['remove', 'c-x.jar']]);
    expect(session.review.plan!.issues.some((i) => i.severity === 'info' && i.message.includes('.awake-integration/policies.json'))).toBe(true);
    await session.apply();
    expect(session.review.phase).toBe('done');
    await wait();
    const mods = session.inventory.value!.mods;
    expect(mods.find((m) => m.projectId === 'sodium')?.installed?.id).toBe('sodV2');
    expect(mods.find((m) => m.key === 'b')?.enabled).toBe(false);
    expect(mods.some((m) => m.key === 'c')).toBe(false);
  });

  it('cancels a prepared plan left by an earlier Manager run, so the helper can exit when idle', async () => {
    const first = await standalone();
    first.setDraft(addChange(first.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'lithium', name: 'Lithium' }));
    await first.validate();
    const planId = first.review.plan!.planId;
    expect((await first.backend.getOperation(planId)).state).toBe('prepared');
    const next = createSession(helper(core), { pollMs: 1 });
    await next.connect();
    expect(core.log.some((l) => l.method === 'operations.cancel' && l.params.operationId === planId)).toBe(true);
    expect((await next.backend.getOperation(planId)).state).toBe('cancelled');
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

  it('keeps a helper stopped for an update from being restarted', async () => {
    core = new FakeCore({ caps: { 'core.shutdown': true } });
    const c = helper(core, { heartbeatMs: 5 });
    await c.connect();
    await c.shutdownHelper!();
    expect(core.log.some((l) => l.method === 'core.shutdown')).toBe(true);
    const hellos = () => core.log.filter((l) => l.method === 'hello').length;
    const before = hellos();
    core.crash();
    await wait(40);
    expect(hellos()).toBe(before);
    await expect(c.listInstances('manager')).rejects.toBeInstanceOf(BackendError);
    c.resumeHelper!();
    expect(await c.listInstances('manager')).toEqual([]);
    expect(hellos()).toBeGreaterThan(before);
  });

  it('reports a helper that will not stop, and keeps using it', async () => {
    core = new FakeCore({ caps: { 'core.shutdown': true } });
    core.shutdownBusy = true;
    const c = helper(core);
    await c.connect();
    await expect(c.shutdownHelper!()).rejects.toBeInstanceOf(BackendError);
    expect(core.log.filter((l) => l.method === 'core.shutdown').length).toBeGreaterThan(1);
    expect(await c.listInstances('manager')).toEqual([]);
  });

  it('cancels unapplied plans before stopping for an update', async () => {
    const session = await standalone(new FakeCore({ caps: { 'core.shutdown': true } }));
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'fabricapi', name: 'Fabric API', versionId: 'fapiV1' }));
    await session.validate();
    const plan = session.review.plan!.planId;
    await session.backend.shutdownHelper!();
    const names = core.log.map((l) => l.method);
    expect(core.log.some((l) => l.method === 'operations.cancel' && l.params.operationId === plan)).toBe(true);
    expect(names.lastIndexOf('operations.cancel')).toBeLessThan(names.lastIndexOf('core.shutdown'));
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


describe('manager.v0.2 negotiation and features (fixture)', () => {
  beforeEach(() => localStorage.clear());
  const blob = (n: number) => new Blob([new Uint8Array(n).map((_, i) => i % 251)]);

  it('negotiates manager.v0.2 and exposes Forge/NeoForge/Quilt, policies and import', async () => {
    core = new FakeCore();
    core.evidence = false; // a 0.2.0 helper refuses the newer offer; the client asks again with manager.v0.2
    const c = helper(core);
    const hs = await c.connect();
    expect(core.log[0]).toMatchObject({ method: 'hello', params: { extensions: ['manager.v0.2.1'] } });
    expect(core.log[1]).toMatchObject({ method: 'hello', params: { extensions: ['manager.v0.2'] } });
    expect(c.canResolveDependencies?.()).toBe(false);
    expect(hs.capabilities).toEqual(expect.arrayContaining(['mods.policies', 'packs.import', 'instances.create']));
    const cat = await c.versionCatalog!({ minecraftVersion: '1.20.1', loader: 'forge' });
    expect(cat.loaderVersions).toContain('47.4.28');
    const acc = await c.createInstance({ name: 'Forge pack', minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.28', idempotencyKey: 'k1' });
    expect(acc.operationId).toBeTruthy();
    expect(core.log.find((l) => l.method === 'workspaces.create')?.params.loader).toEqual({ id: 'forge', version: '47.4.28' });
  });

  it('falls back to the 0.1 contract when an older helper rejects the extension, and never sends 0.2 requests', async () => {
    core = new FakeCore();
    core.legacy = true;
    const session = createSession(helper(core), { pollMs: 1 });
    await session.connect();
    const hellos = core.log.filter((l) => l.method === 'hello');
    expect(hellos.map((h) => 'extensions' in h.params)).toEqual([true, true, false]);
    expect(session.state.handshake!.capabilities).not.toContain('mods.policies');
    expect(session.state.handshake!.capabilities).not.toContain('packs.import');
    expect(session.state.handshake!.capabilities).toContain('instances.create');
    expect((await session.backend.versionCatalog!({})).loaders).toEqual(['vanilla', 'fabric']);
    await expect(session.backend.createInstance({ name: 'x', minecraftVersion: '1.20.1', loader: 'forge', loaderVersion: '47.4.28', idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(session.backend.uploadImport!(blob(10))).rejects.toMatchObject({ code: 'unsupported' });
    expect(core.log.some((l) => /^(inbox|imports)\./.test(l.method) || (l.method === 'workspaces.create'))).toBe(false);
    // Existing Vanilla/Fabric Modrinth workflow still works unchanged.
    core.addWorkspace('Legacy');
    await session.refreshInstances();
    await session.selectInstance(session.state.instances[0]!.id);
    session.setDraft(addChange(session.draft.value!, { kind: 'install', provider: 'modrinth', projectId: 'lithium', name: 'Lithium', versionId: 'litV1' }));
    await session.validate();
    await session.apply();
    expect(session.review.phase).toBe('done');
    expect(core.log.find((l) => l.method === 'plans.prepare')?.params.changes).toEqual([{ action: 'install', projectId: 'lithium', versionId: 'litV1' }]);
  });

  it('keeps CurseForge off unless the helper authorizes it', async () => {
    core = new FakeCore();
    let c = helper(core);
    let hs = await c.connect();
    expect(hs.providers.find((p) => p.id === 'curseforge')).toMatchObject({ available: false, unavailableReason: 'curseforge-disabled' });
    core.addWorkspace('P');
    const [w] = await c.listInstances('manager');
    await expect(c.projectVersions!(w!.id, 'curseforge', '123')).rejects.toMatchObject({ code: 'unsupported' });
    expect(core.log.some((l) => l.params.provider === 'curseforge')).toBe(false);
    core = new FakeCore();
    core.extCaps['providers.curseforge.v1'] = true;
    c = helper(core);
    hs = await c.connect();
    expect(hs.providers.find((p) => p.id === 'curseforge')?.available).toBe(true);
  });

  it('uploads in bounded chunks, inspects, creates the exact workspace, prepares a full plan with overrides and applies it', async () => {
    core = new FakeCore();
    const session = createSession(helper(core), { pollMs: 1 });
    await session.connect();
    const b = session.backend;
    const progress: number[] = [];
    const token = await b.uploadImport!(blob(600_000), (n) => progress.push(n));
    const writes = core.log.filter((l) => l.method === 'inbox.write');
    expect(writes.map((w) => w.params.offset)).toEqual(['0', '262144', '524288']);
    expect(progress.at(-1)).toBe(600_000);
    const ins = await b.inspectImport!(token, 'mrpack');
    expect(ins).toMatchObject({ minecraftVersion: '1.20.1', loader: { kind: 'forge', version: '47.4.28' }, files: [{ path: 'config/example.toml', size: 12 }] });
    const created = await session.createInstance({ name: 'Imported', minecraftVersion: ins.minecraftVersion, loader: ins.loader.kind, loaderVersion: ins.loader.version });
    const id = created!.result!.instanceId!;
    await session.refreshInstances();
    const plan = await session.prepareImport(id, token, 'mrpack', false, 'pack.mrpack');
    expect(core.log.find((l) => l.method === 'imports.prepare')?.params).toMatchObject({ token, format: 'mrpack', includeOptional: false });
    expect(plan.items.map((i) => [i.action, i.name])).toEqual(expect.arrayContaining([['install', 'sodium-0.5.0.jar'], ['override', 'config/example.toml']]));
    expect(core.uploads.get(token)?.discarded).toBe(true); // staged: the upload is no longer needed
    expect(session.review.origin).toBe('pack.mrpack');
    await session.apply();
    expect(session.review.phase).toBe('done');
    expect(core.log.find((l) => l.method === 'transactions.apply')?.params).toMatchObject({ operationId: plan.planId, planDigest: plan.planHash });
  });

  it('imports and snapshots through the composite backend the desktop app uses', async () => {
    core = new FakeCore();
    const backend = createCompositeBackend(helper(core), createLauncherClient({ transport: new FakeLauncher({ running: false }), clientVersion: 't', heartbeatMs: 0 }), { retryMs: 100000 });
    const session = createSession(backend, { pollMs: 1 });
    await session.connect();
    expect(session.can('packs.import')).toBe(true);
    expect(backend.canImport!()).toBe(true);
    const token = await backend.uploadImport!(blob(1000));
    const ins = await backend.inspectImport!(token, 'mrpack');
    const made = await session.createInstance({ name: 'Composite import', minecraftVersion: ins.minecraftVersion, loader: ins.loader.kind, loaderVersion: ins.loader.version });
    await session.refreshInstances();
    await session.prepareImport(made!.result!.instanceId!, token, 'mrpack', false, 'c.mrpack');
    await session.apply();
    expect(session.review.phase).toBe('done');
    const snap = await backend.snapshotWorkspace!(made!.result!.instanceId!);
    expect(snap.mods.map((m) => m.projectId)).toEqual(['sodium', 'fabricapi']);
  });

  it('reports an unsupported archive (ZIP64) as invalid-archive and discards the upload', async () => {
    core = new FakeCore();
    core.inspectError = 'INVALID_ARCHIVE';
    const c = helper(core);
    await c.connect();
    const token = await c.uploadImport!(blob(100));
    await expect(c.inspectImport!(token, 'mrpack')).rejects.toMatchObject({ code: 'invalid-archive' });
  });

  it('discards uploads abandoned by an earlier run on the next start', async () => {
    core = new FakeCore();
    const c1 = helper(core);
    await c1.connect();
    const token = await c1.uploadImport!(blob(100)); // never inspected or discarded
    const c2 = helper(core);
    await c2.connect();
    expect(core.uploads.get(token)?.discarded).toBe(true);
  });

  it('pins and excludes through reviewed policy changes stored by the helper', async () => {
    const c = new FakeCore();
    const e = c.addWorkspace('Pack');
    e.mods = [c.installed('a', 'sodium', 'sodV1', '0.5.0'), c.installed('m', null, null, null)];
    const session = await standalone(c);
    expect(session.policies.value).toBe(true);
    session.setPinned(['a', 'm'], true); // the manual file has no version to pin and is skipped
    session.setExcluded(['a'], true);
    expect(session.draft.value!.changes).toEqual([{ kind: 'policy', modKey: 'a', pinned: true, excluded: true }]);
    await session.validate();
    expect(core.log.find((l) => l.method === 'plans.prepare')?.params.changes).toEqual([{ action: 'policy', inventoryId: 'a', pinnedVersion: 'sodV1', excluded: true }]);
    expect(session.review.plan!.items.map((i) => i.action)).toEqual(['policy']);
    await session.apply();
    expect(session.review.phase).toBe('done');
    await wait();
    const a = session.inventory.value!.mods.find((m) => m.key === 'a')!;
    expect(a.updateLocked).toBe(true);
    expect(a.updateExcluded).toBe(true);
    // manager.v0.2 reads pin and exclusion back separately: still pinned while excluded.
    expect(session.pinned.value.has('a')).toBe(true);
    session.setExcluded(['a'], false); // including again keeps the pin
    expect(session.draft.value!.changes).toEqual([{ kind: 'policy', modKey: 'a', pinned: true, excluded: false }]);
    session.discardDraft();
    // A pin alone reads back as pinned; pinning it again is no change.
    session.setPinned(['a'], true);
    session.setExcluded(['a'], false);
    await session.validate();
    await session.apply();
    await wait();
    expect(session.pinned.value.has('a')).toBe(true);
    session.setPinned(['a'], true);
    expect(session.draft.value!.changes).toEqual([]);
  });

  it('snapshots a workspace into exportable provider references and reports what it left out', async () => {
    const c = new FakeCore();
    const e = c.addWorkspace('Pack');
    e.mods = [c.installed('a', 'sodium', 'sodV1', '0.5.0'), c.installed('b', 'lithium', 'litV1', '0.12.0', false), c.installed('m', null, null, null)];
    e.mods[1]!.metadataState = 'verified';
    const session = await standalone(c);
    const snap = await session.backend.snapshotWorkspace!(session.state.instanceId!);
    expect(snap.mods.map((m) => [m.projectId, m.versionId, m.enabled])).toEqual([['sodium', 'sodV1', true], ['lithium', 'litV1', false]]);
    expect(snap.mods[0]!.url).toMatch(/^https:\/\/cdn\.modrinth\.com\//);
    expect(snap.skipped).toEqual([{ fileName: 'm-x.jar', reason: 'manual' }]);
    expect(snap.configs).toEqual([]);
  });

  it('keeps exporting past a mod whose author turned off third-party distribution', async () => {
    const c = new FakeCore();
    c.addWorkspace('Pack').mods = [c.installed('a', 'sodium', 'sodV1', '0.5.0'), c.installed('b', 'lithium', 'litV1', '0.12.0')];
    c.restrictedProjects.add('sodium');
    const session = await standalone(c);
    const snap = await session.backend.snapshotWorkspace!(session.state.instanceId!);
    expect(snap.mods.map((m) => m.projectId)).toEqual(['lithium']);
    expect(snap.skipped).toEqual([{ fileName: 'sodium-0.5.0.jar', reason: 'restricted' }]);
  });

  it('prepares a CurseForge pack from IDs it already has, asking the provider nothing', async () => {
    const c = new FakeCore();
    const m = c.installed('a', '123', '456', '1.0');
    m.provider = 'curseforge';
    c.addWorkspace('Pack').mods = [m];
    c.restrictedProjects.add('123');
    const session = await standalone(c);
    const before = c.log.filter((l) => l.method === 'providers.versions').length;
    const snap = await session.backend.prepareExport!(session.state.instanceId!, 'curseforge', [{ kind: 'installed', fileName: m.fileName }]);
    expect(c.log.filter((l) => l.method === 'providers.versions').length).toBe(before);
    expect(snap.mods.map((x) => [x.provider, x.projectId, x.versionId, x.url])).toEqual([['curseforge', '123', '456', '']]);
    expect(snap.skipped).toEqual([]);
  });

  it('uses a matched or replaced mod in place of the installed one', async () => {
    const c = new FakeCore();
    const m = c.installed('a', '123', '456', '1.0');
    m.provider = 'curseforge';
    const other = c.installed('b', '124', '457', '1.0');
    other.provider = 'curseforge';
    c.addWorkspace('Pack').mods = [m, other];
    const session = await standalone(c);
    const match = { fileName: m.fileName, projectId: 'mr', versionId: 'mv', versionName: '1', remoteFileName: 'same.jar', size: 3, sha1: 's', sha512: 'l', url: 'https://cdn.modrinth.com/x' };
    const snap = await session.backend.prepareExport!(session.state.instanceId!, 'mrpack', [
      { kind: 'matched', fileName: m.fileName, provider: 'modrinth', match },
      { kind: 'replaced', fileName: other.fileName, provider: 'modrinth', projectId: 'lithium', versionId: 'litV1', name: 'Lithium' },
    ]);
    expect(snap.mods.map((x) => [x.provider, x.projectId, x.versionId, x.name === 'Lithium'])).toEqual([['modrinth', 'mr', 'mv', false], ['modrinth', 'lithium', 'litV1', true]]);
    expect(snap.mods[0]!.fileName).toBe('same.jar');
  });

  it('exports tracked configs through outbox.list/read, hash-checked, at one revision', async () => {
    const c = new FakeCore();
    c.addWorkspace('Pack').mods = [c.installed('a', 'sodium', 'sodV1', '0.5.0')];
    c.configs.set('.minecraft/config/sodium.toml', 'x = 1\n'.repeat(60_000)); // > one 262144-byte chunk
    c.configs.set('.minecraft/config/b.json', '{}');
    const session = await standalone(c);
    const snap = await session.backend.snapshotWorkspace!(session.state.instanceId!);
    expect(snap.configs!.map((f) => [f.path, f.data.length])).toEqual([['config/sodium.toml', 360_000], ['config/b.json', 2]]);
    expect(core.log.filter((l) => l.method === 'outbox.read').length).toBe(3);
    // A config whose bytes no longer match the listed hash is refused, not exported.
    const real = c.configs;
    c.configs = new Map(real);
    const orig = c.configs.get.bind(c.configs);
    c.configs.get = (k: string) => (k.endsWith('b.json') ? '[]' : orig(k)); // same size, other bytes
    await expect(session.backend.snapshotWorkspace!(session.state.instanceId!)).rejects.toThrow(/tracked hash/);
  });

  it('shows a native pack lock separately from Manager policies, and keeps an older plan readable', async () => {
    const c = new FakeCore();
    c.addWorkspace('Pack').mods = [c.installed('a', 'sodium', 'sodV1', '0.5.0')];
    c.nativeLocks.add('a');
    const session = await standalone(c);
    const a = session.inventory.value!.mods.find((m) => m.key === 'a')!;
    expect([a.updateLocked, a.nativeLock, a.pinned, a.updateExcluded]).toEqual([true, true, false, false]);
    expect(session.pinned.value.has('a')).toBe(false);
    session.setExcluded(['a'], true);
    await session.validate();
    // Plan files carry kind: the policy file is bookkeeping, not an override.
    expect(session.review.plan!.items.map((i) => i.action)).toEqual(['policy']);
  });

  it('treats a helper that accepts but does not echo manager.v0.2 as legacy', async () => {
    core = new FakeCore();
    core.noEcho = true;
    const hs = await helper(core).connect();
    expect(hs.capabilities).not.toContain('mods.policies');
    expect(hs.capabilities).not.toContain('packs.import');
  });
});
