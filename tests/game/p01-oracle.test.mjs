// P01 against the oracle (jsnes running the original game). Skipped without roms/zelda.nes or jsnes.
//  1. Pure port: frame-by-frame RAM/SRAM diff of power-on (frames 0-120) up to the first routine of a
//     package that is not ported yet (the rest is skipped with the routine's name).
//  2. Hybrid: same movies with every unported routine executed as original 6502 code on the port's
//     machine (tests/game/p01-hybrid.mjs), which isolates P01: RAM and SRAM must be identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { idleMovie } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { ROOT } from '../core/helpers.mjs';

const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;

const ignored = (i) => i >= 0x110 && i < 0x200; // hardware stack (tools/oracle/ignore.default.json)
const WRAM_CODE = [0x0c90, 0x1f00]; // $6C90-$7EFF relative to $6000

function firstDiff(port, orig, sramMode = false) {
  for (let i = 0; i < orig.length; i++) {
    if (!sramMode && ignored(i)) continue;
    if (sramMode && i >= WRAM_CODE[0] && i < WRAM_CODE[1]) continue;
    if (port[i] !== orig[i]) return `$${(i + (sramMode ? 0x6000 : 0)).toString(16)} port=${port[i]} orig=${orig[i]}`;
  }
  return null;
}

test('power-on frames 0-120: port RAM/SRAM = original until the first unported routine', { skip }, async (t) => {
  const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
  const rom = loadRomFile();
  const oracle = await Oracle.create({ rom: rom.bytes });
  const sink = new TraceCollector({});
  oracle.run(idleMovie(120), sink, {});
  const { createGame } = await import('../../src/headless.js');
  const game = await createGame({ rom: rom.bytes });
  let frame = 0;
  for (;;) {
    const o = sink.frames[frame];
    assert.equal(firstDiff(game.ram, o.ram), null, `RAM at frame ${frame}`);
    assert.equal(firstDiff(game.sram, o.sram, true), null, `SRAM at frame ${frame}`);
    if (++frame > 120) break;
    try {
      game.stepFrame(0, 0);
    } catch (e) {
      if (e.name !== 'NotImplementedError') throw e;
      t.diagnostic(`frames 0-${frame - 1} identical; frame ${frame} needs ${e.message}`);
      return;
    }
  }
});

function hybridCompare(movie) {
  const r = spawnSync(process.execPath, [
    '--import', join(ROOT, 'tests/game/p01-hybrid-register.mjs'),
    join(ROOT, 'tools/oracle/compare.mjs'), movie, '--png', 'none', '--no-fb',
  ], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

for (const movie of ['power-on-600', 'title-start', 'register-name']) {
  test(`hybrid ${movie}: RAM and SRAM identical with unported routines run as original code`, { skip }, () => {
    const { code, out } = hybridCompare(join('tests/oracle/movies', `${movie}.zmv`));
    assert.equal(code, 0, out.split('\n').filter((l) => !/Warning|trace-warnings/.test(l)).slice(-15).join('\n'));
  });
}
