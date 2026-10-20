// P24 against the oracle (jsnes running the original game). Skipped without roms/zelda.nes or jsnes.
//  1. The P24 movies reach what their *.expect.json says in the original game.
//  2. Pure port: frame-by-frame RAM/SRAM diff up to the first routine of a package not ported yet.
//  3. Hybrid: the whole movie with unported routines run as original 6502 code (p01-hybrid.mjs):
//     RAM and SRAM must be identical (save-and-continue reaches mode $D through modes 2-5 and 8).
// Images are not compared here: jsnes 2.1.0 draws odd-numbered 8x16 sprite tiles one tile off
// (top = tile - 1 in the $1000 table), which shows up on the menu cursors only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { loadVarNames } from '../../tools/oracle/lib/var-names.mjs';
import { ROOT } from '../core/helpers.mjs';

const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;
const MOVIES = join(ROOT, 'tests/oracle/movies');
const P24_MOVIES = ['file-eliminate', 'second-quest-name', 'save-and-continue'];

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

async function playOracle(file) {
  const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
  const oracle = await Oracle.create({ rom: loadRomFile().bytes });
  const sink = new TraceCollector({});
  const movie = loadMovie(join(MOVIES, `${file}.zmv`));
  oracle.run(movie, sink, {});
  return { frames: sink.frames, movie };
}

for (const file of P24_MOVIES) {
  test(`movie ${file}: the original reaches its expected states`, { skip }, async (t) => {
    const { frames } = await playOracle(file);
    const timeline = frames.filter((f, i) => i === 0 || f.ram[0x12] !== frames[i - 1].ram[0x12]);
    t.diagnostic(`GameMode changes: ${timeline.map((f) => `${f.frame}:${f.ram[0x12].toString(16)}`).join(' ')}`);
    const expectPath = join(MOVIES, `${file}.expect.json`);
    if (!existsSync(expectPath)) return;
    const expect = JSON.parse(readFileSync(expectPath, 'utf8'));
    const names = await loadVarNames();
    for (const [name, values] of Object.entries(expect.reaches ?? {})) {
      const addr = names.resolve(name);
      for (const value of [].concat(values)) {
        assert.ok(frames.some((f) => f.ram[addr] === value), `${name} never reaches ${value}`);
      }
    }
  });
}

// Pure port: one process-wide game (RAM/SRAM/bus are singletons), so one movie per test file run.
test('pure port, file-eliminate: RAM/SRAM identical until the first unported routine', { skip }, async (t) => {
  const { frames, movie } = await playOracle('file-eliminate');
  const { createGame } = await import('../../src/headless.js');
  const game = await createGame({ rom: loadRomFile().bytes });
  for (let frame = 0; ; ) {
    const o = frames[frame];
    assert.equal(firstDiff(game.ram, o.ram), null, `RAM at frame ${frame}`);
    assert.equal(firstDiff(game.sram, o.sram, true), null, `SRAM at frame ${frame}`);
    if (++frame >= frames.length) break;
    try {
      game.stepFrame(movie.p1[frame - 1], movie.p2[frame - 1]);
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

for (const movie of P24_MOVIES) {
  test(`hybrid ${movie}: RAM and SRAM identical with unported routines run as original code`, { skip }, () => {
    const { code, out } = hybridCompare(join('tests/oracle/movies', `${movie}.zmv`));
    assert.equal(code, 0, out.split('\n').filter((l) => !/Warning|trace-warnings/.test(l)).slice(-15).join('\n'));
  });
}
