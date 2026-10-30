// Status bar text, decimal and hearts formatting into the dynamic transfer buffer (Z_01,
// BANK_01_CODE: runs from WRAM in the original). Package P11.
// FormatDecimalByte, DivideBy10 and FormatHeartsInTextBuf were published early for P24 (wave 2).

import { ram, peek } from '../../core/ram.js';
import { label } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  DynTileBuf, ForceSwordShot, HeartValues, HeartPartial, InvRupees, InvMagicKey, InvKeys, InvBombs,
} from '../../core/vars.js';

/**
 * FormatStatusBarText (Z_01): copy StatusBarTransferBufTemplate (in WRAM, BANK_01_CODE) to DynTileBuf
 * and fill in the hearts, rupee, key and bomb counts.
 */
export function FormatStatusBarText() {
  // FormatStatusBarText (Z_01)
  const tpl = label('StatusBarTransferBufTemplate').addr; // read from its WRAM copy, like the original
  for (let y = 0x28; ;) { $pxa('Z_01:2882', tpl, y); ram[DynTileBuf + y] = peek(tpl + y); y--; if (!$br('Z_01:2885', y >= 0)) break; }
  ram[0x0e] = ram[HeartValues];
  ram[0x0f] = ram[HeartPartial];
  FormatHeartsInTextBuf(0x03);
  FormatDecimalCountByteInTextBuf(ram[InvRupees], 0x1b); // LDX #$02 is overwritten
  if (!$br('Z_01:2898', ram[InvMagicKey] === 0)) {
    // Magic key: "XA" instead of the key count.
    ram[0x00] = 0x21;
    ram[0x01] = 0x21; // "X"
    FormatCharDoublet(0x0a); // "A"
    // LDX #$08: overwritten by CopyTripletToTextBuf
    CopyTripletToTextBuf();
  } else {
    FormatDecimalCountByteInTextBuf(ram[InvKeys], 0x21);
  }
  return FormatDecimalCountByteInTextBuf(ram[InvBombs], 0x27);
}

/** FormatDecimalCountByteInTextBuf (Z_01): A value, Y offset of the LAST character in DynTileBuf. */
export function FormatDecimalCountByteInTextBuf(a, y) {
  // FormatDecimalCountByteInTextBuf (Z_01)
  ram[0x00] = y;
  FormatDecimalCountByte(a);
  return CopyTripletToTextBuf(); // falls through
}

/** CopyTripletToTextBuf (Z_01): DynTileBuf[[$00]-2..[$00]] = [$01..$03]. Returns A = [$01]. */
export function CopyTripletToTextBuf() {
  // CopyTripletToTextBuf (Z_01)
  let x = ram[0x00];
  let a = 0;
  for (let y = 0x02; ;) {
    $pxa('Z_01:2933', 0x0001, y);
    a = ram[0x01 + y];
    ram[(DynTileBuf + x) & 0xffff] = a;
    x = (x - 1) & 0xff;
    y--; if (!$br('Z_01:2937', y >= 0)) break;
  }
  return a;
}

/**
 * FormatDecimalCountByte (Z_01): 123 -> "123", 23 -> "X23", 3 -> "X3 " in [$01..$03]
 * ("X" = $21, space = $24).
 */
export function FormatDecimalCountByte(a) {
  // FormatDecimalCountByte (Z_01)
  const r = FormatDecimalByte(a);
  a = r.a;
  let y = r.y;
  if (!$br('Z_01:2956', y !== 0x24)) y = 0x21;
  ram[0x01] = y;
  if ($br('Z_01:2961', a !== 0x24)) return a;
  return FormatCharDoublet(ram[0x03]); // falls through
}

/** FormatCharDoublet (Z_01): [$02] = A, [$03] = space. Returns A = $24. */
export function FormatCharDoublet(a) {
  // FormatCharDoublet (Z_01)
  ram[0x02] = a;
  ram[0x03] = 0x24;
  return 0x24;
}

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
  if (!$br('Z_01:3171', y !== 0x00)) {
    y = 0x24;
    if (!$br('Z_01:3174', a !== 0x00)) a = y; // TYA
  }
  ram[0x02] = a;
  ram[0x01] = y;
  return { a, y };
}

/** DivideBy10 (Z_01). @returns {{a:number, y:number}} Y = quotient, A = remainder (C = 0). */
export function DivideBy10(a) {
  // DivideBy10 (Z_01): the BNE back to @Loop never falls into FormatHeartsInTextBuf (Y < 26).
  let y = 0x00;
  for (;;) {
    if ($br('Z_01:3195', a < 0x0a)) break;
    a -= 0x0a;
    y = (y + 1) & 0xff;
    $br('Z_01:3198', y !== 0); // never 0 (Y < 26)
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
    if (!$br('Z_01:3253', y !== 0xff)) {
      ram[0x0b] = (ram[0x0d] + 0x12) & 0xff; // offset of last heart in bottom row
      y = 0x12;
    }
    if ($br('Z_01:3264', ram[0x0e] === 0) || !$br('Z_01:3266', x >= ram[0x01])) {
      a = 0x24; // blank tile
      $br('Z_01:3270', true);
    } else if ($br('Z_01:3274', x === ram[0x00])) {
      a = ram[0x0f];
      if ($br('Z_01:3283', a === 0)) a = 0x66; // empty heart
      else if ($br('Z_01:3285', a >= 0x80)) { a = 0xf2; $br('Z_01:3279', true); } // full heart
      else {
        ram[ForceSwordShot] = 0x00;
        a = 0x65; // half heart
        $br('Z_01:3289', true);
      }
    } else if ($br('Z_01:3275', x < ram[0x00])) {
      a = 0x66; // empty heart
    } else {
      a = 0xf2; // full heart
      $br('Z_01:3279', true);
    }
    ram[0x0c] = y;
    ram[DynTileBuf + ram[0x0b]] = a;
    ram[0x0b]--;
    y = ram[0x0c];
    y = (y - 1) & 0xff;
    x++;
  } while ($br('Z_01:3303', x !== 0x10));
  return a;
}
