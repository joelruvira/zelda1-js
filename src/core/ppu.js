// 2C02 PPU modelled at the memory/register level with a dot-based renderer.
//
// Timing model ("catch-up"): the PPU keeps a clock in PPU dots and renders up to it before every
// register access, so mid-frame $2000/$2005/$2006/$2007 accesses behave as on hardware (loopy v/t/x/w).
// Two ways to drive the clock:
//  * cycle tracker on (src/core/timing.js, docs/TIMING.md): `continuous` mode. The clock is absolute
//    (`syncTo(dot)`, dot = 3 x CPU cycle since power-on); every access lands on its exact dot, the PPU
//    crosses frame boundaries by itself (lag frames inside a long NMI) and `onFrame` is called at each
//    completed picture.
//  * legacy (tracker off): per NMI, beginFrame() / endFrame(); the logic runs "instantly", only the timed
//    waits move the clock (waitStatus/cpuCycles).
// jsnesCompat reproduces the CI oracle (jsnes 2.1.0) where it differs from hardware: no skipped dot on odd
// frames, PPUMASK writes during a visible line take effect at the end of that line.
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

/** Palette RAM at power-on in hardware mode (Mesen2 2.1.1 with RAM power-on state "all zeros"). */
const POWER_ON_PALETTE = [
  0x09, 0x01, 0x00, 0x01, 0x00, 0x02, 0x02, 0x0d, 0x08, 0x10, 0x08, 0x24, 0x00, 0x00, 0x04, 0x2c,
  0x09, 0x01, 0x34, 0x03, 0x00, 0x04, 0x00, 0x14, 0x08, 0x3a, 0x00, 0x02, 0x00, 0x20, 0x2c, 0x08,
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
    /** Absolute timing (cycle tracker): the clock crosses frames; onFrame() after each picture. */
    this.continuous = false;
    this.onFrame = null;
    /** Reproduce jsnes 2.1.0 (the oracle) instead of the hardware where they differ (see header). */
    this.jsnesCompat = false;
    /** Hardware mode (cycle tracker 'hardware'): dot-exact copy of Mesen2 2.1.1's PPU (see stepHw). */
    this.hardware = false;
    /** Hardware mode: called with the absolute dot of 240/0 when a picture is complete (Mesen's endFrame). */
    this.onPicture = null;
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
    this.frameStart = 0; // absolute dot of the current frame's 241/1 (continuous mode)
    this.pendingMask = -1; // jsnesCompat: PPUMASK write waiting for the end of the line
    this.skippedThisFrame = false;
    // hardware mode (Mesen2 NesPpu state)
    this.renEn = false; this.prevRenEn = false; // rendering enabled flag (1 dot late) and its copy (2 dots)
    this.needUpdate = false; // Mesen _needStateUpdate
    this.vDelay = 0; this.vNext = 0; // $2006: v takes t 3 dots after the 2nd write
    this.needInc = false; // $2006/$2007 access: v increments 1 dot later
    this.preventVbl = false; // $2002 read on 241/0
    this.ignoreRead = 0; // $2007 reads closer than 6 dots: the second is ignored
    this.loShift = 0; this.hiShift = 0; this.prevPal = 0; this.curPal = 0;
    this.tileAddr = 0; this.tilePal = 0; this.tileLo = 0; this.tileHi = 0;
    this.sprList = []; this.spr0Visible = false; this.sprTiles = []; this.hasSprite = new Uint8Array(258);
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
  writePPUMASK(value) {
    this.sync();
    // jsnes draws a scanline's pixels at its end: a write during a visible line affects the next one
    if (this.jsnesCompat && this.line < 240) {
      // jsnes composes every row up to the current line before the write: the new mask starts next line
      this.pendingMask = value & 0xff;
      this.pendingMaskLine = this.line + 1;
      return;
    }
    this.pendingMask = -1;
    if (this.hardware) { this.writeMaskHw(value & 0xff); return; }
    this.mask = value & 0xff;
  }

  /** $2002 PPUSTATUS (read clears vblank flag and the w latch). */
  readStatus() {
    this.sync();
    const s = this.status;
    this.status &= 0x7f;
    this.w = 0;
    // hardware: a read one dot before the flag rises (241/0 just emulated) suppresses it for this frame
    if (this.hardware && this.line === VBLANK_LINE && this.dot === 1) this.preventVbl = true;
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
      if (this.hardware) { this.vNext = this.t; this.vDelay = 3; this.needUpdate = true; } // v 3 dots later
      else this.v = this.t;
    }
    this.w ^= 1;
  }

  /** $2007 PPUDATA write */
  writeData(value) {
    this.sync();
    this.poke(this.v, value);
    if (this.hardware) { this.needInc = true; this.needUpdate = true; return; } // incremented 1 dot later
    this.incrementV();
  }

  /** $2007 PPUDATA read (buffered except for palette). */
  readData() {
    this.sync();
    // hardware: a second read under 6 dots after the previous one is ignored (Mesen _ignoreVramRead)
    if (this.hardware) {
      if (this.ignoreRead > 0) return 0;
      this.ignoreRead = 6;
      this.needUpdate = true;
    }
    const addr = this.v & 0x3fff;
    let result;
    if (addr >= 0x3f00) {
      result = this.palette[Ppu.paletteIndex(addr)];
      this.readBuffer = this.vram[this.ntIndex(addr)];
    } else {
      result = this.readBuffer;
      this.readBuffer = this.peek(addr);
    }
    if (this.hardware) { this.needInc = true; this.needUpdate = true; return result; }
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

  // ---------------------------------------------------------------- absolute clock (cycle tracker)
  /** Absolute dot of the render position. */
  get absDot() { return this.frameStart + this.pos; }

  /** Continuous mode from power-on: the render position is 241/1 at absolute dot `dot`, vblank flag clear. */
  powerOn(dot) {
    this.continuous = true;
    this.frameStart = dot;
    this.pos = 0; this.clock = 0;
    this.line = VBLANK_LINE; this.dot = 1;
    this.status = 0;
    this.frameDone = false;
  }

  /**
   * Hardware power-on (Mesen2 2.1.1 alignment, docs/TIMING.md §11): the first dot emulated is scanline 0
   * dot 0 at absolute dot `dot`; the frame start (241/1) before it is virtual. The pre-render line of the
   * first complete frame is an even one (no skipped dot), like Mesen's frame counter (1 at power-on).
   */
  powerOnAtLine0(dot) {
    this.continuous = true;
    // power-on palette RAM: indeterminate on real hardware; Mesen2 (non-random RAM setting) uses the
    // values of blargg's palette test, shown as the backdrop until the game writes the palette
    this.palette.set(POWER_ON_PALETTE);
    const toLine0 = (LINES - VBLANK_LINE) * DOTS - 1; // 241/1 -> 0/0: 7160 dots
    this.frameStart = dot - toLine0;
    this.pos = toLine0; this.clock = toLine0;
    this.line = 0; this.dot = 0;
    this.status = 0;
    this.frameDone = false;
    this.oddFrame = true; // toggled at the first 241/1
    this.skippedThisFrame = false;
  }

  /** Render up to absolute dot `dot` (accesses at a dot see every earlier dot emulated). */
  syncTo(dot) {
    const c = dot - this.frameStart;
    if (c > this.clock) this.clock = c;
    this.sync();
  }

  /** Absolute dot of the next frame start (241/1) after the render position, if nothing changes. */
  nextFrameDot() {
    let len = LINES * DOTS;
    if (this.skipsDot()) len--;
    return this.frameStart + len;
  }

  /** True when this frame drops the last dot of the pre-render line (odd frame, rendering on; hardware only). */
  skipsDot() {
    if (this.jsnesCompat || !this.oddFrame) return false;
    // decided at dot 339 of the pre-render line (frame order: 241..261, then 0..240); before that, the
    // prediction assumes no PPUMASK write (hardware: the flag that decides it is PPUMASK 1 dot late)
    if ((this.line === PRERENDER && this.dot > 339) || this.line < VBLANK_LINE) return this.skippedThisFrame;
    return this.renderingOn;
  }

  /** Frame boundary in continuous mode: 241/1, vblank flag set, picture complete. */
  nextFrame() {
    this.frameStart += this.pos;
    this.clock -= this.pos;
    this.pos = 0;
    this.frameDone = false;
    this.frameCount++;
    this.oddFrame = !this.oddFrame;
    this.skippedThisFrame = false;
    if (!this.hardware) this.status |= 0x80; // hardware: set while emulating 241/1 (stepHw)
    this.onFrame?.(this);
  }

  /** Hardware: absolute dot of 241/1 when it is the next dot to emulate, else -1. */
  vblankDotNext() {
    return this.line === VBLANK_LINE && this.dot === 1 ? this.absDot : -1;
  }

  /** Hardware: absolute dot of this frame's 240/0 (picture complete; frame order 241/1 .. 261 .. 0 .. 240). */
  pictureDot() { return this.nextFrameDot() - 342; }

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
    if (this.continuous) {
      const js = this.jsnesCompat;
      while (this.pos < this.clock) {
        if (this.frameDone) { this.nextFrame(); continue; }
        if (js && this.line < 240 && this.dot >= 1 && this.dot <= 256) { this.pixelRunJsnes(); continue; }
        const k = this.idleDots();
        if (k > 0) this.skipDots(k < this.clock - this.pos ? k : this.clock - this.pos);
        else if (js) this.stepJsnes();
        else if (this.hardware) {
          if (this.line < 240 && this.dot >= 1 && this.dot <= 256 && this.blankHw()) this.blankRunHw();
          else this.stepHw();
        } else this.step();
      }
      if (this.frameDone) this.nextFrame(); // landed on 241/1: the vblank flag is already visible
      // landed on 261/1: jsnes clears the flags on arrival there (advanceDots' post-loop check)
      if (js && this.line === PRERENDER && this.dot === 1) { this.status &= ~0xe0; this.hitFound = false; this.hitLine = -1; }
      return;
    }
    while (this.pos < this.clock && !this.frameDone) {
      const k = this.idleDots();
      if (k > 0) this.skipDots(k < this.clock - this.pos ? k : this.clock - this.pos);
      else this.step();
    }
  }

  /** Dots from the render position on which nothing can happen (skipped in one go by sync). */
  idleDots() {
    const line = this.line, dot = this.dot;
    if (this.hardware) {
      if (this.needUpdate) return 0;
      if (line < 240 || line === PRERENDER) {
        // rendering off (flag, its delayed copy and PPUMASK): nothing happens on the visible lines' dots
        // 0 and 258-340 (dot 257 clears the sprites; 258 may finish the greyscale) nor on the pre-render line
        // after its dot 1 (the visible dots 1-256 are drawn by blankRunHw)
        if (!this.blankHw()) return 0;
        if (line === PRERENDER) return dot >= 2 ? DOTS - dot : 0;
        if (dot === 0) return 1;
        if (dot >= 257) return dot === 257 || ((this.mask & 1) && dot === 258) ? 0 : DOTS - dot;
        return 0;
      }
      // 240/0 (picture), 241/0 (frame end) and 241/1 (vblank flag) are stepped
      if (dot <= 1 && (line === 240 || line === VBLANK_LINE)) return 0;
      return DOTS - dot;
    }
    if (line >= 240 && line <= 260) {
      // post-render and vblank lines: nothing (a PPUMASK pending for line 240 applies at its dot 0)
      if (dot === 0 && (line === 240 || line === VBLANK_LINE)) return 0; // pending PPUMASK / 241/0 -> frame end
      return DOTS - dot; // up to dot 0 of the next line (241/0 is stepped: the frame ends at 241/1)
    }
    if (this.jsnesCompat) {
      if (line < 240 && dot >= 257 && dot < 340) {
        const end = line === this.hitLine && this.hitX >= dot && this.hitX < 340 ? this.hitX : 340;
        return end - dot;
      }
      if (line === PRERENDER && dot >= 2 && dot < 340) return 340 - dot;
    }
    return 0;
  }

  skipDots(n) {
    this.pos += n;
    this.dot += n;
    if (this.dot >= DOTS) { this.dot = 0; this.line = (this.line + 1) % LINES; }
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
    if (this.jsnesCompat) { this.stepJsnes(); return; }
    const line = this.line;
    const dot = this.dot;
    const rendering = this.renderingOn;
    const visible = line < 240;

    if (line === PRERENDER && dot === 1) this.status &= ~0xe0; // clear vblank, sprite 0, overflow
    if (dot === 0 && this.pendingMask >= 0 && line === this.pendingMaskLine) { this.mask = this.pendingMask; this.pendingMask = -1; }

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
    if (line === PRERENDER && dot === 339 && this.oddFrame && rendering && !this.jsnesCompat) {
      this.dot = 341; // skipped dot
      this.skippedThisFrame = true;
    }
    if (this.dot >= DOTS) {
      this.dot = 0;
      this.line = (this.line + 1) % LINES;
    } else if (this.dot === 1 && this.line === VBLANK_LINE) this.frameDone = true; // next 241/1

  }

  // ---------------------------------------------------------------- hardware rendering (Mesen2 2.1.1)
  // A dot-exact copy of Mesen2's NesPpu::Exec for what Zelda can see (docs/TIMING.md §11): background
  // fetches at dots 8k+1 (name table, with v), +3 (attribute), +5/+7 (pattern), 16-bit shifters and the
  // previous/current tile palette pair; the rendering flag takes PPUMASK one dot late and the copy used
  // by the v increments two dots late; $2006 updates v 3 dots after the write, $2007 increments v one dot
  // after the access; the vblank flag rises while emulating 241/1, sprite 0 / overflow clear on 261/0;
  // greyscale applies to the pixels from 2 dots before the write. Sprites: evaluation result and pattern
  // fetch for the next line are taken at dots 256/257 (Zelda never changes OAM or the sprite pattern
  // table during the picture).

  writeMaskHw(value) {
    this.mask = value;
    if (this.renEn !== ((value & 0x18) !== 0)) this.needUpdate = true;
  }

  greyPixel(i) {
    const color = this.indexBuffer[i] & 0x30;
    this.indexBuffer[i] = color;
    this.frame32[i] = this.rgba[color];
  }

  updateStateHw() {
    this.needUpdate = false;
    if (this.prevRenEn !== this.renEn) this.prevRenEn = this.renEn;
    const want = (this.mask & 0x18) !== 0;
    if (this.renEn !== want) { this.renEn = want; this.needUpdate = true; }
    if (this.vDelay > 0) {
      if (--this.vDelay === 0) { this.v = this.vNext; this.t = this.v; } else this.needUpdate = true;
    }
    if (this.ignoreRead > 0 && --this.ignoreRead > 0) this.needUpdate = true;
    if (this.needInc) {
      this.needInc = false;
      if ((this.line >= 240 && this.line !== PRERENDER) || !this.renEn) this.v = (this.v + ((this.ctrl & 4) ? 32 : 1)) & 0x7fff;
      else { this.incX(); this.incY(); }
    }
  }

  /** Hardware: rendering fully off (no fetch, no v increment, no sprite) and no delayed update pending. */
  blankHw() { return !this.renEn && !this.prevRenEn && !this.needUpdate && (this.mask & 0x18) === 0; }

  /** Hardware, rendering off: visible dots 1-256 up to the clock (backdrop, or the palette entry at v). */
  blankRunHw() {
    let n = 257 - this.dot;
    if (n > this.clock - this.pos) n = this.clock - this.pos;
    const v = this.v;
    const color = (v & 0x3f00) === 0x3f00 ? this.palette[Ppu.paletteIndex(v)] : this.palette[0];
    const grey = this.mask & 1;
    const row = this.line * WIDTH;
    const rgb = this.rgba[color & 0x3f];
    for (let i = 0; i < n; i++, this.dot++) {
      const x = this.dot - 1;
      this.indexBuffer[row + x] = color;
      this.frame32[row + x] = rgb;
      if (grey && this.dot >= 3) this.greyPixel(row + x - 2);
    }
    this.pos += n;
    // the shifters still shift on visible lines (Mesen shifts after every pixel)
    this.loShift = n >= 16 ? 0 : (this.loShift << n) & 0xffff;
    this.hiShift = n >= 16 ? 0 : (this.hiShift << n) & 0xffff;
  }

  /** One dot (the one at line/dot), as Mesen's Exec: process it, then the delayed state updates. */
  stepHw() {
    const line = this.line;
    const dot = this.dot;
    if (dot === 0) {
      if (line === PRERENDER) { this.status &= ~0x60; this.sprList = []; }
      else if (line === 240) {
        this.onPicture?.(this.absDot); // picture complete (Mesen SendFrame)
      }
    } else if (line < 240 || line === PRERENDER) this.scanlineHw(line, dot);
    else if (dot === 1 && line === VBLANK_LINE) {
      if (!this.preventVbl) this.status |= 0x80;
      this.preventVbl = false;
    }
    if (this.needUpdate) this.updateStateHw();
    this.pos++;
    this.dot++;
    if (this.dot >= DOTS) {
      this.dot = 0;
      this.line = (this.line + 1) % LINES;
    } else if (this.dot === 1 && this.line === VBLANK_LINE) this.frameDone = true;
  }

  loadTileHw(dot) {
    switch (dot & 7) {
      case 1: {
        this.prevPal = this.curPal;
        this.curPal = this.tilePal;
        this.loShift |= this.tileLo;
        this.hiShift |= this.tileHi;
        const v = this.v;
        const tile = this.vram[this.ntIndex(0x2000 | (v & 0xfff))];
        this.tileAddr = (tile << 4) | (v >> 12) | ((this.ctrl & 0x10) << 8);
        break;
      }
      case 3: {
        const v = this.v;
        const shift = ((v >> 4) & 4) | (v & 2);
        this.tilePal = ((this.vram[this.ntIndex(0x23c0 | (v & 0xc00) | ((v >> 4) & 0x38) | ((v >> 2) & 7))] >> shift) & 3) << 2;
        break;
      }
      case 5: this.tileLo = this.chr[this.chrOffset(this.tileAddr & 0x1fff)]; break;
      case 7: this.tileHi = this.chr[this.chrOffset((this.tileAddr + 8) & 0x1fff)]; break;
    }
  }

  scanlineHw(line, dot) {
    const visible = line < 240;
    if (dot <= 256) {
      if (this.renEn) this.loadTileHw(dot);
      if (this.prevRenEn && (dot & 7) === 0) {
        this.incX();
        if (dot === 256) this.incY();
      }
      if (visible) {
        this.pixelHw(line, dot);
        this.loShift = (this.loShift << 1) & 0xffff;
        this.hiShift = (this.hiShift << 1) & 0xffff;
        if (dot === 256 && this.renEn) this.evaluateSpritesHw(line);
        // greyscale: Mesen masks the pixels lazily up to 3 dots back, so pixel x takes the PPUMASK
        // greyscale bit in effect while dot x+3 is emulated
        if (this.mask & 1 && dot >= 3) this.greyPixel(line * WIDTH + dot - 3);
      } else if (dot === 1) this.status &= 0x7f; // pre-render: vblank flag clear
    } else if (dot <= 320) {
      if (dot === 257) {
        this.hasSprite.fill(0);
        if (this.prevRenEn) this.v = (this.v & ~0x41f) | (this.t & 0x41f);
        if (this.renEn) this.loadSpritesHw(line);
      }
      if (visible && dot <= 258 && this.mask & 1) this.greyPixel(line * WIDTH + dot - 3); // pixels 254, 255
      if (this.renEn && line === PRERENDER && dot >= 280 && dot <= 304) this.v = (this.v & ~0x7be0) | (this.t & 0x7be0);
    } else if (dot <= 336) {
      if (this.renEn) this.loadTileHw(dot);
      if (this.prevRenEn && (dot === 328 || dot === 336)) {
        this.loShift = (this.loShift << 8) & 0xffff;
        this.hiShift = (this.hiShift << 8) & 0xffff;
        this.incX();
      }
    } else if (dot === 339 && this.renEn && line === PRERENDER && this.oddFrame) {
      this.dot = 340; // skipped dot: the next one is 0/0
      this.skippedThisFrame = true;
    }
  }

  /** Secondary OAM for the next line (Mesen evaluates on dots 65-256 of `line`). */
  evaluateSpritesHw(line) {
    const h = (this.ctrl & 0x20) ? 16 : 8;
    const list = [];
    this.spr0Visible = false;
    for (let i = 0; i < 64; i++) {
      const sy = this.oam[i * 4];
      if (line < sy || line >= sy + h) continue;
      if (list.length === 8) { this.status |= 0x20; break; }
      if (i === 0) this.spr0Visible = true;
      list.push(i);
    }
    this.sprList = list;
  }

  /** Sprite pattern fetch for the next line (Mesen: dots 257-320). */
  loadSpritesHw(line) {
    const h = (this.ctrl & 0x20) ? 16 : 8;
    const tiles = [];
    for (const i of this.sprList) {
      const sy = this.oam[i * 4], tile = this.oam[i * 4 + 1], attr = this.oam[i * 4 + 2], sx = this.oam[i * 4 + 3];
      if (sy >= 240) continue;
      const row = (attr & 0x80) ? h - 1 - (line - sy) : line - sy;
      const addr = h === 16 ? ((tile & 1) << 12) + ((tile & 0xfe) << 4) + (row >= 8 ? row + 8 : row) : ((this.ctrl & 0x08) << 9) + (tile << 4) + row;
      let lo = this.chr[this.chrOffset(addr & 0x1fff)];
      let hi = this.chr[this.chrOffset((addr + 8) & 0x1fff)];
      if (attr & 0x40) { lo = reverseBits(lo); hi = reverseBits(hi); }
      tiles.push({ index: i, x: sx, lo, hi, palette: 0x10 | ((attr & 3) << 2), behind: (attr & 0x20) !== 0 });
      if (line !== PRERENDER) for (let k = 0; k < 8 && sx + k + 1 < 257; k++) this.hasSprite[sx + k + 1] = 1;
    }
    this.sprTiles = tiles;
  }

  pixelHw(line, dot) {
    const i = line * WIDTH + dot - 1;
    const v = this.v;
    let color;
    if (this.renEn || (v & 0x3f00) !== 0x3f00) {
      const mask = this.mask;
      let bg = 0;
      const bgMin = (mask & 0x08) ? ((mask & 0x02) ? 0 : 8) : 300;
      if (dot > bgMin) {
        const sh = 15 - this.x;
        bg = ((this.loShift >> sh) & 1) | (((this.hiShift >> sh) & 1) << 1);
      }
      color = -1;
      const sprMin = (mask & 0x10) ? ((mask & 0x04) ? 0 : 8) : 300;
      if (this.hasSprite[dot] && dot > sprMin) {
        const tiles = this.sprTiles;
        for (let k = 0; k < tiles.length; k++) {
          const s = tiles[k];
          const col = dot - s.x - 1;
          if (col < 0 || col > 7) continue;
          const sp = (((s.hi >> (7 - col)) & 1) << 1) | ((s.lo >> (7 - col)) & 1);
          if (!sp) continue;
          if (k === 0 && s.index === 0 && this.spr0Visible && bg && dot !== 256 && (mask & 0x08) && !(this.status & 0x40)) this.status |= 0x40;
          if (!bg || !s.behind) color = this.palette[s.palette | sp];
          break;
        }
      }
      if (color < 0) {
        const pal = (this.x + ((dot - 1) & 7) < 8) ? this.prevPal : this.curPal;
        color = bg ? this.palette[pal | bg] : this.palette[0];
      }
    } else color = this.palette[Ppu.paletteIndex(v)];
    this.indexBuffer[i] = color;
    this.frame32[i] = this.rgba[color & 0x3f];
  }

  // ---------------------------------------------------------------- jsnes-compatible rendering
  // jsnes 2.1.0 (the CI oracle) does not fetch tiles dot by dot: at the end of each line it renders the
  // whole background of the next line from the vertical part of v and the horizontal part of t (+ fine
  // X), then moves v one line down; PPUMASK changes apply from the next line; the sprite 0 flag rises
  // on the dot of the hit pixel. Same registers (loopy v/t/x/w) and memory as the hardware path.

  /** One dot in jsnes-compatible mode. */
  stepJsnes() {
    const line = this.line;
    const dot = this.dot;
    const visible = line < 240;
    if (line === PRERENDER && dot === 1) { this.status &= ~0xe0; this.hitFound = false; this.hitLine = -1; }
    if (dot === 0) {
      if (this.pendingMask >= 0 && line === this.pendingMaskLine) { this.mask = this.pendingMask; this.pendingMask = -1; }
      if (visible) {
        if (this.renderingOn) this.evaluateSprites(line);
        else this.lineSprites = [];
      }
    }
    if (visible && dot >= 1 && dot <= 256) {
      if (this.renderingOn) this.pixelJsnes();
      else this.blankPixel();
    }
    if (line === this.hitLine && dot === this.hitX && (this.mask & 0x18) === 0x18) this.status |= 0x40;
    if (dot === 340) this.endLineJsnes(line);
    this.pos++;
    this.dot++;
    if (this.dot >= DOTS) {
      this.dot = 0;
      this.line = (this.line + 1) % LINES;
    } else if (this.dot === 1 && this.line === VBLANK_LINE) this.frameDone = true;
  }

  /**
   * jsnes endScanline: render the next line's background (pre-render line: v = t first), then the
   * sprite 0 hit: checked for the line just rendered (it fires during that line) and pre-computed for
   * the line after (it fires one line early, during the next line, on the dot of the hit pixel).
   */
  endLineJsnes(line) {
    const mask = this.pendingMask >= 0 && this.pendingMaskLine === line + 1 ? this.pendingMask : this.mask;
    if ((mask & 0x18) === 0) return;
    const both = (mask & 0x18) === 0x18;
    const next = line === PRERENDER ? 0 : line + 1;
    if (line === PRERENDER) this.v = this.t;
    else if (line >= 240) return;
    this.renderRowJsnes(next < 240);
    if (!both || next >= 240) return;
    if (!this.hitFound && next >= 1) {
      const x = this.sprite0HitX(next, this.bgRow, mask);
      if (x >= 0) { this.hitFound = true; this.hitLine = next; this.hitX = x; }
    }
    if (!this.hitFound && next + 1 < 240) {
      const tmp = this.bgRowNext ??= new Uint8Array(WIDTH);
      this.bgRowAt((this.v & ~0x041f) | (this.t & 0x041f), tmp);
      const x = this.sprite0HitX(next + 1, tmp, mask);
      if (x >= 0) { this.hitFound = true; this.hitLine = next; this.hitX = x; }
    }
  }

  /** Background pixels of the line addressed by v (pal << 2 | pixel per x); returns v after 33 tiles. */
  bgRowAt(v, row) {
    const fineY = (v >> 12) & 7;
    const table = (this.ctrl & 0x10) << 8;
    let x = -this.x;
    for (let tile = 0; tile < 33; tile++, x += 8) {
      const tileIndex = this.vram[this.ntIndex(0x2000 | (v & 0x0fff))];
      const at = this.vram[this.ntIndex(0x23c0 | (v & 0xc00) | ((v >> 4) & 0x38) | ((v >> 2) & 7))];
      const pal = ((at >> (((v >> 4) & 4) | (v & 2))) & 3) << 2;
      const base = table + tileIndex * 16 + fineY;
      const lo = this.chr[this.chrOffset(base)];
      const hi = this.chr[this.chrOffset(base + 8)];
      for (let sx = 0; sx < 8; sx++) {
        const px = x + sx;
        if (px < 0 || px > 255) continue;
        const bit = 7 - sx;
        const p = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        row[px] = p ? pal | p : 0;
      }
      if ((v & 0x1f) === 31) { v &= ~0x1f; v ^= 0x400; } else v++;
    }
    return v;
  }

  /** Background of one line into bgRow, then v: +33 tiles across (from t), +1 line down. */
  renderRowJsnes(draw) {
    let v = (this.v & ~0x041f) | (this.t & 0x041f); // horizontal from t
    if (draw) v = this.bgRowAt(v, this.bgRow ??= new Uint8Array(WIDTH));
    this.v = v;
    this.incY();
  }

  /** x of the first sprite-0 / background overlap on `line` (jsnes rules), -1 if none. */
  sprite0HitX(line, row, mask) {
    const h = (this.ctrl & 0x20) ? 16 : 8;
    const sy = this.oam[0] + 1;
    const r0 = line - sy;
    if (r0 < 0 || r0 >= h) return -1;
    const tile = this.oam[1], attr = this.oam[2], sx = this.oam[3];
    const r = (attr & 0x80) ? h - 1 - r0 : r0;
    const addr = h === 16 ? ((tile & 1) << 12) + ((tile & 0xfe) + (r >> 3)) * 16 + (r & 7) : ((this.ctrl & 0x08) << 9) + tile * 16 + r;
    let lo = this.chr[this.chrOffset(addr)];
    let hi = this.chr[this.chrOffset(addr + 8)];
    if (attr & 0x40) { lo = reverseBits(lo); hi = reverseBits(hi); }
    const leftClip = (mask & 0x06) !== 0x06;
    for (let col = 0; col < 8; col++) {
      const x = sx + col;
      if (x >= 255) break;
      if (leftClip && x < 8) continue;
      const sp = (((hi >> (7 - col)) & 1) << 1) | ((lo >> (7 - col)) & 1);
      if (sp && (row[x] & 3)) return x;
    }
    return -1;
  }

  /** Visible dots 1-256 of a line up to the clock, jsnes-compatible mode (the hot loop). */
  pixelRunJsnes() {
    let n = 257 - this.dot;
    if (n > this.clock - this.pos) n = this.clock - this.pos;
    const on = this.renderingOn;
    const hit = this.line === this.hitLine ? this.hitX : -1;
    for (let i = 0; i < n; i++) {
      if (on) this.pixelJsnes(); else this.blankPixel();
      if (this.dot === hit && (this.mask & 0x18) === 0x18) this.status |= 0x40;
      this.dot++;
    }
    this.pos += n;
  }

  /** Pixel output in jsnes-compatible mode (background from bgRow). */
  pixelJsnes() {
    const x = this.dot - 1;
    let bg = 0, bgPal = 0;
    if ((this.mask & 0x08) && (x >= 8 || (this.mask & 0x02))) {
      const b = this.bgRow ? this.bgRow[x] : 0;
      bg = b & 3;
      bgPal = b >> 2;
    }
    let color = bg ? this.palette[(bgPal << 2) | bg] : this.palette[0];
    if ((this.mask & 0x10) && (x >= 8 || (this.mask & 0x04))) {
      for (const s of this.lineSprites) {
        const col = x - s.x;
        if (col < 0 || col > 7) continue;
        const sp = (((s.hi >> (7 - col)) & 1) << 1) | ((s.lo >> (7 - col)) & 1);
        if (!sp) continue;
        if (!s.behind || !bg) color = this.palette[(s.palette << 2) | sp];
        break;
      }
    }
    if (this.mask & 0x01) color &= 0x30;
    const i = this.line * WIDTH + x;
    this.indexBuffer[i] = color;
    this.frame32[i] = this.rgba[color & 0x3f];
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
