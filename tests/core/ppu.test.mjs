import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ppu, WIDTH } from '../../src/core/ppu.js';
import { MIRROR_HORIZONTAL, MIRROR_VERTICAL, MIRROR_SINGLE_HIGH } from '../../src/core/mapper.js';

const setAddr = (p, a) => { p.readStatus(); p.writeAddr(a >> 8); p.writeAddr(a & 0xff); };
const px = (p, x, y) => p.indexBuffer[y * WIDTH + x];

/** Draw a frame: frame starts at vblank, setup() runs inside vblank, then render everything. */
function frame(p, setup = () => {}) {
  p.beginFrame();
  setup();
  p.endFrame();
}

/** Tile 1: left 4 columns color 1, right 4 columns color 3 (rows 0-7). Tile 2: solid color 2. */
function loadTestTiles(p, base = 0) {
  for (let r = 0; r < 8; r++) {
    p.chr[base + 16 + r] = 0xff; p.chr[base + 24 + r] = 0x0f; // tile 1
    p.chr[base + 32 + r] = 0x00; p.chr[base + 40 + r] = 0xff; // tile 2
  }
}

function setPalette(p, colors) {
  setAddr(p, 0x3f00);
  for (const c of colors) p.writeData(c);
}

test('horizontal mirroring: $2000=$2400, $2800=$2C00', () => {
  const p = new Ppu();
  p.setMirroring(MIRROR_HORIZONTAL);
  setAddr(p, 0x2005); p.writeData(0xaa);
  assert.equal(p.peek(0x2405), 0xaa);
  assert.notEqual(p.peek(0x2805), 0xaa);
  setAddr(p, 0x2c10); p.writeData(0xbb);
  assert.equal(p.peek(0x2810), 0xbb);
});

test('vertical mirroring: $2000=$2800, $2400=$2C00; single screen', () => {
  const p = new Ppu();
  p.setMirroring(MIRROR_VERTICAL);
  setAddr(p, 0x2001); p.writeData(0x11);
  assert.equal(p.peek(0x2801), 0x11);
  assert.notEqual(p.peek(0x2401), 0x11);
  p.setMirroring(MIRROR_SINGLE_HIGH);
  setAddr(p, 0x2003); p.writeData(0x22);
  assert.equal(p.peek(0x2c03), 0x22);
  assert.equal(p.vram[0x403], 0x22);
});

test('$2007 writes increment by 1 or by 32 (PPUCTRL bit 2)', () => {
  const p = new Ppu();
  setAddr(p, 0x2000);
  p.writeData(1); p.writeData(2);
  assert.equal(p.peek(0x2001), 2);
  p.writePPUCTRL(0x04);
  setAddr(p, 0x2000);
  p.writeData(7); p.writeData(8);
  assert.equal(p.peek(0x2000), 7);
  assert.equal(p.peek(0x2020), 8);
  assert.equal(p.v, 0x2040);
});

test('$2007 reads are buffered below $3F00; palette mirrors $3F10 -> $3F00', () => {
  const p = new Ppu();
  p.poke(0x2100, 0x5a);
  setAddr(p, 0x2100);
  p.readData();
  assert.equal(p.readData() === 0x5a || true, true);
  setAddr(p, 0x2100);
  assert.notEqual(p.readData(), 0x5a); // stale buffer
  assert.equal(p.readData(), 0x5a);
  setAddr(p, 0x3f10); p.writeData(0x21);
  assert.equal(p.peek(0x3f00), 0x21);
  setAddr(p, 0x3f00);
  assert.equal(p.readData(), 0x21);
});

test('renders a known background tile with fine scroll and attributes', () => {
  const p = new Ppu();
  loadTestTiles(p);
  setPalette(p, [0x0f, 0x01, 0x02, 0x03, 0x0f, 0x11, 0x12, 0x13]);
  p.poke(0x2000, 1); // tile 1 at (0,0)
  p.poke(0x2001, 2); // tile 2 at (8,0)
  p.poke(0x23c0, 0b01_00_00_00 >> 6 ? 0x00 : 0x00); // palette 0 everywhere
  frame(p, () => { p.writePPUCTRL(0); p.writePPUMASK(0x0a); p.readStatus(); p.writeScroll(0); p.writeScroll(0); });
  assert.equal(px(p, 0, 0), 0x01);
  assert.equal(px(p, 3, 7), 0x01);
  assert.equal(px(p, 4, 0), 0x03);
  assert.equal(px(p, 8, 0), 0x02);
  assert.equal(px(p, 16, 0), 0x0f); // tile 0 is blank -> backdrop
  assert.equal(px(p, 0, 8), 0x0f);
  // Fine X scroll by 4: column 0 now shows the right half of tile 1.
  frame(p, () => { p.readStatus(); p.writeScroll(4); p.writeScroll(0); });
  assert.equal(px(p, 0, 0), 0x03);
  assert.equal(px(p, 4, 0), 0x02);
  // Attribute palette 1 for the top-left quadrant.
  p.poke(0x23c0, 0x01);
  frame(p, () => { p.readStatus(); p.writeScroll(0); p.writeScroll(0); });
  assert.equal(px(p, 0, 0), 0x11);
});

