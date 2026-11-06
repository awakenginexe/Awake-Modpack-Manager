/**
 * Minimal, defensive ZIP reader/writer for modpack archives (.mrpack, CurseForge ZIP).
 * Reads only the central directory and the entries asked for, through a ByteSource, so a large
 * archive is never loaded whole. Anything unusual is rejected instead of guessed at.
 */

export interface ByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export const bytesSource = (b: Uint8Array): ByteSource => ({ size: b.length, read: async (o, l) => b.subarray(o, o + l) });
export const blobSource = (blob: Blob): ByteSource => ({ size: blob.size, read: async (o, l) => new Uint8Array(await blob.slice(o, o + l).arrayBuffer()) });

export interface ZipLimits {
  maxEntries: number;
  /** Uncompressed size of one entry. */
  maxEntryBytes: number;
  /** Sum of uncompressed sizes. */
  maxTotalBytes: number;
  /** Largest allowed uncompressed/compressed ratio for entries above 1 MiB (zip bombs). */
  maxRatio: number;
}
export const DEFAULT_LIMITS: ZipLimits = { maxEntries: 20_000, maxEntryBytes: 512 * 2 ** 20, maxTotalBytes: 4 * 2 ** 30, maxRatio: 200 };

export interface ZipEntry {
  /** Validated, '/'-separated relative path. Directories end with '/'. */
  path: string;
  directory: boolean;
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export class ZipError extends Error {
  constructor(readonly code: 'not-zip' | 'unsupported' | 'unsafe-path' | 'limits' | 'corrupt', message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Returns why `path` is unsafe to extract on Windows, or null if it is fine. */
export function unsafePathReason(path: string): string | null {
  if (!path || path.length > 240) return 'empty or too long';
  if (/[\x00-\x1f\x7f]/.test(path)) return 'control character';
  if (path.includes('\\')) return 'backslash';
  if (path.startsWith('/')) return 'absolute path';
  if (/[<>:"|?*]/.test(path)) return 'character not allowed on Windows (drive letter, stream or wildcard)';
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return 'empty, . or .. segment';
    if (/[. ]$/.test(s)) return 'segment ending in a dot or space';
    if (RESERVED.test(s)) return 'reserved Windows name';
  }
  return null;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export async function readZip(src: ByteSource, limits: ZipLimits = DEFAULT_LIMITS): Promise<ZipEntry[]> {
  if (src.size < 22) throw new ZipError('not-zip', 'This file is not a ZIP archive.');
  const tailLen = Math.min(src.size, 22 + 0xffff);
  const tail = await src.read(src.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('not-zip', 'This file is not a ZIP archive.');
  const disk = u16(tail, eocd + 4), cdDisk = u16(tail, eocd + 6);
  const count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('unsupported', 'ZIP64 archives are not supported.');
  if (disk !== 0 || cdDisk !== 0 || u16(tail, eocd + 8) !== count) throw new ZipError('unsupported', 'Split (multi-disk) archives are not supported.');
  if (count > limits.maxEntries) throw new ZipError('limits', `The archive has ${count} entries; the limit is ${limits.maxEntries}.`);
  if (cdOffset + cdSize > src.size - tailLen + eocd) throw new ZipError('corrupt', 'The archive directory is outside the file.');

  const cd = await src.read(cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let p = 0, i = 0; i < count; i++) {
    if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) throw new ZipError('corrupt', 'The archive directory is damaged.');
    const flags = u16(cd, p + 8), method = u16(cd, p + 10);
    const crc = u32(cd, p + 16), compressedSize = u32(cd, p + 20), size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32);
    const hostOs = cd[p + 5]!, external = u32(cd, p + 38), localOffset = u32(cd, p + 42);
    if (p + 46 + nameLen > cd.length) throw new ZipError('corrupt', 'The archive directory is damaged.');
    let path: string;
    try { path = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen)); } catch { throw new ZipError('unsafe-path', 'An entry name is not valid UTF-8.'); }
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new ZipError('unsupported', `Encrypted entries are not supported (${path}).`);
    if (method !== 0 && method !== 8) throw new ZipError('unsupported', `Compression method ${method} is not supported (${path}).`);
    if (hostOs === 3 && ((external >>> 16) & 0o170000) === 0o120000) throw new ZipError('unsafe-path', `Symbolic links are not allowed (${path}).`);
    const reason = unsafePathReason(path);
    if (reason) throw new ZipError('unsafe-path', `Unsafe entry path "${path}": ${reason}.`);
    const folded = path.toLowerCase().replace(/\/$/, '');
    if (seen.has(folded)) throw new ZipError('unsafe-path', `Duplicate entry "${path}" (names are case-insensitive on Windows).`);
    seen.add(folded);
    const directory = path.endsWith('/');
    if (directory && size !== 0) throw new ZipError('corrupt', `Directory entry with data (${path}).`);
    if (method === 0 && compressedSize !== size) throw new ZipError('corrupt', `Stored entry size mismatch (${path}).`);
    if (size > limits.maxEntryBytes) throw new ZipError('limits', `"${path}" is larger than ${limits.maxEntryBytes} bytes.`);
    if (size > 2 ** 20 && size / Math.max(compressedSize, 1) > limits.maxRatio) throw new ZipError('limits', `"${path}" is compressed suspiciously well (possible ZIP bomb).`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError('limits', 'The archive expands beyond the size limit.');
    if (localOffset + 30 + compressedSize > cdOffset) throw new ZipError('corrupt', `Entry data is outside the file (${path}).`);
    entries.push({ path, directory, method: method as 0 | 8, crc, compressedSize, size, localOffset });
  }
  return entries;
}

/** Inflate and verify one entry (declared size and CRC-32). */
export async function readEntry(src: ByteSource, e: ZipEntry, maxBytes = e.size): Promise<Uint8Array> {
  if (e.size > maxBytes) throw new ZipError('limits', `"${e.path}" is too large to read (${e.size} bytes).`);
  const header = await src.read(e.localOffset, 30);
  if (u32(header, 0) !== 0x04034b50) throw new ZipError('corrupt', `Local header missing for ${e.path}.`);
  const start = e.localOffset + 30 + u16(header, 26) + u16(header, 28);
  const raw = await src.read(start, e.compressedSize);
  if (raw.length !== e.compressedSize) throw new ZipError('corrupt', `Entry ${e.path} is truncated.`);
  const data = e.method === 0 ? raw : await inflateRaw(raw, e.size);
  if (data.length !== e.size) throw new ZipError('corrupt', `Entry ${e.path} has the wrong size.`);
  if (crc32(data) !== e.crc) throw new ZipError('corrupt', `Entry ${e.path} failed its CRC check.`);
  return data;
}

async function inflateRaw(data: Uint8Array, expected: number): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } });
  const stream = input.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const out = new Uint8Array(expected);
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Stop as soon as the output exceeds the declared size, without buffering the rest.
      if (n + value.length > expected) { await reader.cancel(); throw new ZipError('corrupt', 'An entry expands beyond its declared size.'); }
      out.set(value, n);
      n += value.length;
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError('corrupt', 'An entry could not be decompressed.');
  }
  return out.subarray(0, n);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a stored (uncompressed) ZIP. Paths are validated with the same rules as reading. */
export function writeZip(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01: deterministic output
  for (const f of files) {
    const reason = unsafePathReason(f.path);
    if (reason) throw new ZipError('unsafe-path', `Refusing to write "${f.path}": ${reason}.`);
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(12, DOS_DATE, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true); lv.setUint32(22, f.data.length, true); lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(14, DOS_DATE, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, p); p += part.length; }
  return out;
}
