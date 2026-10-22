// Frame-to-frame timing model (tools/timing/nmi-model.mjs): NMI latency after the idle loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { predictStart, collect } from '../../tools/timing/nmi-model.mjs';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { hasRom, realRom, ROOT } from '../core/helpers.mjs';

test('idle loop JMP (3 cycles): NMI after the instruction that sees the edge with >= 5 dots left', () => {
  // RTI ends at cycle 0; instructions [0,3) [3,6) [6,9) ...; dots of cycle c are 3c..3c+2
  assert.equal(predictStart(0, 3 * 6 + 0), 9, 'edge at the first dot of [6,9): 9 dots left');
  assert.equal(predictStart(0, 3 * 9 - 5), 9, 'exactly 5 dots left');
  assert.equal(predictStart(0, 3 * 9 - 4), 12, '4 dots left: one more instruction');
  assert.equal(predictStart(0, 3 * 6, [4]), 13, 'a DMC fetch in [3,6) delays the loop by 4 cycles');
});

const skip = !hasRom ? 'no ROM (roms/zelda.nes)' : !(await hasJsnes()) ? 'jsnes not installed' : false;
test('title-start: every NMI start and OAM DMA length predicted from the previous RTI', { skip }, async () => {
  const { vbl, nmis, dmc } = await collect(join(ROOT, 'tests/oracle/movies/title-start.zmv'), new Uint8Array(realRom()));
  let n = 0;
  for (let k = 1; k < nmis.length; k++) {
    if (nmis[k - 1].end === undefined) continue;
    assert.equal(predictStart(nmis[k - 1].end, vbl[nmis[k].vbl], dmc), nmis[k].start, `NMI ${k + 1}`);
    n++;
  }
  assert.ok(n > 290);
});
