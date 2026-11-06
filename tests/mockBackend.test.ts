import { beforeEach, describe, expect, it } from 'vitest';
import { BackendError, type Draft } from '../src/backend/contract';
import { MockBackend } from '../src/backend/mock/MockBackend';
import { followOperation } from '../src/domain/operation';

const FAST = { stepMs: 1, latencyMs: 0 };

async function updateDraft(b: MockBackend, instanceId = 'inst-atlas'): Promise<Draft> {
  const inv = await b.getInventory(instanceId);
  const upd = inv.mods.filter((m) => m.available && m.installed && m.available.id !== m.installed.id && !m.locallyModified).slice(0, 3);
  return { instanceId, baseRevision: inv.revision, pinnedKeys: [], changes: upd.map((m) => ({ kind: 'update', modKey: m.key, targetVersionId: m.available!.id })) };
}

describe('MockBackend', () => {
  let b: MockBackend;
  beforeEach(async () => {
    b = new MockBackend(FAST);
    await b.connect();
  });

  it('exposes a large fixture pack with unknown files', async () => {
    const inv = await b.getInventory('inst-atlas');
    expect(inv.mods.length).toBeGreaterThanOrEqual(280);
    expect(inv.mods.some((m) => m.source === 'manual')).toBe(true);
  });

  it('rejects a draft built on an old revision', async () => {
    const d = await updateDraft(b);
    b.touchInstance('inst-atlas');
    await expect(b.validateDraft(d)).rejects.toMatchObject({ code: 'stale-revision' });
  });

  it('skips pinned mods and reports it', async () => {
    const d = await updateDraft(b);
    const pinnedKey = (d.changes[0] as { modKey: string }).modKey;
    const plan = await b.validateDraft({ ...d, pinnedKeys: [pinnedKey] });
    expect(plan.items.some((i) => i.modKey === pinnedKey)).toBe(false);
    expect(plan.issues.some((i) => i.code === 'pinned-skipped')).toBe(true);
  });

  it('pulls in required dependencies and lists optional ones separately', async () => {
    const inv = await b.getInventory('inst-vanilla');
    const plan = await b.validateDraft({ instanceId: 'inst-vanilla', baseRevision: inv.revision, pinnedKeys: [], changes: [
      { kind: 'install', provider: 'modrinth', projectId: 'mr-10', name: 'has a required dependency' },
      { kind: 'install', provider: 'curseforge', projectId: 'cf-23', name: 'has an optional dependency' },
    ] });
    expect(plan.items.some((i) => i.reason === 'required-dependency')).toBe(true);
    expect(plan.optional.length).toBeGreaterThan(0);
    expect(plan.items.every((i) => i.reason !== 'optional-dependency')).toBe(true);
  });

  it('refuses to apply a plan whose hash differs from the reviewed one', async () => {
    const plan = await b.validateDraft(await updateDraft(b));
    await expect(b.applyPlan({ planId: plan.planId, planHash: 'other', idempotencyKey: 'k' })).rejects.toBeInstanceOf(BackendError);
  });

  it('de-duplicates a resent apply by idempotency key', async () => {
    const plan = await b.validateDraft(await updateDraft(b));
    const a = await b.applyPlan({ planId: plan.planId, planHash: plan.planHash, idempotencyKey: 'same' });
    const c = await b.applyPlan({ planId: plan.planId, planHash: plan.planHash, idempotencyKey: 'same' });
    expect(c.operationId).toBe(a.operationId);
  });

  it('runs an apply to completion and bumps the revision', async () => {
    const d = await updateDraft(b);
    const plan = await b.validateDraft(d);
    const { operationId } = await b.applyPlan({ planId: plan.planId, planHash: plan.planHash, idempotencyKey: 'k1' });
    const seen: string[] = [];
    const final = await followOperation(b, operationId, (s) => seen.push(s.state), { pollMs: 5 });
    expect(final.state).toBe('completed');
    expect(seen).toContain('applying');
    expect((await b.getInventory('inst-atlas')).revision).not.toBe(d.baseRevision);
  });

  it('rolls back and reports recovery when apply fails', async () => {
    b.configure({ failApply: true });
    const d = await updateDraft(b);
    const plan = await b.validateDraft(d);
    const { operationId } = await b.applyPlan({ planId: plan.planId, planHash: plan.planHash, idempotencyKey: 'k2' });
    const final = await followOperation(b, operationId, () => {}, { pollMs: 5 });
    expect(final.state).toBe('rolled_back');
    expect(final.recovery?.restored).toBe(true);
    expect((await b.getInventory('inst-atlas')).revision).toBe(d.baseRevision);
  });

  it('cancels a running operation', async () => {
    b.configure({ stepMs: 20 });
    const plan = await b.validateDraft(await updateDraft(b));
    const { operationId } = await b.applyPlan({ planId: plan.planId, planHash: plan.planHash, idempotencyKey: 'k3' });
    await b.cancelOperation(operationId);
    const final = await followOperation(b, operationId, () => {}, { pollMs: 5 });
    expect(final.state).toBe('cancelled');
  });

  it('refuses to manage a running instance', async () => {
    const inv = await b.getInventory('inst-sky');
    await expect(b.validateDraft({ instanceId: 'inst-sky', baseRevision: inv.revision, pinnedKeys: [], changes: [] })).rejects.toMatchObject({ code: 'instance-busy' });
  });

  it('marks cross-provider and manual files as needing permission for export', async () => {
    const report = await b.checkExport('inst-atlas', 'mrpack');
    const manual = report.entries.filter((e) => e.modKey.startsWith('file:'));
    expect(manual.every((e) => e.status === 'needs-permission')).toBe(true);
  });
});

describe('followOperation', () => {
  it('keeps following across a disconnect and resolves after reconnect', async () => {
    const b = new MockBackend({ stepMs: 10, latencyMs: 0 });
    await b.connect();
    const plan = await b.validateDraft(await updateDraft(b));
    const { operationId } = await b.applyPlan({ planId: plan.planId, planHash: plan.planHash, idempotencyKey: 'k' });
    const done = followOperation(b, operationId, () => {}, { pollMs: 5 });
    b.simulateDisconnect();
    await new Promise((r) => setTimeout(r, 120)); // operation finishes while we are offline
    await b.connect();
    expect((await done).state).toBe('completed');
  });
});
