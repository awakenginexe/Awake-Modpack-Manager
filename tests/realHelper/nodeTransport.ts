import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { TransportError, type HelperStatus, type PipeTransport } from '../../src/backend/launcher/transport';

/**
 * Test-only transport that drives a REAL awake-core-host.exe from Node: starts it with
 * `--profile <dir>` (like src-tauri/src/helper.rs) and speaks the 2.0 framing (big-endian uint32
 * length + UTF-8 JSON) over its named pipe. It does not repeat the host's PID/SID/image checks;
 * those are covered by the Rust host and the installed-app run.
 */
export function nodeHelperTransport(exe: string, profile: string): PipeTransport & { pid: () => number | undefined; kill: () => void } {
  let child: ReturnType<typeof spawn> | undefined;
  const sockets = new Map<number, Socket>();
  let next = 1;
  const descriptorPath = join(profile, 'integration', 'core-v2', 'endpoint.json');
  const alive = () => !!child && child.exitCode === null && child.signalCode === null;

  return {
    pid: () => child?.pid,
    kill: () => child?.kill(),
    discover: async () => [],
    startLauncher: async () => undefined,
    open: () => Promise.reject(new TransportError('invalid', 'Launcher pipes are not used here.')),
    async ensureHelper(): Promise<HelperStatus> {
      const base = { stub: false, dataRoot: profile, message: null };
      if (existsSync(descriptorPath)) {
        try {
          const d = JSON.parse(readFileSync(descriptorPath, 'utf8'));
          // Same rule as the host: a descriptor counts only while its process lives.
          let live = false;
          try { process.kill(Number(d.pid), 0); live = true; } catch { /* dead */ }
          if (live) return { ...base, state: 'ready', descriptor: d };
        } catch { /* being published */ }
      }
      if (!alive()) {
        if (!existsSync(profile)) {
          // Same protected ACL the host creates (pipe.rs create_private_dir): user, SYSTEM, Administrators.
          mkdirSync(dirname(profile), { recursive: true });
          mkdirSync(profile);
          const user = execFileSync('whoami', { encoding: 'utf8' }).trim();
          execFileSync('icacls', [profile, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore' });
        }
        child = spawn(exe, ['--profile', profile], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: true });
        child.stderr?.on('data', (b) => process.stderr.write(`[helper] ${b}`));
      }
      return { ...base, state: 'starting', descriptor: null };
    },
    openHelper(serverName: string) {
      return new Promise<number>((resolve, reject) => {
        const s = connect(`\\\\.\\pipe\\${serverName}`);
        s.once('connect', () => { const id = next++; sockets.set(id, s); resolve(id); });
        s.once('error', (e) => reject(new TransportError('not-running', e.message)));
      });
    },
    request(id: number, body: string, timeoutMs: number) {
      const s = sockets.get(id);
      if (!s || s.destroyed) return Promise.reject(new TransportError('closed', 'Connection closed.'));
      return new Promise<string>((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const done = (f: () => void) => { clearTimeout(t); s.off('data', onData); s.off('close', onClose); f(); };
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length < 4) return;
          const n = buf.readUInt32BE(0);
          if (buf.length >= 4 + n) done(() => resolve(buf.subarray(4, 4 + n).toString('utf8')));
        };
        const onClose = () => { sockets.delete(id); done(() => reject(new TransportError('closed', 'Pipe closed.'))); };
        const t = setTimeout(() => { s.destroy(); sockets.delete(id); done(() => reject(new TransportError('timeout', 'Timed out.'))); }, timeoutMs);
        s.on('data', onData);
        s.once('close', onClose);
        const payload = Buffer.from(body, 'utf8');
        const head = Buffer.alloc(4);
        head.writeUInt32BE(payload.length);
        s.write(Buffer.concat([head, payload]));
      });
    },
    async close(id: number) { sockets.get(id)?.destroy(); sockets.delete(id); },
  };
}
