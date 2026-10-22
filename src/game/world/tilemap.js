// Play area tile map (PlayAreaTiles $6530-$67EF, $16 tiles per column) and its transfer to the
// nametables: fill, row/column copies to DynTileBuf, changing one square. Package P12.
// Banks 1 (MapScreenPosToPpuAddr, WRAM code), 5 and 7.

import { ram, cpu, word } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { switchBank } from '../../core/asm.js';
import {
  ObjX, ObjY, DynTileBuf, DynTileBufLen, ReturnToBank4, CurColumn, CurRow, GameSubmode,
} from '../../core/vars.js';
import { AddToInt16At0, Add1ToInt16At0 } from '../util/int16.js';
import { WriteSquareOW } from './overworld.js';

/**
 * MapScreenPosToPpuAddr (Z_01, WRAM): [$02] = Y, [$03] = X.
 * Writes [$00] = high, [$01] = low byte of the nametable 0 address of that screen position.
 */
export function MapScreenPosToPpuAddr() {
  // MapScreenPosToPpuAddr (Z_01)
  ram[0x00] = 0x08;
  let a = ram[0x02];
  a = cpu.asl(a);
  cpu.rolMem(0x00);
  a = cpu.asl(a);
  cpu.rolMem(0x00);
  ram[0x01] = a & 0xe0;
  a = ram[0x03] >> 3;
  ram[0x01] = a | ram[0x01];
  return ram[0x01];
}

/**
 * ChangeTileObjTiles (Z_07): A = first tile, X = object index, [F7] ReturnToBank4.
 * Queues the 2x2 square at the object's position in DynTileBuf and changes the play area map.
 * @returns A = 0
 */
export function ChangeTileObjTiles(a, x) {
  // ChangeTileObjTiles (Z_07)
  ram[0x05] = a;
  const saved = x; // PHA
  ram[0x03] = ram[ObjX + x];
  ram[0x02] = ram[ObjY + x];
  MapScreenPosToPpuAddr();
  x = ram[DynTileBufLen];
  ram[DynTileBuf + x] = ram[0x00];
  ram[DynTileBuf + 5 + x] = ram[0x00];
  ram[DynTileBuf + 1 + x] = ram[0x01];
  ram[DynTileBuf + 6 + x] = ram[0x01];
  ram[DynTileBuf + 6 + x]++;
  a = ram[0x05];
  ram[DynTileBuf + 3 + x] = a;
  ram[DynTileBuf + 4 + x] = a;
  ram[DynTileBuf + 8 + x] = a;
  ram[DynTileBuf + 9 + x] = a;
  if (a >= 0x46 && a < 0xf3) {
    a = (a + 0x02) & 0xff; // CLC / ADC #$02
    ram[DynTileBuf + 8 + x] = a;
    ram[DynTileBuf + 9 + x] = a;
    ram[DynTileBuf + 4 + x]++;
    ram[DynTileBuf + 9 + x]++;
  }
  // @SetCountBytes
  ram[DynTileBuf + 2 + x] = 0x82;
  ram[DynTileBuf + 7 + x] = 0x82;
  ram[DynTileBuf + 10 + x] = 0xff;
  ram[DynTileBufLen] = (x + 0x0a) & 0xff;
  x = saved; // PLA / TAX
  switchBank(5);
  ChangePlayMapSquareOW(x);
  if (ram[ReturnToBank4] !== 0) switchBank(4);
  ram[ReturnToBank4] = 0;
  return 0;
}

/** FillTileMap (Z_07): fills PlayAreaTiles $6530-$67EF with the tile in [$0A]. */
export function FillTileMap() {
  // FillTileMap (Z_07)
  switchBank(5);
  FetchTileMapAddr();
  const y = 0;
  do {
    write(word(0x00) + y, ram[0x0a]);
    Add1ToInt16At0();
  } while (ram[0x00] !== 0xf0 || ram[0x01] !== 0x67);
  return 0x67;
}

/** FetchTileMapAddr (Z_05): [$00:01] = $6530 (PlayAreaTiles). */
export function FetchTileMapAddr() {
  // FetchTileMapAddr (Z_05)
  ram[0x00] = 0x30;
  ram[0x01] = 0x65;
  return 0x65;
}

/**
 * ChangePlayMapSquareOW (Z_05): X = object index, [$05] = primary square/tile.
 * Writes the square at the object's (16-pixel aligned) position into the play area map.
 * @returns X (object index, preserved)
 */
