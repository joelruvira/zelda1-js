// 2C02 PPU modelled at the memory/register level with a dot-based renderer.
//
// Timing model ("catch-up"): the PPU keeps a clock in PPU dots. Ported code mostly
// runs "instantly"; register writes take effect at the current clock. Code that the
// original times against the raster (the sprite-0 HUD split) advances the clock
// explicitly: waitSprite0Hit() renders until the hit, cpuCycles(n) adds 3n dots, and
// every register access first renders everything up to the clock. Mid-frame
// $2000/$2005/$2006/$2007 accesses therefore behave as on hardware (loopy v/t/x/w).
//
// Frame layout: a frame starts at scanline 241 dot 1 (vblank + NMI), runs through the
// pre-render line 261 and visible lines 0-239, and ends at the next 241/1.

import { MIRROR_HORIZONTAL, MIRROR_SINGLE_HIGH, MIRROR_SINGLE_LOW, MIRROR_VERTICAL } from './mapper.js';

export const WIDTH = 256;
export const HEIGHT = 240;
const DOTS = 341;
const LINES = 262;
const PRERENDER = 261;
const VBLANK_LINE = 241;

/** Standard 2C02 palette (RGB), index = NES color 0x00-0x3F. */
export const NES_PALETTE = [
  0x7c7c7c, 0x0000fc, 0x0000bc, 0x4428bc, 0x940084, 0xa80020, 0xa81000, 0x881400,
  0x503000, 0x007800, 0x006800, 0x005800, 0x004058, 0x000000, 0x000000, 0x000000,
  0xbcbcbc, 0x0078f8, 0x0058f8, 0x6844fc, 0xd800cc, 0xe40058, 0xf83800, 0xe45c10,
  0xac7c00, 0x00b800, 0x00a800, 0x00a844, 0x008888, 0x000000, 0x000000, 0x000000,
  0xf8f8f8, 0x3cbcfc, 0x6888fc, 0x9878f8, 0xf878f8, 0xf85898, 0xf87858, 0xfca044,
  0xf8b800, 0xb8f818, 0x58d854, 0x58f898, 0x00e8d8, 0x787878, 0x000000, 0x000000,
  0xfcfcfc, 0xa4e4fc, 0xb8b8f8, 0xd8b8f8, 0xf8b8f8, 0xf8a4c0, 0xf0d0b0, 0xfce0a8,
  0xf8d878, 0xd8f878, 0xb8f8b8, 0xb8f8d8, 0x00fcfc, 0xf8d8f8, 0x000000, 0x000000,
];

