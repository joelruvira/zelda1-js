// Submenu rows while it scrolls in (static buffers, black rows) and the UW sheet map built room by
// room; compass/map checks (Z_05). Package P11.

import { ram, peek, word } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  SubmenuScrollProgress, TileBufSelector, DynTileBuf, CurScanRoomId, LevelInfo_SubmenuMapRotation,
  LevelInfo_SubmenuMapMask, CurLevel, Items, RoomId, OpenDoorwayMask,
} from '../../core/vars.js';
import { GetRoomFlags } from '../world/roomflags.js';
import { FindDoorTypeByDoorBit, CalcOpenDoorwayMask } from '../world/doors.js';

const regA = (r) => (typeof r === 'object' && r !== null ? r.a : r);

// ------------------------------------------------------------------ rows of the submenu

/** Submenu_CueTransferRowUW (Z_05): one submenu row per two frames while scrolling down (UW). */
export function Submenu_CueTransferRowUW() {
  // Submenu_CueTransferRowUW (Z_05)
  let a = ram[SubmenuScrollProgress];
  if ($br('Z_05:6810', (a & 0x80) !== 0)) return; // L1725A_Exit: everything transferred
  const black = a & 0x01;
  a >>= 1; // submenu row
  const y = a;
  if ($br('Z_05:6820', black !== 0)) return PrepFullBlackRow(y);
  if (!$br('Z_05:6828', a >= 0x0d)) {
    $pxa('Z_05:6829', table(bus.rom, 'SubmenuTransferBufSelectorsUW').addr, y);
    return SelectTransferBufAndDecCounter(table(bus.rom, 'SubmenuTransferBufSelectorsUW').byte(y));
  }
  if (!$br('Z_05:6837', a !== 0x15)) return SelectTransferBufAndDecCounter(0x42); // bottom edge of the sheet map
  Submenu_WriteSheetMapRowTransferRecord(); // rows $D..$14: the map
  return DecSubmenuScroll(); // falls through
}

/** DecSubmenuScroll (Z_05) */
export function DecSubmenuScroll() {
  // DecSubmenuScroll (Z_05)
  ram[SubmenuScrollProgress]--;
}

/** PrepFullBlackRow (part of Submenu_CueTransferRowUW, Z_05): Y = row; $20 blank tiles at $28E0 + Y*$20. */
function PrepFullBlackRow(y) {
  ram[DynTileBuf] = 0x28;
  let a = 0xc0;
  do {
    a += 0x20;
    if (!$br('Z_05:6863', a <= 0xff)) {
      a &= 0xff;
      ram[DynTileBuf]++;
    }
    y = (y - 1) & 0xff;
  } while ($br('Z_05:6867', (y & 0x80) === 0));
  ram[DynTileBuf + 1] = a;
  ram[DynTileBuf + 2] = 0x60; // repeat one byte $20 times
  ram[DynTileBuf + 3] = 0x24; // blank tile
  ram[DynTileBuf + 4] = 0xff;
  return DecSubmenuScroll();
}

/** Submenu_CueTransferRowOW (Z_05): OW version (triforce rows instead of the map). */
export function Submenu_CueTransferRowOW() {
  // Submenu_CueTransferRowOW (Z_05)
  let a = ram[SubmenuScrollProgress];
  if ($br('Z_05:6883', (a & 0x80) !== 0)) return; // L17295_Exit
  const black = a & 0x01;
  a >>= 1;
  const y = a;
  if ($br('Z_05:6893', black !== 0)) return PrepFullBlackRow(y);
  if (!$br('Z_05:6899', a >= 0x15)) {
    $pxa('Z_05:6900', table(bus.rom, 'SubmenuTransferBufSelectorsOW').addr, y);
    return SelectTransferBufAndDecCounter(table(bus.rom, 'SubmenuTransferBufSelectorsOW').byte(y));
  }
  ram[SubmenuScrollProgress]--; // nothing to transfer for row $15
}

/** SelectTransferBufAndDecCounter (Z_05): A = TileBufSelector. */
export function SelectTransferBufAndDecCounter(a) {
  // SelectTransferBufAndDecCounter (Z_05)
  ram[TileBufSelector] = a;
  ram[SubmenuScrollProgress]--;
}

// ------------------------------------------------------------------ UW sheet map

/**
 * Submenu_WriteSheetMapRowTransferRecord (Z_05): one row of the big UW map: $10 map marks of rooms
 * CurScanRoomId down to CurScanRoomId-$F, rotated by LevelInfo_SubmenuMapRotation and masked with
 * LevelInfo_SubmenuMapMask.
 */
