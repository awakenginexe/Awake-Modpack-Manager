/**
 * In-memory test double of the native helper's protocol 2.0 (core.schema.json at the pin). It is a
 * fixture, not a provider or transaction engine: fixed fake Modrinth data, operations that advance
 * one state per `operations.get`, and every reply checked against the pinned schema.
 */
import { paramsError, resultError, type CoreMethod } from '../../src/backend/core/schema';
import type { CoreDescriptor, CoreInstalled, CoreOperation, CoreVersion, CoreWorkspace } from '../../src/backend/core/types';
import { TransportError, type HelperStatus, type PipeTransport } from '../../src/backend/launcher/transport';

const P = { major: 2, minor: 0 } as const;
const hex = (seed: string, len = 64) => {
  let h = 2166136261;
  let out = '';
  while (out.length < len) { for (const c of seed + out.length) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; out += h.toString(16).padStart(8, '0'); }
  return out.slice(0, len);
};
const uuid = (seed: string) => { const h = hex(seed, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

function version(projectId: string, versionId: string, number: string, deps: CoreVersion['dependencies'] = [], releaseType: CoreVersion['releaseType'] = 'release'): CoreVersion {
  return {
    projectId, versionId, versionNumber: number, name: `${projectId} ${number}`, releaseType, gameVersions: ['1.21.1'], loaders: ['fabric'],
    files: [{ fileName: `${projectId}-${number}.jar`, size: '1000', sha512: hex(versionId, 128), sha1: hex(versionId, 40), url: `https://cdn.modrinth.com/data/${projectId}/versions/${versionId}/${projectId}-${number}.jar` }],
    dependencies: deps,
  };
}
export const CATALOG: Record<string, { title: string; versions: CoreVersion[] }> = {
  sodium: { title: 'Sodium', versions: [version('sodium', 'sodV2', '0.6.0', [{ projectId: 'fabricapi', versionId: null, type: 'required' }, { projectId: 'indium', versionId: null, type: 'optional' }]), version('sodium', 'sodV1', '0.5.0', [{ projectId: 'fabricapi', versionId: null, type: 'required' }])] },
  fabricapi: { title: 'Fabric API', versions: [version('fabricapi', 'fapiV1', '0.100.0')] },
  lithium: { title: 'Lithium', versions: [version('lithium', 'litV2', '0.13.0', [], 'beta'), version('lithium', 'litV1', '0.12.0')] },
};

type Change = { action: string; projectId?: string; versionId?: string; inventoryId?: string };
interface Op { op: CoreOperation; steps: CoreOperation['state'][]; plan?: { files: { path: string; action: 'install' | 'replace' | 'remove' }[]; deps: CoreVersion['dependencies']; next: CoreInstalled[]; digest: string; base: string } ; createWs?: CoreWorkspace; apply?: boolean }

export class FakeCore implements PipeTransport {
  sessionId = uuid('session-1');
  readonly profileId = 'fixture-profile';
  running = true;
  stub = false;
  states: HelperStatus['state'][] = [];
  capabilities: Record<string, boolean> = {};
  helloRole = 'modpack-core';
  workspaces = new Map<string, { ws: CoreWorkspace; mods: CoreInstalled[] }>();
  ops = new Map<string, Op>();
  keys = new Map<string, { body: string; operationId: string }>();
  log: { method: string; params: Record<string, unknown> }[] = [];
  violations: string[] = [];
  failApplyNext = false;
  recoveryNext = false;
  /** Drop the reply to the next request of this method (the work still happens). */
  dropReplyFor: CoreMethod | null = null;
  extraFieldNext = false;
  private conns = new Map<number, { hello: boolean }>();
  private seq = 0;

  constructor(o: { caps?: Partial<Record<CoreMethod, boolean>>; mods?: number } = {}) {
    const all: CoreMethod[] = ['hello', 'core.info', 'core.shutdown', 'catalog.versions', 'workspaces.create', 'workspaces.list', 'providers.search', 'providers.versions', 'plans.prepare', 'plans.get', 'transactions.apply', 'mods.list', 'updates.check', 'operations.get', 'operations.list', 'operations.cancel', 'events.poll', 'recovery.list', 'recovery.run', 'inbox.begin', 'inbox.write', 'inbox.commit', 'inbox.status', 'outbox.read'];
    for (const m of all) this.capabilities[m] = !['core.shutdown', 'events.poll', 'inbox.begin', 'inbox.write', 'inbox.commit', 'inbox.status', 'outbox.read'].includes(m);
    Object.assign(this.capabilities, o.caps ?? {});
    if (o.mods) {
      const ws = this.addWorkspace('Big pack');
      ws.mods = Array.from({ length: o.mods }, (_, i) => this.installed(`m${i}`, `mod${i}`, `v${i}`, '1.0.0'));
      ws.ws.instanceRevision = hex(`rev-big-${o.mods}`);
    }
  }

  get descriptor(): CoreDescriptor {
    return { protocol: P, role: 'modpack-core', serverName: `awake-core-v2-${this.sessionId}`, pid: '777', profileId: this.profileId, sessionId: this.sessionId };
  }

  installed(inventoryId: string, projectId: string | null, versionId: string | null, number: string | null, enabled = true): CoreInstalled {
    return { inventoryId, fileName: `${projectId ?? inventoryId}-${number ?? 'x'}.jar${enabled ? '' : '.disabled'}`, enabled, size: '1000', sha256: hex(inventoryId + versionId), projectId, versionId, versionNumber: number, metadataState: projectId ? 'verified' : 'unknown', updateLocked: false };
  }
  addWorkspace(name: string, mc = '1.21.1'): { ws: CoreWorkspace; mods: CoreInstalled[] } {
    const physicalId = `phys-${this.workspaces.size + 1}`;
    const entry = { ws: { workspaceId: uuid(physicalId), physicalId, name, minecraftVersion: mc, loader: { id: 'fabric' as const, version: '0.16.9' }, instanceRevision: hex(`rev-${physicalId}-0`), ownership: 'manager-owned' as const, recoveryRequired: false }, mods: [] as CoreInstalled[] };
    this.workspaces.set(physicalId, entry);
    return entry;
  }

  /* ----- PipeTransport (helper half) ----- */
  async discover() { return []; }
  async open(): Promise<number> { throw new Error('use openHelper'); }
  async ensureHelper(): Promise<HelperStatus> {
    const state = this.states.shift() ?? (this.running ? 'ready' : 'failed');
    return { state, descriptor: state === 'ready' ? this.descriptor : null, stub: this.stub, dataRoot: 'C:\\Temp\\core-fixture', message: null };
  }
  async openHelper(serverName: string, pid: string): Promise<number> {
    if (!this.running) throw new TransportError('not-running', 'gone');
    if (serverName !== this.descriptor.serverName || pid !== this.descriptor.pid) throw new TransportError('identity', 'wrong server');
    this.conns.set(++this.seq, { hello: false });
    return this.seq;
  }
  async close(id: number) { this.conns.delete(id); }
  crash() { this.conns.clear(); this.sessionId = uuid(`session-${++this.seq}`); }

  async request(id: number, body: string): Promise<string> {
    const c = this.conns.get(id);
    if (!c) throw new TransportError('closed', 'connection closed');
    await Promise.resolve();
    const req = JSON.parse(body) as { protocol: unknown; requestId: string; method: CoreMethod; params: Record<string, unknown> };
    if (JSON.stringify(req.protocol) !== JSON.stringify(P)) this.violations.push('protocol');
    const bad = paramsError(req.method, req.params);
    if (bad) this.violations.push(bad);
    this.log.push({ method: req.method, params: req.params });
    let reply: { result: Record<string, unknown> } | { error: { code: string; message: string; retryable: boolean } };
    try {
      if (req.method !== 'hello' && !c.hello) throw this.err('HANDSHAKE_REQUIRED');
      if (req.method !== 'hello' && !this.capabilities[req.method]) throw this.err('UNSUPPORTED_CAPABILITY');
      const result = this.handle(req.method, req.params, c);
      const wrong = resultError(req.method, result);
      if (wrong) this.violations.push(`fixture reply ${wrong}`);
      if (this.extraFieldNext) { this.extraFieldNext = false; (result as Record<string, unknown>).surprise = true; }
      reply = { result };
    } catch (e) {
      if (!(e instanceof Error) || !('code' in e)) throw e;
      reply = { error: { code: (e as Error & { code: string }).code, message: e.message, retryable: false } };
    }
    if (this.dropReplyFor === req.method) { this.dropReplyFor = null; this.conns.delete(id); throw new TransportError('closed', 'reply lost'); }
    return JSON.stringify({ protocol: P, requestId: req.requestId, ...reply });
  }

  private err(code: string, message = code) { return Object.assign(new Error(message), { code }); }
  private now = 1_762_000_000_000;
  private newOp(kind: CoreOperation['kind'], steps: CoreOperation['state'][], physicalId?: string): Op {
    const operationId = uuid(`op-${this.ops.size + 1}-${kind}`);
    const t = String(this.now += 1000);
    const op: Op = { op: { operationId, kind, state: 'queued', terminal: false, createdAt: t, updatedAt: t, sequence: String(this.ops.size + 1), cancellationRequested: false, ...(physicalId ? { physicalId } : {}) }, steps };
    this.ops.set(operationId, op);
    return op;
  }
  private accepted(o: Op, replayed = false) { return { operationId: o.op.operationId, state: o.op.state, terminal: o.op.terminal, replayed }; }
  /** Idempotency: same key and body replays; same key, different body conflicts. */
  private idem(method: string, p: Record<string, unknown>, make: () => Op) {
    const k = String(p.idempotencyKey);
    const body = JSON.stringify([method, p]);
    const seen = this.keys.get(k);
    if (seen) { if (seen.body !== body) throw this.err('IDEMPOTENCY_CONFLICT'); return this.accepted(this.ops.get(seen.operationId)!, true); }
    const o = make();
    this.keys.set(k, { body, operationId: o.op.operationId });
    return this.accepted(o);
  }
  private page<T>(items: T[], p: Record<string, unknown>, max = 200) {
    const offset = (p.offset as number | undefined) ?? 0;
    const limit = Math.min((p.limit as number | undefined) ?? max, max);
    return { slice: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null };
  }
  private advance(o: Op) {
    const next = o.steps.shift();
    if (!next) return;
    o.op.state = next;
    o.op.terminal = ['completed', 'failed', 'cancelled', 'rolled_back'].includes(next);
    o.op.updatedAt = String(this.now += 1000);
    o.op.progress = { phase: next, completed: '1', total: '2', unit: 'steps' };
    if (next === 'completed' && o.createWs) {
      const e = this.addWorkspace(o.createWs.name, o.createWs.minecraftVersion);
      e.ws.loader = o.createWs.loader;
      o.op.result = { workspace: e.ws };
      delete o.op.progress;
    }
    if (next === 'completed' && o.apply && o.plan && o.op.physicalId) {
      const e = this.workspaces.get(o.op.physicalId)!;
      e.mods = o.plan.next;
      e.ws.instanceRevision = hex(`rev-${o.op.operationId}`);
      o.op.result = { planDigest: o.plan.digest, instanceRevision: e.ws.instanceRevision, fileCount: o.plan.files.length, verified: true };
      delete o.op.progress;
    }
    if (next === 'rolled_back') o.op.error = { code: 'INTEGRITY_FAILED', message: 'A downloaded file did not match its hash; nothing was changed.', retryable: false };
    if (next === 'recovery_required') o.op.error = { code: 'RECOVERY_REQUIRED', message: 'The change was interrupted. Roll it back before using this project.', retryable: false };
  }

  private handle(m: CoreMethod, p: Record<string, unknown>, c: { hello: boolean }): Record<string, unknown> {
    switch (m) {
      case 'hello':
        c.hello = true;
        return { protocol: P, role: this.helloRole, coreVersion: '2.0.0-fixture', storageVersion: 1, profileId: this.profileId, sessionId: this.sessionId, capabilities: this.capabilities, limits: { frameBytes: 1048576, clients: 8, pageItems: 200 } };
      case 'core.info':
        return { role: 'modpack-core', coreVersion: '2.0.0-fixture', profileId: this.profileId, dataRoot: 'C:\\Temp\\core-fixture', workspaceRoot: 'C:\\Temp\\core-fixture\\workspaces', state: 'ready', supportedLoaders: ['vanilla', 'fabric'] };
      case 'catalog.versions':
        return { minecraftVersions: ['1.21.1', '1.20.1'], loaderVersions: p.loader === 'fabric' ? ['0.16.9', '0.16.5'] : [] };
      case 'workspaces.create':
        return this.idem(m, p, () => { const o = this.newOp('workspace-create', ['resolving', 'verifying', 'completed']); o.createWs = { name: p.name, minecraftVersion: p.minecraftVersion, loader: p.loader } as CoreWorkspace; return o; });
      case 'workspaces.list': {
        const { slice, total, nextOffset } = this.page([...this.workspaces.values()].map((e) => e.ws), p);
        return { workspaces: slice, total, nextOffset };
      }
      case 'providers.search': {
        const q = String(p.query).toLowerCase();
        const hits = Object.entries(CATALOG).filter(([id, v]) => !q || id.includes(q) || v.title.toLowerCase().includes(q));
        const { slice, total, nextOffset } = this.page(hits, p);
        return { projects: slice.map(([id, v]) => ({ projectId: id, slug: id, title: v.title, description: `${v.title} description`, iconUrl: null, gameVersions: ['1.21.1'], loaders: ['fabric'] })), total, nextOffset };
      }
      case 'providers.versions': {
        const e = CATALOG[String(p.projectId)];
        if (!e) throw this.err('NOT_FOUND');
        return { versions: e.versions, total: e.versions.length, nextOffset: null };
      }
      case 'mods.list': {
        const e = this.workspaces.get(String(p.physicalId));
        if (!e) throw this.err('NOT_FOUND');
        if (p.instanceRevision && p.instanceRevision !== e.ws.instanceRevision) throw this.err('STALE_INSTANCE');
        const { slice, total, nextOffset } = this.page(e.mods, p);
        return { items: slice, instanceRevision: e.ws.instanceRevision, total, nextOffset };
      }
      case 'updates.check': {
        const e = this.workspaces.get(String(p.physicalId))!;
        const updates = e.mods.filter((x) => x.projectId && CATALOG[x.projectId]).map((x) => {
          const newest = CATALOG[x.projectId!]!.versions[0]!;
          return { projectId: x.projectId!, installedVersionId: x.versionId!, candidate: newest.versionId === x.versionId ? null : newest, excluded: false };
        });
        return { updates, instanceRevision: e.ws.instanceRevision, total: updates.length, nextOffset: null };
      }
      case 'plans.prepare': {
        const e = this.workspaces.get(String(p.physicalId));
        if (!e) throw this.err('NOT_FOUND');
        if (p.instanceRevision !== e.ws.instanceRevision) throw this.err('STALE_INSTANCE', 'The project changed since you looked at it.');
        return this.idem(m, p, () => {
          const o = this.newOp('modpack-change', ['resolving', 'downloading', 'prepared'], e.ws.physicalId);
          o.plan = this.resolve(e.mods, p.changes as Change[], o.op.operationId, e.ws.instanceRevision);
          return o;
        });
      }
      case 'plans.get': {
        const o = this.ops.get(String(p.operationId));
        if (!o?.plan || o.op.state !== 'prepared') throw this.err('NOT_FOUND');
        const { slice, total, nextOffset } = this.page(o.plan.files.map((f) => ({ ...f, beforeSha256: f.action === 'install' ? 'missing' : hex(f.path), afterSha256: f.action === 'remove' ? 'missing' : hex(f.path + 'new'), size: '1000' })), p);
        return { operationId: o.op.operationId, planDigest: o.plan.digest, instanceRevision: o.plan.base, expectedInstanceRevision: hex(`exp-${o.op.operationId}`), files: slice, total, nextOffset, warnings: o.plan.files.some((f) => f.action === 'remove') ? ['Removed files are kept in the operation backup until the change is verified.'] : [], dependencies: o.plan.deps };
      }
      case 'transactions.apply': {
        const o = this.ops.get(String(p.operationId));
        if (!o?.plan) throw this.err('NOT_FOUND');
        const known = this.keys.get(String(p.idempotencyKey));
        if (!known && o.op.state !== 'prepared') throw this.err('STALE_PLAN');
        if (p.planDigest !== o.plan.digest) throw this.err('STALE_PLAN');
        const e = this.workspaces.get(o.op.physicalId!)!;
        if (!known && p.instanceRevision !== e.ws.instanceRevision) throw this.err('STALE_INSTANCE');
        return this.idem(m, p, () => {
          o.apply = true;
          o.steps = this.failApplyNext ? ['acquiring', 'revalidating', 'backing_up', 'applying', 'rolling_back', 'rolled_back']
            : this.recoveryNext ? ['acquiring', 'applying', 'recovery_required'] : ['acquiring', 'revalidating', 'backing_up', 'applying', 'verifying', 'completed'];
          this.failApplyNext = false;
          this.recoveryNext = false;
          return o;
        });
      }
      case 'operations.get': {
        const o = this.ops.get(String(p.operationId));
        if (!o) throw this.err('NOT_FOUND');
        this.advance(o);
        return o.op as unknown as Record<string, unknown>;
      }
      case 'operations.list': {
        const { slice, total, nextOffset } = this.page([...this.ops.values()].map((o) => o.op), p);
        return { operations: slice, total, nextOffset };
      }
      case 'operations.cancel': {
        const o = this.ops.get(String(p.operationId));
        if (!o) throw this.err('NOT_FOUND');
        const cancellable = ['queued', 'resolving', 'downloading', 'prepared'].includes(o.op.state);
        if (cancellable) { o.op.cancellationRequested = true; o.steps = ['cancelled']; }
        return { cancellationRequested: cancellable, cancellable };
      }
      case 'recovery.list': {
        const ops = [...this.ops.values()].filter((o) => o.op.state === 'recovery_required').map((o) => o.op);
        return { operations: ops, blockedWorkspaces: ops.map((o) => o.physicalId!) };
      }
      case 'recovery.run': {
        const o = this.ops.get(String(p.operationId));
        if (!o || o.op.state !== 'recovery_required') throw this.err('NOT_FOUND');
        return this.idem(m, p, () => { o.steps = ['rolling_back', 'rolled_back']; return o; });
      }
      default:
        throw this.err('UNSUPPORTED_CAPABILITY');
    }
  }

  /** Fixture "resolver": requested installs plus missing required dependencies; optional ones are only reported. */
  private resolve(mods: CoreInstalled[], changes: Change[], opId: string, base: string) {
    const next = mods.map((x) => ({ ...x }));
    const files: { path: string; action: 'install' | 'replace' | 'remove' }[] = [];
    const deps: CoreVersion['dependencies'] = [];
    const add = (projectId: string, versionId: string) => {
      const v = CATALOG[projectId]?.versions.find((x) => x.versionId === versionId);
      if (!v) throw this.err('NOT_FOUND', `No version ${versionId} of ${projectId}.`);
      const old = next.findIndex((x) => x.projectId === projectId);
      const item = this.installed(`inv-${projectId}-${versionId}`, projectId, versionId, v.versionNumber);
      if (old >= 0) { files.push({ path: `mods/${item.fileName}`, action: 'replace' }); next[old] = item; } else { files.push({ path: `mods/${item.fileName}`, action: 'install' }); next.push(item); }
      for (const d of v.dependencies) {
        deps.push(d);
        if (d.type === 'required' && d.projectId && !next.some((x) => x.projectId === d.projectId)) add(d.projectId, CATALOG[d.projectId]!.versions[0]!.versionId);
      }
    };
    for (const ch of changes) {
      if (ch.action === 'install' || ch.action === 'replace') add(ch.projectId!, ch.versionId!);
      else {
        const i = next.findIndex((x) => x.inventoryId === ch.inventoryId);
        if (i < 0) throw this.err('NOT_FOUND', 'Unknown inventory item.');
        if (ch.action === 'remove') { files.push({ path: `mods/${next[i]!.fileName}`, action: 'remove' }); next.splice(i, 1); }
        else {
          // Like the real helper (299c140bd): a toggle is remove old name + install new name.
          const enabled = ch.action === 'enable';
          const from = next[i]!.fileName;
          next[i] = { ...next[i]!, enabled, fileName: from.replace(/\.disabled$/, '') + (enabled ? '' : '.disabled') };
          files.push({ path: `.minecraft/mods/${from}`, action: 'remove' }, { path: `.minecraft/mods/${next[i]!.fileName}`, action: 'install' });
        }
      }
    }
    // The real helper also lists its bookkeeping files.
    if (files.length) files.push({ path: '.awake-integration/policies.json', action: 'replace' });
    return { files, deps, next, digest: hex(`digest-${opId}`), base };
  }
}
