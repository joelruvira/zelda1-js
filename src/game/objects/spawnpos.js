// P05 objects — where the objects of a room spawn (Z_05): the spawn lists by Link's direction,
// the cellar keese, the cave dweller type, "monsters from the edges" cells and the safety checks.

import { ram, cpu, peek, word } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  RoomObjCount, CurLevel, LevelBlockAttrsByteF, ObjDir, SpawnCycle, ObjX, ObjY, GameMode, ObjType,
  RoomId, LevelBlockAttrsB, ObjCollidedTile, ObjectFirstUnwalkableTile, CurEdgeSpawnCell,
} from '../../core/vars.js';
import { GetCollidableTileStill } from '../movement/tiles.js';
import { Abs } from '../movement/math.js';
import { FetchTileMapAddr } from '../world/tilemap.js';
import { AddToInt16At0 } from '../util/int16.js';

/**
 * AssignObjSpawnPositions (Z_05, bank 5 mapped). [02] = object template ID.
 * Assigns spawn coordinates to objects 1-9 from the spawn list for Link's direction; in mode 9 makes
 * 4 blue keese; in caves (modes $B/$C) clears slots 1-8 and sets the cave dweller type in slot 1.
 */
export function AssignObjSpawnPositions() {
  // AssignObjSpawnPositions (Z_05)
  let y = ram[RoomObjCount];
  let a = ram[0x02];
  // 0 or Zelda: no normal objects; from the edges; no objects
  const normal = !$br('Z_05:1885', a === 0) && !$br('Z_05:1887', a === 0x37)
    && ($br('Z_05:1891', ram[CurLevel] !== 0) || !$br('Z_05:1894', (ram[LevelBlockAttrsByteF] & 0x08) !== 0))
    && !$br('Z_05:1897', ram[RoomObjCount] === 0);
  if (normal) {
    // Index of Link's direction bit.
    a = ram[ObjDir];
    y = 0xff;
    do {
      y = (y + 1) & 0xff;
      a = cpu.lsr(a);
    } while ($br('Z_05:1905', !cpu.c));
    const lo = table(bus.rom, 'SpawnPosListAddrsLo');
    $pxa('Z_05:1908', lo.addr, y);
    ram[0x06] = lo.byte(y);
    const hi = table(bus.rom, 'SpawnPosListAddrsHi');
    $pxa('Z_05:1910', hi.addr, y);
    ram[0x07] = hi.byte(y);
    y = ram[SpawnCycle];
    let x = 0x01;
    do {
      // @LoopSpawnSpot
      $pxa('Z_05:1918', word(0x06), y);
      a = read((word(0x06) + y) & 0xffff);
      ram[(ObjX + x) & 0xff] = (a << 4) & 0xff;
      ram[(ObjY + x) & 0xff] = (a & 0xf0) | 0x0d;
      if (!$br('Z_05:1930', !!IsSafeToSpawn(x))) x++;
      y++;
      if (!$br('Z_05:1935', y < 0x09)) y = 0x00;
    } while ($br('Z_05:1939', x < 0x0a));
    ram[SpawnCycle] = y;
  }
  // @AssignSpecialPositions
  a = ram[GameMode];
  if (!$br('Z_05:1946', a !== 0x09)) {
    const xs = table(bus.rom, 'CellarKeeseXs');
    const ys = table(bus.rom, 'CellarKeeseYs');
    for (let x = 0x03; ;) {
      ram[ObjType + 1 + x] = 0x1b; // blue keese
      $pxa('Z_05:1951', xs.addr, x);
      ram[ObjX + 1 + x] = xs.byte(x);
      $pxa('Z_05:1953', ys.addr, y);
      ram[ObjY + 1 + x] = ys.byte(y); // the original indexes the Ys with Y, not X
      x--;
      if (!$br('Z_05:1956', x >= 0)) break;
    }
    return;
  }
  // @CheckCaves
  if (!$br('Z_05:1962', a === 0x0b) && $br('Z_05:1964', a !== 0x0c)) return;
  for (let x = 0x07; ;) {
    ram[ObjType + 1 + x] = 0x00;
    x--;
    if (!$br('Z_05:1974', x >= 0)) break;
  }
  // cave dweller type = $6A + ((cave attribute) - $40) / 4
  $pxa('Z_05:1978', LevelBlockAttrsB, ram[RoomId]);
  a = peek(LevelBlockAttrsB + ram[RoomId]) & 0xfc;
  a = ((a - 0x40) & 0xff) >> 2;
  ram[ObjType + 1] = (a + 0x6a) & 0xff;
}

