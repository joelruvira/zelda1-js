// Pure unit tests of the mid-frame write classifier (tools/timing/lib/classify.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lineDotToFrameDot, region, impact, hwSlack, jsnesSlack, FRAME_DOTS, PRE_COPY_DOT,
} from '../../tools/timing/lib/classify.mjs';

test('frameDot origin is line 241 dot 1 (the port PPU clock origin)', () => {
  assert.equal(lineDotToFrameDot(241, 1), 0);
  assert.equal(lineDotToFrameDot(261, 1), 20 * 341);
  assert.equal(lineDotToFrameDot(0, 1), 21 * 341);
  assert.equal(lineDotToFrameDot(52, 90), 24982); // title-start frame 121, TurnOffAllVideo
});

test('regions', () => {
  assert.equal(region(0), 'vblank');
  assert.equal(region(PRE_COPY_DOT - 1), 'vblank');
  assert.equal(region(PRE_COPY_DOT), 'prerender');
  assert.equal(region(lineDotToFrameDot(10, 5)), 'visible');
  assert.equal(region(lineDotToFrameDot(240, 5)), 'post');
  assert.equal(region(FRAME_DOTS + 5), 'next');
});

test('impact: only writes that change what is drawn', () => {
  const base = { maskBefore: 0x1e, ctrlBefore: 0x30, tNt: 0, v: 0, vAfter: 0, firstWrite: true };
  assert.equal(impact({ ...base, reg: 0x2001, val: 0x00 }), 'mask:render-on/off');
  assert.equal(impact({ ...base, reg: 0x2001, val: 0x1e }), null);
  assert.equal(impact({ ...base, reg: 0x2000, val: 0xb0 }), null, 'NMI enable bit only');
  assert.equal(impact({ ...base, reg: 0x2000, val: 0x31 }), 'ctrl:nametable(t)');
  assert.equal(impact({ ...base, maskBefore: 0, reg: 0x2007, val: 1, v: 0x2000 }), null, 'VRAM write with video off');
  assert.equal(impact({ ...base, maskBefore: 0, reg: 0x2007, val: 1, v: 0x3f01 }), 'data:palette');
  assert.equal(impact({ ...base, reg: 0x4014, val: 2 }), 'oam-dma');
});

test('slack: 0 on pixel dots, hblank gap otherwise; jsnes only sees scanline boundaries', () => {
  assert.deepEqual(hwSlack(lineDotToFrameDot(52, 90)), { back: 0, fwd: 0 });
  const h = hwSlack(lineDotToFrameDot(3, 296));
  assert.ok(h.back > 0 && h.fwd > 0);
  assert.deepEqual(jsnesSlack(lineDotToFrameDot(52, 90)), { back: 30, fwd: 83 });
  assert.equal(hwSlack(lineDotToFrameDot(245, 10)).fwd, Math.floor((PRE_COPY_DOT - lineDotToFrameDot(245, 10) - 1) / 3), 'vblank write: until the pre-render copy');
});
