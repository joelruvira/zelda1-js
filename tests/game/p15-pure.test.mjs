// P15 in the pure port (no hybrid): the cave scenarios run through src/headless.js against the oracle.
// Each movie is compared (RAM + SRAM) up to the first routine of a package not ported yet (a
// diagnostic names it; while the packages of the wave are in progress, e.g. CheckZora of P18, the
// pure port may stop early). shop-buy and money-game ran whole with diff 0 when the overworld routines
// they reach were all ported; cave-and-cellar and uw-old-man-hint also need the UW enemies.
// Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { compareTraces, loadIgnoreConfig } from '../../tools/oracle/lib/diff-core.mjs';
import { runPort } from '../../tools/oracle/lib/port-adapter.mjs';
import { ROOT } from '../core/helpers.mjs';

const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;
const MOVIES = join(ROOT, 'tests/oracle/movies');

const SCENARIOS = ['shop-buy', 'money-game', 'cave-and-cellar', 'uw-old-man-hint'];

for (const name of SCENARIOS) {
  test(`P15 pure port ${name}: diff 0 up to the first routine not ported yet`, { skip, timeout: 900000 }, async (t) => {
    const rom = loadRomFile();
    const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
    const sram = expect.sram ? new Uint8Array(readFileSync(join(MOVIES, expect.sram))) : null;
    const movie = loadMovie(join(MOVIES, `${name}.zmv`));
    const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
    const a = new TraceCollector({});
    (await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 })).run(movie, a);
    const b = new TraceCollector({});
    let stopped = null;
    try {
      await runPort({ rom: rom.bytes, sram, inputs: movie, sink: b });
    } catch (e) {
      if (e.name !== 'NotImplementedError') throw e;
      stopped = e.message;
    }
    t.diagnostic(stopped ? `frames 0-${b.frames.length - 1} compared; frame ${b.frames.length}: ${stopped}`
      : `whole movie (${b.frames.length} frames)`);
    const report = compareTraces(a, b, { ignore: loadIgnoreConfig().ignore, compareFb: false });
    const first = report.frames[0];
    assert.equal(report.divergentFrames, 0, `${name}: first divergence at frame ${report.firstDivergence}: `
      + JSON.stringify(first && { ram: first.ram.slice(0, 8), sram: first.sram.slice(0, 8) }));
  });
}
