// Frame replay with the port's dot-based PPU (tools/timing/lib/replay.mjs) against the oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { hasRom, realRom, ROOT } from '../core/helpers.mjs';

const skip = !hasRom ? 'no ROM (roms/zelda.nes)' : !(await hasJsnes()) ? 'jsnes not installed' : false;

test('title-start 100-121: replay at true times == oracle, except jsnes per-scanline row 52 of frame 121', { skip }, async () => {
  const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
  const { loadMovie } = await import('../../tools/oracle/lib/movie.mjs');
  const { getPalette } = await import('../../tools/oracle/lib/palette.mjs');
  const { attachRecorder, renderReplay, pictureDiff } = await import('../../tools/timing/lib/replay.mjs');
  const { portModelTimes } = await import('../../tools/timing/replay-scope.mjs');
  const movie = loadMovie(join(ROOT, 'tests/oracle/movies/title-start.zmv'));
  const oracle = await Oracle.create({ rom: new Uint8Array(realRom()) });
  const want = (f) => f >= 100 && f <= 121;
  const { frames } = attachRecorder(oracle, want);
  const fbs = new Map();
  oracle.run({ ...movie, length: 121 }, { write(r) { if (r.fb) fbs.set(r.frame, r.fb); } }, { captureFb: want });
  const palette = await getPalette();
  for (let f = 100; f <= 121; f++) {
    const rec = frames.get(f);
    const d = pictureDiff(fbs.get(f), renderReplay(rec, palette));
    if (f < 121) assert.equal(d.count, 0, `frame ${f}`);
    else assert.deepEqual(d, { count: 33, rows: [52, 52] });
  }
  // the port's current model (logic in zero time) blanks the title before line 52
  const rec = frames.get(121);
  const model = portModelTimes(rec);
  const d = pictureDiff(renderReplay(rec, palette), renderReplay(rec, palette, (e, i) => model[i]));
  assert.deepEqual(d.rows, [16, 52]);
});
