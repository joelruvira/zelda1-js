// The APK carries the player's ROM (npm run android:build packs roms/zelda.nes), but the ROM must never
// reach git: no versioned (or committable) file is a ROM or contains an iNES header, the generated asset
// folders are git-ignored, and the packing step validates the ROM. When dist/zelda1-js.apk exists, it must
// contain exactly the valid US PRG0 ROM at assets/rom/zelda.nes. No emulator needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { packRom, ROM_ASSETS_DIR, ROM_ASSET_PATH, ROM_SOURCE, REPO } from '../../scripts/android/rom-asset.mjs';
import { checkZeldaRom } from '../../android/web/romcheck.js';

const INES = Buffer.from([0x4e, 0x45, 0x53, 0x1a]); // "NES\x1A"
const git = (...args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
const hasGit = git('rev-parse', '--is-inside-work-tree').stdout?.trim() === 'true';
const RELEASE_APK = join(REPO, 'dist/zelda1-js.apk');

test('git: no versioned or committable file is a ROM or contains an iNES header', { skip: !hasGit && 'not a git checkout' }, () => {
  const list = (...a) => git('ls-files', '-z', ...a).stdout.split('\0').filter(Boolean);
  const files = [...new Set([...list(), ...list('--others', '--exclude-standard')])];
  assert.ok(files.length > 100, `files listed: ${files.length}`);
  for (const f of files) {
    assert.ok(!/\.(nes|fds|unf|unif)$/i.test(f), `${f} looks like a ROM and would go into git`);
    const p = join(REPO, f);
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    assert.equal(readFileSync(p).indexOf(INES), -1, `${f} contains an iNES header ("NES\\x1A")`);
  }
});

test('git: the ROM, the generated assets, the APKs and the signing key are ignored', { skip: !hasGit && 'not a git checkout' }, () => {
  const paths = [
    'roms/zelda.nes',
    relative(REPO, join(ROM_ASSETS_DIR, ROM_ASSET_PATH)),
    'android/app/src/main/assets/www/src/main.js',
    'android/app/src/debug/assets/www/android/web/selftest.js',
    'dist/zelda1-js.apk',
    'dist/zelda1-js-debug.apk',
    'android/keystore/release.jks',
    'android/keystore/keystore.properties',
    'android/local.properties',
  ];
  for (const p of paths) assert.equal(git('check-ignore', '-q', '--no-index', p).status, 0, `${p} must be git-ignored`);
});

test('pack: the ROM goes only to the git-ignored build folder', () => {
  assert.match(relative(REPO, ROM_ASSETS_DIR).split('\\').join('/'), /^android\/app\/build\//);
  assert.equal(ROM_ASSET_PATH, 'rom/zelda.nes');
});

test('pack: a missing or wrong ROM fails with a clear Spanish message and leaves no ROM behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zelda-rompack-'));
  try {
    const outDir = join(dir, 'assets');
    await assert.rejects(packRom({ source: join(dir, 'nope.nes'), outDir }), /No encuentro la ROM/);
    const bad = join(dir, 'bad.nes');
    writeFileSync(bad, Buffer.alloc(1000));
    await assert.rejects(packRom({ source: bad, outDir }), /no vale: .*cabecera iNES/);
    assert.ok(!existsSync(join(outDir, ROM_ASSET_PATH)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pack: the US PRG0 ROM is validated and copied byte for byte', { skip: !existsSync(ROM_SOURCE) && 'roms/zelda.nes not present' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zelda-rompack-'));
  try {
    const r = await packRom({ outDir: dir });
    assert.equal(r.sha1, 'a12d74c73a0481599a5d832361d168f4737bbcf6');
    assert.ok(readFileSync(join(dir, ROM_ASSET_PATH)).equals(readFileSync(ROM_SOURCE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const unzip = (apk, ...args) => spawnSync('unzip', [...args, apk], { encoding: 'buffer', maxBuffer: 1 << 26 });
const canUnzip = !spawnSync('unzip', ['-v']).error;

test('APK: dist/zelda1-js.apk contains the valid US PRG0 ROM (and only there)', {
  skip: (!existsSync(RELEASE_APK) && 'dist/zelda1-js.apk not built (npm run android:build)') || (!canUnzip && 'no unzip'),
}, async () => {
  const names = unzip(RELEASE_APK, '-Z1').stdout.toString().split('\n').filter(Boolean);
  assert.ok(names.includes(`assets/${ROM_ASSET_PATH}`), 'assets/rom/zelda.nes in the APK');
  assert.deepEqual(names.filter((n) => /\.nes$/i.test(n)), [`assets/${ROM_ASSET_PATH}`], 'one ROM, nowhere else');
  const rom = spawnSync('unzip', ['-p', RELEASE_APK, `assets/${ROM_ASSET_PATH}`], { maxBuffer: 1 << 26 }).stdout;
  const check = await checkZeldaRom(new Uint8Array(rom));
  assert.equal(check.ok, true, check.message);
  assert.equal(check.sha1, 'a12d74c73a0481599a5d832361d168f4737bbcf6');
});
