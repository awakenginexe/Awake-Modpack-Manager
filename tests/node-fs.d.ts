// The app has no @types/node; tests only need this one call to read fixtures.
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
}
