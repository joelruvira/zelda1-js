// The game speed does not depend on the screen's refresh rate (phones run at 60/90/120 Hz, adaptive):
// core/loop.js counts emulated frames by elapsed time, and the Android shell feeds it the vsync timestamp
// of requestAnimationFrame. Simulated displays, no emulator needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoop, NES_FPS } from '../../src/core/loop.js';

function simulate(hz, seconds, jitterMs = 0) {
  let t = 0;
  let frames = 0;
  const queue = [];
  const loop = createLoop({ frame: () => { frames++; }, now: () => t, schedule: (cb) => queue.push(cb) });
  loop.start();
  const perWake = [];
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
  for (let i = 1; t < seconds * 1000; i++) {
    t = (i * 1000) / hz + rand() * jitterMs;
    const before = frames;
    queue.shift()();
    perWake.push(frames - before);
  }
  return { fps: frames / seconds, perWake };
}

for (const hz of [60, 90, 120, 144]) {
  test(`${hz} Hz display: exactly ${NES_FPS} emulated frames per second`, () => {
    const { fps, perWake } = simulate(hz, 120);
    assert.ok(Math.abs(fps - NES_FPS) < 0.02, `fps ${fps}`);
    assert.ok(Math.max(...perWake) <= 2, 'never more than 2 frames in one display refresh');
    if (hz === 120) {
      // 120 Hz: one emulated frame every other refresh, never a run of 2 (no speed-up bursts)
      const doubles = perWake.filter((n) => n === 2).length;
      assert.equal(doubles, 0);
    }
  });
}

test('vsync timestamps keep a steady cadence at 60 Hz (one frame per refresh, one double every ~10 s)', () => {
  const { perWake } = simulate(60, 60);
  const zeros = perWake.slice(10).filter((n) => n === 0).length;
  const doubles = perWake.slice(10).filter((n) => n === 2).length;
  assert.ok(zeros <= 1, `refreshes without a frame: ${zeros}`);
  assert.ok(doubles <= 7, `refreshes with 2 frames: ${doubles}`);
});

test('stop() + start() while a wake-up is pending (app sent to background and back) keeps one chain', () => {
  let t = 0;
  const queue = [];
  const loop = createLoop({ frame: () => {}, now: () => t, schedule: (cb) => queue.push(cb) });
  loop.start();
  loop.stop(); // the pending requestAnimationFrame callback fires later, when the page is visible again
  loop.start();
  for (let i = 0; i < 10; i++) {
    t += 16;
    const pending = queue.splice(0);
    for (const cb of pending) cb();
  }
  assert.equal(queue.length, 1, 'exactly one wake-up scheduled per refresh');
});
