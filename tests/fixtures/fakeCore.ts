import { createHash } from 'node:crypto';
/**
 * In-memory test double of the native helper's protocol 2.0 (core.schema.json at the pin). It is a
 * fixture, not a provider or transaction engine: fixed fake Modrinth data, operations that advance
 * one state per `operations.get`, and every reply checked against the pinned schema.
 */
import { paramsError, resultError, type CoreMethod } from '../../src/backend/core/schema';
import type { CoreConflictDetails, CoreDescriptor, CoreInstalled, CoreOperation, CoreReviewedResolution, CoreVersion, CoreWorkspace } from '../../src/backend/core/types';
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

type Change = { action: string; projectId?: string; versionId?: string; inventoryId?: string; pinnedVersion?: string | null; excluded?: boolean };
/** Extension capabilities a 0.2 helper reports when hello carries manager.v0.2 (CurseForge stays off, as shipped). */
export const EXT_CAPS = {
  'loaders.forge.v1': true, 'loaders.neoforge.v1': true, 'loaders.quilt.v1': true, 'policies.v1': true, 'providers.curseforge.v1': false,
  'imports.inspect': true, 'imports.prepare': true, 'inbox.discard': true, 'inbox.discard.v1': true,
  'providers.project': true, 'outbox.configs.v1': true, 'outbox.list': true, 'outbox.read': true,
  'workspaces.delete': true, 'workspaces.rename': true, 'imports.packAuthoritative.v1': true,
} as Record<string, boolean>;
/** What imports.inspect reports for the fixture archive (any uploaded bytes). */
export const FIXTURE_IMPORT = {
  minecraftVersion: '1.20.1', loader: { id: 'forge', version: '47.4.28' },
  files: [{ path: 'config/example.toml', sha256: 'a'.repeat(64), size: '12' }],
  projects: [{ provider: 'modrinth', projectId: 'sodium', versionId: 'sodV1', required: true }], downloadCount: 1, warnings: [],
};
interface Op { op: CoreOperation; steps: CoreOperation['state'][]; plan?: { files: { path: string; action: 'install' | 'replace' | 'remove' }[]; deps: CoreVersion['dependencies']; next: CoreInstalled[]; digest: string; base: string; reviewed?: CoreReviewedResolution[] } ; createWs?: CoreWorkspace; apply?: boolean; failure?: CoreOperation['error'] }

/**
 * Shapes from the real Revelations blockers: Easy Magic pins Puzzles Lib 8.0.15 while its mods.toml accepts
 * [8.0.0,); Skeleton AI Fix's provider record requires Forge Config API Port, which its mods.toml never declares.
 */
export const BLOCKER_CONFLICTS: CoreConflictDetails = {
  truncated: false,
  conflicts: [
    {
      kind: 'version_pin', provider: 'modrinth', projectId: 'QAGBst4M', title: 'Puzzles Lib',
      selected: { versionId: 'mIyVGf3d', versionNumber: 'v8.1.33-1.20.1-Forge', fileName: 'PuzzlesLib-v8.1.33-1.20.1-Forge.jar' },
      requests: [{ provider: 'modrinth', projectId: '9hx3AbJM', title: 'Easy Magic', versionId: 'W2xPEG9I', versionNumber: 'v8.0.1-1.20.1-Forge', fileName: 'EasyMagic-v8.0.1-1.20.1-Forge.jar',
        requestedVersionId: 'V4g0yKzo', requestedVersionNumber: 'v8.0.15-1.20.1-Forge',
        evidence: { result: 'satisfied', modId: 'puzzleslib', declaredRange: '[8.0.0,)', mandatory: true, selectedModVersion: '8.1.33' } }],
      candidates: [{ versionId: 'mIyVGf3d', versionNumber: 'v8.1.33-1.20.1-Forge' }], resolutions: ['use_version'],
      message: 'Easy Magic pins a different Puzzles Lib version than the selected v8.1.33-1.20.1-Forge.',
    },
    {
      kind: 'missing_dependency', provider: 'modrinth', projectId: 'ohNO6lps', title: 'Forge Config API Port', selected: null,
      requests: [{ provider: 'modrinth', projectId: 'jn24bUJo', title: 'Skeleton AI Fix', versionId: 'VMGmo5Si', versionNumber: 'v20.1.1-1.20.1-Forge', fileName: 'SkeletonAIFix-v20.1.1-1.20.1-Forge.jar',
        requestedVersionId: null, requestedVersionNumber: null,
        evidence: { result: 'not_declared', modId: 'forgeconfigapiport', declaredRange: null, mandatory: null, selectedModVersion: null } }],
      candidates: [], resolutions: ['proceed_without'],
      message: 'Skeleton AI Fix requires Forge Config API Port, but no Forge Config API Port version supports Minecraft 1.20.1 with forge.',
    },
  ],
};