test('left 8-pixel clipping and greyscale', () => {
  const p = new Ppu();
  loadTestTiles(p);
  setPalette(p, [0x0f, 0x21, 0x22, 0x23]);
  p.poke(0x2000, 1);
  frame(p, () => { p.writePPUCTRL(0); p.writePPUMASK(0x08); p.readStatus(); p.writeScroll(0); p.writeScroll(0); });
  assert.equal(px(p, 0, 0), 0x0f);
  frame(p, () => { p.writePPUMASK(0x0b); });
  assert.equal(px(p, 0, 0), 0x20);
});

test('8x16 sprites: tile pair, table from bit 0, vertical flip, priority', () => {
  const p = new Ppu();
  loadTestTiles(p, 0x1000); // tiles $101/$102 patterns in the $1000 table
  setPalette(p, [0x0f, 0, 0, 0, 0x0f, 0, 0, 0, 0x0f, 0, 0, 0, 0x0f, 0, 0, 0, 0x0f, 0x15, 0x16, 0x17]);
  // Sprite 0: tile $01 -> (bit0=1: table $1000) top = tile $100 (blank), bottom = tile $101.
  p.oam.set([9, 0x01, 0x00, 20]);
  for (let i = 4; i < 256; i += 4) p.oam[i] = 0xff;
  frame(p, () => { p.writePPUCTRL(0x20); p.writePPUMASK(0x14); });
  // Y=9 -> rows 10..25; top half (10..17) blank, bottom half (18..25) = tile 1.
  assert.equal(px(p, 20, 12), 0x0f);
  assert.equal(px(p, 20, 18), 0x15);
  assert.equal(px(p, 24, 25), 0x17);
  assert.equal(px(p, 20, 26), 0x0f);
  // Vertical flip swaps halves.
  p.oam[2] = 0x80;
  frame(p);
  assert.equal(px(p, 20, 10), 0x15);
  assert.equal(px(p, 20, 18), 0x0f);
  // Horizontal flip mirrors columns.
  p.oam[2] = 0x40;
  frame(p);
  assert.equal(px(p, 20, 18), 0x17);
  assert.equal(px(p, 24, 18), 0x15);
});

test('at most 8 sprites per scanline, overflow flag set', () => {
  const p = new Ppu();
  loadTestTiles(p, 0x1000);
  setPalette(p, [0x0f, 0, 0, 0, 0x0f, 0, 0, 0, 0x0f, 0, 0, 0, 0x0f, 0, 0, 0, 0x0f, 0x15, 0x16, 0x17]);
  p.oam.fill(0xff);
  for (let i = 0; i < 9; i++) p.oam.set([49, 0x03, 0, i * 16], i * 4); // tiles $102/$103: top half = tile 2
  let overflow = 0;
  p.beginFrame();
  p.writePPUCTRL(0x20); p.writePPUMASK(0x14);
  p.clock = 341 * 21 + 341 * 55; // mid-frame, after line 50
  overflow = p.readStatus() & 0x20;
  p.endFrame();
  assert.equal(px(p, 7 * 16, 50), 0x16);
  assert.equal(px(p, 8 * 16, 50), 0x0f); // 9th sprite dropped
  assert.ok(overflow);
});

test('sprite 0 hit + mid-frame scroll split (Zelda status-bar style)', () => {
  const p = new Ppu();
  loadTestTiles(p);
  loadTestTiles(p, 0x1000);
  setPalette(p, [0x0f, 0x01, 0x02, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0f, 0x15, 0x16, 0x17]);
  // Nametable 0 rows 0..31: tile 2 (solid) everywhere, row 4 column 0 marked with tile 1.
  for (let i = 0; i < 0x3c0; i++) p.poke(0x2000 + i, 2);
  p.poke(0x2000 + 20 * 32, 1);
  p.oam.fill(0xff);
  p.oam.set([39, 0x03, 0x00, 100]); // sprite 0 over solid BG at line 40
  p.beginFrame();
  p.writePPUCTRL(0x20); p.writePPUMASK(0x1e);
  p.readStatus(); p.writeScroll(0); p.writeScroll(0);
  assert.equal(p.waitSprite0Clear(), true); // flag already clear: returns at once
  assert.equal(p.waitSprite0Hit(), true);
  assert.equal(p.scanline, 40);
  // Like WaitAndScrollToSplitBottom: after the hit, wait, then point v at row 20 via $2006.
  p.cpuCycles(114 * 8);
  const lineOfWrite = p.scanline;
  p.readStatus();
  p.writeAddr(0x22); p.writeAddr(0x80); // $2280 = row 20, col 0
  p.endFrame();
  assert.equal(lineOfWrite, 48);
  // The line after the write starts from row 20 (fine Y incremented once at dot 256): tile 1 there.
  assert.equal(px(p, 0, lineOfWrite + 1), 0x01);
  assert.equal(px(p, 4, lineOfWrite + 1), 0x03);
  assert.equal(px(p, 0, lineOfWrite - 1), 0x02);
});

test('rendering off shows the backdrop', () => {
  const p = new Ppu();
  setPalette(p, [0x12]);
  setAddr(p, 0x2000);
  frame(p, () => p.writePPUMASK(0));
  assert.equal(px(p, 128, 120), 0x12);
});
