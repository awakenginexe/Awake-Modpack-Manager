import schema from './core.schema.json';

/**
 * Awake native helper protocol 2.0 (role `modpack-core`).
 *
 * Source of truth: Awake Launcher docs/modpack-manager/{core-protocol.md, core.schema.json} at
 * commit 8787e06f934c6f792d102d7ab885d8afffdccb12 (branch release/3.2.0, helper
 * implementation 0.4.0, opt-in hello extensions `manager.v0.2.1` then `manager.v0.2`), copied verbatim to ./core.schema.json. Every request the Manager sends and every result it
 * accepts is checked against that schema, so the client can neither send nor trust anything the
 * contract does not define. Re-pin by replacing the JSON file and this commit.
 */
export const CORE_CONTRACT_COMMIT = '4ec20f38c4056b7cd1d2febf7c3b7b8bef8f944a';
/** Hello extension that enables the Manager 0.2 capabilities and payload variants. */
export const MANAGER_EXTENSION = 'manager.v0.2';
/**
 * Helper 0.2.1 level: implies manager.v0.2 and adds structured dependency conflicts with loader-metadata
 * evidence (error.details), reviewed dependencyResolutions and Sinytra Connector imports. Offered first;
 * an older helper rejects it and is asked again with manager.v0.2.
 */
export const EVIDENCE_EXTENSION = 'manager.v0.2.1';
export const CORE_VERSION = { major: 2, minor: 0 } as const;

type Schema = Record<string, unknown>;
const defs = (schema as { $defs: Record<string, Schema> }).$defs;
const xMethods = (schema as { 'x-methods': Record<string, { params: Schema; result: Schema }> })['x-methods'];
const method = (m: string) => xMethods[m];
export type CoreMethod =
  | 'hello' | 'core.info' | 'core.shutdown' | 'catalog.versions' | 'workspaces.create' | 'workspaces.list'
  | 'providers.search' | 'providers.versions' | 'plans.prepare' | 'plans.get' | 'transactions.apply'
  | 'mods.list' | 'updates.check' | 'operations.get' | 'operations.list' | 'operations.cancel' | 'events.poll'
  | 'recovery.list' | 'recovery.run' | 'inbox.begin' | 'inbox.write' | 'inbox.commit' | 'inbox.status' | 'outbox.read'
  | 'imports.inspect' | 'imports.prepare' | 'inbox.discard' | 'providers.project' | 'outbox.list' | 'workspaces.delete' | 'workspaces.rename' | 'workspaces.adopt' | 'workspaces.release';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Returns the first violation as a JSON-pointer-ish message, or null when `v` matches. */
export function check(s: Schema, v: unknown, at = '$'): string | null {
  if (typeof s.$ref === 'string') {
    const target = defs[s.$ref.replace('#/$defs/', '')];
    if (!target) return `${at}: unknown $ref ${s.$ref}`;
    const e = check(target, v, at);
    if (e) return e;
  }
  if ('const' in s && JSON.stringify(v) !== JSON.stringify(s.const)) return `${at}: expected ${JSON.stringify(s.const)}`;
  if (Array.isArray(s.enum) && !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(v))) return `${at}: not one of ${JSON.stringify(s.enum)}`;
  if (typeof s.type === 'string') {
    const ok = s.type === 'object' ? isObj(v) : s.type === 'array' ? Array.isArray(v) : s.type === 'integer' ? Number.isInteger(v) : s.type === 'null' ? v === null : typeof v === s.type;
    if (!ok) return `${at}: expected ${s.type}`;
  }
  if (typeof v === 'string') {
    if (typeof s.minLength === 'number' && v.length < s.minLength) return `${at}: too short`;
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) return `${at}: too long`;
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) return `${at}: does not match ${s.pattern}`;
    if (s.format === 'uuid' && !UUID.test(v)) return `${at}: not a UUID`;
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) return `${at}: below ${s.minimum}`;
    if (typeof s.maximum === 'number' && v > s.maximum) return `${at}: above ${s.maximum}`;
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) return `${at}: too few items`;
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) return `${at}: too many items`;
    if (isObj(s.items)) for (let i = 0; i < v.length; i++) { const e = check(s.items, v[i], `${at}[${i}]`); if (e) return e; }
  }
  if (isObj(v)) {
    const props = isObj(s.properties) ? (s.properties as Record<string, Schema>) : {};
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in v)) return `${at}.${r}: required`;
    for (const [k, val] of Object.entries(v)) {
      if (k in props) { const e = check(props[k]!, val, `${at}.${k}`); if (e) return e; }
      else if (s.additionalProperties === false) return `${at}.${k}: not allowed`;
    }
  }
  if (Array.isArray(s.anyOf) && !s.anyOf.some((x) => check(x as Schema, v, at) === null)) return `${at}: matches no allowed shape`;
  if (Array.isArray(s.oneOf) && s.oneOf.filter((x) => check(x as Schema, v, at) === null).length !== 1) return `${at}: must match exactly one shape`;
  for (const part of (s.allOf as Schema[] | undefined) ?? []) {
    if (isObj(part.if)) {
      const branch = check(part.if as Schema, v, at) === null ? part.then : part.else;
      if (isObj(branch)) { const e = check(branch as Schema, v, at); if (e) return e; }
    } else {
      const e = check(part, v, at);
      if (e) return e;
    }
  }
  return null;
}

const contract = (m: string) => { const x = method(m); if (!x) throw new Error(`${m} is not in the pinned contract`); return x; };
export const paramsError = (m: CoreMethod, params: unknown) => check(contract(m).params, params, `${m}.params`);
export const resultError = (m: CoreMethod, result: unknown) => check(contract(m).result, result, `${m}.result`);
export const descriptorError = (d: unknown) => check(defs.descriptor!, d, 'descriptor');
