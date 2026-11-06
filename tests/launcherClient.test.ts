import { afterEach, describe, expect, it } from 'vitest';
import { BackendError } from '../src/backend/contract';
import { createLauncherClient } from '../src/backend/launcher/LauncherClient';
import { buildRequest, parseResponse, ProtocolError, WireViolation } from '../src/backend/launcher/protocol';
import { createSession } from '../src/state/session';
import { DRAFT_CAPABILITIES, FakeLauncher, instance, mods } from './fixtures/fakeLauncher';

const client = (fake: FakeLauncher | null) => createLauncherClient({ transport: fake, clientVersion: 'test', heartbeatMs: 0 });
const PROFILE_ROOT = 'C:\\Temp\\fixture-profile';
/** Instance keys are scoped by profile: `${profileId}|${physicalId}` (handoff.md). */
const key = (physicalId: string) => `prof-id|${physicalId}`;
async function ready(fake: FakeLauncher) {
  const c = client(fake);
  await c.connect();
  await c.listInstances(PROFILE_ROOT);
  return c;
}
let fake: FakeLauncher;
afterEach(() => expect(fake?.violations ?? []).toEqual([]));

describe('protocol envelope', () => {
  it('builds strict requests and validates replies', () => {
    expect(JSON.parse(buildRequest('r1', 'mods.list', { physicalId: 'x' }, { major: 1, minor: 0 }))).toEqual({ protocol: { major: 1, minor: 0 }, requestId: 'r1', method: 'mods.list', params: { physicalId: 'x' } });
    const v = { major: 1, minor: 0 };
    expect(parseResponse('{"protocol":{"major":1,"minor":0},"requestId":"r1","result":{"a":1}}', 'r1', v)).toEqual({ a: 1 });
    expect(() => parseResponse('{"protocol":{"major":1,"minor":0},"requestId":null,"error":{"code":"INVALID_REQUEST","message":"m","retryable":false}}', 'r1', v)).toThrow(ProtocolError);
    expect(() => parseResponse('{"protocol":{"major":1,"minor":0},"requestId":"r2","result":{}}', 'r1', v)).toThrow(WireViolation);
    expect(() => parseResponse('{"protocol":{"major":2,"minor":0},"requestId":"r1","result":{}}', 'r1', v)).toThrow(WireViolation);
    expect(() => parseResponse('{"protocol":{"major":1,"minor":0},"requestId":"r1","result":{},"error":{}}', 'r1', v)).toThrow(WireViolation);
    expect(() => parseResponse('{"protocol":{"major":1,"minor":0},"requestId":"r1","result":{},"extra":1}', 'r1', v)).toThrow(WireViolation);
    expect(() => parseResponse('nope', 'r1', v)).toThrow(WireViolation);
  });
});

