import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendError } from '../src/backend/contract';
import { MockBackend } from '../src/backend/mock/MockBackend';
import { addChanges } from '../src/domain/draft';
import { hasUpdate } from '../src/domain/modList';
import { createSession, type Session } from '../src/state/session';

async function ready(options = {}) {
  const backend = new MockBackend({ stepMs: 1, latencyMs: 0, ...options });
  const session = createSession(backend, { pollMs: 5 });
  await session.connect();
  await session.selectInstance('inst-atlas');
  return { backend, session };
}

function draftUpdates(session: Session, n = 3) {
  const mods = session.inventory.value!.mods.filter((m) => hasUpdate(m) && !m.locallyModified).slice(0, n);
  session.setDraft(addChanges(session.draft.value!, mods.map((m) => ({ kind: 'update' as const, modKey: m.key, targetVersionId: m.available!.id }))));
}

const until = async (fn: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('session', () => {
  beforeEach(() => localStorage.clear());

  it('connects, lists instances and loads the selected inventory', async () => {
    const { session } = await ready();
    expect(session.state.connection).toBe('connected');
    expect(session.state.instances.length).toBeGreaterThan(0);
    expect(session.inventory.value?.mods.length).toBeGreaterThanOrEqual(280);
  });

  it('reviews then applies exactly the reviewed plan and clears the draft', async () => {
    const { session } = await ready();
    draftUpdates(session);
    await session.validate();
    expect(session.review.phase).toBe('reviewed');
    const hash = session.review.plan!.planHash;
    await session.apply();
    await until(() => session.review.phase === 'done');
    expect(session.review.operation?.planHash).toBe(hash);
    expect(session.draft.value?.changes).toHaveLength(0);
  });

  it('marks the plan outdated when the draft changes after review', async () => {
    const { session } = await ready();
    draftUpdates(session, 2);
    await session.validate();
    draftUpdates(session, 3);
    expect(session.planOutdated.value).toBe(true);
    const spy = vi.spyOn(session.backend, 'preparePlan');
    await session.apply();
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops for renewed confirmation when prepare changes the plan', async () => {
    const { session, backend } = await ready({ driftOnPrepare: true });
    const apply = vi.spyOn(backend, 'applyPlan');
    draftUpdates(session);
    await session.validate();
    const reviewedHash = session.review.plan!.planHash;
    await session.apply();
    expect(session.review.phase).toBe('changed');
    expect(session.review.plan!.planHash).not.toBe(reviewedHash);
    expect(apply).not.toHaveBeenCalled();
    session.acceptChangedPlan();
    await session.apply();
    await until(() => session.review.phase === 'done');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('checks the plan against an instance that changed since the draft was made', async () => {
    const { session, backend } = await ready();
    draftUpdates(session);
    backend.touchInstance('inst-atlas');
    await session.validate();
    expect(session.review.phase).toBe('reviewed');
    expect(session.review.plan!.baseRevision).toBe(session.inventory.value!.revision);
  });

  it('stops as stale when the changed instance makes part of the draft pointless', async () => {
    const { session, backend } = await ready();
    draftUpdates(session);
    const gone = session.draft.value!.changes[0] as { modKey: string };
    backend.touchInstance('inst-atlas');
    const read = backend.getInventory.bind(backend);
    vi.spyOn(backend, 'getInventory').mockImplementation(async (...a) => { const inv = await read(...a); return { ...inv, mods: inv.mods.filter((m) => m.key !== gone.modKey) }; });
    await session.validate();
    expect(session.review.phase).toBe('stale');
    expect(session.draft.value!.changes).toHaveLength(3);
  });

  it('updating a stale draft re-reads the instance, so the next check passes', async () => {
    const { session, backend } = await ready();
    draftUpdates(session);
    await session.validate();
    backend.touchInstance('inst-atlas');
    await session.apply();
    expect(session.review.phase).toBe('stale');
    await session.rebaseDraft();
    expect(session.review.phase).toBe('idle');
    await session.validate();
    expect(session.review.phase).toBe('reviewed');
  });

  it('recovers a lost Apply reply by resending the same request, which the coordinator de-duplicates', async () => {
    const { session, backend } = await ready({ stepMs: 5 });
    const original = backend.applyPlan.bind(backend);
    let lose = true;
    const apply = vi.spyOn(backend, 'applyPlan').mockImplementation(async (req) => {
      const accepted = await original(req); // coordinator accepted it…
      if (!lose) return accepted;
      lose = false;
      backend.simulateDisconnect(); // …but the reply never arrived
      throw new BackendError('disconnected', 'connection lost');
    });
    draftUpdates(session);
    await session.validate();
    await session.apply();
    expect(session.review.phase).toBe('unconfirmed');
    await session.connect();
    await until(() => session.review.phase === 'done');
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]?.[0]).toEqual(apply.mock.calls[0]?.[0]); // identical body and key
    expect((await backend.listOperations()).filter((o) => o.kind === 'apply-plan')).toHaveLength(1);
  });

  it('submits an Apply that never reached the coordinator once, on reconnect', async () => {
    const { session, backend } = await ready({ stepMs: 5 });
    const original = backend.applyPlan.bind(backend);
    let lose = true;
    vi.spyOn(backend, 'applyPlan').mockImplementation(async (req) => {
      if (!lose) return original(req);
      lose = false;
      backend.simulateDisconnect();
      throw new BackendError('disconnected', 'connection lost');
    });
    draftUpdates(session);
    await session.validate();
    await session.apply();
    await session.connect();
    await until(() => session.review.phase === 'done');
    expect((await backend.listOperations()).filter((o) => o.kind === 'apply-plan')).toHaveLength(1);
  });

  it('shows a rollback as a failure with recovery details', async () => {
    const { session } = await ready({ failApply: true });
    draftUpdates(session);
    await session.validate();
    await session.apply();
    await until(() => session.review.phase === 'failed');
    expect(session.review.operation?.state).toBe('rolled_back');
    expect(session.review.operation?.recovery?.message).toBeTruthy();
    expect(session.draft.value?.changes.length).toBeGreaterThan(0); // draft kept for retry
  });

  it('gates features on negotiated capabilities', async () => {
    const { session } = await ready({ capabilities: ['installations.discover', 'instances.list', 'mods.inventory'] });
    expect(session.can('plan.apply')).toBe(false);
    draftUpdates(session);
    const validate = vi.spyOn(session.backend, 'validateDraft');
    await session.validate();
    expect(validate).not.toHaveBeenCalled();
  });

  it('persists drafts and pins locally', async () => {
    const { session } = await ready();
    draftUpdates(session, 1);
    session.setPinned(['a'], true);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(localStorage.getItem('awake-mm:drafts')!)['inst-atlas'].changes).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('awake-mm:pins')!)['inst-atlas']).toEqual(['a']);
  });
});

describe('session installPack', () => {
  it('installs a modpack and selects the new instance for managing', async () => {
    localStorage.clear();
    const { session } = await ready();
    const hit = (await session.backend.searchPacks({ provider: 'modrinth', text: '', offset: 0, limit: 1 })).hits[0]!;
    const version = (await session.backend.packVersions('modrinth', hit.packId))[0]!;
    let accepted = '';
    const final = await session.installPack({ provider: 'modrinth', packId: hit.packId, versionId: version.id, instanceName: hit.name }, (id) => { accepted = id; });
    expect(final?.state).toBe('completed');
    expect(accepted).toBe(final?.operationId);
    expect(session.instance.value?.pack?.packId).toBe(hit.packId);
    expect(session.inventory.value?.instanceId).toBe(final?.result?.instanceId);
  });
});
