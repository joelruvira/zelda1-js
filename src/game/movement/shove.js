// P06 movement — shoving (Z_07): knockback of Link and monsters, 4 pixels per frame.

import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjShoveDir, ObjShoveDistance, ObjDir, ObjGridOffset, ObjType, ObjX, ObjY, ObjectFirstUnwalkableTile,
} from '../../core/vars.js';
import { GetOppositeDir } from './math.js';
import { EnsureObjectAligned, GetCollidingTileMoving } from './tiles.js';
import { BoundByRoomWithA } from './bounds.js';
import { CheckPersonBlocking } from '../npc/uwperson.js';

/** Obj_Shove (Z_07). X = object being shoved. */
export function Obj_Shove(x) {
  // Obj_Shove (Z_07)
  const SD = (ObjShoveDir + x) & 0xff; // zp,X
  let a = ram[SD];
  if ($br('Z_07:2328', !(a & 0x80))) {
    // @MoveIfNotDone
    if ($br('Z_07:2378', ram[(ObjShoveDistance + x) & 0xff] !== 0)) return ShoveMoveMin(x);
    return ResetShoveInfo(x); // falls through
  }
  // First call for this shove: clear the high bit (ASL / LSR).
  a &= 0x7f;
  ram[SD] = a;
  if ($br('Z_07:2338', ram[(ObjDir + x) & 0xff] < 0x03)) {
    // @FacingHorizontally: a horizontal shove is fine.
    if (!$br('Z_07:2371', (a & 0x0c) !== 0)) return;
  } else if ($br('Z_07:2344', (a & 0x03) === 0)) {
    return; // facing vertically, vertical shove: fine
  }
  // @CheckPerpendicularShove: allowed if grid offset = 0.
  $pxa('Z_07:2348', ObjGridOffset, x);
  if ($br('Z_07:2349', ram[ObjGridOffset + x] === 0)) return;
  if ($br('Z_07:2355', x !== 0)) return ResetShoveInfo(x);
  // Link: shove opposite to the facing direction. (Unverified code 1EED3.)
  ram[ObjShoveDir] = GetOppositeDir(ram[ObjDir]).a;
}

/** ResetShoveInfo (Z_07). X = object. @returns A = 0 */
export function ResetShoveInfo(x) {
  // ResetShoveInfo (Z_07)
  return SetShoveInfoWith0(0x00, x); // falls through
}

/** SetShoveInfoWith0 (Z_07). A = 0, X = object. @returns A */
export function SetShoveInfoWith0(a, x) {
  // SetShoveInfoWith0 (Z_07)
  // STA zp,X: wraps inside page 0 (only an out-of-range X reaches it; battery: P22 Ganon_CheckCollisions
  // with X = a random CurObjIndex, seed 1 case 1780).
  ram[(ObjShoveDir + x) & 0xff] = a;
  ram[(ObjShoveDistance + x) & 0xff] = a;
  return a;
}

/** ShoveMoveMin (Z_07, part of Obj_Shove): move up to 4 pixels; [03] is the counter, [02] the step. */
function ShoveMoveMin(x) {
  const SD = (ObjShoveDir + x) & 0xff; // zp,X
  ram[0x03] = 0x04;
  do {
    // @LoopShovePixel
    $pxa('Z_07:2405', ObjGridOffset, x);
    if (!$br('Z_07:2406', ram[ObjGridOffset + x] !== 0)) {
      EnsureObjectAligned(x);
      ram[0x0f] = ram[SD] & 0x0f;
      if ($br('Z_07:2413', GetCollidingTileMoving(x) >= ram[ObjectFirstUnwalkableTile])) return ResetShoveInfo(x);
    }
    // @CheckBoundary
    if ($br('Z_07:2421', BoundByRoomWithA(ram[SD] & 0x0f, x) === 0)) return ResetShoveInfo(x);
    const t = ram[ObjType + 1];
    if ($br('Z_07:2428', t === 0x36) || (!$br('Z_07:2430', t < 0x4b) && !$br('Z_07:2432', t >= 0x53))) {
      // @CheckBlocked: grumble or a person in the room.
      CheckPersonBlocking();
      if ($br('Z_07:2437', ram[0x0f] === 0)) return ResetShoveInfo(x);
    }
    // @ChooseSpeed
    ram[0x02] = $br('Z_07:2445', (ram[SD] & 0x05) !== 0) ? 0x01 : 0xff;
    ram[(ObjShoveDistance + x) & 0xff]--;
    $pxa('Z_07:2455', ObjGridOffset, x);
    const g = (ram[ObjGridOffset + x] + ram[0x02]) & 0xff;
    ram[ObjGridOffset + x] = g;
    if ($br('Z_07:2463', (g & 0x0f) === 0) || (!$br('Z_07:2465', x !== 0) && !$br('Z_07:2467', (g & 0x07) !== 0))) {
      ram[ObjGridOffset + x] = 0x00; // @SetGridOffset (A = 0 on both paths)
    }
    // @ApplySpeed
    if (!$br('Z_07:2476', (ram[SD] & 0x03) === 0)) {
      ram[(ObjX + x) & 0xff] = ram[(ObjX + x) & 0xff] + ram[0x02];
    } else {
      ram[(ObjY + x) & 0xff] = ram[(ObjY + x) & 0xff] + ram[0x02]; // @AddToY
    }
    // @NextShovePixel
    ram[0x03]--;
  } while ($br('Z_07:2493', ram[0x03] !== 0));
}
