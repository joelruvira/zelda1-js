// NES color handling for traces: framebuffers are stored as 6-bit NES color indices
// (0..63) so the port and the emulator can be compared without depending on an RGB palette.
// Every "black" duplicate ($0D, $0E, $0F, $1D, ...) is canonicalized to $0F.
import { loadJsnes } from './jsnes-loader.mjs';

export const FB_WIDTH = 256;
export const FB_HEIGHT = 240;
export const FB_SIZE = FB_WIDTH * FB_HEIGHT;
export const UNKNOWN_COLOR = 0xff;

let cached = null;

/** Returns {rgb: Uint8Array(192), canon: Uint8Array(64), reverse: Map<jsnesPixel, index>}. */
export async function getPalette() {
  if (cached) return cached;
  const { NES } = await loadJsnes();
  const table = new NES({}).ppu.palTable;
  const rgb = new Uint8Array(64 * 3);
  const canon = new Uint8Array(64);
  const reverse = new Map();
  const firstByColor = new Map();
  for (let i = 0; i < 64; i++) {
    const v = table.emphTable[0][i]; // jsnes packs pixels as 0x00BBGGRR
    rgb[i * 3] = v & 0xff;
    rgb[i * 3 + 1] = (v >> 8) & 0xff;
    rgb[i * 3 + 2] = (v >> 16) & 0xff;
    const preferred = v === 0 ? 0x0f : i;
    if (!firstByColor.has(v)) firstByColor.set(v, preferred);
    canon[i] = firstByColor.get(v);
  }
  for (const [v, idx] of firstByColor) reverse.set(v, idx);
  // Emphasized colors map to their base index (emphasis is not tracked in traces).
  for (let e = 1; e < 8; e++) {
    for (let i = 0; i < 64; i++) {
      const v = table.emphTable[e][i];
      if (!reverse.has(v)) reverse.set(v, canon[i]);
    }
  }
  cached = { rgb, canon, reverse };
  return cached;
}

/** Converts a jsnes Uint32 frame buffer (0x00BBGGRR) into canonical NES color indices. */
export function jsnesBufferToIndices(buffer, palette, out = new Uint8Array(FB_SIZE)) {
  for (let i = 0; i < FB_SIZE; i++) {
    const idx = palette.reverse.get(buffer[i] & 0xffffff);
    out[i] = idx === undefined ? UNKNOWN_COLOR : idx;
  }
  return out;
}

/** Canonicalizes an index framebuffer produced by the port (masks emphasis bits). */
export function canonicalizeIndices(fb, palette, out = new Uint8Array(FB_SIZE)) {
  for (let i = 0; i < FB_SIZE; i++) out[i] = fb[i] === UNKNOWN_COLOR ? UNKNOWN_COLOR : palette.canon[fb[i] & 0x3f];
  return out;
}

/** Expands indices to RGB for PNG output; unknown pixels become magenta. */
export function indicesToRgb(fb, palette) {
  const rgb = new Uint8Array(FB_SIZE * 3);
  for (let i = 0; i < FB_SIZE; i++) {
    if (fb[i] === UNKNOWN_COLOR) {
      rgb[i * 3] = 0xff; rgb[i * 3 + 2] = 0xff;
    } else {
      rgb.set(palette.rgb.subarray(fb[i] * 3, fb[i] * 3 + 3), i * 3);
    }
  }
  return rgb;
}
