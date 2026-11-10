import type { ContentHit, ContentKind, ContentVersion, DependencyRef, InstalledMod, InstanceSummary, LoaderKind, PackHit, PackProviderId, PackVersion, ProviderId, ReleaseType, SearchHit, VersionRef } from '../contract';

export interface CatalogContent extends ContentHit { kind: ContentKind; versions: ContentVersion[] }

const CONTENT_NAMES: Record<ContentKind, string[]> = {
  resourcepack: ['Faithful', 'Fresh Animations', 'Bare Bones', 'Stay True', 'Dramatic Skys', 'Mizuno Craft', 'Default Dark Mode', 'Better Leaves', 'Xali Enhanced', 'Low Fire', 'Round Trees', 'Visual Enchants'],
  shader: ['Complementary Reimagined', 'BSL', 'Sildurs Vibrant', 'MakeUp Ultra Fast', 'Photon', 'Rethinking Voxels', 'Bliss', 'Solas', 'Super Duper Vanilla', 'Insanity', 'Kappa', 'Nostalgia'],
};

/** Demo resource packs and shaders, with versions for the demo instances' Minecraft versions. */
export function buildContentCatalog(seed = 47): CatalogContent[] {
  const rand = seeded(seed);
  const out: CatalogContent[] = [];
  for (const kind of ['resourcepack', 'shader'] as const) {
    for (const provider of ['modrinth', 'curseforge'] as const) {
      CONTENT_NAMES[kind].forEach((base, i) => {
        const name = provider === 'curseforge' ? `${base} CF` : base;
        const projectId = `${provider}-${kind}-${i}`;
        const games = i % 5 === 4 ? ['1.20.1'] : i % 5 === 3 ? ['1.21.1'] : ['1.21.1', '1.20.1', '1.12.2'];
        const major = 1 + Math.floor(rand() * 8);
        const versions: ContentVersion[] = Array.from({ length: 2 + Math.floor(rand() * 4) }, (_, v) => ({
          id: `${projectId}-v${v}`, name: `${name} ${major}.${6 - v}`, versionNumber: `${major}.${6 - v}`,
          releaseType: v === 0 && rand() > 0.75 ? 'beta' : 'release',
          publishedAt: new Date(Date.UTC(2026, 9 - v, 2 + i)).toISOString(),
          fileName: `${name.replace(/\s+/g, '')}_${major}.${6 - v}.zip`, sizeBytes: Math.floor((kind === 'shader' ? 400_000 : 4_000_000) * (1 + rand() * 9)),
          gameVersions: games, loaders: kind === 'shader' ? (i % 3 === 0 ? ['iris'] : ['iris', 'optifine']) : [],
        }));
        out.push({
          kind, provider, projectId, name, author: ['EminGT', 'FreshLX', 'capttatsu', 'vanilla_tweaks', 'lumen'][i % 5]!,
          summary: kind === 'shader' ? `${base} adds soft shadows, better water and atmospheric lighting.` : `${base} retextures the game while keeping its familiar look.`,
          downloads: Math.floor(rand() * 60_000_000), versions,
        });
      });
    }
  }
  return out;
}

const PACK_WORDS = ['Skyward', 'Ember', 'Northern', 'Arcane', 'Hollow', 'Starfall', 'Iron', 'Verdant', 'Tidal', 'Clockwork', 'Frontier', 'Echo'];
const PACK_KINDS = ['Odyssey', 'Engineers', 'Survival', 'Kingdoms', 'Quest', 'Expedition', 'Tech', 'Magic'];
const PACK_PROVIDERS: PackProviderId[] = ['modrinth', 'curseforge', 'ftb', 'atlauncher', 'technic'];

export interface CatalogPack extends PackHit {
  versions: PackVersion[];
  modCount: number;
}