describe('LauncherClient (fixture IPC)', () => {
  it('handshakes and exposes only the read capabilities it implements', async () => {
    fake = new FakeLauncher({ capabilities: { hello: true, 'launcher.info': true, 'instances.list': true, 'mods.list': true, 'transactions.apply': true, 'instances.create': true } });
    const hs = await client(fake).connect();
    expect(hs.contract).toBe('1.0');
    expect(hs.capabilities.sort()).toEqual(['installations.discover', 'instances.list', 'mods.inventory']);
    expect(fake.log.map((l) => l.method)).toEqual(['hello', 'launcher.info']);
  });

  it('lists instances across pages with collisions, unloaded entries, warnings and counts', async () => {
    const list = Array.from({ length: 620 }, (_, i) => instance(i));
    list[3] = instance(3, { identityStatus: 'conflict' });
    list[4] = instance(4, { loaded: false, nativeActivity: null, uuid: null });
    list[5] = instance(5, { nativeActivity: 'launch_active' });
    fake = new FakeLauncher({ instances: list, inventories: { 'phys-0000': mods(7) }, warnings: [{ code: 'duplicate-instance-id', path: 'C:\\Temp\\fixture\\instances\\inst3' }] });
    const c = client(fake);
    await c.connect();
    const [inst] = await c.listInstallations();
    const instances = await c.listInstances(inst!.id);
    expect(instances).toHaveLength(620);
    expect(fake.log.filter((l) => l.method === 'instances.list').length).toBe(2);
    const conflict = instances.find((i) => i.launcher?.instanceId === 'inst3')!;
    const unloaded = instances.find((i) => i.launcher?.instanceId === 'inst4')!;
    expect(conflict.manageable).toBe(false);
    expect(conflict.blockedReason).toBe('conflict');
    expect(unloaded.manageable).toBe(false);
    expect(unloaded.status).toBe('unknown');
    expect(instances.find((i) => i.launcher?.instanceId === 'inst5')!.status).toBe('running');
    expect(instances.find((i) => i.id === key('phys-0000'))!.modCount).toBe(7);
    expect(unloaded.modCount).toBeUndefined();
    expect(instances[0]!.minecraftVersion).toBeUndefined(); // not in protocol 1.0: never invented
    expect(c.instanceWarnings?.()).toEqual([{ code: 'duplicate-instance-id', path: 'C:\\Temp\\fixture\\instances\\inst3' }]);
  });

  it('pages a large inventory, echoing the revision and reporting progress', async () => {
    fake = new FakeLauncher({ instances: [instance(1)], inventories: { 'phys-0001': mods(1234) } });
    const c = await ready(fake);
    const progress: number[] = [];
    const inv = await c.getInventory(key('phys-0001'), (loaded) => progress.push(loaded));
    expect(inv.mods).toHaveLength(1234);
    expect(progress).toEqual([500, 1000, 1234]);
    const calls = fake.log.filter((l) => l.method === 'mods.list' && l.params.limit !== 1) /* skip library count reads */;
    expect(calls.map((l) => l.params.offset ?? 0)).toEqual([0, 500, 1000]);
    expect(calls.slice(1).every((l) => l.params.instanceRevision === calls[1]!.params.instanceRevision)).toBe(true);
  });

  it('maps indexed, unindexed, disabled and conflicting files without inventing data', async () => {
    fake = new FakeLauncher({ instances: [instance(1)], inventories: { 'phys-0001': [
      ...mods(4),
      { fileName: 'shared.jar', enabled: true, size: '5', modifiedMs: '-1', kind: 'jar', linked: true, metadataState: 'conflict', metadata: null },
      { fileName: 'notes', enabled: true, size: '0', modifiedMs: '0', kind: 'directory', linked: false, metadataState: 'unindexed', metadata: null },
      { fileName: 'huge.jar', enabled: true, size: '9007199254740993', modifiedMs: '1', kind: 'jar', linked: false, metadataState: 'unindexed', metadata: null },
    ] } });
    const c = await ready(fake);
    const { mods: list } = await c.getInventory(key('phys-0001'));
    const indexed = list.find((m) => m.fileName === 'mod-0001.jar')!;
    expect(indexed).toMatchObject({ name: 'Mod 1', source: 'modrinth', projectId: 'p1', installed: { id: 'v1', name: '1.1.0' }, metadataState: 'indexed', sizeBytes: 1001 });
    expect(indexed.available).toBeUndefined();
    expect(indexed.dependencies).toBeUndefined();
    expect(list.find((m) => m.fileName === 'mod-0000.jar')).toMatchObject({ source: 'manual', installed: null, metadataState: 'unindexed' });
    expect(list.find((m) => m.fileName === 'mod-0003.jar.disabled')).toMatchObject({ enabled: false, name: 'Mod 3' });
    expect(list.find((m) => m.fileName === 'shared.jar')).toMatchObject({ source: 'manual', metadataState: 'conflict', linked: true });
    expect(list.find((m) => m.fileName === 'notes')).toMatchObject({ kind: 'directory', name: 'notes' });
    expect(list.find((m) => m.fileName === 'huge.jar')!.sizeBytes).toBeUndefined(); // beyond 2^53: unknown, not rounded
  });

  it('restarts paging when the instance changes mid-read', async () => {
    fake = new FakeLauncher({ instances: [instance(1)], inventories: { 'phys-0001': mods(800) } });
    const c = await ready(fake);
    fake.staleOnceAtOffset = 500;
    const inv = await c.getInventory(key('phys-0001'));
    expect(inv.mods).toHaveLength(800);
    expect(fake.log.filter((l) => l.method === 'mods.list' && l.params.limit !== 1) /* skip library count reads */.map((l) => l.params.offset ?? 0)).toEqual([0, 500, 0, 500]);
  });

  it('reconnects with hello after the idle timeout closes the pipe', async () => {
    fake = new FakeLauncher();
    const c = client(fake);
    await c.connect();
    fake.closeAfterNextRequest = true;
    await c.listInstances(PROFILE_ROOT);
    expect(fake.hellos).toBe(2);
  });

  it('serializes concurrent reads (one request in flight per connection)', async () => {
    fake = new FakeLauncher();
    const c = await ready(fake);
    await Promise.all([c.getInventory(key('phys-0001')), c.getInventory(key('phys-0002')), c.listInstances(PROFILE_ROOT)]);
    expect(fake.maxInFlight).toBe(1);
  });

  it('reports Launcher not running, then connects once it starts', async () => {
    fake = new FakeLauncher({ running: false });
    const c = client(fake);
    await expect(c.connect()).rejects.toMatchObject({ code: 'not-running' });
    fake.start();
    await expect(c.connect()).resolves.toBeTruthy();
  });

  it('rejects an endpoint whose hello does not match the descriptor', async () => {
    fake = new FakeLauncher();
    fake.helloSessionOverride = 'someone-else';
    await expect(client(fake).connect()).rejects.toMatchObject({ code: 'identity' });
  });

  it('flags unsupported profiles on removable or network drives', async () => {
    fake = new FakeLauncher({ running: false, drive: 'remote' });
    await expect(client(fake).connect()).rejects.toMatchObject({ code: 'unsupported-profile' });
  });

  it('fails closed on malformed replies and maps Launcher errors', async () => {
    fake = new FakeLauncher();
    const c = await ready(fake);
    fake.malformedNext = true;
    await expect(c.getInventory(key('phys-0001'))).rejects.toMatchObject({ code: 'protocol' });
    await expect(c.getInventory(key('phys-9999'))).rejects.toMatchObject({ code: 'rejected', detail: 'NOT_FOUND' });
    fake.instances.push(instance(9999, { loaded: false }));
    await c.listInstances(PROFILE_ROOT);
    await expect(c.getInventory(key('phys-9999'))).rejects.toMatchObject({ code: 'rejected', detail: 'NOT_FOUND' });
    fake.busyNext = true;
    await expect(c.getInventory(key('phys-0001'))).rejects.toMatchObject({ code: 'instance-busy' });
  });

  it('refuses every write-side operation without sending anything', async () => {
    fake = new FakeLauncher();
    const c = client(fake);
    await c.connect();
    const before = fake.log.length;
    const writes = [
      c.createInstance({ name: 'x', minecraftVersion: '1.21.1', loader: 'fabric', idempotencyKey: 'k' }),
      c.applyPlan({ planId: 'p', planHash: 'h', baseRevision: 'r', idempotencyKey: 'k' }),
      c.validateDraft({ instanceId: key('phys-0001'), baseRevision: 'r', changes: [], pinnedKeys: [] }),
      c.preparePlan('p'), c.requestLaunch(key('phys-0001'), 'k'), c.installPack({ provider: 'modrinth', packId: 'a', versionId: 'b', instanceName: 'c', idempotencyKey: 'k' }),
      c.search({ text: '', provider: 'modrinth', minecraftVersion: '', loader: 'fabric', releaseTypes: [], compatibleOnly: false, offset: 0, limit: 1 }),
      c.listContent(key('phys-0001'), 'config'), c.cancelOperation('o'), c.getRecoveryStatus(key('phys-0001')),
    ];
    for (const w of writes) await expect(w).rejects.toMatchObject({ code: 'unsupported' });
    expect(fake.log.length).toBe(before);
  });

  it('explains that a browser cannot reach the Launcher', async () => {
    fake = new FakeLauncher();
    await expect(client(null).connect()).rejects.toBeInstanceOf(BackendError);
    await expect(client(null).connect()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('drives the session read-only: real data in, write actions gated off', async () => {
    localStorage.clear();
    fake = new FakeLauncher();
    const session = createSession(client(fake), { pollMs: 5 });
    await session.connect();
    expect(session.state.connection).toBe('connected');
    expect(session.state.instances.map((i) => i.name)).toEqual(['Instance 1', 'Instance 2']);
    await session.selectInstance(key('phys-0001'));
    expect(session.inventory.value?.mods).toHaveLength(305);
    expect(session.state.inventoryObservedAt).not.toBeNull();
    for (const cap of ['plan.validate', 'plan.apply', 'instances.create', 'launch.request', 'operations.watch'] as const) expect(session.can(cap)).toBe(false);
    session.setDraft({ ...session.draft.value!, changes: [{ kind: 'disable', modKey: 'mod-0001.jar' }] });
    await session.validate();
    expect(session.review.phase).toBe('idle');
    expect(fake.log.every((l) => ['hello', 'launcher.info', 'instances.list', 'mods.list'].includes(l.method))).toBe(true);
  });

  it('starts the Launcher only on request and connects once its endpoint appears', async () => {
    localStorage.clear();
    fake = new FakeLauncher({ running: false });
    const session = createSession(client(fake), { pollMs: 5 });
    await session.connect();
    expect(session.state.waitingForLauncher).toBe(true);
    expect(session.backend.canStartLauncher?.()).toBe(false); // no known installation
    fake.installDir = 'C:\\Temp\\fixture-install';
    await session.connect();
    expect(fake.startRequests).toEqual([]); // never started on its own
    expect(session.backend.canStartLauncher?.()).toBe(true);
    await session.startLauncher();
    expect(fake.startRequests).toEqual([{ dataRoot: PROFILE_ROOT, added: [] }]);
    expect(session.state.launcherStartedAt).not.toBeNull();
    await session.connect();
    expect(session.state.connection).toBe('connected');
    expect(session.state.launcherStartedAt).toBeNull();
  });

  it('marks the session disconnected when the Launcher exits, and keeps the last snapshot', async () => {
    localStorage.clear();
    fake = new FakeLauncher();
    const session = createSession(client(fake), { pollMs: 5 });
    await session.connect();
    await session.selectInstance(key('phys-0001'));
    fake.stop();
    await session.loadInventory();
    expect(session.state.connection).toBe('disconnected');
    expect(session.inventory.value?.mods).toHaveLength(305);
    expect(session.state.inventoryError?.code).toBe('not-running');
  });
});

/*
 * Draft 1.0 operation methods. At the pin the Launcher reports them false, so these run only
 * against the fixture with DRAFT_CAPABILITIES. They prove the adapter, not the Launcher.
 */
describe('LauncherClient draft operations (fixture only)', () => {
  const draftReady = async () => {
    localStorage.clear();
    fake = new FakeLauncher({ capabilities: DRAFT_CAPABILITIES });
    const session = createSession(client(fake), { pollMs: 5 });
    await session.connect();
    return session;
  };

  it('maps only fully specified draft capabilities; prepare stays off', async () => {
    const session = await draftReady();
    for (const cap of ['operations.watch', 'operations.cancel', 'launch.request', 'instances.create', 'plan.apply'] as const) expect(session.can(cap)).toBe(true);
    expect(session.can('plan.prepare')).toBe(false);
    expect(session.can('plan.validate')).toBe(false);
  });

  it('follows a launch until process-started through the contract states', async () => {
    const session = await draftReady();
    const seen: string[] = [];
    const stop = setInterval(() => { const s = session.state.operations[0]?.state; if (s && seen.at(-1) !== s) seen.push(s); }, 1);
    const final = await session.launch(key('phys-0001'));
    clearInterval(stop);
    expect(final?.state).toBe('completed');
    expect(final?.kind).toBe('launch');
    expect(fake.log.find((l) => l.method === 'launch.request')?.params).toEqual({ idempotencyKey: expect.any(String), physicalId: 'phys-0001' });
    expect(seen.every((s) => ['queued', 'acquiring', 'applying', 'completed'].includes(s))).toBe(true);
  });

  it('resends a request whose reply was lost with the same idempotency key, creating one operation', async () => {
    const session = await draftReady();
    fake.dropReplyNext = true; // the first launch.request is processed, but its reply is lost
    const final = await session.launch(key('phys-0001'));
    expect(final?.state).toBe('completed');
    expect(fake.ops.size).toBe(1);
    const sent = fake.log.filter((l) => l.method === 'launch.request');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.params).toEqual(sent[0]?.params);
    expect(fake.hellos).toBe(2);
  });

  it('reports INTERACTION_REQUIRED as a failed launch with the Launcher message', async () => {
    const session = await draftReady();
    fake.launchNeedsInteraction = true;
    const final = await session.launch(key('phys-0001'));
    expect(final?.state).toBe('failed');
    expect(final?.error).toEqual({ code: 'INTERACTION_REQUIRED', message: 'Sign in to Awake Launcher to continue.' });
  });

  it('cancels only by request; the state comes from operations.get', async () => {
    const session = await draftReady();
    const c = session.backend;
    const { operationId } = await c.createInstance({ name: 'New', minecraftVersion: '1.21.1', loader: 'vanilla', idempotencyKey: 'create-1' });
    await c.cancelOperation(operationId);
    expect((await c.getOperation(operationId)).state).toBe('cancelled');
    expect(fake.log.find((l) => l.method === 'instances.create')?.params).toEqual({ idempotencyKey: 'create-1', name: 'New', minecraftVersion: '1.21.1' });
  });

  it('refuses a loader instance without sending: the draft has no loader wire shape', async () => {
    const session = await draftReady();
    const before = fake.log.length;
    await expect(session.backend.createInstance({ name: 'x', minecraftVersion: '1.21.1', loader: 'fabric', idempotencyKey: 'k1' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(fake.log.length).toBe(before);
  });

  it('keeps following a durable operation across a Launcher restart', async () => {
    const session = await draftReady();
    const { operationId } = await session.backend.requestLaunch(key('phys-0001'), 'launch-restart');
    fake.stop();
    await expect(session.backend.getOperation(operationId)).rejects.toMatchObject({ code: 'not-running' });
    fake.start();
    await session.connect();
    expect((await session.backend.listOperations()).map((o) => o.operationId)).toContain(operationId);
    let s = await session.backend.getOperation(operationId);
    while (s.state !== 'completed') s = await session.backend.getOperation(operationId);
    expect(fake.ops.size).toBe(1);
  });

  it('rejects an operation record that breaks the schema', async () => {
    const session = await draftReady();
    const { operationId } = await session.backend.requestLaunch(key('phys-0001'), 'bad-1');
    fake.badOperationNext = true;
    await expect(session.backend.getOperation(operationId)).rejects.toMatchObject({ code: 'protocol' });
  });

  it('sends transactions.apply with exactly the draft fields', async () => {
    const session = await draftReady();
    const digest = 'a'.repeat(64);
    await session.backend.applyPlan({ planId: '00000000-0000-4000-8000-00000000abcd', planHash: digest, baseRevision: 'rev-1', idempotencyKey: 'apply-1' });
    expect(fake.log.find((l) => l.method === 'transactions.apply')?.params).toEqual({ idempotencyKey: 'apply-1', operationId: '00000000-0000-4000-8000-00000000abcd', planDigest: digest, instanceRevision: 'rev-1' });
    await expect(session.backend.applyPlan({ planId: 'other', planHash: digest, baseRevision: 'rev-1', idempotencyKey: 'apply-1' })).rejects.toMatchObject({ code: 'rejected', detail: 'IDEMPOTENCY_CONFLICT' });
  });
});
