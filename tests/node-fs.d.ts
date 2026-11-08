// The app has no @types/node; tests only need these calls (fixture files, fixture hashes).
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
}
declare module 'node:crypto' {
  export function createHash(algorithm: string): { update(data: string | Uint8Array): { digest(encoding: 'hex'): string } };
}
