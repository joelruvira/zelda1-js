// Underworld room layout: walls (WallTileList, rotated 180 degrees for the other half) and
// floor (column descriptors -> squares). Package P12, bank 5.

import { ram, word } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import {
  AddToInt16At0, Add1ToInt16At0, AddToInt16At2, Add1ToInt16At2, AddToInt16At4, Add1ToInt16At4,
  Sub1FromInt16At4,
} from '../util/int16.js';
import { GetUniqueRoomId } from './roomflags.js';
import { $br, $pxa } from '../../core/timing.js';

/** LayoutUWFloor (Z_05): lays out the $C x 7 floor squares of the UW room in PlayAreaTiles. */
export function LayoutUWFloor() {
  // LayoutUWFloor (Z_05)
  let a = GetUniqueRoomId();
  const layouts = label('RoomLayoutsUW').addr;
  ram[0x02] = layouts & 0xff;
  ram[0x03] = layouts >> 8;
  a = (a << 2) & 0xff; // ASL / ASL
  ram[0x00] = a;
  AddToInt16At2(a);
  AddToInt16At2(ram[0x00]);
  AddToInt16At2(ram[0x00]);
  ram[0x00] = 0x8c;
  ram[0x01] = 0x65;
  const colDir = table(bus.rom, 'ColumnDirectoryUW');
  const prim = table(bus.rom, 'PrimarySquaresUW');
  ram[0x06] = 0;
  do {
    // @LoopColumnUW
    let y = ram[0x06];
    $pxa('Z_05:5345', ram[0x02], y);
    a = read(word(0x02) + y);
    let x = (a & 0xf0) >> 3;
    $pxa('Z_05:5351', colDir.addr, x);
    ram[0x04] = colDir.byte(x);
    $pxa('Z_05:5353', colDir.addr + 1, x);
    ram[0x05] = colDir.byte(x + 1);
    $pxa('Z_05:5355', ram[0x02], y);
    a = read(word(0x02) + y);
    x = a & 0x0f;
    y = 0;
    for (;;) {
      // @FindSquare
      $pxa('Z_05:5361', ram[0x04], y);
      a = read(word(0x04) + y);
      if (!$br('Z_05:5362', !(a & 0x80))) {
        x = (x - 1) & 0xff;
        if ($br('Z_05:5364', (x & 0x80) !== 0)) break; // @FoundColumn
      }
      y = (y + 1) & 0xff;
    }
    AddToInt16At4(y);
    ram[0x07] = 0;
    ram[0x08] = 0;
    do {
      // @LoopSquareRow
      $pxa('Z_05:5380', ram[0x04], 0);
      a = read(word(0x04));
      x = a & 0x07;
      $pxa('Z_05:5383', prim.addr, x);
      WriteSquareUW(prim.byte(x), 0);
      AddToInt16At0(0x02);
      $pxa('Z_05:5389', ram[0x04], 0);
      a = (read(word(0x04)) & 0x70) >> 4;
      if (!$br('Z_05:5396', a === ram[0x08])) {
        ram[0x08]++;
      } else {
        ram[0x08] = 0;
        Add1ToInt16At4();
      }
      // @NextLoopSquareRow
      ram[0x07]++;
    } while ($br('Z_05:5408', ram[0x07] < 0x07));
    AddToInt16At0(0x1e);
    ram[0x06]++;
  } while (!$br('Z_05:5414', ram[0x06] >= 0x0c));
}

/**
 * WriteSquareUW (Z_05): A = primary square, Y = offset from [$00:01].
 * $70 <= A < $F3: tiles A..A+3; otherwise A in the 4 tiles of the square.
 */
export function WriteSquareUW(a, y) {
  // WriteSquareUW (Z_05)
  const p = word(0x00);
  if (!$br('Z_05:5426', a < 0x70) && !$br('Z_05:5428', a >= 0xf3)) {
    let x = a;
    write(p + y, a);
    y++;
    x = (x + 1) & 0xff;
    write(p + y, x);
    y = (y + 0x15) & 0xff;
    x = (x + 1) & 0xff;
    write(p + y, x);
    x = (x + 1) & 0xff;
    a = x;
  } else {
    // @WriteType2
    write(p + y, a);
    y++;
    write(p + y, a);
    y = (y + 0x15) & 0xff;
    write(p + y, a);
  }
  // @WriteLastTile
  y = (y + 1) & 0xff;
  write(p + y, a);
  return a;
}

