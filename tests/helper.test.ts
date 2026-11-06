import { describe, expect, it } from 'vitest';
import { BackendError } from '../src/backend/contract';
import { createCompositeBackend } from '../src/backend/composite';
import { createHelperClient } from '../src/backend/helper/HelperClient';
import { createLauncherClient } from '../src/backend/launcher/LauncherClient';
import type { HelperStatus, PipeTransport } from '../src/backend/launcher/transport';
import { createSession } from '../src/state/session';
import { DRAFT_CAPABILITIES, FakeLauncher, instance } from './fixtures/fakeLauncher';

/** A fake helper: the same fixture pipe, reached through ensureHelper/openHelper instead of discovery. */
function helperTransport(fake: FakeLauncher, o: { stub?: boolean; states?: HelperStatus['state'][] } = {}) {
  const states = [...(o.states ?? [])];
  const t = {
    ensures: 0,
    discover: async () => [],
    open: async (): Promise<number> => { throw new Error('the helper client must not use the Launcher open'); },
    request: (id: number, body: string) => fake.request(id, body),
    close: (id: number) => fake.close(id),
    async ensureHelper(): Promise<HelperStatus> {
      t.ensures++;
      const state = states.shift() ?? 'ready';
      return { state, descriptor: state === 'ready' ? fake.descriptor : null, stub: !!o.stub, dataRoot: 'C:\\Temp\\mm-core', message: state === 'not_installed' ? 'not here' : null };
    },
    openHelper: (serverName: string, pid: string) => fake.open(serverName, pid),
  };
  return t satisfies PipeTransport;
}
const helperFake = (caps = DRAFT_CAPABILITIES, extra: Record<string, unknown> = { role: 'core-host' }) => {
  const f = new FakeLauncher({ capabilities: caps, instances: [instance(7)] });
  f.helloExtra = extra;
  return f;
};

describe('HelperClient (fixture IPC)', () => {
  it('never grants write capabilities to a stub helper, whatever it advertises', async () => {
    const fake = helperFake(DRAFT_CAPABILITIES, { role: 'core-host', stub: true });
    const c = createHelperClient({ transport: helperTransport(fake, { stub: true }), clientVersion: 't' });
    const hs = await c.connect();
    expect(hs.stub).toBe(true);
    expect(hs.capabilities.sort()).toEqual(['installations.discover', 'instances.list', 'mods.inventory']);
    await expect(c.createInstance({ name: 'x', minecraftVersion: '1.21.1', loader: 'vanilla', idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: 'unsupported' });
    expect(fake.log.some((l) => l.method === 'instances.create')).toBe(false);
  });

  it('exposes advertised operations for a real helper and keys instances as helper-owned', async () => {
    const fake = helperFake();
    const c = createHelperClient({ transport: helperTransport(fake), clientVersion: 't' });
    const hs = await c.connect();
    expect(hs.stub).toBe(false);
    expect(hs.capabilities).toEqual(expect.arrayContaining(['operations.watch', 'plan.apply', 'instances.create']));
    const list = await c.listInstances('manager');
    expect(list.map((i) => i.id)).toEqual(['helper|' + instance(7).physicalId]);
    expect((await c.getInventory(list[0]!.id)).mods.length).toBeGreaterThan(0);
  });

  it('waits while the helper starts, and reports a missing helper clearly', async () => {
    const fake = helperFake();
    const t = helperTransport(fake, { states: ['starting', 'starting'] });
    await createHelperClient({ transport: t, clientVersion: 't', pollMs: 1 }).connect();
    expect(t.ensures).toBe(3);
    const missing = createHelperClient({ transport: helperTransport(fake, { states: ['not_installed'] }), clientVersion: 't' });
    await expect(missing.connect()).rejects.toMatchObject({ code: 'helper-unavailable', detail: 'not_installed' });
    await expect(createHelperClient({ transport: null, clientVersion: 't' }).connect()).rejects.toBeInstanceOf(BackendError);
  });

  it('refuses an endpoint that claims a different role, and the Launcher client refuses a helper', async () => {
    const asLauncher = createHelperClient({ transport: helperTransport(helperFake(DRAFT_CAPABILITIES, { role: 'launcher' })), clientVersion: 't' });
    await expect(asLauncher.connect()).rejects.toMatchObject({ code: 'identity' });
    const l = new FakeLauncher();
    l.helloExtra = { role: 'core-host' };
    await expect(createLauncherClient({ transport: l, clientVersion: 't', heartbeatMs: 0 }).connect()).rejects.toMatchObject({ code: 'identity' });
  });
});

describe('composite backend: standalone helper + optional Launcher', () => {
  it('works without the Launcher, waits for it on its own installation, and routes each call to one side', async () => {
    const hf = helperFake();
    const launcher = new FakeLauncher({ running: false });
    const backend = createCompositeBackend(
      createHelperClient({ transport: helperTransport(hf), clientVersion: 't' }),
      createLauncherClient({ transport: launcher, clientVersion: 't', heartbeatMs: 0 }),
      { retryMs: 5 },
    );
    const session = createSession(backend, { pollMs: 1 });
    await session.connect();
    expect(session.state.connection).toBe('connected');
    expect(session.state.installations.map((i) => [i.id, i.available])).toEqual([['manager', true], ['C:\\Temp\\fixture-profile', false]]);
    expect(session.source.value).toBe('helper');
    expect(session.state.instances.map((i) => i.id)).toEqual(['helper|' + instance(7).physicalId]);

    session.state.installationId = 'C:\\Temp\\fixture-profile';
    await session.refreshInstances();
    expect(session.source.value).toBe('launcher');
    expect(session.state.waitingForLauncher).toBe(true);
    expect(session.can('instances.list')).toBe(false);

    launcher.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(session.state.waitingForLauncher).toBe(false);
    await session.refreshInstances();
    expect(session.state.instances.length).toBe(2);
    const before = hf.log.length;
    await session.selectInstance(session.state.instances[0]!.id);
    expect(launcher.log.at(-1)?.method).toBe('mods.list');
    expect(hf.log.length).toBe(before); // the helper never saw the Launcher instance
  });

  it('reports the helper error when neither side is reachable', async () => {
    const backend = createCompositeBackend(
      createHelperClient({ transport: helperTransport(helperFake(), { states: ['not_installed'] }), clientVersion: 't' }),
      createLauncherClient({ transport: new FakeLauncher({ running: false }), clientVersion: 't', heartbeatMs: 0 }),
      { retryMs: 100000 },
    );
    await expect(backend.connect()).rejects.toMatchObject({ code: 'helper-unavailable' });
  });
});
