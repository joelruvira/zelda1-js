// P06 movement — room bounds (Z_01, Z_05): stop movement that would leave the room's walkable area.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjX, ObjY, ObjType, RoomBoundLeft, RoomBoundRight, RoomBoundUp, RoomBoundDown, CurLevel, DoorwayDir,
} from '../../core/vars.js';
import { ResetMovingDir } from './walker.js';

/** Objects whose bounds are checked on their far side too: slots >= $D (weapons/items) or type $5C. */
function usesExtent(x, r0, r1, rl, r2) {
  if ($br(r0, x === 0)) return false;
  if ($br(r1, x >= 0x0d)) return true;
  $pxa(rl, ObjType, x);
  return !$br(r2, ram[ObjType + x] !== 0x5c);
}

/**
 * BoundDirectionHorizontally (Z_01). X = object, [0F] = direction.
 * Uses [00]. Leaves [0F] = 0 if a horizontal bound was crossed in that direction.
 * @returns Y = direction of the bound checked last (2 left, 1 right)
 */
export function BoundDirectionHorizontally(x) {
  // BoundDirectionHorizontally (Z_01)
  let y = 0x02;
  ram[0x00] = ram[(ObjX + x) & 0xff];
  if (usesExtent(x, 'Z_01:3365', 'Z_01:3370', 'Z_01:3371', 'Z_01:3373')) ram[0x00] = ram[0x00] + 0x0b;
  // @Left
  if ($br('Z_01:3385', ram[0x00] < ram[RoomBoundLeft])) return BoundDirectionReturn(y);
  if (usesExtent(x, 'Z_01:3391', 'Z_01:3393', 'Z_01:3394', 'Z_01:3396')) ram[0x00] = ram[0x00] - 0x17;
  // @Right
  y = 0x01;
  if ($br('Z_01:3409', ram[0x00] < ram[RoomBoundRight])) return y;
  return BoundDirectionReturn(y);
}

/** BoundDirectionReturn (Z_01, part of BoundDirectionHorizontally). Y = bound direction. @returns Y */
function BoundDirectionReturn(y) {
  if (!$br('Z_01:3417', (y & ram[0x0f]) === 0)) ResetMovingDir(); // JMP ResetMovingDir
  return y; // L6825_Exit
}

/**
 * BoundDirectionVertically (Z_01). X = object, [0F] = direction.
 * Uses [00]. Leaves [0F] = 0 if a vertical bound was crossed in that direction.
 * @returns Y = direction of the bound checked last (8 up, 4 down)
 */
export function BoundDirectionVertically(x) {
  // BoundDirectionVertically (Z_01)
  let y = 0x08;
  ram[0x00] = ram[(ObjY + x) & 0xff];
  if (usesExtent(x, 'Z_01:3433', 'Z_01:3438', 'Z_01:3439', 'Z_01:3441')) ram[0x00] = ram[0x00] + 0x0f;
  // @Up
  if ($br('Z_01:3453', ram[0x00] < ram[RoomBoundUp])) return BoundDirectionReturn(y);
  if (usesExtent(x, 'Z_01:3459', 'Z_01:3461', 'Z_01:3462', 'Z_01:3464')) ram[0x00] = ram[0x00] - 0x21;
  // @Down
  y = 0x04;
  if ($br('Z_01:3477', ram[0x00] >= ram[RoomBoundDown])) return BoundDirectionReturn(y);
  return y; // L6825_Exit
}

/**
 * BoundByRoomWithA (Z_01). A = direction, X = object.
 * @returns A = [0F] = direction, or 0 if a bound was crossed (Z flag of the original)
 */
export function BoundByRoomWithA(a, x) {
  // BoundByRoomWithA (Z_01)
  ram[0x0f] = a;
  return BoundByRoom(x); // falls through
}

/**
 * BoundByRoom (Z_01). X = object, [0F] = direction.
 * @returns A = [0F] = direction, or 0 if a bound was crossed (Z flag of the original)
 */
export function BoundByRoom(x) {
  // BoundByRoom (Z_01)
  BoundDirectionHorizontally(x);
  BoundDirectionVertically(x);
  return ram[0x0f];
}

/** SetupObjRoomBounds (Z_05): copy the OW or UW object bounds (and first unwalkable tile). @returns X = 5 */
export function SetupObjRoomBounds() {
  // SetupObjRoomBounds (Z_05)
  const bounds = table(bus.rom, 'ObjectRoomBoundsOW'); // UW set follows at +5
  let y = 0x05;
  if (!$br('Z_05:6447', ram[CurLevel] !== 0)) {
    y = 0x00;
    ram[DoorwayDir] = y;
  }
  let x = 0;
  do {
    $pxa('Z_05:6455', bounds.addr, y);
    ram[RoomBoundLeft + x] = bounds.byte(y);
    y++;
    x++;
  } while ($br('Z_05:6460', x !== 0x05));
  return x;
}
