// Overworld room layout: column descriptors -> squares -> PlayAreaTiles, tile objects,
// secrets found and shortcuts (also used for caves and UW cellars). Package P12, bank 5.

import { ram, sram, cpu, word, peek } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import {
  RoomId, LevelBlockAttrsD, LevelInfo_WorldFlagsAddr, RoomTileObjType, RoomTileObjX, RoomTileObjY,
} from '../../core/vars.js';
import { AddToInt16At0, Add1ToInt16At4, AddToInt16At4 } from '../util/int16.js';
import { FetchTileMapAddr } from './tilemap.js';
import { GetRoomFlags } from './roomflags.js';
import { GetShortcutOrItemXY } from '../items/roomitem.js';

/** LayoutRoomOW (Z_05): [$02:03] = RoomLayoutsOW + unique room ID * $10; falls into LayoutRoomOrCaveOW. */
export function LayoutRoomOW() {
  // LayoutRoomOW (Z_05)
  const addr = table(bus.rom, 'RoomLayoutsOWAddr');
  ram[0x02] = addr.byte(0);
  ram[0x03] = addr.byte(1);
  ram[0x06] = 0;
  const x = ram[RoomId];
  let a = peek(LevelBlockAttrsD + x);
  a = cpu.asl(a);
  a = cpu.asl(a);
  cpu.rolMem(0x06);
  a = cpu.asl(a);
  cpu.rolMem(0x06);
  a = cpu.asl(a);
  cpu.rolMem(0x06);
  a = cpu.adc(a, ram[0x02]);
  ram[0x02] = a;
  a = cpu.adc(ram[0x06], ram[0x03]);
  ram[0x03] = a;
  return LayoutRoomOrCaveOW();
}

/**
 * LayoutRoomOrCaveOW (Z_05): [$02:03] = address of the room's 16 column descriptors.
 * Writes the $10 x $B squares of the room into PlayAreaTiles.
 */
export function LayoutRoomOrCaveOW() {
  // LayoutRoomOrCaveOW (Z_05)
  ram[0x08] = sram[LevelInfo_WorldFlagsAddr - 0x6000];
  ram[0x09] = sram[LevelInfo_WorldFlagsAddr + 1 - 0x6000];
  FetchTileMapAddr();
  ram[0x0c] = 0;
  ram[0x06] = 0;
  const colDir = label('ColumnDirectoryOW').addr; // BANK_06_DATA, read in SRAM
  const prim = table(bus.rom, 'PrimarySquaresOW');
  for (;;) {
    // @LoopColumnOW
    let y = ram[0x06];
    let a = read(word(0x02) + y);
    let x = (a & 0xf0) >> 3;
    ram[0x04] = peek(colDir + x);
    ram[0x05] = peek(colDir + x + 1);
    a = read(word(0x02) + y);
    x = a & 0x0f;
    y = 0xff;
    do {
      do {
        y = (y + 1) & 0xff;
        a = read(word(0x04) + y);
      } while (!(a & 0x80));
      x = (x - 1) & 0xff;
    } while (x < 0x80);
    AddToInt16At4(y);
    ram[0x07] = 0;
    do {
      // @LoopSquareOW
      a = read(word(0x04)) & 0x3f;
      ram[0x0d] = a;
      x = a;
      a = prim.byte(x);
      y = ram[RoomId];
      if (read(word(0x08) + y) & 0x80) {
        // The secret was found in this room.
        if (a === 0xe7 || a === 0xea) {
          // @MakeStairs
          ram[0x0d] = 0x10;
          a = 0x70;
        } else if (a === 0xe6) {
          // @MakeCave: A = $0C as primary and square index
          a = 0x0c;
          ram[0x0d] = a;
        }
      }
      a = CheckTileObject(a);
      WriteSquareOW(a, 0);
      AddToInt16At0(0x02);
      a = read(word(0x04)) & 0x40;
      let advance = true;
      if (a !== 0) {
        a ^= ram[0x0c];
        ram[0x0c] = a;
        if (a !== 0) advance = false;
      }
      if (advance) Add1ToInt16At4(); // @NextSquare
      ram[0x07]++;
    } while (ram[0x07] !== 0x0b);
    AddToInt16At0(0x16);
    ram[0x06]++;
    if (ram[0x06] >= 0x10) return;
  }
}

/**
 * CheckTileObject (Z_05): A = primary square; [$06] column, [$07] row.
 * @returns A = primary square for the tile object ($E5-$EA), else the argument
 */
export function CheckTileObject(a) {
  // CheckTileObject (Z_05)
  ram[0x0a] = 0xea;
  let x = 0x05;
  for (;;) {
    if (a === ram[0x0a]) break;
    ram[0x0a]--;
    x = (x - 1) & 0xff;
    if (x >= 0x80) return a; // BMI L16AF0_Exit
  }
  const prim = table(bus.rom, 'TileObjectPrimarySquaresOW').byte(x);
  ram[RoomTileObjType] = table(bus.rom, 'TileObjectTypes').byte(x);
  ram[RoomTileObjX] = (ram[0x06] << 4) & 0xff;
  ram[RoomTileObjY] = (((ram[0x07] << 4) & 0xff) + 0x40) & 0xff;
  return prim;
}

/**
 * WriteSquareOW (Z_05): A = primary square, Y = offset from [$00:01], [$0D] = square index.
 * Index >= $10: tiles A..A+3; else the 4 tiles of SecondarySquaresOW[index * 4].
 */
export function WriteSquareOW(a, y) {
  // WriteSquareOW (Z_05)
  const p = word(0x00);
  let x = ram[0x0d];
  if (x >= 0x10) {
    x = a;
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
    // @WriteType3
    const sec = table(bus.rom, 'SecondarySquaresOW');
    x = (x << 2) & 0xff;
    write(p + y, sec.byte(x));
    y++;
    x++;
    write(p + y, sec.byte(x));
    y = (y + 0x15) & 0xff;
    x++;
    write(p + y, sec.byte(x));
    x++;
    a = sec.byte(x);
  }
  // @WriteLastTile
  y = (y + 1) & 0xff;
  write(p + y, a);
  return a;
}

/** CheckShortcut (Z_05): if the room's shortcut was seen but not found, writes stairs at its place. */
export function CheckShortcut() {
  // CheckShortcut (Z_05)
  let a = GetRoomFlags();
  let y = ram[RoomId]; // Y returned by GetRoomFlags
  if (a & 0x80) return; // ASL / BCS @Exit
  if (!(read(word(0x00) + y) & 0x20)) return;
  FetchTileMapAddr();
  const r = GetShortcutOrItemXY();
  a = r.a;
  y = r.y;
  const x = a >> 2;
  const cols = table(bus.rom, 'PlayAreaColumnAddrs');
  ram[0x00] = cols.byte(x);
  ram[0x01] = cols.byte(x + 1);
  y = ((y - 0x40) & 0xff) >> 3;
  a = read(word(0x00) + y);
  let stairs = true;
  if (a === 0xc4) stairs = true;
  else if (a === 0xbc) return;
  else if (a !== 0xd8) stairs = true;
  else if (ram[RoomTileObjType] === 0x62) stairs = true;
  else {
    // Unverified in the asm (16BAF): no tile object and a black square.
    ram[RoomTileObjType] = 0x00;
    a = 0x0c;
    ram[0x0d] = a;
    stairs = false;
  }
  if (stairs) {
    // @WriteStairs
    ram[0x0d] = 0x10;
    a = 0x70;
  }
  WriteSquareOW(a, y);
}
