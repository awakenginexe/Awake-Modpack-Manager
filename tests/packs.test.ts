import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importPack, ImportError } from '../src/domain/packFormats';
import { analyzeProject, buildExport, newProject, planExport, type ModpackProject } from '../src/domain/project';
import { bytesSource, crc32, readEntry, readZip, unsafePathReason, writeZip, ZipError } from '../src/domain/zip';

const fixture = (name: string) => bytesSource(new Uint8Array(readFileSync(`tests/fixtures/packs/${name}`)));

describe('zip safety', () => {
  it('rejects unsafe paths by rule', () => {
    for (const p of ['../x', 'a/../x', '/x', 'C:/x', 'a\\b', 'a/b:c', 'CON', 'a/nul.txt', 'a./b', 'a /b', 'a//b', '', 'a\u0001b']) expect(unsafePathReason(p), p).not.toBeNull();
    for (const p of ['mods/a.jar', 'overrides/config/x.toml', 'overrides/', 'resourcepacks/My Pack (1).zip']) expect(unsafePathReason(p), p).toBeNull();
  });

  it.each([
    ['evil-traversal.zip', 'unsafe-path'], ['evil-absolute.zip', 'unsafe-path'], ['evil-drive.zip', 'unsafe-path'],
    ['evil-backslash.zip', 'unsafe-path'], ['evil-ads.zip', 'unsafe-path'], ['evil-reserved.zip', 'unsafe-path'],
    ['evil-trailing-dot.zip', 'unsafe-path'], ['evil-case-duplicate.zip', 'unsafe-path'], ['evil-symlink.zip', 'unsafe-path'],
    ['evil-bomb.zip', 'limits'], ['evil-encrypted.zip', 'unsupported'],
  ])('rejects %s (%s)', async (name, code) => {
    await expect(readZip(fixture(name))).rejects.toMatchObject({ name: 'ZipError', code });
  });

  it('enforces entry-count and size limits', async () => {
    const src = fixture('large-300.mrpack');
    await expect(readZip(src, { maxEntries: 10, maxEntryBytes: 2 ** 30, maxTotalBytes: 2 ** 40, maxRatio: 200 })).rejects.toMatchObject({ code: 'limits' });
    await expect(readZip(src, { maxEntries: 1000, maxEntryBytes: 100, maxTotalBytes: 2 ** 40, maxRatio: 200 })).rejects.toMatchObject({ code: 'limits' });
  });

  it('verifies CRC after reading', async () => {
    const src = fixture('bad-crc.zip');
    const [e] = await readZip(src);
    await expect(readEntry(src, e!)).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('rejects non-zip input', async () => {
    await expect(readZip(bytesSource(new TextEncoder().encode('definitely not a zip file at all')))).rejects.toBeInstanceOf(ZipError);
  });

  it('round-trips its own stored archives and refuses to write unsafe paths', async () => {
    const data = new TextEncoder().encode('hello');
    const zip = writeZip([{ path: 'a/b.txt', data }]);
    const src = bytesSource(zip);
    const [e] = await readZip(src);
    expect(e).toMatchObject({ path: 'a/b.txt', size: 5, crc: crc32(data) });
    expect(new TextDecoder().decode(await readEntry(src, e!))).toBe('hello');
    expect(() => writeZip([{ path: '../x', data }])).toThrow(ZipError);
  });
});

describe('modpack import (preview only)', () => {
  it('reads a 300-mod .mrpack with overrides', async () => {
    const t = performance.now();
    const p = await importPack(fixture('large-300.mrpack'), 'large-300.mrpack');
    const ms = performance.now() - t;
    expect(p.format).toBe('mrpack');
    expect(p.project).toMatchObject({ name: 'Fixture Large Pack', version: '2.3.0', minecraftVersion: '1.21.1', loader: { kind: 'fabric', version: '0.16.9' } });
    expect(p.project.mods).toHaveLength(301);
    const mr = p.project.mods.filter((m) => m.provider === 'modrinth');
    expect(mr).toHaveLength(300);
    expect(mr[0]).toMatchObject({ projectId: 'P0000001', versionId: 'V0000001', verified: true, origin: 'import' });
    expect(p.project.mods.find((m) => m.file?.path.startsWith('resourcepacks/'))?.provider).toBe('manual');
    expect(p.project.overrides).toHaveLength(41);
    expect(p.warnings).toEqual([]);
    expect(analyzeProject(p.project).filter((i) => i.severity === 'error')).toEqual([]);
    console.log(`import 300-mod mrpack: ${ms.toFixed(1)} ms`);
  });

  it('reads a CurseForge manifest ZIP', async () => {
    const p = await importPack(fixture('curseforge-250.zip'), 'cf.zip');
    expect(p.project).toMatchObject({ name: 'Fixture CF Pack', version: '1.4.2', author: 'Fixture', minecraftVersion: '1.20.1', loader: { kind: 'forge', version: '47.3.0' } });
    expect(p.project.mods).toHaveLength(250);
    expect(p.project.mods.filter((m) => !m.required)).toHaveLength(5);
    expect(p.warnings.filter((w) => w.code === 'optional-mod')).toHaveLength(5);
    expect(p.project.overrides).toEqual([{ path: 'overrides/config/forge.toml', size: 6 }]);
  });

  it.each([['bad-hash.mrpack', /sha1/], ['bad-path.mrpack', /Unsafe file path/], ['not-a-pack.zip', /not a Modrinth/]])('rejects %s', async (name, msg) => {
    await expect(importPack(fixture(name), name)).rejects.toThrow(msg);
    await expect(importPack(fixture(name), name)).rejects.toBeInstanceOf(ImportError);
  });
});

describe('project analysis and export', () => {
  it('reports duplicates, missing required and present incompatible dependencies; unknown deps are not issues', () => {
    const p = newProject({ name: 'x', minecraftVersion: '1.21.1', loader: { kind: 'fabric', version: '0.16.9' } });
    const base = { provider: 'modrinth' as const, required: true, pinned: false, verified: true, origin: 'planned' as const };
    p.mods = [
      { ...base, key: 'mr:a', name: 'A', projectId: 'a', dependencies: [{ projectId: 'lib', type: 'required' }, { projectId: 'b', type: 'incompatible' }] },
      { ...base, key: 'mr:b', name: 'B', projectId: 'b' },
      { ...base, key: 'mr:b2', name: 'B again', projectId: 'b' },
      { ...base, key: 'mr:c', name: 'C', projectId: 'c', verified: false },
    ];
    const codes = analyzeProject(p).map((i) => i.code).sort();
    expect(codes).toEqual(['dependency-missing', 'duplicate-project', 'incompatible', 'unverified']);
  });

  it('exports a verified .mrpack that re-imports identically; overrides are reported as omitted', async () => {
    const { project } = await importPack(fixture('large-300.mrpack'), 'large-300.mrpack');
    const plan = planExport(project, 'mrpack');
    expect(plan).toMatchObject({ ready: true, overridesOmitted: 41 });
    const again = await importPack(bytesSource(buildExport(project, plan)), 'again.mrpack');
    expect(again.project.mods.map((m) => [m.key, m.file?.sha512])).toEqual(project.mods.map((m) => [m.key, m.file?.sha512]));
    expect(again.project.loader).toEqual(project.loader);
  });

  it('blocks a CurseForge export of Modrinth mods until they are excluded', async () => {
    const { project } = await importPack(fixture('large-300.mrpack'), 'large-300.mrpack');
    const plan = planExport(project, 'curseforge');
    expect(plan.ready).toBe(false);
    expect(plan.blockers.filter((b) => b.code === 'not-curseforge')).toHaveLength(301);
    expect(() => buildExport(project, plan)).toThrow();
  });

  it('round-trips a CurseForge manifest', async () => {
    const { project } = await importPack(fixture('curseforge-250.zip'), 'cf.zip');
    const plan = planExport(project, 'curseforge');
    expect(plan.ready).toBe(true);
    const again = await importPack(bytesSource(buildExport(project, plan)), 'again.zip');
    expect(again.project.mods.map((m) => [m.projectId, m.versionId, m.required])).toEqual(project.mods.map((m) => [m.projectId, m.versionId, m.required]));
  });

  it('blocks a .mrpack export of user-typed plans without verified files', () => {
    const p: ModpackProject = newProject({ name: 'x', minecraftVersion: '1.21.1', loader: { kind: 'fabric', version: '' } });
    p.mods = [{ key: 'mr:sodium', name: 'Sodium', provider: 'modrinth', projectId: 'sodium', required: true, pinned: false, verified: false, origin: 'planned' }];
    const codes = planExport(p, 'mrpack').blockers.map((b) => b.code).sort();
    expect(codes).toEqual(['no-download', 'no-hashes', 'no-loader-version', 'no-size']);
  });
});
