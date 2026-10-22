// Frame replay: captures, in the oracle, the complete PPU state at the start of an NMI plus every
// PPU-affecting CPU access of that NMI (writes, $2002/$2007 reads, OAM DMA with its page, MMC1
// mirroring changes) with its exact raster position, and re-renders the picture with the port's
// dot-based PPU (src/core/ppu.js, imported read-only) applying each access at a chosen time.
//
//  * timeOf = true raster position  -> "hardware-like" picture (dot accurate), to validate the replay
//    against jsnes and to measure where jsnes' per-scanline rendering differs from a dot renderer.
//  * timeOf = port model            -> the picture the port produces when its logic runs in zero time.
//  * timeOf = true +/- k cycles     -> empirical slack of each write (how exact its cycle must be).
import { Ppu } from '../../../src/core/ppu.js';
import { MIRROR_HORIZONTAL, MIRROR_VERTICAL, MIRROR_SINGLE_LOW } from '../../../src/core/mapper.js';
import { canonicalizeIndices } from '../../oracle/lib/palette.mjs';
import { attachProbe } from './ppu-probe.mjs';

// jsnes rom.js mirroring constants -> port (MMC1 encoding)
const JSNES_MIRROR = { 0: MIRROR_VERTICAL, 1: MIRROR_HORIZONTAL, 3: MIRROR_SINGLE_LOW };

function snapshotPpu(nes, shadow) {
  const p = nes.ppu;
  const at = (a) => p.vramMem[p.vramMirrorTable[a]];
  const nt = new Uint8Array(0x1000);
  for (let i = 0; i < 0x1000; i++) nt[i] = at(0x2000 + i);
  const pal = new Uint8Array(32);
  for (let i = 0; i < 32; i++) pal[i] = at(0x3f00 + i) & 0x3f;
  return {
    chr: p.vramMem.slice(0, 0x2000), nt, pal, oam: p.spriteMem.slice(),
    ctrl: shadow.ctrl, mask: shadow.mask,
    v: p.vramAddress & 0x7fff, t: p.vramTmpAddress & 0x7fff, x: p.regFH & 7, w: p.firstWrite ? 0 : 1,
    readBuffer: p.vramBufferedReadValue ?? 0,
    mirroring: JSNES_MIRROR[p.currentMirroring] ?? MIRROR_HORIZONTAL,
  };
}

/**
 * Records the selected frames while the oracle plays. Returns { frames: Map(frame -> rec) } where
 * rec = { frame, nmi, snap, events[], fb (oracle picture, canonical indices) }.
 */
export function attachRecorder(oracle, wanted) {
  const frames = new Map();
  let cur = null;
  const nes = oracle.nes;
  const st = attachProbe(oracle, {
    onNmiStart(n) {
      cur = wanted(n.frame) ? { frame: n.frame, nmi: n, snap: snapshotPpu(nes, st), events: [], fb: null } : null;
    },
    onWrite(ev) {
      if (!cur || ev.frame !== cur.frame) return;
      const e = { kind: 'w', reg: ev.reg, val: ev.val, frameDot: ev.frameDot, pc: ev.pc, bank: ev.bank, cyc: ev.cyc, line: ev.line, dot: ev.dot,
        stack: ev.stack, stackBanks: ev.stackBanks, maskBefore: ev.maskBefore, ctrlBefore: ev.ctrlBefore, tNt: ev.tNt, v: ev.v, vAfter: ev.vAfter, firstWrite: ev.firstWrite };
      if (ev.reg === 0x4014) e.page = nes.cpu.mem.slice(ev.val << 8, (ev.val << 8) + 256);
      cur.events.push(e);
    },
    onRead(ev) {
      if (cur && ev.frame === cur.frame) cur.events.push({ kind: 'r', reg: ev.reg, frameDot: ev.frameDot, pc: ev.pc, bank: ev.bank });
    },
    onNmiEnd(n) {
      if (cur && n.frame === cur.frame) { cur.nmi = n; frames.set(cur.frame, cur); }
      cur = null;
    },
  });
  // sprite-0 hit: the dot where the flag is set (for the split timing analysis; ignored by renderReplay)
  const setStatusFlag = nes.ppu.setStatusFlag.bind(nes.ppu);
  nes.ppu.setStatusFlag = (flag, value) => {
    if (cur && flag === 6 && value) {
      const portD = nes.ppu.scanline * 341 + nes.ppu.curX - 1;
      cur.events.push({ kind: 'h', frameDot: (oracle.videoFrames - cur.nmi.video) * 89342 + portD });
    }
    return setStatusFlag(flag, value);
  };
  const setMirroring = nes.ppu.setMirroring.bind(nes.ppu);
  nes.ppu.setMirroring = (m) => {
    if (cur) {
      const s = nes.ppu.scanline, x = nes.ppu.curX;
      const portD = s * 341 + x - 1;
      cur.events.push({ kind: 'm', val: JSNES_MIRROR[m] ?? MIRROR_HORIZONTAL, frameDot: (oracle.videoFrames - cur.nmi.video) * 89342 + portD });
    }
    return setMirroring(m);
  };
  return { frames, probe: st };
}

