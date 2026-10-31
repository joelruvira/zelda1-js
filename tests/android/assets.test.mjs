// The web assets packed into the APK (scripts/android/copy-web.mjs): everything the shell imports is
// there, nothing of the self test leaks into the release assets, and never a ROM. No emulator needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { copyWeb, listWebFiles, REPO } from '../../scripts/android/copy-web.mjs';
import { parseZmv } from '../../android/web/selftest.js';
import { loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { checkZeldaRom } from '../../android/web/romcheck.js';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g;
const HTML_REF = /(?:src|href)="([^"]+)"/g;

/** Every file reachable from `entry` (relative posix path) through static/dynamic imports and HTML refs. */
function reachable(root, entry) {
  const seen = new Set();
  const todo = [entry];
  while (todo.length) {
    const rel = todo.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = join(root, rel);
    assert.ok(existsSync(file), `${rel} is referenced but missing from the assets`);
    const text = readFileSync(file, 'utf8');
    const re = rel.endsWith('.html') ? HTML_REF : IMPORT;
    for (const m of text.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || spec.startsWith('/') || spec.includes(':') || (!rel.endsWith('.html') && !spec.startsWith('.'))) continue;
      todo.push(posix.normalize(posix.join(posix.dirname(rel), spec)));
    }
  }
  return seen;
}

test('copy: the shell and every module it imports are in the main assets; selftest only in debug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zelda-assets-'));
  try {
    const mainOut = join(dir, 'main');
    const debugOut = join(dir, 'debug');
    const r = copyWeb({ mainOut, debugOut });
    const files = reachable(mainOut, 'android/web/index.html');
    for (const f of ['android/web/app.js', 'src/session.js', 'src/core/timing.js', 'src/core/cfg.gen.js', 'src/core/symbols.js',
      'src/audio/audio.js', 'src/audio/worklet.js', 'src/game/nmi.js', 'android/web/app.css']) {
      assert.ok(files.has(f), `${f} reachable from index.html`);
    }
    assert.ok(files.size > 100, `modules reachable: ${files.size}`);
    assert.ok(existsSync(join(mainOut, 'LICENSE.txt')));
    assert.ok(!existsSync(join(mainOut, 'android/web/selftest.html')));
    assert.ok(!existsSync(join(mainOut, 'tests')));
    // the self test page and its movies are complete in the debug tree (+ shared main modules)
    assert.ok(existsSync(join(debugOut, 'android/web/selftest.js')));
    assert.ok(existsSync(join(debugOut, 'tests/oracle/movies/title-start.zmv')));
    const index = JSON.parse(readFileSync(join(debugOut, 'tests/oracle/movies/index.json'), 'utf8'));
    assert.ok(index.includes('walk-first-screens') && index.length >= 70);
    // nothing but code, text and test inputs; never a ROM
    for (const f of [...r.main, ...r.debug]) {
      assert.ok(!/\.nes$/i.test(f) && !f.startsWith('roms/') && !f.startsWith('reference/'), f);
      assert.match(f, /\.(js|html|css|zmv|json|sav)$/);
    }
    // deterministic: same sources -> same fingerprint
    assert.equal(copyWeb({ mainOut, debugOut }).digest, r.digest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copy: every git-tracked src/*.js file is packed', () => {
  const { main } = listWebFiles();
  for (const f of ['src/main.js', 'src/headless.js', 'src/core/loop.js', 'src/core/input.js']) assert.ok(main.includes(f), f);
  assert.ok(!main.some((f) => f.endsWith('.DS_Store')));
});

test('self test: its .zmv parser matches tools/oracle/lib/movie.mjs on every movie', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = join(REPO, 'tests/oracle/movies');
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.zmv'))) {
    const a = parseZmv(readFileSync(join(dir, name), 'utf8'));
    const b = loadMovie(join(dir, name));
    assert.equal(a.length, b.length, name);
    assert.deepEqual([...a.p1], [...b.p1], name);
    assert.deepEqual([...a.p2], [...b.p2], name);
  }
});

test('ROM check: rejects non-iNES files, other games and other revisions with a Spanish message', async () => {
  const junk = await checkZeldaRom(new Uint8Array(1000));
  assert.equal(junk.ok, false);
  assert.equal(junk.code, 'not-ines');
  const header = new Uint8Array(16 + 2 * 16384);
  header.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0, 0]);
  const other = await checkZeldaRom(header);
  assert.equal(other.code, 'not-zelda');
  assert.match(other.message, /no es The Legend of Zelda/);
  const big = await checkZeldaRom(new Uint8Array((1 << 20) + 1));
  assert.equal(big.code, 'too-big');
});

test('ROM check: accepts the US PRG0 ROM and refuses it with one byte changed', { skip: !romExists() && 'roms/zelda.nes not present' }, async () => {
  const { bytes } = loadRomFile();
  const ok = await checkZeldaRom(bytes);
  assert.equal(ok.ok, true);
  assert.equal(ok.sha1, 'a12d74c73a0481599a5d832361d168f4737bbcf6');
  const patched = bytes.slice();
  patched[16 + 0x10] ^= 0xff; // bank 0
  const bad = await checkZeldaRom(patched);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'other-revision');
  assert.match(bad.message, /USA \(PRG0\)/);
});


