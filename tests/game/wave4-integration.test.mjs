// Wave 4 integration (Phase 4): the PURE port (no hybrid) plays this wave's target movies to the end
// with RAM + SRAM diff 0 on every frame, and the picture matches on sampled frames except the known
// CPU-timing classes (no cycle accounting yet, docs/TIMING.md):
//   - mode 7 (scroll) and the first mode-4 frame after it: only scanline 63, the playfield split line;
//   - frames whose original NMI runs longer than a video frame (lag after them), e.g. ow-bomb-secret
//     1180 (mode $B, PPUMASK off before the picture is drawn).
// The movies of other packages that also run whole in the pure port are checked by p09/p15/p18-pure.
// uw-cellar goes through InitMode9 (cellar $7F, frames 12355-12607): the suspected P05 bug in
// InitMode9 submode 9 (UpdatePlayer: $59, $6D, $80) does not exist. Skipped without the ROM or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { compareTraces, loadIgnoreConfig } from '../../tools/oracle/lib/diff-core.mjs';
import { runPort } from '../../tools/oracle/lib/port-adapter.mjs';
import { GameMode } from '../../src/core/vars.js';
import { ROOT } from '../core/helpers.mjs';

const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;
const MOVIES = join(ROOT, 'tests/oracle/movies');

/** movie -> modes the oracle run must go through (checks the scenario). */
const TARGETS = {
  'power-on-600': [0],
  'title-idle': [0],
  'pause-and-menu': [5],
  'ow-bomb-secret': [5, 0x0b],
  'ow-shortcut': [5, 0x0c],
  'cave-and-cellar': [5, 0x0b, 0x10],
  'uw-cellar': [5, 0x09, 0x10],
  'dark-room-candle': [5],
};
const EVERY = 5; // picture sampled every 5 frames
const LAG_TIMING = { 'ow-bomb-secret': [1180] };

for (const [name, modes] of Object.entries(TARGETS)) {
  test(`wave 4 pure port ${name}: whole movie, RAM/SRAM diff 0, picture except known timing`, { skip, timeout: 900000 }, async (t) => {
    const rom = loadRomFile();
    const expectPath = join(MOVIES, `${name}.expect.json`);
    const expect = existsSync(expectPath) ? JSON.parse(readFileSync(expectPath, 'utf8')) : {};
    const sram = expect.sram ? new Uint8Array(readFileSync(join(MOVIES, basename(expect.sram)))) : null;
    const movie = loadMovie(join(MOVIES, `${name}.zmv`));
    const captureFb = (f) => f % EVERY === 0;
    const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
    const a = new TraceCollector({});
    (await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 })).run(movie, a, { captureFb });
    const seen = new Set(a.frames.map((f) => f.ram[GameMode]));
    for (const m of modes) assert.ok(seen.has(m), `${name}: the oracle never reaches mode $${m.toString(16)}`);
    const b = new TraceCollector({});
    await runPort({ rom: rom.bytes, sram, inputs: movie, sink: b, captureFb });
    assert.equal(b.frames.length, a.frames.length, `${name}: the port must play the whole movie`);
    const report = compareTraces(a, b, { ignore: loadIgnoreConfig().ignore, maxReportFrames: 1e9 });
    const byFrame = new Map(a.frames.map((f) => [f.frame, f]));
    const timing = [];
    for (const f of report.frames) {
      assert.equal(f.ram.length, 0, `${name}: RAM differs at frame ${f.frame}`);
      assert.equal(f.sram.length, 0, `${name}: SRAM differs at frame ${f.frame}`);
      const mode = byFrame.get(f.frame).ram[GameMode];
      const splitLine = f.fb.bbox.y0 === 63 && f.fb.bbox.y1 === 63 && (mode === 7 || mode === 4);
      const lag = (LAG_TIMING[name] ?? []).includes(f.frame);
      if (!splitLine && !lag) assert.fail(`${name}: picture differs at frame ${f.frame} (mode ${mode}, ${f.fb.count} pixels)`);
      timing.push(f.frame);
    }
    t.diagnostic(`${a.frames.length} frames; picture timing-only differences on ${timing.length} sampled frames`);
  });
}