export function ChangePlayMapSquareOW(x) {
  // ChangePlayMapSquareOW (Z_05)
  const saved = x; // PHA
  const cols = table(bus.rom, 'PlayAreaColumnAddrs');
  let a = ram[ObjX + x] & 0xf0;
  x = a >> 2;
  ram[0x00] = cols.byte(x);
  ram[0x01] = cols.byte(x + 1);
  x = saved;
  a = ram[ObjY + x] & 0xf0;
  a = ((a - 0x40) & 0xff) >> 3; // SEC / SBC #$40 / LSR x3
  AddToInt16At0(a);
  const y = 0;
  x = 0x10;
  a = ram[0x05];
  if (a < 0x27 || a >= 0xf3) {
    const prim = table(bus.rom, 'PrimarySquaresOW');
    x = 0x0e;
    do {
      if (a === prim.byte(x)) break;
      x--;
    } while (x !== 0);
  }
  // @Write
  ram[0x0d] = x;
  WriteSquareOW(a, y);
  return saved;
}

/**
 * CopyColumnToTileBuf (Z_05): CurColumn = target column + 1.
 * Appends a vertical transfer record of the $16 tiles of that play area column to DynTileBuf.
 */
export function CopyColumnToTileBuf() {
  // CopyColumnToTileBuf (Z_05)
  ram[0x00] = 0x1a;
  ram[0x01] = 0x65;
  let x = (ram[CurColumn] - 1) & 0xff;
  let y = ram[DynTileBufLen];
  ram[DynTileBuf + 1 + y] = x;
  ram[DynTileBuf + y] = 0x21;
  do {
    AddToInt16At0(0x16);
    x = (x - 1) & 0xff;
  } while (x < 0x80);
  ram[DynTileBuf + 2 + y] = 0x96;
  ram[DynTileBuf + 25 + y] = x;
  x = y;
  y = 0;
  ram[0x06] = 0;
  do {
    ram[DynTileBuf + 3 + x] = read(word(0x00) + y);
    Add1ToInt16At0();
    x = (x + 1) & 0xff;
    ram[0x06]++;
  } while (ram[0x06] < 0x16);
  x = (x + 3) & 0xff;
  ram[DynTileBufLen] = x;
}

/** CopyRowToTileBuf (Z_05): puts the tile row CurRow of the play area in DynTileBuf (32 tiles). */
export function CopyRowToTileBuf() {
  // CopyRowToTileBuf (Z_05)
  ram[0x01] = 0x65;
  let x = ram[CurRow];
  const sum = x + 0x30;
  ram[0x00] = sum & 0xff;
  if (sum > 0xff) ram[0x01]++; // unverified in the asm (16932)
  ram[DynTileBuf] = 0x20;
  ram[DynTileBuf + 1] = 0xe0;
  do {
    // @Add20H
    const s = ram[DynTileBuf + 1] + 0x20;
    ram[DynTileBuf + 1] = s;
    if (s > 0xff) ram[DynTileBuf]++;
    x = (x - 1) & 0xff;
  } while (x < 0x80);
  ram[DynTileBuf + 2] = 0x20;
  ram[DynTileBuf + 35] = x;
  x = 0;
  const y = 0;
  do {
    ram[DynTileBuf + 3 + x] = read(word(0x00) + y);
    AddToInt16At0(0x16);
    x++;
  } while (x < 0x20);
  ram[DynTileBufLen] = 0x23;
  return 0x23;
}

/**
 * CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone (Z_05): after the last row, INC GameSubmode.
 * @returns C (also in cpu.c): 1 if copied the last row
 */
export function CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone() {
  // CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone (Z_05)
  const c = CopyNextRowToTransferBuf();
  if (c) ram[GameSubmode]++; // BCS to LayoutRoom_SubmodeTask's INC GameSubmode
  return c;
}

/**
 * CopyNextRowToTransferBuf (Z_05)
 * @returns C (also in cpu.c): 1 if copied the last row (CurRow reached $16)
 */
export function CopyNextRowToTransferBuf() {
  // CopyNextRowToTransferBuf (Z_05)
  CopyRowToTileBuf();
  ram[CurRow]++;
  cpu.cmp(ram[CurRow], 0x16);
  return cpu.c;
}