/** FillWalls (Z_05): writes the UW room walls (WallTileList) into PlayAreaTiles. */
export function FillWalls() {
  // FillWalls (Z_05)
  const list = label('WallTileList').addr;
  ram[0x00] = list & 0xff;
  ram[0x01] = list >> 8;
  ram[0x02] = 0x47;
  ram[0x03] = 0x65;
  ram[0x04] = 0x5a;
  ram[0x05] = 0x65;
  ram[0x06] = 0x0a;
  return wallLoop(0, false);
}

/**
 * NextLoopWallTile (Z_05): entry in the middle of FillWalls' loop (advance the wall tile list
 * pointer, then continue the loop and the 180-degree copy).
 */
export function NextLoopWallTile(y = 0) {
  // NextLoopWallTile (Z_05)
  return wallLoop(y, true);
}

// LoopWallTile / ReachedTopWallBottom / DecBottomOffset / MoveWallPtrs / NextLoopWallTile and the
// rotated copy, as one loop (internal labels of FillWalls).
function wallLoop(y, atNext) {
  const end = (label('WallTileList').addr + 0x4e) & 0xff;
  for (;;) {
    if (!atNext) {
      // LoopWallTile
      $pxa('Z_05:4626', ram[0x00], y);
      let a = read(word(0x00) + y);
      let x;
      if ($br('Z_05:4627', a === 0)) {
        // ReachedTopWallBottom
        a = 0x13;
        ram[0x06] = a;
        x = 0x19;
        $br('Z_05:4594', true);
      } else {
        write(word(0x02) + y, a);
        write(word(0x04) + y, a);
        if (!$br('Z_05:4635', a === 0xde) && !$br('Z_05:4637', a >= 0xe2)) {
          a = (a + 0x01) & 0xff; // ADC #$01 (C clear after CMP #$E2 / BCS)
          write(word(0x04) + y, a);
        }
        a = 0x01;
        x = 0x01;
        ram[0x06]--;
        if (!$br('Z_05:4644', ram[0x06] !== 0)) {
          ram[0x06] = 0x0a;
          a = 0x0d;
          x = 0x1f;
        }
      }
      // MoveWallPtrs
      AddToInt16At2(a);
      a = x;
      x = (x - 1) & 0xff;
      if ($br('Z_05:4657', x === 0)) Sub1FromInt16At4(); // DecBottomOffset
      else AddToInt16At4(a);
    }
    atNext = false;
    // NextLoopWallTile
    if (!$br('Z_05:4666', Add1ToInt16At0() !== end)) break;
  }
  // Copy rotated 180 degrees.
  ram[0x02] = 0x30;
  ram[0x03] = 0x65;
  ram[0x04] = 0xef;
  ram[0x05] = 0x67;
  for (;;) {
    // @LoopRotate
    $pxa('Z_05:4682', ram[0x02], y);
    let a = read(word(0x02) + y);
    write(word(0x04) + y, a);
    if ($br('Z_05:4685', a === 0xdd)) {
      // @SwapWithVertical
      $br('Z_05:4711', true);
      write(word(0x04) + y, 0xdc);
    } else if (!$br('Z_05:4687', a >= 0xe0)) {
      if (!$br('Z_05:4689', a >= 0xdc)) {
        a = (a + 0x01) & 0xff;
        write(word(0x04) + y, a);
      }
      a = (a + 0x01) & 0xff;
      write(word(0x04) + y, a); // @SetRotatedTile
    }
    // @NextLoopRotate
    Sub1FromInt16At4();
    if ($br('Z_05:4703', Add1ToInt16At2() !== 0x90)) continue;
    if ($br('Z_05:4706', ram[0x03] !== 0x66)) continue;
    return;
  }
}
