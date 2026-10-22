// P05 objects — object slots: find an empty monster slot, destroy/clear an object, metastate
// resets and the invincibility timer (Z_07, Z_04, Z_01 BANK_01_CODE).

import { ram } from '../../core/ram.js';
import {
  ObjType, ObjShoveDir, ObjShoveDistance, ObjTimer, ObjState, ObjInvincibilityTimer,
  ObjUninitialized, ObjMetastate, EmptyMonsterSlot, FrameCounter,
} from '../../core/vars.js';
import { SetShoveInfoWith0 } from '../movement/shove.js';

/** DestroyObject_WRAM (Z_01, runs from WRAM). A = 0, X = object. @returns A = 1 */
export function DestroyObject_WRAM(a, x) {
  // DestroyObject_WRAM (Z_01)
  ram[ObjShoveDir + x] = a;
  ram[ObjShoveDistance + x] = a;
  ram[ObjTimer + x] = a;
  ram[ObjState + x] = a;
  ram[ObjInvincibilityTimer + x] = a;
  ram[ObjUninitialized + x] = 0xff;
  ram[ObjMetastate + x] = 0x01;
  return 0x01;
}

/** DestroyMonster_Bank4 (Z_04). X = object. @returns A = 1 */
export function DestroyMonster_Bank4(x) {
  // DestroyMonster_Bank4 (Z_04)
  ram[ObjType + x] = 0x00;
  const a = SetShoveInfoWith0(0x00, x);
  ram[ObjTimer + x] = a;
  ram[ObjState + x] = a;
  ram[ObjInvincibilityTimer + x] = a;
  ram[ObjUninitialized + x] = 0xff;
  ram[ObjMetastate + x] = 0x01;
  return 0x01;
}

/** DestroyMonster (Z_07). X = object. @returns A = 1 */
export function DestroyMonster(x) {
  // DestroyMonster (Z_07): falls through into SetTypeAndClearObject with A = 0
  return SetTypeAndClearObject(0x00, x);
}

/** SetTypeAndClearObject (Z_07). A = object type, X = object. @returns A = 1 */
export function SetTypeAndClearObject(a, x) {
  // SetTypeAndClearObject (Z_07)
  ram[ObjType + x] = a;
  return DestroyObject_WRAM(0x00, x); // JMP
}

/**
 * FindEmptyMonsterSlot (Z_07): look for an empty slot from $B down to 1.
 * @returns {a, y}: Y = empty slot, or 0 when none was found (the Z flag of CPY #0);
 *   A = ObjType of the last slot read (0 when found); [59] EmptyMonsterSlot = slot when found.
 */
export function FindEmptyMonsterSlot() {
  // FindEmptyMonsterSlot (Z_07)
  let y = 0x0c;
  let a = 0;
  for (;;) {
    y--;
    if (y === 0) break; // @End
    a = ram[ObjType + y];
    if (a !== 0) continue;
    ram[EmptyMonsterSlot] = y;
    break;
  }
  return { a, y };
}

/** DecrementInvincibilityTimer (Z_07). X = object: every other frame, decrement its timer. */
export function DecrementInvincibilityTimer(x) {
  // DecrementInvincibilityTimer (Z_07)
  if (ram[ObjInvincibilityTimer + x] === 0) return;
  if (ram[FrameCounter] & 0x01) return; // LSR / BCS
  ram[ObjInvincibilityTimer + x]--;
}

/** ResetObjMetastateAndTimer (Z_07). X = object. @returns A = 0 */
export function ResetObjMetastateAndTimer(x) {
  // ResetObjMetastateAndTimer (Z_07)
  ram[ObjTimer + x] = 0x00;
  return ResetObjMetastate(x); // falls through
}

/** ResetObjMetastate (Z_07). X = object: the object starts behaving on its own. @returns A = 0 */
export function ResetObjMetastate(x) {
  // ResetObjMetastate (Z_07)
  ram[ObjMetastate + x] = 0x00;
  return 0x00;
}
