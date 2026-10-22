// P19 — enemies/keese-bubble (Z_04). The keese routines and AnimateAndDrawCommonObject were advanced by
// the wave-4 integrator (keeses appear in the first underworld rooms the overworld movies reach); the
// bubble routines are still stubs for P19. X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  Random, ObjDir, FlyingMaxSpeedFrac, Flyer_ObjSpeed, InvClock, ItemLiftTimer, Flyer_ObjDistTraveled,
  Flyer_ObjFlyingState, Flyer_ObjTurns,
} from '../../core/vars.js';
import { ResetFlyerState } from '../items/fairy.js';
import {
  MoveFlyer, Flyer_SpeedUp, Flyer_Chase, Flyer_Wander, Flyer_SlowDown, Flyer_Delay,
} from './flyer.js';
import {
  Anim_FetchObjPosForSpriteDescriptor, Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor,
  Anim_SetObjHFlipForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored,
} from '../draw/anim.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { ResetShoveInfo } from '../movement/shove.js';
import { stubX } from '../stub.js';

export const InitBubble = stubX('InitBubble');
export const UpdateBubble = stubX('UpdateBubble');

/** InitBlueKeese (Z_04). X = keese: random one of 8 directions; max speed $C0, speed $1F. */
export function InitBlueKeese(x) {
  // InitBlueKeese (Z_04)
  const y = ram[Random + x] & 0x07;
  ram[ObjDir + x] = table(bus.rom, 'Directions8').byte(y);
  ResetFlyerState(x);
  ram[FlyingMaxSpeedFrac] = 0xc0;
  ram[Flyer_ObjSpeed + x] = 0x1f;
  return 0x1f;
}

/** InitRedOrBlackKeese (Z_04). X = keese: a blue keese with speed $7F. */
export function InitRedOrBlackKeese(x) {
  // InitRedOrBlackKeese (Z_04)
  InitBlueKeese(x);
  ram[Flyer_ObjSpeed + x] = 0x7f;
  return 0x7f;
}

/**
 * AnimateAndDrawCommonObject (Z_04). A = new animation counter, X = object: advance the animation, set
 * the h-flip from the animation frame and draw frame image 0 not mirrored.
 */
export function AnimateAndDrawCommonObject(a, x) {
  // AnimateAndDrawCommonObject (Z_04)
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(a, x);
  Anim_SetObjHFlipForSpriteDescriptor(x);
  return DrawObjectNotMirrored(0x00, x);
}

/** UpdateKeese (Z_04). X = keese: fly (no clock, no item lifted), draw, collide, reset the shove. */
export function UpdateKeese(x) {
  // UpdateKeese (Z_04)
  if ((ram[InvClock] | ram[ItemLiftTimer]) === 0) {
    ControlKeeseFlight(x);
    MoveFlyer(x);
  }
  Anim_FetchObjPosForSpriteDescriptor(x);
  DrawObjectMirrored((ram[Flyer_ObjDistTraveled + x] & 0x02) >> 1, x);
  CheckMonsterCollisions(x);
  return ResetShoveInfo(x);
}

/** ControlKeeseFlight (Z_04). X = keese: ControlKeeseFlight_JumpTable by flying state. */
export function ControlKeeseFlight(x) {
  // ControlKeeseFlight (Z_04)
  return tableJump(label('ControlKeeseFlight_JumpTable').addr, ram[Flyer_ObjFlyingState + x], [
    () => Flyer_SpeedUp(x),
    () => Flyer_KeeseDecideState(x),
    () => Flyer_Chase(x),
    () => Flyer_Wander(x),
    () => Flyer_SlowDown(x),
    () => Flyer_Delay(x),
  ]);
}

/** Flyer_KeeseDecideState (Z_04). X = keese: next state 2 (Random+1 >= $A0), 3 (>= $20) or 4. */
export function Flyer_KeeseDecideState(x) {
  // Flyer_KeeseDecideState (Z_04)
  let y = 0x02;
  const a = ram[Random + 1 + x];
  if (a < 0xa0) {
    y++;
    if (a < 0x20) y++;
  }
  return Flyer_SetStateAndTurns(x, y); // falls through
}

/** Flyer_SetStateAndTurns (Z_04). X = flyer, Y = flying state; 6 turns. @returns A = 6 */
export function Flyer_SetStateAndTurns(x, y) {
  // Flyer_SetStateAndTurns (Z_04)
  ram[Flyer_ObjFlyingState + x] = y;
  ram[Flyer_ObjTurns + x] = 0x06;
  return 0x06;
}