/**
 * Renders a recorded frame with the port PPU. timeOf(event, index) -> frameDot at which the access
 * takes effect (default: its true position). Accesses are applied in recorded order; a time earlier
 * than the previous access is clamped to it (the PPU clock cannot go back).
 */
export function renderReplay(rec, palette, timeOf = (e) => e.frameDot) {
  const ppu = new Ppu();
  const s = rec.snap;
  ppu.mirroring = s.mirroring;
  ppu.chr.set(s.chr);
  for (let i = 0; i < 0x1000; i++) ppu.poke(0x2000 + i, s.nt[i]); // the 4 logical tables through mirroring
  for (let i = 0; i < 32; i++) if ((i & 0x13) !== 0x10) ppu.palette[i] = s.pal[i];
  ppu.oam.set(s.oam);
  ppu.ctrl = s.ctrl; ppu.mask = s.mask; ppu.v = s.v; ppu.t = s.t; ppu.x = s.x; ppu.w = s.w; ppu.readBuffer = s.readBuffer;
  ppu.oddFrame = false; // frameDot is a raster position; jsnes' skipped dot is already in it
  ppu.beginFrame();
  ppu.status = 0x80;
  let clock = 0;
  const end = ppu.frameDots();
  for (let i = 0; i < rec.events.length; i++) {
    const e = rec.events[i];
    if (e.kind === 'h') continue;
    let t = timeOf(e, i);
    if (t >= end) break; // belongs to a later video frame
    clock = Math.max(clock, t);
    ppu.clock = clock;
    if (e.kind === 'm') { ppu.setMirroring(e.val); continue; }
    if (e.kind === 'r') { if (e.reg === 0x2002) ppu.readStatus(); else ppu.readData(); continue; }
    switch (e.reg) {
      case 0x2000: ppu.writePPUCTRL(e.val); break;
      case 0x2001: ppu.writePPUMASK(e.val); break;
      case 0x2003: ppu.writeOAMADDR(e.val); break;
      case 0x2004: ppu.writeOAMDATA(e.val); break;
      case 0x2005: ppu.writeScroll(e.val); break;
      case 0x2006: ppu.writeAddr(e.val); break;
      case 0x2007: ppu.writeData(e.val); break;
      case 0x4014: ppu.sync(); ppu.oamDMA(e.page); break;
      default: break;
    }
  }
  ppu.endFrame();
  return canonicalizeIndices(ppu.indexBuffer, palette);
}

/** Pixel differences ignoring row 0 (the oracle never draws it). */
export function pictureDiff(a, b) {
  let count = 0, y0 = 240, y1 = -1;
  for (let i = 256; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    count++;
    const y = i >> 8;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { count, rows: count ? [y0, y1] : null };
}
