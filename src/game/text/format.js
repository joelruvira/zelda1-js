// Decimal and hearts formatting into the dynamic transfer buffer (Z_01). Package P11.
// Early port (published by P24, which needs them for the file-select screen in wave 2):
// FormatDecimalByte, DivideBy10, FormatHeartsInTextBuf. The rest of P11 goes here later.

import { ram } from '../../core/ram.js';
import { DynTileBuf, ForceSwordShot } from '../../core/vars.js';

/**
 * FormatDecimalByte (Z_01): spaces ($24) for missing leading digits.
 * @returns {{a:number, y:number}} Y = first char, A = second char; [$01..$03] = the 3 chars.
 */
export function FormatDecimalByte(a) {
  // FormatDecimalByte (Z_01)
  let r = DivideBy10(a);
  ram[0x03] = r.a;
  r = DivideBy10(r.y); // TYA
  a = r.a;
  let y = r.y;
  if (y === 0x00) {
    y = 0x24;
    if (a === 0x00) a = y; // TYA
  }
  ram[0x02] = a;
  ram[0x01] = y;
  return { a, y };
}

/** DivideBy10 (Z_01). @returns {{a:number, y:number}} Y = quotient, A = remainder (C = 0). */
export function DivideBy10(a) {
  // DivideBy10 (Z_01): the BNE back to @Loop never falls into FormatHeartsInTextBuf (Y < 26).
  let y = 0x00;
  while (a >= 0x0a) {
    a -= 0x0a;
    y = (y + 1) & 0xff;
  }
  return { a, y };
}

/**
 * FormatHeartsInTextBuf (Z_01): [$0E] hearts value, [$0F] heart partial, Y = offset of the first
 * character in DynTileBuf. Writes 8 hearts at Y..Y+7 (top row) and 8 at Y+$0B..Y+$12 (bottom).
 * @returns A = last tile written
 */
export function FormatHeartsInTextBuf(y) {
  // FormatHeartsInTextBuf (Z_01)
  ram[0x0d] = y;
  let a = ram[0x0e];
  ram[0x00] = (0x0f - (a & 0x0f)) & 0xff; // $F - hearts
  ram[0x01] = (0x0f - (a >> 4)) & 0xff; // $F - heart containers
  let x = 0x00;
  ram[0x0b] = (y + 0x07) & 0xff; // offset of last heart in top row
  y = 0x07;
  do {
    if (y === 0xff) {
      ram[0x0b] = (ram[0x0d] + 0x12) & 0xff; // offset of last heart in bottom row
      y = 0x12;
    }
    if (ram[0x0e] === 0 || x < ram[0x01]) {
      a = 0x24; // blank tile
    } else if (x === ram[0x00]) {
      a = ram[0x0f];
      if (a === 0) a = 0x66; // empty heart
      else if (a >= 0x80) a = 0xf2; // full heart
      else {
        ram[ForceSwordShot] = 0x00;
        a = 0x65; // half heart
      }
    } else if (x < ram[0x00]) {
      a = 0x66; // empty heart
    } else {
      a = 0xf2; // full heart
    }
    ram[0x0c] = y;
    ram[DynTileBuf + ram[0x0b]] = a;
    ram[0x0b]--;
    y = ram[0x0c];
    y = (y - 1) & 0xff;
    x++;
  } while (x !== 0x10);
  return a;
}