/** IsSafeToSpawn (Z_05). X = object. @returns C (also in cpu.c): 1 if unsafe (unwalkable or near Link) */
export function IsSafeToSpawn(x) {
  // IsSafeToSpawn (Z_05): the caller's Y is saved and restored around GetCollidableTileStill
  GetCollidableTileStill(x);
  $pxa('Z_05:2005', ObjCollidedTile, x);
  if ($br('Z_05:2007', ram[ObjCollidedTile + x] >= ram[ObjectFirstUnwalkableTile])) return ReturnUnsafeToSpawn();
  return IsDistanceSafeToSpawn(x); // falls through
}

/** IsDistanceSafeToSpawn (Z_05). X = object. @returns C: 1 if closer than $22 to Link on both axes */
export function IsDistanceSafeToSpawn(x) {
  // IsDistanceSafeToSpawn (Z_05)
  if (!$br('Z_05:2022', Abs((ram[ObjX] - ram[(ObjX + x) & 0xff]) & 0xff) >= 0x22)
    && $br('Z_05:2030', Abs((ram[ObjY] - ram[(ObjY + x) & 0xff]) & 0xff) < 0x22)) return ReturnUnsafeToSpawn();
  cpu.c = 0; // walkable
  return 0;
}

/** ReturnUnsafeToSpawn (Z_05, global label inside IsDistanceSafeToSpawn). @returns C = 1 (unsafe) */
export function ReturnUnsafeToSpawn() {
  // ReturnUnsafeToSpawn (Z_05)
  cpu.c = 1;
  return 1;
}

/**
 * FindNextEdgeSpawnCell (Z_05). Starting at CurEdgeSpawnCell (square: row in the high nibble,
 * column in the low one), move counterclockwise around the room's edge until a square whose tile
 * is < $84 (walkable), or back at the start. Leaves [00:01] = column address, [0A] = the cell.
 */
export function FindNextEdgeSpawnCell() {
  // FindNextEdgeSpawnCell (Z_05)
  ram[0x0a] = ram[CurEdgeSpawnCell];
  for (;;) {
    // @LoopEdgeCell
    let y = 0x10;
    let a = ram[0x0a] & 0x0f;
    let leftOrRight = $br('Z_05:3424', a === 0);
    if (!leftOrRight) {
      y = 0xf0;
      leftOrRight = !$br('Z_05:3430', a !== 0x0f);
    }
    if (leftOrRight) ram[0x0a] = (y + ram[0x0a]) & 0xff; // @HandleLeftOrRight
    // @CheckTopOrBottom
    a = ram[0x0a] & 0xf0;
    if (!$br('Z_05:3446', a !== 0xe0)) ram[0x0a]++;
    else if (!$br('Z_05:3453', a !== 0x40)) ram[0x0a]--;
    // @PointToColumn
    FetchTileMapAddr();
    y = ram[0x0a] & 0x0f;
    if (!$br('Z_05:3469', y === 0)) {
      do {
        AddToInt16At0(0x2c);
        y--;
      } while ($br('Z_05:3474', y !== 0));
    }
    // @GetRowOffset
    y = ((ram[0x0a] & 0xf0) - 0x40) & 0xff;
    y >>= 3;
    $pxa('Z_05:3491', word(0x00), y);
    if ($br('Z_05:3493', read((word(0x00) + y) & 0xffff) < 0x84)) break; // LDA ($00),Y through the bus
    if (!$br('Z_05:3499', ram[0x0a] !== ram[CurEdgeSpawnCell])) break;
  }
  // @SetSpawnCell
  ram[CurEdgeSpawnCell] = ram[0x0a];
}
