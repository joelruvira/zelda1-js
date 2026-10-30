// P18 enemyow — enemies/peahat (Z_04): peahats (flyers that can only be hurt while resting) and the
// flyer init/decision helpers shared with the flying ghini. X = object slot in every routine.

import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import { tableJump } from '../../core/asm.js';
import { label } from '../../core/rom.js';
import {
  ObjDir, FlyingMaxSpeedFrac, Flyer_ObjSpeed, ObjShoveDir, InvClock, ObjStunTimer, Flyer_ObjDistTraveled,
  Flyer_ObjFlyingState, Flyer_ObjTurns, Random,
} from '../../core/vars.js';
import { ResetObjMetastateAndTimer } from '../objects/slots.js';
import { ResetFlyerState } from '../items/fairy.js';
import { Obj_Shove } from '../movement/shove.js';
import {
  MoveFlyer, Flyer_SpeedUp, Flyer_Chase, Flyer_Wander, Flyer_SlowDown, Flyer_Delay,
} from './flyer.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored } from '../draw/anim.js';
import { CheckLinkCollision, CheckMonsterCollisions } from '../combat/collisions.js';

/** InitPeahat (Z_04). X = peahat: no spawn cloud; start going up. */
export function InitPeahat(x) {
  // InitPeahat (Z_04)
  ResetObjMetastateAndTimer(x);
  ram[ObjDir + x] = 0x08;
  return EndInitFlyer(x); // falls through
}

/** EndInitFlyer (Z_04). X = flyer: reset the flyer state; max speed $A0, speed $1F. @returns A */
export function EndInitFlyer(x) {
  // EndInitFlyer (Z_04)
  ResetFlyerState(x);
  ram[FlyingMaxSpeedFrac] = 0xa0;
  ram[Flyer_ObjSpeed + x] = 0x1f;
  return 0x1f;
}

/**
 * UpdatePeahat (Z_04). X = peahat: shove, or fly (unless clock/stunned); draw (frame = low bit of the
 * distance flown); only in flying state 5 (resting) can weapons hit it.
 */
export function UpdatePeahat(x) {
  // UpdatePeahat (Z_04)
  if (!$br('Z_04:4026', ram[ObjShoveDir + x] === 0)) {
    Obj_Shove(x);
  } else if (!$br('Z_04:4036', (ram[InvClock] | ram[ObjStunTimer + x]) !== 0)) {
    ControlPeahatFlight(x);
    MoveFlyer(x);
  }
  // @DrawAndCheckCollisions
  Anim_FetchObjPosForSpriteDescriptor(x);
  $pxa('Z_04:4047', Flyer_ObjDistTraveled, x);
  DrawObjectMirrored(ram[Flyer_ObjDistTraveled + x] & 0x01, x);
  $pxa('Z_04:4053', Flyer_ObjFlyingState, x);
  if (!$br('Z_04:4055', ram[Flyer_ObjFlyingState + x] === 0x05)) return CheckLinkCollision(x);
  return CheckMonsterCollisions(x);
}

/** ControlPeahatFlight (Z_04). X = peahat: ControlPeahatFlight_JumpTable by flying state. */
export function ControlPeahatFlight(x) {
  // ControlPeahatFlight (Z_04)
  $pxa('Z_04:4061', Flyer_ObjFlyingState, x);
  return tableJump(label('ControlPeahatFlight_JumpTable').addr, ram[Flyer_ObjFlyingState + x], [
    () => Flyer_SpeedUp(x),
    () => Flyer_PeahatDecideState(x),
    () => Flyer_Chase(x),
    () => Flyer_Wander(x),
    () => Flyer_SlowDown(x),
    () => Flyer_Delay(x),
  ]);
}

/** Flyer_PeahatDecideState (Z_04). X = peahat: random next state 2 (>= $B0), 3 (>= $20) or 4. */
export function Flyer_PeahatDecideState(x) {
  // Flyer_PeahatDecideState (Z_04)
  let y = 0x02;
  const a = ram[Random + x];
  if (!$br('Z_04:4082', a >= 0xb0)) {
    y++;
    if (!$br('Z_04:4085', a >= 0x20)) y++;
  }
  return Flyer_SetFlyingStateAnd6Turns(x, y); // falls through
}

/** Flyer_SetFlyingStateAnd6Turns (Z_04). X = flyer, Y = flying state; 6 turns. @returns A = 6 */
export function Flyer_SetFlyingStateAnd6Turns(x, y) {
  // Flyer_SetFlyingStateAnd6Turns (Z_04)
  ram[Flyer_ObjFlyingState + x] = y;
  ram[Flyer_ObjTurns + x] = 0x06;
  return 0x06;
}
