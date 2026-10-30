// P06 movement — tile collision (Z_07): which play-area tile an object touches, grid alignment.

import { ram, word } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import { ObjGridOffset, ObjX, ObjY, ObjCollidedTile, CurLevel, RoomId } from '../../core/vars.js';

/**
 * EnsureObjectAligned (Z_07). X = object. If grid offset = 0, snap X to a multiple of 8 and
 * Y to (multiple of 8) | 5.
 */
export function EnsureObjectAligned(x) {
  // EnsureObjectAligned (Z_07)
  $pxa('Z_07:2124', ObjGridOffset, x);
  if ($br('Z_07:2125', ram[ObjGridOffset + x] !== 0)) return; // L1EDEA_Exit
  ram[(ObjX + x) & 0xff] = ram[(ObjX + x) & 0xff] & 0xf8;
  ram[(ObjY + x) & 0xff] = (ram[(ObjY + x) & 0xff] & 0xf8) | 0x05;
}

/** GetCollidableTileStill (Z_07). X = object. [0F] = 0. @returns A = tile ([049E][X] = tile) */
export function GetCollidableTileStill(x) {
  // GetCollidableTileStill (Z_07)
  const y = 0x00;
  ram[0x0f] = y;
  $br('Z_07:2151', true); // BEQ GetCollidableTile (always)
  return GetCollidableTile(x, y);
}

/** GetCollidingTileMoving (Z_07). X = object, [0F] = direction. @returns A = tile ([049E][X] = tile) */
export function GetCollidingTileMoving(x) {
  // GetCollidingTileMoving (Z_07)
  let y = $br('Z_07:2164', x === 0) ? 0xf8 : 0xf0; // hotspot offset -8 for Link, -$10 for others
  const a = ram[0x0f] & 0x05;
  if ($br('Z_07:2171', a === 0)) return GetCollidableTile(x, y); // up, left or none
  y = 0x08; // down
  if ($br('Z_07:2177', (a & 0x04) !== 0)) return GetCollidableTile(x, y);
  y = 0x10; // right
  return GetCollidableTile(x, y); // falls through
}

/**
 * GetCollidableTile (Z_07). X = object, Y = offset from the hotspot, [0F] = direction or 0.
 * Uses [00:01] (column address) and [04]. In OW, walkable tiles become $26.
 * @returns A = tile ([049E][X] = tile)
 */
export function GetCollidableTile(x, y) {
  // GetCollidableTile (Z_07)
  ram[0x04] = y;
  y = (ram[(ObjY + x) & 0xff] + 0x0b) & 0xff; // $B pixels down from the top of the object
  let pushed = y; // PHA
  let col;
  if (!$br('Z_07:2200', (ram[0x0f] & 0x0c) === 0)) {
    // Vertical direction: adjust Y unless moving down with Y >= $DD.
    if ($br('Z_07:2202', (ram[0x0f] & 0x04) === 0) || !$br('Z_07:2204', y >= 0xdd)) {
      pushed = (pushed + ram[0x04]) & 0xff; // @AdjustY
    }
    col = ram[(ObjX + x) & 0xff]; // @AsIsX
  } else {
    // @AdjustX: horizontal direction or 0.
    col = ram[(ObjX + x) & 0xff];
    if (!$br('Z_07:2225', (ram[0x0f] & 0x01) === 0)) {
      if (!$br('Z_07:2227', col >= 0xf0)) {
        $br('Z_07:2228', true); // BCC @AddHotspotOffset (always)
        col = (col + ram[0x04]) & 0xff;
      }
    } else if (!$br('Z_07:2232', col < 0x10)) {
      col = (col + ram[0x04]) & 0xff; // @AddHotspotOffset
    }
  }
  // @FetchTile
  const ci = (col & 0xf8) >> 2;
  const cols = table(bus.rom, 'PlayAreaColumnAddrs');
  ram[0x00] = cols.byte(ci);
  $pxa('Z_07:2250', cols.addr + 1, ci);
  ram[0x01] = cols.byte(ci + 1);
  let row = ((pushed - 0x40) & 0xff) >> 3; // PLA, minus the status bar, / 8
  $pxa('Z_07:2259', word(0x00), row);
  ram[ObjCollidedTile + x] = read((word(0x00) + row) & 0xffff);
  if (!$br('Z_07:2263', (ram[0x0f] & 0x0c) === 0)) {
    // Vertical: also check the next column; keep the greater tile (blocking tiles sort last).
    row = (row + 0x16) & 0xff;
    $pxa('Z_07:2272', word(0x00), row);
    const t = read((word(0x00) + row) & 0xffff);
    $pxa('Z_07:2273', ObjCollidedTile, x);
    if (!$br('Z_07:2274', t < ram[ObjCollidedTile + x])) ram[ObjCollidedTile + x] = t;
  }
  // @CheckWalkable
  $pxa('Z_07:2278', ObjCollidedTile, x);
  if ($br('Z_07:2280', ram[CurLevel] !== 0)) return ram[ObjCollidedTile + x]; // UW: @Exit
  $pxa('Z_07:2284', ObjCollidedTile, x);
  let a = ram[ObjCollidedTile + x];
  const walkable = table(bus.rom, 'WalkableTiles');
  for (let i = 0x09; ;) {
    i--;
    if ($br('Z_07:2289', i < 0)) break; // @SetTile
    $pxa('Z_07:2290', walkable.addr, i);
    if ($br('Z_07:2291', a !== walkable.byte(i))) continue;
    a = 0x26;
    break;
  }
  // @SetTile
  ram[ObjCollidedTile + x] = a;
  if (!$br('Z_07:2299', x !== 0) && !$br('Z_07:2302', ram[RoomId] !== 0x1f)
    && !$br('Z_07:2305', (ram[0x0f] & 0x0c) === 0)
    && !$br('Z_07:2310', ram[ObjX] !== 0x80) && !$br('Z_07:2313', ram[ObjY] >= 0x56)) {
    ram[ObjCollidedTile] = 0x26; // false wall in OW room $1F
  }
  $pxa('Z_07:2318', ObjCollidedTile, x);
  return ram[ObjCollidedTile + x]; // @ReturnTile
}
