// P06 movement — shoving (Z_07): knockback of Link and monsters, 4 pixels per frame.

import { ram } from '../../core/ram.js';
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
  let a = ram[ObjShoveDir + x];
  if (!(a & 0x80)) {
    // @MoveIfNotDone
    if (ram[ObjShoveDistance + x] !== 0) return ShoveMoveMin(x);
    return ResetShoveInfo(x); // falls through
  }
  // First call for this shove: clear the high bit (ASL / LSR).
  a &= 0x7f;
  ram[ObjShoveDir + x] = a;
  if (ram[ObjDir + x] < 0x03) {
    // @FacingHorizontally: a horizontal shove is fine.
    if ((a & 0x0c) === 0) return;
  } else if ((a & 0x03) === 0) {
    return; // facing vertically, vertical shove: fine
  }
  // @CheckPerpendicularShove: allowed if grid offset = 0.
  if (ram[ObjGridOffset + x] === 0) return;
  if (x !== 0) return ResetShoveInfo(x);
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
  ram[ObjShoveDir + x] = a;
  ram[ObjShoveDistance + x] = a;
  return a;
}

/** ShoveMoveMin (Z_07, part of Obj_Shove): move up to 4 pixels; [03] is the counter, [02] the step. */
function ShoveMoveMin(x) {
  ram[0x03] = 0x04;
  do {
    // @LoopShovePixel
    if (ram[ObjGridOffset + x] === 0) {
      EnsureObjectAligned(x);
      ram[0x0f] = ram[ObjShoveDir + x] & 0x0f;
      if (GetCollidingTileMoving(x) >= ram[ObjectFirstUnwalkableTile]) return ResetShoveInfo(x);
    }
    // @CheckBoundary
    if (BoundByRoomWithA(ram[ObjShoveDir + x] & 0x0f, x) === 0) return ResetShoveInfo(x);
    const t = ram[ObjType + 1];
    if (t === 0x36 || (t >= 0x4b && t < 0x53)) {
      // @CheckBlocked: grumble or a person in the room.
      CheckPersonBlocking();
      if (ram[0x0f] === 0) return ResetShoveInfo(x);
    }
    // @ChooseSpeed
    ram[0x02] = (ram[ObjShoveDir + x] & 0x05) !== 0 ? 0x01 : 0xff;
    ram[ObjShoveDistance + x]--;
    const g = (ram[ObjGridOffset + x] + ram[0x02]) & 0xff;
    ram[ObjGridOffset + x] = g;
    if ((g & 0x0f) === 0 || (x === 0 && (g & 0x07) === 0)) {
      ram[ObjGridOffset + x] = 0x00; // @SetGridOffset (A = 0 on both paths)
    }
    // @ApplySpeed
    if (ram[ObjShoveDir + x] & 0x03) {
      ram[ObjX + x] = ram[ObjX + x] + ram[0x02];
    } else {
      ram[ObjY + x] = ram[ObjY + x] + ram[0x02]; // @AddToY
    }
    // @NextShovePixel
    ram[0x03]--;
  } while (ram[0x03] !== 0);
}
