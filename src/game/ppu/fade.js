// World fading: steps the bottom half of the background palette through LevelInfo_PaletteCycles
// (dark rooms, cellars, caves). Package P13, Z_01 (BANK_01_CODE, runs from WRAM).

import { ram, peek } from '../../core/ram.js';
import { ObjTimer, FadeCycle, DynTileBufLen, DynTileBuf, LevelInfo_PaletteCycles } from '../../core/vars.js';

/**
 * AnimateWorldFading (Z_01). [$051C] FadeCycle = cycle number (bit 7: reverse fade).
 * Every 10 frames (ObjTimer[12]) appends a transfer record of 8 palette bytes ($3F08) to DynTileBuf.
 * @returns A: 0 (Z set) when the 4 steps are done; otherwise non-zero (still fading)
 */
export function AnimateWorldFading() {
  // AnimateWorldFading (Z_01)
  let a = ram[ObjTimer + 12];
  if (a !== 0) return a; // @Exit: only delay
  a = ram[FadeCycle];
  if (a & 0x80) a ^= 0x83; // reverse fade
  ram[0x00] = a; // map cycle XY to offset X0 + Y*8
  let y = ((((a << 3) & 0xff) + ram[0x00]) & 0xff) & 0xfc;

  let x = ram[DynTileBufLen];
  ram[DynTileBuf + x] = 0x3f; // PPU address $3F08
  x = (x + 1) & 0xff;
  ram[DynTileBuf + x] = 0x08;
  x = (x + 1) & 0xff;
  ram[DynTileBuf + x] = 0x08; // length 8
  ram[0x00] = 0x08;
  x = (x + 1) & 0xff;
  do {
    // @CopyPalette
    ram[DynTileBuf + x] = peek(LevelInfo_PaletteCycles + y);
    y = (y + 1) & 0xff;
    x = (x + 1) & 0xff;
    ram[0x00]--;
  } while (ram[0x00] !== 0);
  ram[DynTileBuf + x] = 0xff; // end marker
  ram[DynTileBufLen] = x;
  ram[FadeCycle]++;
  if ((ram[FadeCycle] & 0x0f) === 0x04) return 0x00; // @ReturnDone
  ram[ObjTimer + 12] = 0x0a; // update every 10 frames
  return 0x0a;
}
