"""Generate modpack archive fixtures with Python's zipfile (an independent ZIP implementation).
Usage: python -I tests/fixtures/packs/make_packs.py   (writes next to this script; deterministic)
All URLs, hashes and IDs are synthetic. Nothing here is downloaded or installed."""
import hashlib, io, json, pathlib, zipfile

OUT = pathlib.Path(__file__).parent
DATE = (2026, 1, 1, 0, 0, 0)

def info(name, system=0, attr=0):
    zi = zipfile.ZipInfo(name, DATE)
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.create_system = system
    zi.external_attr = attr
    return zi

def write(name, entries):
    with zipfile.ZipFile(OUT / name, 'w') as z:
        for e in entries:
            zi = info(e[0], *e[2:]) if len(e) > 2 else info(e[0])
            z.writestr(zi, e[1])

def mr_file(i, loader='fabric'):
    data = f'synthetic jar {i}'.encode()
    proj = f'P{i:07d}'
    ver = f'V{i:07d}'
    return {
        'path': f'mods/fixture-mod-{i:03d}-1.{i}.0.jar',
        'hashes': {'sha1': hashlib.sha1(data).hexdigest(), 'sha512': hashlib.sha512(data).hexdigest()},
        'env': {'client': 'required', 'server': 'optional' if i % 9 == 0 else 'required'},
        'downloads': [f'https://cdn.modrinth.com/data/{proj}/versions/{ver}/fixture-mod-{i:03d}.jar'],
        'fileSize': len(data),
    }

# 1. Realistic large .mrpack: 300 mods, a resource pack, overrides.
files = [mr_file(i) for i in range(1, 301)]
files.append({'path': 'resourcepacks/fixture-pack.zip', 'hashes': {'sha1': 'a' * 40, 'sha512': 'b' * 128},
              'downloads': ['https://github.com/example/fixture/releases/download/1.0/fixture-pack.zip'], 'fileSize': 1234})
index = {'formatVersion': 1, 'game': 'minecraft', 'versionId': '2.3.0', 'name': 'Fixture Large Pack', 'summary': 'Synthetic 300-mod pack',
         'files': files, 'dependencies': {'minecraft': '1.21.1', 'fabric-loader': '0.16.9'}}
overrides = [(f'overrides/config/mod{i:03d}.toml', f'# config {i}\nenabled = true\n') for i in range(40)]
write('large-300.mrpack', [('modrinth.index.json', json.dumps(index))] + overrides + [('client-overrides/options.txt', 'fov:0.5\n')])

# 2. CurseForge manifest ZIP: 250 mods (5 optional), Forge.
manifest = {'minecraft': {'version': '1.20.1', 'modLoaders': [{'id': 'forge-47.3.0', 'primary': True}]},
            'manifestType': 'minecraftModpack', 'manifestVersion': 1, 'name': 'Fixture CF Pack', 'version': '1.4.2', 'author': 'Fixture',
            'files': [{'projectID': 100000 + i, 'fileID': 4000000 + i, 'required': i % 50 != 0} for i in range(1, 251)], 'overrides': 'overrides'}
write('curseforge-250.zip', [('manifest.json', json.dumps(manifest)), ('modlist.html', '<ul></ul>'), ('overrides/config/forge.toml', 'x = 1\n')])

# 3. Hostile archives: each must be rejected by the reader.
small = [('modrinth.index.json', json.dumps({**index, 'files': files[:2]}))]
write('evil-traversal.zip', small + [('overrides/../../evil.txt', 'x')])
write('evil-absolute.zip', small + [('/etc/evil.txt', 'x')])
write('evil-drive.zip', small + [('C:/Windows/evil.txt', 'x')])
write('evil-backslash.zip', small + [('overrides\\..\\evil.txt', 'x')])
write('evil-ads.zip', small + [('overrides/config.txt:hidden', 'x')])
write('evil-reserved.zip', small + [('overrides/CON.txt', 'x')])
write('evil-trailing-dot.zip', small + [('overrides/config./a.txt', 'x')])
write('evil-case-duplicate.zip', small + [('overrides/A.txt', 'x'), ('overrides/a.txt', 'y')])
write('evil-symlink.zip', small + [('overrides/link', '/etc/passwd', 3, (0o120777 << 16))])
write('evil-bomb.zip', small + [('overrides/zeros.bin', b'\0' * (64 * 2 ** 20))])

# Encrypted flag (no real encryption needed: the reader must refuse before reading data).
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w') as z:
    z.writestr(info('modrinth.index.json'), small[0][1])
data = bytearray(buf.getvalue())
cd = data.rfind(b'PK\x01\x02')
data[cd + 8] |= 1
(OUT / 'evil-encrypted.zip').write_bytes(bytes(data))

# CRC mismatch: corrupt one stored byte after writing.
with zipfile.ZipFile(OUT / 'bad-crc.zip', 'w', zipfile.ZIP_STORED) as z:
    zi = zipfile.ZipInfo('modrinth.index.json', DATE)
    z.writestr(zi, small[0][1])
raw = bytearray((OUT / 'bad-crc.zip').read_bytes())
raw[30 + len('modrinth.index.json') + 5] ^= 0xFF  # inside the stored data
(OUT / 'bad-crc.zip').write_bytes(bytes(raw))

# 4. Invalid manifests (archive is fine, contents are not).
bad_hash = {**index, 'files': [{**files[0], 'hashes': {'sha1': 'zz', 'sha512': 'b' * 128}}]}
write('bad-hash.mrpack', [('modrinth.index.json', json.dumps(bad_hash))])
bad_path = {**index, 'files': [{**files[0], 'path': '../mods/evil.jar'}]}
write('bad-path.mrpack', [('modrinth.index.json', json.dumps(bad_path))])
write('not-a-pack.zip', [('readme.txt', 'hello')])
print('ok')
