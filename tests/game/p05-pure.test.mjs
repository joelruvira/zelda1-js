// P05 in the pure port (no hybrid): register-name and walk-first-screens run through
// src/headless.js until the first routine of a package not ported yet (NotImplementedError);
// RAM and SRAM must match the oracle on every frame up to there. While P13 (transitions) and the
// later packages are in progress the pure port stops before mode 5 (a diagnostic names the frame
// and the routine); the full movies are checked in hybrid mode by tests/game/p05-oracle.test.mjs.
// Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { compareTraces, loadIgnoreConfig } from '../../tools/oracle/lib/diff-core.mjs';
import { runPort } from '../../tools/oracle/lib/port-adapter.mjs';
import { ROOT } from '../core/helpers.mjs';

const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;

for (const name of ['register-name', 'walk-first-screens']) {
  test(`P05 pure port ${name}: diff 0 up to the first routine not ported yet`, { skip }, async (t) => {
    const rom = loadRomFile();
    const movie = loadMovie(join(ROOT, 'tests/oracle/movies', `${name}.zmv`));
    const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
    const a = new TraceCollector({});
    (await Oracle.create({ rom: rom.bytes })).run(movie, a);
    const b = new TraceCollector({});
    let stopped = null;
    try {
      await runPort({ rom: rom.bytes, inputs: movie, sink: b });
    } catch (e) {
      if (e.name !== 'NotImplementedError') throw e;
      stopped = e.message;
    }
    t.diagnostic(stopped ? `frames 0-${b.frames.length - 1} compared; frame ${b.frames.length}: ${stopped}`
      : `whole movie (${b.frames.length} frames)`);
    assert.ok(b.frames.length > 470, `${name}: the pure port must get past mode 2 (got ${b.frames.length} frames)`);
    const report = compareTraces(a, b, { ignore: loadIgnoreConfig().ignore, compareFb: false });
    const first = report.frames[0];
    assert.equal(report.divergentFrames, 0, `${name}: first divergence at frame ${report.firstDivergence}: `
      + JSON.stringify(first && { ram: first.ram.slice(0, 8), sram: first.sram.slice(0, 8) }));
  });
}
