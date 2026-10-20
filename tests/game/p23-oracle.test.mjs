// P23 against the oracle (jsnes running the original game) on the title-idle movie: the whole attract
// demo (title, story scroll, item parade, back to the title). Skipped without roms/zelda.nes or jsnes.
//  1. Pure port: frame-by-frame RAM/SRAM diff until the first routine of a package not ported yet
//     (AnimateItemObject, P10, when the first story item appears).
//  2. Hybrid: unported routines run as original 6502 code (tests/game/p01-hybrid.mjs): RAM and SRAM
//     must be identical over all 5000 frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { ROOT } from '../core/helpers.mjs';
import { GameMode, DemoPhase, DemoSubphase } from '../../src/core/vars.js';

const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;
const MOVIE = join('tests/oracle/movies', 'title-idle.zmv');

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

let oracleFrames = null;
async function oracleTrace() {
  if (oracleFrames) return oracleFrames;
  const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
  const rom = loadRomFile();
  const oracle = await Oracle.create({ rom: rom.bytes });
  const sink = new TraceCollector({});
  const movie = loadMovie(join(ROOT, MOVIE));
  oracle.run(movie, sink, {});
  oracleFrames = sink.frames;
  return oracleFrames;
}

test('title-idle movie: the original stays in mode 0 and plays the whole demo', { skip }, async () => {
  const frames = await oracleTrace();
  assert.equal(frames.length, 5001);
  assert.ok(frames.every((f) => f.ram[GameMode] === 0), 'GameMode 0');
  for (const s of [0, 1, 2, 3, 4]) {
    assert.ok(frames.some((f) => f.ram[DemoPhase] === 1 && f.ram[DemoSubphase] === s), `story subphase ${s}`);
  }
  // Back to the title after the story.
  const end = frames.findIndex((f, i) => i > 1000 && f.ram[DemoPhase] === 0);
  assert.ok(end > 4000, `back to phase 0 at ${end}`);
});

test('title-idle pure port: RAM/SRAM = original until the first unported routine', { skip }, async (t) => {
  const frames = await oracleTrace();
  const rom = loadRomFile();
  const { createGame } = await import('../../src/headless.js');
  const game = await createGame({ rom: rom.bytes });
  for (let frame = 0; ; ) {
    const o = frames[frame];
    assert.equal(firstDiff(game.ram, o.ram), null, `RAM at frame ${frame}`);
    assert.equal(firstDiff(game.sram, o.sram, true), null, `SRAM at frame ${frame}`);
    if (++frame >= frames.length) break;
    try {
      game.stepFrame(o.p1 ?? 0, o.p2 ?? 0);
    } catch (e) {
      if (e.name !== 'NotImplementedError') throw e;
      t.diagnostic(`frames 0-${frame - 1} identical; frame ${frame} needs ${e.message}`);
      return;
    }
  }
});

test('hybrid title-idle: RAM and SRAM identical over the whole demo', { skip }, () => {
  const r = spawnSync(process.execPath, [
    '--import', join(ROOT, 'tests/game/p01-hybrid-register.mjs'),
    join(ROOT, 'tools/oracle/compare.mjs'), MOVIE, '--png', 'none', '--no-fb',
  ], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, out.split('\n').filter((l) => !/Warning|trace-warnings/.test(l)).slice(-15).join('\n'));
});
