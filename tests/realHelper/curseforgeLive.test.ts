import { describe, expect, it } from 'vitest';
import { createHelperClient } from '../../src/backend/helper/HelperClient';
import { nodeHelperTransport } from './nodeTransport';

/**
 * The real pinned helper against the real CurseForge API, with the key from GitHub Actions
 * (.github/workflows/manager-checks.yml). Skipped everywhere else.
 */
const exe = process.env.AWAKE_CF_LIVE_HELPER, profile = process.env.AWAKE_CF_LIVE_PROFILE;
describe.skipIf(!exe || !profile || process.env.AWAKE_CORE_CURSEFORGE_AUTHORIZED !== '1')('CurseForge through the pinned helper', () => {
  it('searches popular-first and returns real project icons', async () => {
    const backend = createHelperClient({ transport: nodeHelperTransport(exe!, profile!), clientVersion: 'ci', pollMs: 200, heartbeatMs: 0 });
    const hs = await backend.connect();
    expect(hs.providers.find((p) => p.id === 'curseforge')?.available).toBe(true);
    const page = await backend.search({ text: 'Create', provider: 'curseforge', minecraftVersion: '1.20.1', loader: 'forge', releaseTypes: ['release'], compatibleOnly: true, offset: 0, limit: 20 });
    expect(page.hits.length).toBeGreaterThan(5);
    expect(page.hits.filter((h) => h.iconUrl?.startsWith('https://media.forgecdn.net/')).length).toBeGreaterThan(page.hits.length / 2);
    // Popularity order puts the mod people mean first, not an arbitrary match.
    expect(page.hits.slice(0, 5).map((h) => h.name).join(' | ')).toMatch(/^Create|\| Create\b/);
  }, 90_000);
});