export function Submenu_WriteSheetMapRowTransferRecord() {
  // Submenu_WriteSheetMapRowTransferRecord (Z_05)
  let y = 0x10;
  let x = ram[SubmenuScrollProgress] >> 1; // submenu row
  ram[DynTileBuf + 3 + y] = 0xff;
  ram[DynTileBuf + 2] = 0x10;
  // PPU address $290C + X*$20
  ram[DynTileBuf] = 0x28;
  let a = 0xec;
  do {
    a += 0x20;
    if (!$br('Z_05:7584', a <= 0xff)) {
      a &= 0xff;
      ram[DynTileBuf]++;
    }
    x = (x - 1) & 0xff;
  } while ($br('Z_05:7588', (x & 0x80) === 0));
  ram[DynTileBuf + 1] = a;
  const scan = ram[CurScanRoomId]; // PHA
  do {
    Submenu_WriteScanningMapRoomMark(y);
    ram[CurScanRoomId]--;
    y--;
  } while ($br('Z_05:7599', y !== 0));
  ram[CurScanRoomId] = (scan - 0x10) & 0xff;
  // @Rotate right by LevelInfo_SubmenuMapRotation bytes.
  for (x = peek(LevelInfo_SubmenuMapRotation); !$br('Z_05:7613', x === 0); x = (x - 1) & 0xff) {
    const last = ram[DynTileBuf + 18];
    for (y = 0x0e; ;) {
      $pxa('Z_05:7618', DynTileBuf + 3, y);
      ram[DynTileBuf + 4 + y] = ram[DynTileBuf + 3 + y];
      y--; if (!$br('Z_05:7621', y >= 0)) break;
    }
    ram[DynTileBuf + 3] = last;
  }
  // @DoneRotate: blank ($F5) the rooms outside the level. Map row = progress/2 - $D.
  x = ((ram[SubmenuScrollProgress] - 0x1a) & 0xff) >> 1;
  const masks = table(bus.rom, 'MapRowMasks');
  for (y = 0x0f; ;) {
    $pxa('Z_05:7644', LevelInfo_SubmenuMapMask, y);
    $pxa('Z_05:7645', masks.addr, x);
    if (!$br('Z_05:7646', (peek(LevelInfo_SubmenuMapMask + y) & masks.byte(x)) !== 0)) ram[DynTileBuf + 3 + y] = 0xf5;
    y--; if (!$br('Z_05:7651', y >= 0)) break;
  }
}

/** HasCompass (Z_05): returns A = 0 if the compass of the current level is missing (Z flag). */
export function HasCompass() {
  // HasCompass (Z_05)
  $br('Z_05:7659', true);
  return hasLevelItem(0x10);
}

/** HasMap (Z_05): returns A = 0 if the map of the current level is missing (Z flag). */
export function HasMap() {
  // HasMap (Z_05)
  return hasLevelItem(0x11);
}

function hasLevelItem(x) {
  let a = ram[CurLevel];
  if ($br('Z_05:7668', a === 0)) return a; // @Exit: OW
  a = (a - 1) & 0xff; // zero-based level
  if (!$br('Z_05:7672', a < 0x08)) x += 2; // level 9: InvCompass9 / InvMap9
  const y = a & 0x07;
  $pxa('Z_05:7678', Items, x);
  $pxa('Z_05:7679', table(bus.rom, 'LevelMasks').addr, y);
  return ram[Items + x] & table(bus.rom, 'LevelMasks').byte(y);
}

/**
 * Submenu_WriteScanningMapRoomMark (Z_05): Y = offset (1..$10) from DynTileBuf+2. Writes the map
 * mark of room CurScanRoomId: $F5 if not visited, else $E2 + its open doorway mask.
 */
export function Submenu_WriteScanningMapRoomMark(y) {
  // Submenu_WriteScanningMapRoomMark (Z_05)
  const savedY = y; // TYA / PHA
  GetRoomFlags(); // only for [$00:01] = level block world flags
  const savedRoom = ram[RoomId]; // PHA
  ram[RoomId] = ram[CurScanRoomId];
  ram[OpenDoorwayMask] = 0x13; // + $E2 = $F5, the blank mark
  y = ram[RoomId];
  $pxa('Z_05:7708', ram[0x00], y);
  if (!$br('Z_05:7715', (read((word(0x00) + y) & 0xffff) & 0x20) === 0)) {
    // Visited: build the open doorway mask from the 4 doors (up first, index 3).
    ram[0x02] = 0x08;
    let x = 0x03;
    do {
      const a = regA(FindDoorTypeByDoorBit());
      CalcOpenDoorwayMask(a, x);
      x = (x - 1) & 0xff;
      ram[0x02] >>= 1;
    } while ($br('Z_05:7724', ram[0x02] !== 0));
  }
  ram[RoomId] = savedRoom;
  y = savedY;
  ram[DynTileBuf + 2 + y] = (ram[OpenDoorwayMask] + 0xe2) & 0xff;
}
