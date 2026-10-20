// Runs the real game in the oracle. Skipped unless roms/zelda.nes and jsnes are present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { compareTraces } from '../../tools/oracle/lib/diff-core.mjs';
import { loadVarNames } from '../../tools/oracle/lib/var-names.mjs';

const MOVIES = join(import.meta.dirname, 'movies');
const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;
const { Oracle } = skip ? {} : await import('../../tools/oracle/lib/nes-oracle.mjs');
const FrameCounter = 0x15;

async function play(name, opts = {}) {
  const rom = loadRomFile();
  const oracle = await Oracle.create({ rom: rom.bytes });
  const sink = new TraceCollector({});
  oracle.run(loadMovie(join(MOVIES, name)), sink, opts);
  return sink.frames;
}

test('ROM header looks like Zelda (MMC1, 128KB PRG, CHR-RAM)', { skip }, () => {
  assert.deepEqual(loadRomFile().info.warnings, []);
});

test('power-on 600 frames: no hang, one NMI per frame, deterministic', { skip }, async () => {
  const a = await play('power-on-600.zmv', { captureFb: (f) => f === 600 });
  assert.equal(a.length, 601);
  for (let i = 2; i < a.length; i++) {
    assert.equal(a[i].ram[FrameCounter], (a[i - 1].ram[FrameCounter] + 1) & 0xff, `FrameCounter at ${i}`);
  }
  assert.ok(a[600].fb, 'framebuffer captured');
  const b = await play('power-on-600.zmv');
  assert.equal(compareTraces({ frames: a }, { frames: b }, { compareFb: false }).equal, true);
});

for (const file of ['power-on-600', 'title-start', 'register-name', 'walk-first-screens']) {
  test(`movie ${file} plays to the end`, { skip }, async (t) => {
    const frames = await play(`${file}.zmv`);
    const expectPath = join(MOVIES, `${file}.expect.json`);
    const timeline = frames.filter((f, i) => i === 0 || f.ram[0x12] !== frames[i - 1].ram[0x12]);
    t.diagnostic(`GameMode changes: ${timeline.map((f) => `${f.frame}:${f.ram[0x12].toString(16)}`).join(' ')}`);
    if (!existsSync(expectPath)) return;
    const expect = JSON.parse(readFileSync(expectPath, 'utf8'));
    const names = await loadVarNames();
    for (const [name, value] of Object.entries(expect.always ?? {})) {
      const addr = names.resolve(name);
      const bad = frames.find((f) => f.ram[addr] !== value);
      assert.equal(bad, undefined, `${name} != ${value} at frame ${bad?.frame}`);
    }
    for (const [name, values] of Object.entries(expect.reaches ?? {})) {
      const addr = names.resolve(name);
      for (const value of [].concat(values)) {
        assert.ok(frames.some((f) => f.ram[addr] === value), `${name} never reaches ${value}`);
      }
    }
  });
}