const sha256Hex = (t: string) => createHash('sha256').update(t).digest('hex');

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
  /** Behave like the 0.1 helper: hello with `extensions` is an invalid request. */
  legacy = false;
  /** Behave like the pre-final 0.2.0 helper (3b279ff): accepts the offer but does not echo it. */
  noEcho = false;
  /** A 0.2.1 helper accepts manager.v0.2.1; set false to model 0.2.0, which rejects that offer as INVALID_REQUEST. */
  evidence = true;
  /** Dependency conflicts the next prepare reports until a request resolves every one of them. */
  conflicts: CoreConflictDetails | null = null;
  /** Native Packwiz update=false locks, by inventory id. */
  nativeLocks = new Set<string>();
  /** Policy-tracked, unchanged config overrides the outbox may export (.minecraft-relative path -> text). */
  configs = new Map<string, string>();
  extCaps: Record<string, boolean> = { ...EXT_CAPS };
  /** Policies per inventory id (pinned version / excluded). */
  policies = new Map<string, { pinnedVersion: string | null; excluded: boolean }>();
  uploads = new Map<string, { size: number; sha256: string; data: string[]; received: number; complete: boolean; discarded: boolean }>();
  inspectError: string | null = null;
  failImportPrepare = false;
  prepareRequests: Record<string, unknown>[] = [];
  /** Every method called, in order. */
  calls: string[] = [];
  private conns = new Map<number, { hello: boolean; ext: boolean; evidence?: boolean }>();
  private seq = 0;

  constructor(o: { caps?: Partial<Record<CoreMethod, boolean>>; mods?: number } = {}) {
    const all: CoreMethod[] = ['hello', 'core.info', 'core.shutdown', 'catalog.versions', 'workspaces.create', 'workspaces.list', 'providers.search', 'providers.versions', 'plans.prepare', 'plans.get', 'transactions.apply', 'mods.list', 'updates.check', 'operations.get', 'operations.list', 'operations.cancel', 'events.poll', 'recovery.list', 'recovery.run', 'inbox.begin', 'inbox.write', 'inbox.commit', 'inbox.status', 'outbox.read'];
    for (const m of all) this.capabilities[m] = !['core.shutdown', 'events.poll', 'outbox.read'].includes(m);
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
    this.conns.set(++this.seq, { hello: false, ext: false });
    return this.seq;
  }
  async close(id: number) { this.conns.delete(id); }
  shutdownBusy = false;
  restrictedProjects = new Set<string>();
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
      // A 0.1 helper has no inbox; a 0.2 helper enables it only for manager.v0.2 clients.
      const inbox = req.method.startsWith('inbox.') || req.method.startsWith('imports.');
      const caps: Record<string, boolean | undefined> = c.ext ? { ...this.capabilities, ...this.extCaps } : this.capabilities;
      if (req.method !== 'hello' && ((inbox && !c.ext) || !caps[req.method])) throw this.err('UNSUPPORTED_CAPABILITY');
      this.calls.push(req.method);
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
  /** Reported conflicts fail the prepare (before staging) until every one has a resolution the fixture accepts. */
  private reviewConflicts(o: Op, p: Record<string, unknown>) {
    if (!this.conflicts) return;
    const given = (p.dependencyResolutions as { projectId: string; versionId: string | null }[] | undefined) ?? [];
    const open = this.conflicts.conflicts.filter((c) => !given.some((r) => r.projectId === c.projectId && (c.kind === 'version_pin' ? r.versionId === c.selected?.versionId : r.versionId === null)));
    if (open.length) {
      o.steps = ['resolving', 'failed'];
      o.failure = { code: 'DEPENDENCY_CONFLICT', retryable: false, message: `Dependency review required (${open.length}): ${open.map((c) => `${c.title} (${c.requests.map((r) => r.title).join(', ')})`).join('; ')}`,
        details: { truncated: this.conflicts.truncated, conflicts: open } };
      return;
    }
    o.plan!.reviewed = this.conflicts.conflicts.map((c) => ({ projectId: c.projectId, title: c.title, versionId: c.kind === 'version_pin' ? c.selected!.versionId : null,
      requestedBy: c.requests.map((r) => ({ projectId: r.projectId, title: r.title, requestedVersionId: r.requestedVersionId, evidence: r.evidence.result as 'satisfied' | 'not_declared' | 'unknown' })) }));
  }
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
    if (next === 'failed' && o.failure) { o.op.error = o.failure; delete o.op.progress; }
    if (next === 'rolled_back') o.op.error = { code: 'INTEGRITY_FAILED', message: 'A downloaded file did not match its hash; nothing was changed.', retryable: false };
    if (next === 'recovery_required') o.op.error = { code: 'RECOVERY_REQUIRED', message: 'The change was interrupted. Roll it back before using this project.', retryable: false };
  }

  private handle(m: CoreMethod, p: Record<string, unknown>, c: { hello: boolean; ext: boolean; evidence?: boolean }): Record<string, unknown> {
    switch (m) {
      case 'hello': {
        if (p.extensions && this.legacy) throw this.err('INVALID_REQUEST', 'hello.params.extensions: not allowed');
        const offered = Array.isArray(p.extensions) ? p.extensions as string[] : [];
        if (offered.includes('manager.v0.2.1') && !this.evidence) throw this.err('INVALID_REQUEST', 'Invalid hello parameters.');
        c.hello = true;
        c.ext = offered.length > 0;
        c.evidence = offered.includes('manager.v0.2.1');
        // 0.1 inbox flags stay false without the extension (core-protocol.md).
        const caps = c.ext ? { ...this.capabilities, ...this.extCaps, ...(c.evidence ? { 'dependencies.resolutions.v1': true, 'loaders.connector.v1': true } : {}) }
          : { ...this.capabilities, 'inbox.begin': false, 'inbox.write': false, 'inbox.commit': false, 'inbox.status': false };
        return { protocol: P, role: this.helloRole, coreVersion: c.ext ? '0.2.0-fixture' : '0.1.1-fixture', storageVersion: 1, profileId: this.profileId, sessionId: this.sessionId, capabilities: caps, limits: { frameBytes: 1048576, clients: 8, pageItems: 200 }, ...(Array.isArray(p.extensions) && !this.noEcho ? { extensions: p.extensions } : {}) };
      }
      case 'core.info':
        return { role: 'modpack-core', coreVersion: '2.0.0-fixture', profileId: this.profileId, dataRoot: 'C:\\Temp\\core-fixture', workspaceRoot: 'C:\\Temp\\core-fixture\\workspaces', state: 'ready', supportedLoaders: c.ext ? ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt'] : ['vanilla', 'fabric'] };
      case 'catalog.versions':
        if (!c.ext && p.loader && !['vanilla', 'fabric'].includes(String(p.loader))) throw this.err('UNSUPPORTED_CAPABILITY');
        return { minecraftVersions: ['1.21.1', '1.20.1'], loaderVersions: p.loader === 'fabric' ? ['0.16.9', '0.16.5'] : p.loader === 'forge' ? (p.minecraftVersion === '1.20.1' ? ['47.4.28', '47.3.0'] : []) : [] };
      case 'inbox.begin': {
        const token = uuid(`upload-${String(p.idempotencyKey)}`);
        if (!this.uploads.has(token)) this.uploads.set(token, { size: Number(p.size), sha256: String(p.sha256), data: [], received: 0, complete: false, discarded: false });
        return this.transfer(token);
      }
      case 'inbox.write': {
        const u = this.uploads.get(String(p.token));
        if (!u || u.discarded) throw this.err('TRANSFER_DISCARDED');
        if (Number(p.offset) !== u.received) throw this.err('INVALID_REQUEST', 'offset');
        const n = atob(String(p.bytesBase64)).length;
        if (n > 262144) this.violations.push('inbox chunk too large');
        u.data.push(String(p.bytesBase64));
        u.received += n;
        return this.transfer(String(p.token));
      }
      case 'inbox.commit': {
        const u = this.uploads.get(String(p.token));
        if (!u || u.discarded) throw this.err('TRANSFER_DISCARDED');
        if (u.received !== u.size) throw this.err('INVALID_REQUEST', 'incomplete');
        u.complete = true;
        return this.transfer(String(p.token));
      }
      case 'inbox.discard': {
        const u = this.uploads.get(String(p.token));
        if (u) u.discarded = true;
        return { token: String(p.token), discarded: true };
      }
      case 'imports.inspect': {
        const u = this.uploads.get(String(p.token));
        if (!u?.complete || u.discarded) throw this.err('NOT_FOUND');
        if (this.inspectError) throw this.err(this.inspectError, 'Unsupported archive: ZIP64 is not supported.');
        return FIXTURE_IMPORT;
      }
      case 'imports.prepare': {
        const u = this.uploads.get(String(p.token));
        if (!u?.complete || u.discarded) throw this.err('NOT_FOUND');
        const e = this.workspaces.get(String(p.physicalId));
        if (!e) throw this.err('NOT_FOUND');
        if (p.instanceRevision !== e.ws.instanceRevision) throw this.err('STALE_INSTANCE');
        this.prepareRequests.push(p);
        if (this.failImportPrepare) throw this.err('DEPENDENCY_CONFLICT', 'Fixture failure.');
        return this.idem(m, p, () => {
          const o = this.newOp('modpack-change', ['resolving', 'downloading', 'prepared'], e.ws.physicalId);
          o.plan = this.resolve(e.mods, [{ action: 'install', projectId: 'sodium', versionId: 'sodV1' }], o.op.operationId, e.ws.instanceRevision);
          o.plan.files.push({ path: 'config/example.toml', action: 'install' });
          this.reviewConflicts(o, p);
          return o;
        });
      }
      case 'workspaces.create':
        return this.idem(m, p, () => { const o = this.newOp('workspace-create', ['resolving', 'verifying', 'completed']); o.createWs = { name: p.name, minecraftVersion: p.minecraftVersion, loader: p.loader } as CoreWorkspace; return o; });
      case 'workspaces.delete': {
        const e = this.workspaces.get(String(p.physicalId));
        if (!e) throw this.err('NOT_FOUND');
        return this.idem(m, p, () => { const o = this.newOp('workspace-delete', ['acquiring', 'applying', 'verifying', 'completed'], e.ws.physicalId); this.workspaces.delete(e.ws.physicalId); return o; });
      }
      case 'workspaces.rename': {
        const e = this.workspaces.get(String(p.physicalId));
        if (!e) throw this.err('NOT_FOUND');
        e.ws.name = String(p.name);
        return { workspace: e.ws };
      }
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
      case 'providers.project': {
        const e = CATALOG[String(p.projectId)];
        if (!e) throw this.err('NOT_FOUND');
        return { project: { projectId: String(p.projectId), slug: String(p.projectId), title: e.title, description: '', iconUrl: null, gameVersions: [], loaders: [], provider: 'modrinth' } };
      }
      case 'outbox.list': {
        const e = this.workspaces.get(String(p.physicalId));
        if (!e) throw this.err('NOT_FOUND');
        if (p.instanceRevision !== e.ws.instanceRevision) throw this.err('STALE_INSTANCE');
        const files = [...this.configs].map(([path, text]) => ({ path, size: String(new TextEncoder().encode(text).length), sha256: sha256Hex(text) }));
        const { slice, total, nextOffset } = this.page(files, p);
        return { instanceRevision: e.ws.instanceRevision, files: slice, total, nextOffset };
      }
      case 'outbox.read': {
        const e = this.workspaces.get(String(p.physicalId));
        if (!e) throw this.err('NOT_FOUND');
        if (p.instanceRevision !== e.ws.instanceRevision) throw this.err('STALE_INSTANCE');
        const text = this.configs.get(String(p.path));
        if (text === undefined) throw this.err('NOT_FOUND');
        const all = new TextEncoder().encode(text);
        const off = Number(p.offset);
        const part = all.subarray(off, off + Number(p.length));
        return { path: p.path, instanceRevision: e.ws.instanceRevision, offset: String(off), size: String(all.length), bytesBase64: btoa(Array.from(part, (b) => String.fromCharCode(b)).join('')), eof: off + part.length >= all.length, sha256: sha256Hex(text) };
      }
      case 'providers.versions': {
        if (this.restrictedProjects.has(String(p.projectId))) throw this.err('PROVIDER_RESTRICTED', 'CurseForge project does not allow third-party distribution.');
        const e = CATALOG[String(p.projectId)];
        if (!e) throw this.err('NOT_FOUND');
        return { versions: e.versions, total: e.versions.length, nextOffset: null };
      }
      case 'mods.list': {
        const e = this.workspaces.get(String(p.physicalId));
        if (!e) throw this.err('NOT_FOUND');
        if (p.instanceRevision && p.instanceRevision !== e.ws.instanceRevision) throw this.err('STALE_INSTANCE');
        // manager.v0.2 adds the separate policy and native lock; updateLocked stays their OR.
        const items = e.mods.map((x) => {
          const policy = this.policies.get(x.inventoryId) ?? { pinnedVersion: null, excluded: false };
          const nativeLock = this.nativeLocks.has(x.inventoryId);
          const updateLocked = x.updateLocked || nativeLock;
          return c.ext ? { ...x, updateLocked, policy, nativeLock } : { ...x, updateLocked };
        });
        const { slice, total, nextOffset } = this.page(items, p);
        return { items: slice, instanceRevision: e.ws.instanceRevision, total, nextOffset };
      }
      case 'updates.check': {
        const e = this.workspaces.get(String(p.physicalId))!;
        const updates = e.mods.filter((x) => x.projectId && CATALOG[x.projectId]).map((x) => {
          const newest = CATALOG[x.projectId!]!.versions[0]!;
          const pol = this.policies.get(x.inventoryId);
          return { projectId: x.projectId!, installedVersionId: x.versionId!, candidate: newest.versionId === x.versionId || pol?.pinnedVersion ? null : newest, excluded: !!pol?.excluded };
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
          this.reviewConflicts(o, p);
          return o;
        });
      }
      case 'plans.get': {
        const o = this.ops.get(String(p.operationId));
        if (!o?.plan || o.op.state !== 'prepared') throw this.err('NOT_FOUND');
        const kind = (path: string) => /(^|\/)mods\//.test(path) ? 'mod' : /(\.awake-integration|\.index)\/|instance\.cfg$|mmc-pack\.json$/.test(path) ? 'bookkeeping' : 'override';
        const { slice, total, nextOffset } = this.page(o.plan.files.map((f) => ({ ...f, ...(c.ext ? { kind: kind(f.path) } : {}), beforeSha256: f.action === 'install' ? 'missing' : hex(f.path), afterSha256: f.action === 'remove' ? 'missing' : hex(f.path + 'new'), size: '1000' })), p);
        return { operationId: o.op.operationId, planDigest: o.plan.digest, instanceRevision: o.plan.base, expectedInstanceRevision: hex(`exp-${o.op.operationId}`), files: slice, total, nextOffset, warnings: o.plan.files.some((f) => f.action === 'remove') ? ['Removed files are kept in the operation backup until the change is verified.'] : [], dependencies: o.plan.deps, ...(c.evidence && o.plan.reviewed ? { dependencyResolutions: o.plan.reviewed } : {}) };
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
        // Like the helper: conflict details only for manager.v0.2.1 clients.
        if (o.op.error?.details && !c.evidence) { const { details: _, ...error } = o.op.error; return { ...o.op, error } as unknown as Record<string, unknown>; }
        return o.op as unknown as Record<string, unknown>;
      }
      case 'operations.list': {
        const { slice, total, nextOffset } = this.page([...this.ops.values()].map((o) => o.op), p);
        return { operations: slice, total, nextOffset };
      }
      case 'core.shutdown':
        if (this.shutdownBusy) throw this.err('BUSY');
        return { shuttingDown: true };
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

  private transfer(token: string) {
    const u = this.uploads.get(token)!;
    return { token, size: String(u.size), received: String(u.received), sha256: u.sha256, complete: u.complete };
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
      else if (ch.action === 'policy') {
        const i = next.findIndex((x) => x.inventoryId === ch.inventoryId);
        if (i < 0) throw this.err('NOT_FOUND', 'Unknown inventory item.');
        if (ch.pinnedVersion !== null && ch.pinnedVersion !== next[i]!.versionId) throw this.err('POLICY_CONFLICT');
        this.policies.set(ch.inventoryId!, { pinnedVersion: ch.pinnedVersion ?? null, excluded: !!ch.excluded });
        // Like the real 0.2.0 helper: updateLocked is set by a pin AND by an exclusion.
        next[i] = { ...next[i]!, updateLocked: ch.pinnedVersion !== null || !!ch.excluded };
      }
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
    if (files.length || changes.some((c) => c.action === 'policy')) files.push({ path: '.awake-integration/policies.json', action: 'replace' });
    return { files, deps, next, digest: hex(`digest-${opId}`), base };
  }
}
