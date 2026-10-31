// Touch controls of the Android shell (android/web/touch.js): geometry and finger -> NES button bits.
// No emulator needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dpadBits, faceBits, zoneAt, fingerBits, computeLayout, DPAD_DEAD_ZONE, BUTTON_HIT } from '../../android/web/touch.js';
import { fitScreen } from '../../android/web/screen.js';
import { BTN } from '../../src/core/input.js';

// Galaxy S2x Ultra in landscape: 3120x1440 px, devicePixelRatio 3.5 -> 891.4 x 411.4 CSS px
const W = 3120 / 3.5;
const H = 1440 / 3.5;
const fit = fitScreen({ cssWidth: W, cssHeight: H, dpr: 3.5 });
const L = computeLayout({ width: W, height: H, game: fit.css });

test('picture: integer scale in device pixels, centred, 1:1 pixel aspect', () => {
  assert.equal(fit.scale, 6);
  assert.deepEqual([fit.devW, fit.devH, fit.devX, fit.devY], [1536, 1440, 792, 0]);
  const fhd = fitScreen({ cssWidth: 2340 / 2.625, cssHeight: 1080 / 2.625, dpr: 2.625 });
  assert.deepEqual([fhd.scale, fhd.devW, fhd.devH, fhd.devX, fhd.devY], [4, 1024, 960, 658, 60]);
  const full = fitScreen({ cssWidth: 2340 / 2.625, cssHeight: 1080 / 2.625, dpr: 2.625, mode: 'fit' });
  assert.equal(full.devH, 1080);
  assert.equal(full.devW, Math.floor(256 * 4.5));
  for (const f of [fit, fhd, full]) assert.ok(Math.abs(f.devW / f.devH - 256 / 240) < 0.002);
});

test('D-pad: 8 directions, dead zone in the centre', () => {
  const r = 100;
  assert.equal(dpadBits(0, 0, r), 0);
  assert.equal(dpadBits(r * DPAD_DEAD_ZONE * 0.9, 0, r), 0);
  assert.equal(dpadBits(60, 0, r), BTN.RIGHT);
  assert.equal(dpadBits(-60, 0, r), BTN.LEFT);
  assert.equal(dpadBits(0, -60, r), BTN.UP);
  assert.equal(dpadBits(0, 60, r), BTN.DOWN);
  assert.equal(dpadBits(50, -50, r), BTN.UP | BTN.RIGHT);
  assert.equal(dpadBits(-50, -50, r), BTN.UP | BTN.LEFT);
  assert.equal(dpadBits(50, 50, r), BTN.DOWN | BTN.RIGHT);
  assert.equal(dpadBits(-50, 50, r), BTN.DOWN | BTN.LEFT);
  // sector borders: 22.5° either side of each axis is the cardinal direction
  const at = (deg) => dpadBits(80 * Math.cos((deg * Math.PI) / 180), 80 * Math.sin((deg * Math.PI) / 180), r);
  assert.equal(at(22), BTN.RIGHT);
  assert.equal(at(23), BTN.RIGHT | BTN.DOWN);
  assert.equal(at(-22), BTN.RIGHT);
  assert.equal(at(-23), BTN.RIGHT | BTN.UP);
  assert.equal(at(180), BTN.LEFT);
  // far outside the drawn pad the direction still counts (the finger slid off)
  assert.equal(dpadBits(0, -400, r), BTN.UP);
  // never opposite directions at once
  for (let d = 0; d < 360; d += 1) {
    const b = at(d);
    assert.ok(!((b & BTN.UP) && (b & BTN.DOWN)) && !((b & BTN.LEFT) && (b & BTN.RIGHT)), `angle ${d}`);
  }
});

test('layout: controls in the side bands, B left of A, Select/Start bottom centre', () => {
  const left = fit.css.x;
  const right = fit.css.x + fit.css.w;
  assert.ok(L.dpad.cx + L.dpad.r <= left + 1, 'D-pad left of the picture');
  assert.ok(L.dpad.cx - L.dpad.r >= 0);
  assert.ok(L.b.cx - L.b.r >= right - 1, 'B right of the picture');
  assert.ok(L.a.cx + L.a.r <= W);
  assert.ok(L.b.cx < L.a.cx, 'NES order: B left, A right');
  assert.ok(L.select.x + L.select.w < W / 2 && L.start.x > W / 2);
  assert.ok(L.select.y + L.select.h <= H && L.select.y > H * 0.8);
  // sizes a thumb can hit (>= ~9 mm on a 75 mm tall screen: 411 CSS px)
  assert.ok(L.dpad.r * 2 >= 150, `dpad ${L.dpad.r * 2}`);
  assert.ok(L.a.r * 2 >= 80, `button ${L.a.r * 2}`);
});

test('A/B: each alone, both in the middle, none far away', () => {
  assert.equal(faceBits(L.a.cx, L.a.cy, L), BTN.A);
  assert.equal(faceBits(L.b.cx, L.b.cy, L), BTN.B);
  const mx = (L.a.cx + L.b.cx) / 2;
  const my = (L.a.cy + L.b.cy) / 2;
  assert.equal(faceBits(mx, my, L), BTN.A | BTN.B);
  assert.equal(faceBits(L.a.cx, L.a.cy - L.a.r * BUTTON_HIT - 2, L), 0);
});

test('fingers: zones, sliding, multitouch', () => {
  assert.equal(zoneAt(L.dpad.cx, L.dpad.cy, L), 'dpad');
  assert.equal(zoneAt(L.a.cx, L.a.cy, L), 'face');
  assert.equal(zoneAt(L.select.x + 5, L.select.y + 5, L), 'select');
  assert.equal(zoneAt(L.start.x + 5, L.start.y + 5, L), 'start');
  assert.equal(zoneAt(L.menu.x + 3, L.menu.y + 3, L), 'menu');
  // a finger that went down on B and slides onto A presses A (and only A)
  assert.equal(fingerBits('face', L.b.cx, L.b.cy, L), BTN.B);
  assert.equal(fingerBits('face', L.a.cx, L.a.cy, L), BTN.A);
  // Start released when the finger leaves it
  assert.equal(fingerBits('start', L.start.x + 2, L.start.y + 2, L), BTN.START);
  assert.equal(fingerBits('start', L.start.x + 2, 10, L), 0);
  // multitouch: diagonal + B + A
  const bits = fingerBits('dpad', L.dpad.cx + 40, L.dpad.cy - 40, L) | fingerBits('face', L.b.cx, L.b.cy, L) | fingerBits('face', L.a.cx, L.a.cy, L);
  assert.equal(bits, BTN.UP | BTN.RIGHT | BTN.A | BTN.B);
});

test('layout respects the display cutout', () => {
  const safe = { left: 40, right: 0, top: 0, bottom: 0 };
  const c = computeLayout({ width: W, height: H, game: fit.css, safe });
  assert.ok(c.dpad.cx - c.dpad.r >= 40);
});

test('virtual input source: Input ORs the touch/pad bits and overrides still win', async () => {
  const { Input } = await import('../../src/core/input.js');
  const input = new Input();
  input.getGamepads = () => [];
  input.setVirtual(0, BTN.A | BTN.LEFT);
  input.key('KeyZ', true);
  assert.equal(input.buttons(0), BTN.A | BTN.B | BTN.LEFT);
  assert.equal(input.buttons(1), 0);
  input.setOverride(0, BTN.START);
  input.write4016(1); input.write4016(0);
  const read = Array.from({ length: 8 }, () => input.read(0) & 1);
  assert.deepEqual(read, [0, 0, 0, 1, 0, 0, 0, 0]);
});
