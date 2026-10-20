// P02 against the original (jsnes): every DriveAudio call must leave the same RAM and make the
// same $4000-$4017 writes. Needs roms/zelda.nes and jsnes (tools/oracle); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hasRom, realRom, ROOT } from '../core/helpers.mjs';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { loadMovie, idleMovie } from '../../tools/oracle/lib/movie.mjs';
import { runAudioOracle, fullSweepSchedule } from '../../tools/oracle/lib/audio-oracle.mjs';
import { compareCalls } from '../../tools/oracle/audio-compare.mjs';
import { loadSymbols, label, loadRom } from '../../src/core/rom.js';

const skip = !hasRom ? 'needs roms/zelda.nes' : !(await hasJsnes()) ? 'needs jsnes (npm install in tools/oracle)' : false;

async function check(movie, pokes) {
  await loadSymbols();
  const rom = realRom();
  const { calls } = await runAudioOracle({ rom, movie, driveAudioAddr: label('DriveAudio').addr, pokes });
  assert.equal(calls.length, movie.length, 'one DriveAudio call per NMI');
  const bad = await compareCalls(calls, rom, { loadRom, quiet: true, maxReports: 3 });
  assert.equal(bad, 0, `${bad} DriveAudio calls differ`);
}

for (const name of ['power-on-600', 'title-start', 'register-name']) {
  test(`DriveAudio per-call diff 0: ${name}`, { skip }, async () => {
    await check(loadMovie(join(ROOT, 'tests/oracle/movies', `${name}.zmv`)));
  });
}

test('DriveAudio per-call diff 0: every song, tune, effect and sample injected in game', { skip, timeout: 300000 }, async () => {
  const base = loadMovie(join(ROOT, 'tests/oracle/movies/register-name.zmv'));
  const { frames, pokes } = fullSweepSchedule({ start: base.length + 20 });
  const pad = idleMovie(frames - base.length);
  await check({ ...base, p1: [...base.p1, ...pad.p1], p2: [...base.p2, ...pad.p2], length: frames }, pokes);
});
