// Battery (tools/oracle/battery.mjs): lockstep of every movie (tests/oracle/movies, fuzz-* included) in the
// pure port against the oracle, RAM + SRAM + the whole picture on every frame, every difference classified;
// plus the boot from empty / corrupt SRAM. Slow (~20-30 min on 12 cores): only with BATTERY=1.
//   BATTERY=1 node --test tests/oracle/battery.test.mjs
// Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';

const skip = !process.env.BATTERY ? 'set BATTERY=1 (slow)'
  : !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;
const TOOL = join(REPO_ROOT, 'tools/oracle/battery.mjs');

test('battery: every movie in lockstep, RAM/SRAM diff 0 and a pixel-perfect picture on every frame', { skip, timeout: 4 * 3600e3 }, () => {
  const r = spawnSync(process.execPath, ['--no-warnings', TOOL, 'movies'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  const sum = JSON.parse(readFileSync(join(REPO_ROOT, 'out/battery/movies-summary.json'), 'utf8'));
  const bad = sum.reports.filter((x) => x.defects);
  assert.equal(bad.length, 0, `defects in ${bad.map((x) => `${x.movie} (first frame ${x.DEFECT_first ?? x.portError?.frame})`).join(', ')}\n${r.stdout.slice(-3000)}`);
  // every frame of every movie compared (RAM/SRAM), and the picture of every frame except the ones the
  // original never shows (its next NMI starts before another video frame completes, e.g. nested NMIs)
  for (const x of sum.reports) {
    assert.equal(x.compared, x.frames + 1, `${x.movie}: compared ${x.compared} of ${x.frames + 1}`);
    assert.equal(x.fbCompared + x.noFb.length, x.frames, `${x.movie}: pictures compared ${x.fbCompared} of ${x.frames}`);
  }
  // pixel perfect with the cycle tracker (jsnes-compat, the default): no differing pixel in any movie
  const px = sum.reports.filter((x) => x.px || x.pxFrames);
  assert.equal(px.length, 0, `picture differs in ${px.map((x) => `${x.movie} (${x.pxFrames} frames, ${x.px} px)`).join(', ')}`);
  // and every video frame (lag frames inside long NMIs included), with the same number of video frames
  const vid = sum.reports.filter((x) => !x.video || x.video.differing || x.video.oracle !== x.video.port);
  assert.equal(vid.length, 0, `video frames differ in ${vid.map((x) => `${x.movie} ${JSON.stringify(x.video)}`).join(', ')}`);
});

test('battery: boot from empty, garbage and corrupt-checksum SRAM', { skip, timeout: 3600e3 }, () => {
  const r = spawnSync(process.execPath, ['--no-warnings', TOOL, 'boot'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
