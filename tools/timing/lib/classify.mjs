// Classifies a logged PPU write (lib/ppu-probe.mjs) by raster region, picture impact and timing slack.
//
// Coordinates: frameDot = PPU dots since the NMI's video frame started (NES line 241 dot 1, the
// origin of src/core/ppu.js `clock`). One frame = 262*341 dots (the odd-frame skipped dot is ignored:
// it only shifts positions by 1 dot = 1/3 cycle).
//
// Why "region" matters for the port: the port runs all logic at clock ~0 (start of vblank) except
// the explicitly timed waits. A write the hardware performs while the picture is being drawn is
// applied by the port to the whole picture instead of only from that raster position on.

export const DOTS = 341;
export const LINES = 262;
export const FRAME_DOTS = DOTS * LINES; // 89342
export const PRE_LINE_DOT = 20 * DOTS - 1; // frameDot of line 261 dot 0
export const PRE_COPY_DOT = PRE_LINE_DOT + 257; // first rendering side effect of the pre-render line
export const VIS0_DOT = 21 * DOTS - 1; // frameDot of line 0 dot 0
export const POST_DOT = VIS0_DOT + 240 * DOTS; // line 240 dot 0

export const lineDotToFrameDot = (line, dot) => (line >= 241 ? (line - 241) * DOTS : (line + 21) * DOTS) + dot - 1;

/** Region of a frameDot (may exceed one frame when the NMI overran: 'next'). */
export function region(frameDot) {
  if (frameDot >= FRAME_DOTS) return 'next';
  if (frameDot < PRE_COPY_DOT) return 'vblank';
  if (frameDot < POST_DOT) return frameDot < VIS0_DOT ? 'prerender' : 'visible';
  return 'post';
}

const renderOn = (mask) => (mask & 0x18) !== 0;

/** Why this write can change the picture (null = it cannot, whatever its timing). */
export function impact(ev) {
  const on = renderOn(ev.maskBefore);
  switch (ev.reg) {
    case 0x2001: {
      const d = ev.maskBefore ^ ev.val;
      if (d & 0x18) return 'mask:render-on/off';
      if (d & 0xe1) return 'mask:grey/emphasis';
      if (d & 0x06 && on) return 'mask:left-clip';
      return null;
    }
    case 0x2000: {
      if (!on) return null;
      if ((ev.ctrlBefore ^ ev.val) & 0x38) return 'ctrl:pattern/size';
      if ((ev.val & 3) !== ev.tNt) return 'ctrl:nametable(t)';
      return null;
    }
    case 0x2005:
      return on ? 'scroll' : null;
    case 0x2006:
      if (on) return 'addr(v)';
      // rendering off: the backdrop shows the palette entry v points at ("palette hack")
      return !ev.firstWrite && ev.vAfter >= 0x3f00 && (ev.vAfter & 0x03) !== 0 ? 'addr:palette-pointer' : null;
    case 0x2007:
      if (on) return 'data:render-glitch';
      return ev.v >= 0x3f00 ? 'data:palette' : null;
    case 0x2003:
    case 0x2004:
      return on ? 'oam' : null;
    case 0x4014:
      return on ? 'oam-dma' : null;
    default:
      return null;
  }
}

/**
 * Cycles the write could move earlier/later without the hardware picture changing: the gap
 * between pixel-output dots (lines 0-239, dots 1-256) and the pre-render copy point (dot 257) that
 * contains it. A write landing on pixel dots has 0 slack (1 CPU cycle = 3 pixels).
 */
export function hwSlack(x) {
  const f = Math.floor(x / FRAME_DOTS) * FRAME_DOTS;
  const r = x - f;
  const pix = (frameBase, line, dot) => frameBase + VIS0_DOT + line * DOTS + dot; // frameDot of (line, dot)
  let prev, next;
  if (r < PRE_COPY_DOT) {
    prev = pix(f - FRAME_DOTS, 239, 256);
    next = f + PRE_COPY_DOT;
  } else if (r < VIS0_DOT) {
    prev = f + PRE_COPY_DOT;
    next = pix(f, 0, 1);
  } else if (r >= POST_DOT) {
    prev = pix(f, 239, 256);
    next = f + FRAME_DOTS + PRE_COPY_DOT;
  } else {
    const line = Math.floor((r - VIS0_DOT) / DOTS);
    const dot = r - VIS0_DOT - line * DOTS;
    if (dot >= 1 && dot <= 256) return { back: 0, fwd: 0 };
    if (dot === 0) {
      prev = line === 0 ? f + PRE_COPY_DOT : pix(f, line - 1, 256);
      next = pix(f, line, 1);
    } else {
      prev = pix(f, line, 256);
      next = line === 239 ? f + FRAME_DOTS + PRE_COPY_DOT : pix(f, line + 1, 1);
    }
  }
  return { back: Math.floor((x - prev - 1) / 3), fwd: Math.floor((next - x - 1) / 3) };
}

/**
 * Same for jsnes, which applies register writes per whole scanline (the background of a line is
 * drawn at its end, src/ppu/index.js endScanline/triggerRendering): only crossing a scanline
 * boundary of the pre-render/visible lines can change its picture.
 */
export function jsnesSlack(x) {
  const f = Math.floor(x / FRAME_DOTS) * FRAME_DOTS;
  const r = x - f;
  if (r >= PRE_LINE_DOT && r < POST_DOT) {
    const start = f + PRE_LINE_DOT + Math.floor((r - PRE_LINE_DOT) / DOTS) * DOTS;
    return { back: Math.floor((x - start) / 3), fwd: Math.floor((start + DOTS - 1 - x) / 3) };
  }
  const prev = r < PRE_LINE_DOT ? f - FRAME_DOTS + POST_DOT : f + POST_DOT;
  const next = r < PRE_LINE_DOT ? f + PRE_LINE_DOT : f + FRAME_DOTS + PRE_LINE_DOT;
  return { back: Math.floor((x - prev) / 3), fwd: Math.floor((next - 1 - x) / 3) };
}

export function classify(ev) {
  const reg = region(ev.frameDot);
  const why = impact(ev);
  return {
    region: reg,
    impact: why,
    relevant: why !== null && reg !== 'vblank',
    hw: hwSlack(ev.frameDot),
    js: jsnesSlack(ev.frameDot),
  };
}