export function buildPackCatalog(seed = 31): CatalogPack[] {
  const rand = seeded(seed);
  const out: CatalogPack[] = [];
  PACK_PROVIDERS.forEach((provider, p) => {
    for (let i = 0; i < 36; i++) {
      const kind = PACK_KINDS[(i + p) % PACK_KINDS.length]!;
      const name = `${PACK_WORDS[(i + p * 5) % PACK_WORDS.length]} ${kind}${i >= 24 ? ' II' : ''}`;
      const mc = provider === 'technic' && i % 3 === 0 ? '1.12.2' : rand() > 0.5 ? '1.21.1' : '1.20.1';
      const loader: LoaderKind = mc === '1.12.2' ? 'forge' : (['fabric', 'neoforge', 'forge', 'quilt'] as const)[Math.floor(rand() * 4)]!;
      const major = 1 + Math.floor(rand() * 5);
      const versions: PackVersion[] = Array.from({ length: 3 + Math.floor(rand() * 4) }, (_, v) => ({
        id: `${provider}-${i}-v${v}`,
        name: `${major}.${5 - v}.0`,
        minecraftVersion: mc,
        loader,
        releaseType: v === 0 && rand() > 0.7 ? 'beta' : 'release',
        publishedAt: new Date(Date.UTC(2026, 9 - v, 1 + i)).toISOString(),
      }));
      out.push({
        provider, packId: `${provider}-pack-${i}`, name,
        author: ['Northwind Studio', 'Team Ember', 'packsmith', 'CraftWorks', 'lumen'][i % 5]!,
        summary: `${name} is a modpack built around ${kind.toLowerCase()}.`,
        downloads: Math.floor(rand() * 5_000_000), minecraftVersion: mc, loader, versions,
        modCount: 40 + Math.floor(rand() * 260),
      });
    }
  });
  return out;
}

/** Deterministic PRNG so fixtures (and tests) are stable across runs. */
export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIX = ['Iron', 'Ender', 'Copper', 'Mystic', 'Better', 'Simple', 'Quark', 'Applied', 'Thermal', 'Botanic', 'Storage', 'Farmer', 'Sky', 'Deep', 'Nether', 'Frost', 'Ancient', 'Tiny', 'Create', 'Immersive', 'Waystone', 'Cobble', 'Lumen', 'Arcane'];
const SUFFIX = ['Works', 'Tweaks', 'Expansion', 'Core', 'Storage', 'Decor', 'Pipes', 'Furnaces', 'Biomes', 'Mobs', 'Trees', 'Tools', 'Lib', 'API', 'Plus', 'Delight', 'Additions', 'Backpacks', 'Chests', 'Wands', 'Structures', 'Overhaul'];

/** A project's two newest versions: [latest, previous]. */
function versionPair(rand: () => number): [VersionRef, VersionRef] {
  const major = 1 + Math.floor(rand() * 4);
  const minor = Math.floor(rand() * 12);
  const r = rand();
  const releaseType: ReleaseType = r > 0.93 ? 'alpha' : r > 0.82 ? 'beta' : 'release';
  const id = () => `v-${Math.floor(rand() * 1e9).toString(36)}`;
  return [
    { id: id(), name: `${major}.${minor + 1}.0`, releaseType },
    { id: id(), name: `${major}.${minor}.${Math.floor(rand() * 9)}`, releaseType: 'release' },
  ];
}

export interface CatalogProject extends SearchHit {
  loaders: LoaderKind[];
  minecraftVersions: string[];
  requires: string[];
  optional: string[];
  incompatibleWith: string[];
  versions: [VersionRef, VersionRef];
}

export function buildCatalog(seed = 7): CatalogProject[] {
  const rand = seeded(seed);
  const out: CatalogProject[] = [];
  const providers: ProviderId[] = ['modrinth', 'curseforge'];
  for (let i = 0; i < 360; i++) {
    const provider = providers[i % 2]!;
    const name = `${PREFIX[i % PREFIX.length]} ${SUFFIX[Math.floor(i / PREFIX.length) % SUFFIX.length]}`;
    const loaders: LoaderKind[] = rand() > 0.5 ? ['fabric', 'quilt'] : ['forge', 'neoforge'];
    const mcs = rand() > 0.3 ? ['1.21.1', '1.20.1'] : ['1.20.1'];
    const versions = versionPair(rand);
    out.push({
      provider,
      projectId: `${provider === 'modrinth' ? 'mr' : 'cf'}-${i}`,
      name,
      author: ['Awake Labs', 'Kitsune', 'blockworks', 'Team Lumen', 'oakleaf'][i % 5]!,
      summary: `${name} adds focused features that fit well in larger modpacks.`,
      downloads: Math.floor(rand() * 40_000_000),
      compatible: true,
      latest: versions[0],
      loaders,
      minecraftVersions: mcs,
      requires: [],
      optional: [],
      incompatibleWith: [],
      versions,
    });
  }
  // Wire a few dependency relationships so plans have something to resolve.
  for (let i = 10; i < out.length; i += 7) out[i]!.requires.push(out[i % 10]!.projectId);
  for (let i = 12; i < out.length; i += 11) out[i]!.optional.push(out[(i + 3) % out.length]!.projectId);
  out[42]!.incompatibleWith.push(out[43]!.projectId);
  return out;
}