// Pixel ABGR (little-endian RGBA bytes) for a Uint32Array view of an ImageData buffer.
const toAbgr = (rgb) => (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;

export class Ppu {
  constructor() {
    this.chr = new Uint8Array(0x2000); // CHR-RAM
    this.vram = new Uint8Array(0x800); // 2 physical nametables
    this.palette = new Uint8Array(32);
    this.oam = new Uint8Array(256);
    /** Output: NES color index per pixel (with greyscale applied), for oracle diffs. */
    this.indexBuffer = new Uint8Array(WIDTH * HEIGHT);
    /** Output: RGBA pixels ready for ImageData. */
    this.frameBuffer = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    this.frame32 = new Uint32Array(this.frameBuffer.buffer);
    this.rgba = new Uint32Array(64);
    this.setRgbPalette(NES_PALETTE);
    this.mirroring = MIRROR_HORIZONTAL;
    this.chrOffset = (a) => a & 0x1fff; // replaced by the mapper's CHR banking
    this.reset();
  }

  reset() {
    this.ctrl = 0; this.mask = 0; this.status = 0; this.oamAddr = 0;
    this.v = 0; this.t = 0; this.x = 0; this.w = 0; this.readBuffer = 0;
    this.line = VBLANK_LINE; this.dot = 1; // render position
    this.clock = 0; // dots since frame start (target position)
    this.pos = 0; // dots already emulated since frame start
    this.frameCount = 0;
    this.oddFrame = false;
    this.bgLo = 0; this.bgHi = 0; this.atLo = 0; this.atHi = 0;
    this.nextTile = 0; this.nextAttr = 0; this.nextLo = 0; this.nextHi = 0;
    this.lineSprites = []; // sprites for the line being drawn
    this.frameDone = false;
  }

  setRgbPalette(rgbList) { rgbList.forEach((c, i) => { this.rgba[i] = toAbgr(c); }); }

  /** Set nametable mirroring (MMC1 encoding: 0/1 single screen, 2 vertical, 3 horizontal). */
  setMirroring(mode) { this.sync(); this.mirroring = mode; }

  // ---------------------------------------------------------------- memory map
  ntIndex(addr) {
    const table = (addr >> 10) & 3;
    switch (this.mirroring) {
      case MIRROR_SINGLE_LOW: return addr & 0x3ff;
      case MIRROR_SINGLE_HIGH: return 0x400 | (addr & 0x3ff);
      case MIRROR_VERTICAL: return ((table & 1) << 10) | (addr & 0x3ff);
      default: return ((table >> 1) << 10) | (addr & 0x3ff); // horizontal
    }
  }

  static paletteIndex(addr) {
    let i = addr & 0x1f;
    if ((i & 0x13) === 0x10) i &= 0x0f; // $3F10/$14/$18/$1C mirror $3F00/$04/$08/$0C
    return i;
  }

  /** Read PPU address space ($0000-$3FFF) without side effects. */
  peek(addr) {
    addr &= 0x3fff;
    if (addr < 0x2000) return this.chr[this.chrOffset(addr)];
    if (addr < 0x3f00) return this.vram[this.ntIndex(addr)];
    return this.palette[Ppu.paletteIndex(addr)];
  }

  /** Write PPU address space without side effects. */
  poke(addr, value) {
    addr &= 0x3fff;
    value &= 0xff;
    if (addr < 0x2000) this.chr[this.chrOffset(addr)] = value;
    else if (addr < 0x3f00) this.vram[this.ntIndex(addr)] = value;
    else this.palette[Ppu.paletteIndex(addr)] = value & 0x3f;
  }

  // ---------------------------------------------------------------- CPU registers
  get renderingOn() { return (this.mask & 0x18) !== 0; }
  get inRender() { return this.renderingOn && (this.line < 240 || this.line === PRERENDER); }

  /** $2000 PPUCTRL */
  writePPUCTRL(value) {
    this.sync();
    this.ctrl = value & 0xff;
    this.t = (this.t & ~0x0c00) | ((value & 3) << 10);
  }

  /** $2001 PPUMASK */
  writePPUMASK(value) { this.sync(); this.mask = value & 0xff; }

  /** $2002 PPUSTATUS (read clears vblank flag and the w latch). */
  readStatus() {
    this.sync();
    const s = this.status;
    this.status &= 0x7f;
    this.w = 0;
    return s;
  }

  /** $2003 OAMADDR */
  writeOAMADDR(value) { this.oamAddr = value & 0xff; }

  /** $2004 OAMDATA */
  writeOAMDATA(value) { this.oam[this.oamAddr] = value; this.oamAddr = (this.oamAddr + 1) & 0xff; }

  /** $2005 PPUSCROLL */
  writeScroll(value) {
    this.sync();
    if (this.w === 0) {
      this.t = (this.t & ~0x1f) | (value >> 3);
      this.x = value & 7;
    } else {
      this.t = (this.t & ~0x73e0) | ((value & 7) << 12) | ((value & 0xf8) << 2);
    }
    this.w ^= 1;
  }

  /** $2006 PPUADDR */
  writeAddr(value) {
    this.sync();
    if (this.w === 0) {
      this.t = (this.t & 0xff) | ((value & 0x3f) << 8);
    } else {
      this.t = (this.t & 0x7f00) | value;
      this.v = this.t;
    }
    this.w ^= 1;
  }

  /** $2007 PPUDATA write */
  writeData(value) {
    this.sync();
    this.poke(this.v, value);
    this.incrementV();
  }

  /** $2007 PPUDATA read (buffered except for palette). */
  readData() {
    this.sync();
    const addr = this.v & 0x3fff;
    let result;
    if (addr >= 0x3f00) {
      result = this.palette[Ppu.paletteIndex(addr)];
      this.readBuffer = this.vram[this.ntIndex(addr)];
    } else {
      result = this.readBuffer;
      this.readBuffer = this.peek(addr);
    }
    this.incrementV();
    return result;
  }

  incrementV() {
    if (this.inRender) { this.incX(); this.incY(); } // rendering glitch on hardware
    else this.v = (this.v + ((this.ctrl & 4) ? 32 : 1)) & 0x7fff;
  }

  /** $4014 OAM DMA from a 256-byte page (e.g. ram.subarray(0x200, 0x300)). */
  oamDMA(page) {
    for (let i = 0; i < 256; i++) this.oam[(this.oamAddr + i) & 0xff] = page[i];
  }

  // ---------------------------------------------------------------- timing API
  /** Advance the clock by n CPU cycles (3 PPU dots each). */
  cpuCycles(n) { this.clock += n * 3; }

  /** Busy-wait like `LDA $2002 / AND #mask / BEQ|BNE` (cyclesPerPoll per iteration). */
  waitStatus(mask, wantSet, cyclesPerPoll = 9) {
    const limit = this.frameDots();
    for (;;) {
      this.sync();
      if (((this.status & mask) !== 0) === wantSet) return true;
      if (this.clock >= limit) return false;
      this.clock += cyclesPerPoll * 3;
    }
  }

  /** WaitAndScrollToSplitBottom's loop: render until sprite 0 hits. false if it never does this frame. */
  waitSprite0Hit() { return this.waitStatus(0x40, true); }

  /** IsrNmi's @WaitVBlankEnd loop: wait for the sprite 0 flag to clear (pre-render line). */
  waitSprite0Clear() { return this.waitStatus(0x40, false); }

  /** Current raster position (for debugging/tests). */
  get scanline() { this.sync(); return this.line; }

  frameDots() { return LINES * DOTS - ((this.oddFrame && this.renderingOn) ? 1 : 0); }

  /** Called at NMI time: starts a frame at 241/1 with the vblank flag set. */
  beginFrame() {
    this.clock = 0;
    this.pos = 0;
    this.line = VBLANK_LINE;
    this.dot = 1;
    this.status |= 0x80;
    this.frameDone = false;
  }

  /** Render the rest of the frame (up to the next vblank). */
  endFrame() {
    this.clock = Math.max(this.clock, this.frameDots());
    this.sync();
    this.frameCount++;
    this.oddFrame = !this.oddFrame;
  }

  /** Emulate dots until pos reaches clock. */
  sync() {
    while (this.pos < this.clock && !this.frameDone) this.step();
  }

  // ---------------------------------------------------------------- rendering
  incX() {
    if ((this.v & 0x1f) === 31) { this.v &= ~0x1f; this.v ^= 0x400; } else this.v++;
  }

  incY() {
    if ((this.v & 0x7000) !== 0x7000) { this.v += 0x1000; return; }
    this.v &= ~0x7000;
    let y = (this.v & 0x3e0) >> 5;
    if (y === 29) { y = 0; this.v ^= 0x800; } else if (y === 31) y = 0; else y++;
    this.v = (this.v & ~0x3e0) | (y << 5);
  }

  fetchTile() {
    const v = this.v;
    this.nextTile = this.vram[this.ntIndex(0x2000 | (v & 0xfff))];
    const at = this.vram[this.ntIndex(0x23c0 | (v & 0xc00) | ((v >> 4) & 0x38) | ((v >> 2) & 7))];
    const shift = ((v >> 4) & 4) | (v & 2);
    this.nextAttr = (at >> shift) & 3;
    const base = ((this.ctrl & 0x10) << 8) + this.nextTile * 16 + ((v >> 12) & 7);
    this.nextLo = this.chr[this.chrOffset(base)];
    this.nextHi = this.chr[this.chrOffset(base + 8)];
  }

  loadShifters() {
    this.bgLo = (this.bgLo & 0xff00) | this.nextLo;
    this.bgHi = (this.bgHi & 0xff00) | this.nextHi;
    this.atLo = (this.atLo & 0xff00) | ((this.nextAttr & 1) ? 0xff : 0);
    this.atHi = (this.atHi & 0xff00) | ((this.nextAttr & 2) ? 0xff : 0);
  }

  shift() {
    this.bgLo = (this.bgLo << 1) & 0xffff; this.bgHi = (this.bgHi << 1) & 0xffff;
    this.atLo = (this.atLo << 1) & 0xffff; this.atHi = (this.atHi << 1) & 0xffff;
  }

  /** Sprite evaluation for visible line `y` (OAM Y is top-1; at most 8 sprites). */
  evaluateSprites(y) {
    const h = (this.ctrl & 0x20) ? 16 : 8;
    const list = [];
    for (let i = 0; i < 64; i++) {
      const sy = this.oam[i * 4];
      const row = y - (sy + 1);
      if (row < 0 || row >= h) continue;
      if (list.length === 8) { this.status |= 0x20; break; }
      const tile = this.oam[i * 4 + 1];
      const attr = this.oam[i * 4 + 2];
      let r = (attr & 0x80) ? h - 1 - row : row;
      let addr;
      if (h === 16) {
        addr = ((tile & 1) << 12) + ((tile & 0xfe) + (r >> 3)) * 16 + (r & 7);
      } else {
        addr = ((this.ctrl & 0x08) << 9) + tile * 16 + r;
      }
      let lo = this.chr[this.chrOffset(addr)];
      let hi = this.chr[this.chrOffset(addr + 8)];
      if (attr & 0x40) { lo = reverseBits(lo); hi = reverseBits(hi); }
      list.push({ index: i, x: this.oam[i * 4 + 3], lo, hi, palette: 4 + (attr & 3), behind: (attr & 0x20) !== 0 });
    }
    this.lineSprites = list;
  }

  /** Output the pixel for the current dot (1..256) of a visible line. */
  pixel() {
    const x = this.dot - 1;
    const y = this.line;
    let bg = 0;
    let bgPal = 0;
    if ((this.mask & 0x08) && (x >= 8 || (this.mask & 0x02))) {
      const bit = 15 - this.x;
      bg = (((this.bgHi >> bit) & 1) << 1) | ((this.bgLo >> bit) & 1);
      bgPal = (((this.atHi >> bit) & 1) << 1) | ((this.atLo >> bit) & 1);
    }
    let color = bg ? this.palette[(bgPal << 2) | bg] : this.palette[0];
    if ((this.mask & 0x10) && (x >= 8 || (this.mask & 0x04))) {
      for (const s of this.lineSprites) {
        const col = x - s.x;
        if (col < 0 || col > 7) continue;
        const sp = (((s.hi >> (7 - col)) & 1) << 1) | ((s.lo >> (7 - col)) & 1);
        if (!sp) continue;
        if (s.index === 0 && bg && x !== 255) this.status |= 0x40;
        if (!s.behind || !bg) color = this.palette[(s.palette << 2) | sp];
        break;
      }
    }
    if (this.mask & 0x01) color &= 0x30;
    const i = y * WIDTH + x;
    this.indexBuffer[i] = color;
    this.frame32[i] = this.rgba[color & 0x3f];
  }

  /** Emulate one PPU dot at (line, dot), then advance. */
  step() {
    const line = this.line;
    const dot = this.dot;
    const rendering = this.renderingOn;
    const visible = line < 240;

    if (line === PRERENDER && dot === 1) this.status &= ~0xe0; // clear vblank, sprite 0, overflow
    if (line === VBLANK_LINE && dot === 1) this.status |= 0x80;

    if (visible && dot === 0) { if (rendering) this.evaluateSprites(line); else this.lineSprites = []; }

    const renderLine = rendering && (visible || line === PRERENDER);
    if (renderLine) {
      if ((dot >= 2 && dot <= 257) || (dot >= 322 && dot <= 337)) this.shift();
      if (((dot >= 9 && dot <= 257) || dot === 329 || dot === 337) && (dot & 7) === 1) this.loadShifters();
    }

    if (visible && dot >= 1 && dot <= 256) {
      if (rendering) this.pixel();
      else this.blankPixel();
    }

    if (renderLine) {
      const fetchDot = (dot >= 1 && dot <= 256) || (dot >= 321 && dot <= 336);
      if (fetchDot && (dot & 7) === 0) { this.fetchTile(); this.incX(); }
      if (dot === 256) this.incY();
      if (dot === 257) this.v = (this.v & ~0x41f) | (this.t & 0x41f);
      if (line === PRERENDER && dot >= 280 && dot <= 304) this.v = (this.v & ~0x7be0) | (this.t & 0x7be0);
    }

    // advance
    this.pos++;
    this.dot++;
    if (line === PRERENDER && dot === 339 && this.oddFrame && rendering) this.dot = 341; // skipped dot
    if (this.dot >= DOTS) {
      this.dot = 0;
      this.line = (this.line + 1) % LINES;
      if (this.line === VBLANK_LINE) this.frameDone = true;
    }
  }

  blankPixel() {
    const x = this.dot - 1;
    const i = this.line * WIDTH + x;
    // With rendering off the PPU shows the backdrop (or the palette entry v points at).
    const addr = this.v & 0x3fff;
    let color = addr >= 0x3f00 ? this.palette[Ppu.paletteIndex(addr)] : this.palette[0];
    if (this.mask & 0x01) color &= 0x30;
    this.indexBuffer[i] = color;
    this.frame32[i] = this.rgba[color & 0x3f];
  }
}

function reverseBits(b) {
  b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
  b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
  return ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
}
