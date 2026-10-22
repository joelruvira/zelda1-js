// Room layout entry points: LayOutRoom (OW or UW), caves, shortcuts and cellars, the column
// directory patch for cellars and the dark room check. Package P12, bank 5.

import { ram, poke, peek } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { CurLevel, CurRow, GameSubmode, LevelBlockAttrsE } from '../../core/vars.js';
import { FillTileMap } from './tilemap.js';
import { LayoutRoomOW, LayoutRoomOrCaveOW, CheckShortcut } from './overworld.js';
import { FillWalls, LayoutUWFloor } from './underworld.js';
import { LayOutDoors } from './doors-draw.js';
import { AddDoorFlagsToCurOpenedDoors } from './doors.js';
import { GetUniqueRoomId } from './roomflags.js';

/** LayOutRoom (Z_05): lays out the current room (OW or UW) in PlayAreaTiles. */
export function LayOutRoom() {
  // LayOutRoom (Z_05)
  PatchColumnDirectoryForCellar();
  if (ram[CurLevel] === 0) {
    // Is in OW (label inside UpdateMode12EndLevel_Sub4).
    LayoutRoomOW();
    return CheckShortcut();
  }
  // Is in UW: fill with the brick tile of the margins.
  ram[0x0a] = 0xf6;
  FillTileMap();
  AddDoorFlagsToCurOpenedDoors();
  FillWalls();
  LayOutDoors();
  return LayoutUWFloor();
}

/** PatchColumnDirectoryForCellar (Z_05): ColumnDirectoryOW[0] = OW column heap 0 (OW) or the UW cellar heap. */
export function PatchColumnDirectoryForCellar() {
  // PatchColumnDirectoryForCellar (Z_05)
  const heap = table(bus.rom, 'ColumnHeapOWAddr');
  let a = heap.byte(0);
  let x = heap.byte(1);
  if (ram[CurLevel] !== 0) {
    const cellar = label('ColumnHeapUWCellar').addr;
    a = cellar & 0xff;
    x = cellar >> 8;
  }
  const dir = label('ColumnDirectoryOW').addr; // BANK_06_DATA in SRAM
  poke(dir, a);
  poke(dir + 1, x);
}

function layoutSubroomAndAdvanceSubmode(x) {
  // shared tail of LayoutCaveAndAvanceSubmode (the ':' label)
  const addrs = table(bus.rom, 'SubroomLayoutAddrs');
  ram[0x02] = addrs.byte(x);
  ram[0x03] = addrs.byte(x + 1);
  ram[GameSubmode]++;
  return LayoutRoomOrCaveOW();
}

/** LayoutCaveAndAvanceSubmode (Z_05): lays out the usual cave; INC GameSubmode. */
export function LayoutCaveAndAvanceSubmode() {
  // LayoutCaveAndAvanceSubmode (Z_05)
  return layoutSubroomAndAdvanceSubmode(0x00);
}

/** LayoutShortcutAndAdvanceSubmode (Z_05): lays out the shortcut cave; INC GameSubmode. */
export function LayoutShortcutAndAdvanceSubmode() {
  // LayoutShortcutAndAdvanceSubmode (Z_05)
  return layoutSubroomAndAdvanceSubmode(0x02);
}

/** LayoutCellarAndAdvanceSubmode (Z_05): CurRow = 0; lays out the tunnel or treasure cellar. */
export function LayoutCellarAndAdvanceSubmode() {
  // LayoutCellarAndAdvanceSubmode (Z_05)
  ram[CurRow] = 0;
  const a = GetUniqueRoomId();
  return layoutSubroomAndAdvanceSubmode((a & 0x01) === 0 ? 0x04 : 0x06);
}

/** LayoutRoom_SubmodeTask (Z_05): LayOutRoom, CurRow = 0, INC GameSubmode. */
export function LayoutRoom_SubmodeTask() {
  // LayoutRoom_SubmodeTask (Z_05)
  LayOutRoom();
  ram[CurRow] = 0;
  ram[GameSubmode]++;
}

/**
 * IsDarkRoom_Bank5 (Z_05): Y = room ID.
 * @returns A = $80 if dark (UW only), else 0
 */
export function IsDarkRoom_Bank5(y) {
  // IsDarkRoom_Bank5 (Z_05)
  const a = ram[CurLevel];
  if (a === 0) return a;
  return peek(LevelBlockAttrsE + y) & 0x80;
}