export function buildInventory(catalog: CatalogProject[], count: number, seed: number, mc: string): InstalledMod[] {
  const rand = seeded(seed);
  const mods: InstalledMod[] = [];
  const used = new Set<string>();
  for (let i = 0; mods.length < count && i < catalog.length * 2; i++) {
    const p = catalog[Math.floor(rand() * catalog.length)]!;
    if (used.has(p.projectId)) continue;
    used.add(p.projectId);
    const installed = p.versions[1]!;
    const hasUpdate = rand() > 0.72;
    const deps: DependencyRef[] = p.requires.map((id) => ({
      kind: 'required', projectId: id, name: catalog.find((c) => c.projectId === id)?.name ?? id,
      state: 'satisfied',
    }));
    mods.push({
      key: `${p.projectId}`,
      fileName: `${p.name.toLowerCase().replace(/\s+/g, '-')}-${installed.name}.jar`,
      name: p.name,
      source: p.provider,
      projectId: p.projectId,
      installed,
      available: hasUpdate ? p.versions[0] : installed,
      enabled: rand() > 0.06,
      dependencies: deps,
      locallyModified: rand() > 0.97,
      sizeBytes: Math.floor(40_000 + rand() * 9_000_000),
    });
  }
  // Mark required deps that are not installed as missing.
  const installedIds = new Set(mods.map((m) => m.projectId));
  for (const m of mods) for (const d of m.dependencies ?? []) if (d.projectId && !installedIds.has(d.projectId)) d.state = 'missing';
  // Manual files the coordinator cannot attribute to a provider. They must stay visible.
  const manualCount = Math.max(1, Math.round(count * 0.04));
  for (let i = 0; i < manualCount; i++) {
    const fileName = `custom-tweaks-${i + 1}-${mc}.jar`;
    mods.push({ key: `file:${fileName}`, fileName, name: fileName.replace(/\.jar$/, ''), source: 'manual', installed: null, enabled: true, dependencies: [{ kind: 'required', name: 'unknown', state: 'unknown' }] });
  }
  return mods;
}

export function buildInstances(): InstanceSummary[] {
  return [
    { id: 'inst-atlas', name: 'Atlas Expedition', minecraftVersion: '1.21.1', loader: { kind: 'neoforge', version: '21.1.77' }, modCount: 0, status: 'ready', path: 'C:\\Users\\Player\\AppData\\Roaming\\AwakeLauncher\\instances\\Atlas Expedition', manageable: true, revision: 'r1' },
    { id: 'inst-cozy', name: 'Cozy Fabric', minecraftVersion: '1.20.1', loader: { kind: 'fabric', version: '0.16.9' }, modCount: 0, status: 'ready', path: 'C:\\Users\\Player\\AppData\\Roaming\\AwakeLauncher\\instances\\Cozy Fabric', manageable: true, revision: 'r1' },
    { id: 'inst-sky', name: 'Skyblock Nights', minecraftVersion: '1.20.1', loader: { kind: 'forge', version: '47.3.0' }, modCount: 0, status: 'running', path: 'C:\\Users\\Player\\AppData\\Roaming\\AwakeLauncher\\instances\\Skyblock Nights', manageable: false, blockedReason: 'running', revision: 'r1' },
    { id: 'inst-vanilla', name: 'Vanilla 1.21', minecraftVersion: '1.21.1', loader: { kind: 'vanilla' }, modCount: 0, status: 'ready', manageable: true, revision: 'r1' },
    { id: 'inst-old', name: 'Old Survival', minecraftVersion: '1.12.2', loader: { kind: 'forge', version: '14.23.5' }, modCount: 0, status: 'broken', manageable: false, blockedReason: 'broken', revision: 'r1' },
  ];
}
