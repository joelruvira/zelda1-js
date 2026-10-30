// Mesen2 as second oracle (tools/oracle-mesen, docs/ORACLE.md "Segundo oráculo: Mesen2").
// Slow and needs a local Mesen2 (reference/, not in the repo): only with MESEN=1.
//   MESEN=1 node --test tests/oracle-mesen/
//   MESEN=1 MESEN_FULL=1 node --test tests/oracle-mesen/   (+ uw-level1-full and boss-gleeok4, ~2 min)
// Skipped without MESEN=1, without Mesen2 set up (node tools/oracle-mesen/setup.mjs), without
// roms/zelda.nes or without jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { romExists, loadRomFile, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { idleMovie, loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { setupProblems, findNmiAndRti, runMesen, mesenSettings } from '../../tools/oracle-mesen/lib/mesen.mjs';
import { compareMesenJsnes } from '../../tools/oracle-mesen/vs-jsnes.mjs';

const MOVIES = join(REPO_ROOT, 'tests/oracle/movies');
const ready = process.env.MESEN ? setupProblems() : [];
const skip = !process.env.MESEN ? 'set MESEN=1 (needs Mesen2 in reference/, slow)'
  : !romExists() ? 'roms/zelda.nes not present'
  : ready.length ? `Mesen2 not ready: ${ready.join('; ')} (node tools/oracle-mesen/setup.mjs)`
  : !(await hasJsnes()) ? 'jsnes not installed' : false;

test('settings: NTSC, no randomized power-on, no overclock, raw palette', () => {
  const s = mesenSettings();
  assert.equal(s.Nes.Region, 'Ntsc');
  assert.equal(s.Nes.RandomizeCpuPpuAlignment, false);
  assert.equal(s.Nes.RandomizeMapperPowerOnState, false);
  assert.equal(s.Nes.RamPowerOnState, 'AllZeros');
  assert.equal(s.Nes.PpuExtraScanlinesBeforeNmi + s.Nes.PpuExtraScanlinesAfterNmi, 0);
  assert.equal(s.Nes.UserPalette.length, 512);
  assert.equal(s.Nes.UserPalette[0x1ff], 0xff0001ff);
});

test('NMI handler and its RTI are found in the ROM', { skip: !romExists() && 'roms/zelda.nes not present' }, () => {
  const { nmi, rti } = findNmiAndRti(loadRomFile().bytes);
  assert.equal(nmi, 0xe484);
  assert.equal(rti, 0xe57f);
});

test('Mesen run is deterministic and yields frames 0..N with 256x240 pictures', { skip, timeout: 120e3 }, async () => {
  const rom = loadRomFile();
  const run = async () => {
    const out = [];
    for await (const r of runMesen({ rom: rom.bytes, romPath: rom.path, movie: idleMovie(60), captureFb: (f) => f === 60 })) out.push(r);
    return out;
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a.map((r) => r.frame), Array.from({ length: 61 }, (_, i) => i));
  assert.equal(a[60].fb.length, 256 * 240);
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(a[i].ram, b[i].ram, `RAM frame ${i}`);
    assert.deepEqual(a[i].sram, b[i].sram, `SRAM frame ${i}`);
  }
  assert.deepEqual(a[60].fb, b[60].fb);
});

const SET = ['power-on-600', 'title-start', 'walk-first-screens', ...(process.env.MESEN_FULL ? ['uw-level1-full', 'boss-gleeok4'] : [])];
for (const name of SET) {
  test(`Mesen vs jsnes: ${name}: RAM/SRAM identical, picture differences only in known classes`, { skip, timeout: 900e3 }, async () => {
    const rep = await compareMesenJsnes(join(MOVIES, `${name}.zmv`));
    assert.equal(rep.compared, loadMovie(join(MOVIES, `${name}.zmv`)).length + 1);
    assert.equal(rep.ramFrames, 0, JSON.stringify(rep.examples.ram.slice(0, 3)));
    assert.equal(rep.classes.other, 0, JSON.stringify(rep.examples.other.slice(0, 3)));
    // power-on palette: Mesen $3F00=$09, jsnes $00, until the game writes the palette (frames 0-5)
    assert.ok(rep.classes.backdrop <= 6, `backdrop frames ${rep.classes.backdrop}`);
    if (name === 'title-start') {
      // frame 121: PPUMASK write on visible line 52 (docs/TIMING.md §4), only that frame
      assert.deepEqual(rep.examples['late-write'].map((e) => e.frame), [121]);
    }
  });
}

test('run.mjs writes a .ztrace readable by the jsnes oracle tools', { skip, timeout: 120e3 }, async () => {
  const { main } = await import('../../tools/oracle-mesen/run.mjs');
  const out = join(REPO_ROOT, 'out/oracle-mesen/test-idle');
  assert.equal(await main(['idle:30', '--out', out, '--quiet', '--png', 'last']), 0);
  const { readTrace } = await import('../../tools/oracle/lib/trace.mjs');
  const t = readTrace(join(out, 'trace.ztrace'));
  assert.equal(t.meta.emulator, 'mesen2-2.1.1');
  assert.equal(t.frames.length, 31);
  assert.ok(t.frames[30].fb);
  assert.ok(readFileSync(join(out, 'frame_000030.png')).length > 100);
});
