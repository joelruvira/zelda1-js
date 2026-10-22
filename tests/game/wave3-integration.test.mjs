// Wave 3 integration (Phase 3): the pure port (no hybrid) against the oracle, RAM + SRAM + picture on
// every frame, for this wave's target movies, up to the first routine of a later package (a
// NotImplementedError stub). The whole movies are checked in hybrid mode (stubs run as original 6502
// code) by the P05/P11/P12/P13 oracle tests. Skipped without roms/zelda.nes or jsnes.
//
// Frontier after the wave-3 integrator round 1 (first stub reached, all of them in mode 5's first frame):
// CheckWarps (P14) in UpdatePlayer/Link_EndMoveAndAnimate, then CheckInitWhirlwindAndBeginUpdate (P16),
// the weapon updates (P09), CheckZora (P18) and the room item routines (P10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { compareTraces, loadIgnoreConfig } from '../../tools/oracle/lib/diff-core.mjs';
import { runPort } from '../../tools/oracle/lib/port-adapter.mjs';
import { ROOT } from '../core/helpers.mjs';

const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;

/** movie -> [frames the pure port must reach, SRAM file or null]. */
const TARGETS = {
  'register-name': [558, null], // frame 559: CheckWarps (P14), first frame of mode 5
  'walk-first-screens': [558, null],
  'ow-tour': [558, null],
  'cave-and-cellar': [558, null],
  'pause-and-menu': [304, 'tests/oracle/movies/p11-items.sav'], // frame 305: CheckWarps (P14)
  'uw-level1-map': [304, 'tests/oracle/movies/p11-items.sav'],
};
const PLAY = 620;

// Picture-only differences from CPU timing inside the NMI (the port has no cycle accounting yet; see
// tests/game/wave2-integration.test.mjs): frame 121 is Start on the title (the original's PPUMASK
// write lands after scanline 52 of that frame).
const KNOWN_TIMING = (name, frame) => frame === 121; // frames played (a little past the frontier keeps the test fast)

for (const [name, [reach, sramFile]] of Object.entries(TARGETS)) {
  test(`wave 3 pure port ${name}: RAM, SRAM and picture match the original up to the first stub`, { skip }, async (t) => {
    const rom = loadRomFile();
    const full = loadMovie(join(ROOT, 'tests/oracle/movies', `${name}.zmv`));
    const movie = { ...full, length: Math.min(PLAY, full.length), p1: full.p1.slice(0, PLAY), p2: full.p2.slice(0, PLAY) };
    const sramPath = sramFile && join(ROOT, sramFile);
    if (sramPath && !existsSync(sramPath)) return t.skip(`${sramFile} missing`);
    const sram = sramPath ? new Uint8Array(readFileSync(sramPath)) : null;
    const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
    const a = new TraceCollector({});
    (await Oracle.create({ rom: rom.bytes, sram })).run(movie, a, { captureFb: () => true });
    const b = new TraceCollector({});
    let stopped = null;
    try {
      await runPort({ rom: rom.bytes, sram, inputs: movie, sink: b, captureFb: () => true });
    } catch (e) {
      if (e.name !== 'NotImplementedError') throw e;
      stopped = e.message;
    }
    t.diagnostic(stopped ? `frames 0-${b.frames.length - 1} compared; frame ${b.frames.length}: ${stopped}`
      : `${b.frames.length} frames`);
    assert.ok(b.frames.length - 1 >= reach, `${name} must reach frame ${reach} (got ${b.frames.length - 1})`);
    const report = compareTraces(a, b, { ignore: loadIgnoreConfig().ignore, maxReportFrames: 1000 });
    const timing = [];
    for (const f of report.frames) {
      assert.equal(f.ram.length, 0, `RAM at frame ${f.frame}`);
      assert.equal(f.sram.length, 0, `SRAM at frame ${f.frame}`);
      if (!KNOWN_TIMING(name, f.frame)) assert.fail(`picture at frame ${f.frame}: ${f.fb?.count} pixels`);
      timing.push(f.frame);
    }
    if (timing.length) t.diagnostic(`picture differs only on known CPU-timing frames: ${timing.join(', ')}`);
  });
}
