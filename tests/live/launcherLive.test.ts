/**
 * Live test: real LauncherClient against a running Awake Launcher (feature build).
 * Skipped unless AWAKE_MM_LIVE_PROFILE is the Launcher's data folder.
 *
 * Uses a test-only Node pipe transport (Node can open Windows named pipes). It does not verify the
 * server process/user; the desktop host does that and has its own live test (src-tauri, `live_`).
 */
import { createConnection, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLauncherClient } from '../../src/backend/launcher/LauncherClient';
import type { LauncherProfile, PipeTransport } from '../../src/backend/launcher/transport';
import { TransportError } from '../../src/backend/launcher/transport';

const root = process.env.AWAKE_MM_LIVE_PROFILE;

function nodeTransport(dataRoot: string): PipeTransport {
  const sockets = new Map<number, { socket: Socket; buffer: Buffer; waiter: ((b: Buffer | Error) => void) | null }>();
  let seq = 0;
  return {
    async discover(): Promise<LauncherProfile[]> {
      let endpoint = null;
      try { endpoint = JSON.parse(readFileSync(join(dataRoot, 'integration', 'v1', 'endpoint.json'), 'utf8')); } catch { /* not running */ }
      return [{ source: 'added', installDir: null, dataRoot, resolvedBy: 'Chosen folder', exists: true, drive: 'fixed', endpoint, endpointError: null }];
    },
    open: (serverName) => new Promise((resolve, reject) => {
      const socket = createConnection(`\\\\.\\pipe\\${serverName}`);
      const id = ++seq;
      const entry = { socket, buffer: Buffer.alloc(0), waiter: null as ((b: Buffer | Error) => void) | null };
      const pump = () => {
        if (!entry.waiter || entry.buffer.length < 4) return;
        const len = entry.buffer.readUInt32BE(0);
        if (entry.buffer.length < 4 + len) return;
        const body = entry.buffer.subarray(4, 4 + len);
        entry.buffer = entry.buffer.subarray(4 + len);
        const w = entry.waiter; entry.waiter = null; w(body);
      };
      socket.on('data', (d) => { entry.buffer = Buffer.concat([entry.buffer, d]); pump(); });
      socket.on('close', () => { sockets.delete(id); entry.waiter?.(new TransportError('closed', 'pipe closed')); });
      socket.once('error', (e) => reject(new TransportError('not-running', e.message)));
      socket.once('connect', () => { sockets.set(id, entry); resolve(id); });
    }),
    request: (id, body, timeoutMs) => new Promise((resolve, reject) => {
      const entry = sockets.get(id);
      if (!entry) return reject(new TransportError('closed', 'not open'));
      const bytes = Buffer.from(body, 'utf8');
      const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length, 0);
      const timer = setTimeout(() => { entry.waiter = null; entry.socket.destroy(); reject(new TransportError('timeout', 'no reply')); }, timeoutMs);
      entry.waiter = (r) => { clearTimeout(timer); r instanceof Error ? reject(r) : resolve(r.toString('utf8')); };
      entry.socket.write(Buffer.concat([header, bytes]));
    }),
    async close(id) { sockets.get(id)?.socket.destroy(); sockets.delete(id); },
  };
}

describe.skipIf(!root)('LauncherClient against a running Awake Launcher (live)', () => {
  it('connects, lists real instances and reads real paged inventories', async () => {
    const client = createLauncherClient({ transport: nodeTransport(root!), clientVersion: 'live-test', heartbeatMs: 0 });
    const hs = await client.connect();
    expect(hs.contract).toBe('1.0');
    expect(hs.capabilities).toEqual(expect.arrayContaining(['instances.list', 'mods.inventory']));
    expect(hs.capabilities).not.toContain('plan.apply');
    const [installation] = await client.listInstallations();
    const instances = await client.listInstances(installation!.id);
    const names = instances.map((i) => i.name).sort();
    console.log('live instances:', instances.map((i) => `${i.name} [${i.status}] mods=${i.modCount}`).join('; '));
    expect(names).toEqual(['IPC Fixture Big Pack', 'IPC Fixture Empty', 'IPC Fixture Small']);
    const big = instances.find((i) => i.name === 'IPC Fixture Big Pack')!;
    expect(big.manageable).toBe(true);
    expect(big.minecraftVersion).toBeUndefined();

    const progress: number[] = [];
    const inv = await client.getInventory(big.id, (n) => progress.push(n));
    console.log(`live big inventory: ${inv.mods.length} entries, revision ${inv.revision.slice(0, 12)}…, progress ${progress.join(',')}`);
    expect(inv.mods.length).toBe(big.modCount);
    expect(inv.mods.length).toBeGreaterThanOrEqual(320);
    const indexed = inv.mods.filter((m) => m.metadataState === 'indexed');
    const disabled = inv.mods.filter((m) => !m.enabled);
    const conflicts = inv.mods.filter((m) => m.metadataState === 'conflict');
    console.log(`indexed=${indexed.length} unindexed=${inv.mods.filter((m) => m.metadataState === 'unindexed').length} conflict=${conflicts.length} disabled=${disabled.length} dirs=${inv.mods.filter((m) => m.kind === 'directory').length} locked=${inv.mods.filter((m) => m.updateLocked).length}`);
    expect(indexed.length).toBeGreaterThan(150);
    expect(indexed.some((m) => m.source === 'modrinth') && indexed.some((m) => m.source === 'curseforge')).toBe(true);
    expect(disabled.length).toBeGreaterThan(0);

    const empty = instances.find((i) => i.name === 'IPC Fixture Empty')!;
    expect((await client.getInventory(empty.id)).mods).toEqual([]);
    await expect(client.applyPlan({ planId: 'x', planHash: 'y', idempotencyKey: 'z' })).rejects.toMatchObject({ code: 'unsupported' });
  }, 60_000);

  it('follows real pagination with the revision echoed', async () => {
    const client = createLauncherClient({ transport: nodeTransport(root!), clientVersion: 'live-test', heartbeatMs: 0, pageLimit: 100 });
    await client.connect();
    const [installation] = await client.listInstallations();
    const big = (await client.listInstances(installation!.id)).find((i) => i.name === 'IPC Fixture Big Pack')!;
    const progress: number[] = [];
    const inv = await client.getInventory(big.id, (n) => progress.push(n));
    console.log(`live paging: ${progress.join(' -> ')}`);
    expect(progress).toEqual([100, 200, 300, 322]);
    expect(new Set(inv.mods.map((m) => m.fileName)).size).toBe(322);
  }, 60_000);

  it('survives the Launcher idle timeout by re-running hello', async () => {
    const client = createLauncherClient({ transport: nodeTransport(root!), clientVersion: 'live-test', heartbeatMs: 0 });
    await client.connect();
    const [installation] = await client.listInstallations();
    await new Promise((r) => setTimeout(r, 32_000)); // server idle timeout is 30 s
    const instances = await client.listInstances(installation!.id);
    expect(instances.length).toBe(3);
  }, 60_000);
});
