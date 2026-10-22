// P17 enemycore — enemies/flyer (Z_04): the flying-monster engine shared by keese, peahats, flying
// ghinis, moldorm, gleeok heads, patra and fairies: flying states (speed up / slow down / delay / chase /
// wander), 8-way movement with a speed fraction, bounds, and 8-way turning (Directions8).
// X = object slot in every routine.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjTimer, Flyer_ObjFlyingState, Flyer_ObjSpeed, Random, FlyingMaxSpeedFrac, Flyer_ObjSpeedFrac, ObjDir,
  ObjX, ObjY, Flyer_ObjOffsetX, Flyer_ObjOffsetY, Flyer_ObjDistTraveled, ObjType, Moldorm_ObjBounceDir,
  Flyer_ObjTurns, ChaseTargetX, ChaseTargetY,
} from '../../core/vars.js';
import { BoundDirectionHorizontally, BoundDirectionVertically } from '../movement/bounds.js';

/** LDA Directions8, Y */
const directions8 = (y) => table(bus.rom, 'Directions8').byte(y);

/** Flyer_DoNothing (Z_04). */
export function Flyer_DoNothing(x) {
  // Flyer_DoNothing (Z_04)
}

/** Flyer_Delay (Z_04). X = flyer: when its timer expires, go to flying state 0. */
export function Flyer_Delay(x) {
  // Flyer_Delay (Z_04)
  if (ram[ObjTimer + x] !== 0) return;
  ram[Flyer_ObjFlyingState + x] = 0x00;
}

/** Flyer_SlowDown (Z_04). X = flyer: decrease the speed; below $20, delay a random time (state 5). */
export function Flyer_SlowDown(x) {
  // Flyer_SlowDown (Z_04)
  ram[Flyer_ObjSpeed + x]--;
  return flyerCheckSpeed(x); // JMP :+
}

/** Flyer_SpeedUp (Z_04). X = flyer: increase the speed; at the maximum, go to flying state 1. */
export function Flyer_SpeedUp(x) {
  // Flyer_SpeedUp (Z_04)
  ram[Flyer_ObjSpeed + x]++;
  return flyerCheckSpeed(x);
}

/** Flyer_SpeedUp@: (shared by Flyer_SlowDown). */
function flyerCheckSpeed(x) {
  const a = ram[Flyer_ObjSpeed + x] & 0xe0;
  if (a !== 0) return Flyer_CompareMaxSpeed(a, x);
  ram[ObjTimer + x] = (ram[Random + x] & 0x3f) | 0x40;
  return Flyer_SetFlyingState(0x05, x); // falls through
}

/** Flyer_SetFlyingState (Z_04). A = flying state, X = flyer. @returns A */
export function Flyer_SetFlyingState(a, x) {
  // Flyer_SetFlyingState (Z_04)
  ram[Flyer_ObjFlyingState + x] = a;
  return a;
}

/** Flyer_CompareMaxSpeed (Z_04, part of Flyer_SpeedUp). A = speed & $E0. */
function Flyer_CompareMaxSpeed(a, x) {
  if (a < ram[FlyingMaxSpeedFrac]) return a;
  return Flyer_SetFlyingState(0x01, x);
}

/**
 * MoveFlyer (Z_04). X = flyer: add (speed & $E0) to the speed fraction; on a whole pixel move one
 * pixel along each component of the 8-way direction, count the distance, and bound (BoundFlyer).
 * Uses [02] (direction bit tested).
 */
export function MoveFlyer(x) {
  // MoveFlyer (Z_04)
  const sum = (ram[Flyer_ObjSpeed + x] & 0xe0) + ram[Flyer_ObjSpeedFrac + x];
  ram[Flyer_ObjSpeedFrac + x] = sum;
  if (sum < 0x100) return; // @Exit
  ram[0x02] = 0x01;
  const d = ram[ObjDir + x];
  if (d & ram[0x02]) {
    ram[ObjX + x]++;
    ram[Flyer_ObjOffsetX + x]++;
  }
  // @Left
  ram[0x02] <<= 1;
  if (d & ram[0x02]) {
    ram[ObjX + x]--;
    ram[Flyer_ObjOffsetX + x]--;
  }
  // @Down
  ram[0x02] <<= 1;
  if (d & ram[0x02]) {
    ram[ObjY + x]++;
    ram[Flyer_ObjOffsetY + x]++;
  }
  // @Up
  ram[0x02] <<= 1;
  if (d & ram[0x02]) {
    ram[ObjY + x]--;
    ram[Flyer_ObjOffsetY + x]--;
  }
  // @End
  ram[Flyer_ObjDistTraveled + x]++;
  BoundFlyer(x);
}

/**
 * BoundFlyer (Z_04). X = object: if a room bound blocks its direction (vertical bounds skipped for
 * boulders, $20), reverse the 8-way direction. Uses [00], [0F]. @returns A = [0F] or the new direction
 */
export function BoundFlyer(x) {
  // BoundFlyer (Z_04)
  ram[0x0f] = ram[ObjDir + x];
  BoundDirectionHorizontally(x);
  if (ram[ObjType + x] !== 0x20) BoundDirectionVertically(x);
  if (ram[0x0f] !== 0) return ram[0x0f]; // L132F8_Exit
  return ReverseObjDir8(x); // falls through
}

/**
 * ReverseObjDir8 (Z_04). X = object: face the opposite 8-way direction. For moldorm ($41) only the
 * heads (slots 5 and $A) take it, as a deferred bounce direction (DeferBounce).
 * @returns A
 */
export function ReverseObjDir8(x) {
  // ReverseObjDir8 (Z_04)
  const y = (GetObjDir8Index(x) + 0x04) & 0x07;
  if (ram[ObjType + x] === 0x41) {
    // DeferBounce
    if (x !== 0x05 && x !== 0x0a) return 0x41; // L13307_Exit
    const a = directions8(y);
    ram[Moldorm_ObjBounceDir + x] = a;
    return a;
  }
  const a = directions8(y);
  ram[ObjDir + x] = a;
  return a; // L132F8_Exit
}

/**
 * Flyer_Chase (Z_04). X = flyer: when the timer expires, count down the turns; turn towards the
 * player and delay $10 frames, or go to flying state 1 when no turns are left.
 */
export function Flyer_Chase(x) {
  // Flyer_Chase (Z_04)
  if (ram[ObjTimer + x] !== 0) return; // L13307_Exit
  ram[Flyer_ObjTurns + x]--;
  if (ram[Flyer_ObjTurns + x] === 0) return SetFlyingState1(x); // falls through
  // SetDelayAndTurn
  ram[ObjTimer + x] = 0x10;
  return TurnTowardsPlayer8(x); // falls through
}

/** SetFlyingState1 (Z_04). X = flyer. @returns A = 1 */
export function SetFlyingState1(x) {
  // SetFlyingState1 (Z_04)
  return Flyer_SetFlyingState(0x01, x);
}

/**
 * TurnTowardsPlayer8 (Z_04). X = object: build the 8-way direction to the chase target in [00]; keep
 * the direction if the target is within one turn of it, else turn one step (see TestDir). Uses [00], [01].
 */
export function TurnTowardsPlayer8(x) {
  // TurnTowardsPlayer8 (Z_04)
  let y = 0x00;
  ram[0x00] = y;
  y = 0x01;
  if (ram[ChaseTargetX] !== ram[ObjX + x]) {
    if (ram[ChaseTargetX] < ram[ObjX + x]) y++;
    ram[0x00] = y;
  }
  // @CalcVertical
  y = 0x01;
  if (ram[ChaseTargetY] !== ram[ObjY + x]) {
    if (ram[ChaseTargetY] < ram[ObjY + x]) y++;
    ram[0x00] = ((y << 2) | ram[0x00]) & 0xff;
  }
  // @SkipVertical
  y = GetObjDir8Index(x);
  ram[0x01] = 0x03;
  y = (y + 1) & 0xff; // turn right
  do {
    // @LoopLeft
    y &= 0x07;
    if (directions8(y) === ram[0x00]) return; // L1336F_Exit
    y = (y - 1) & 0xff; // turn left
    ram[0x01]--;
  } while (ram[0x01] !== 0);
  ram[0x01] = 0x03;
  y = (y + 1) & 0xff;
  do {
    // LoopRight
    y &= 0x07;
    const a = directions8(y);
    // TestDir: allow the turn if (test direction | target direction) < 7
    if ((a & ram[0x00]) !== 0 && (a | ram[0x00]) < 0x07) return SetDir8ForIndex(x, y);
    // NextLoopRight
    y = (y + 1) & 0xff;
    ram[0x01]--;
  } while (ram[0x01] !== 0);
  y = (y - 1) & 0xff;
  return SetDir8ForIndex(x, y); // falls through
}

/** SetDir8ForIndex (Z_04). X = object, Y = 8-way index. @returns A = new direction */
export function SetDir8ForIndex(x, y) {
  // SetDir8ForIndex (Z_04)
  const a = directions8(y);
  ram[ObjDir + x] = a;
  return a;
}

/**
 * Flyer_Wander (Z_04). X = flyer: when the timer expires, count down the turns; turn randomly and
 * delay $10 frames, or go to flying state 1 when no turns are left.
 */
export function Flyer_Wander(x) {
  // Flyer_Wander (Z_04)
  if (ram[ObjTimer + x] !== 0) return; // L133AC_Exit
  ram[Flyer_ObjTurns + x]--;
  if (ram[Flyer_ObjTurns + x] === 0) return SetFlyingState1(x);
  ram[ObjTimer + x] = 0x10;
  return TurnRandomlyDir8(x); // falls through
}

/** TurnRandomlyDir8 (Z_04). X = object: Random+1 >= $A0 keep, >= $50 turn right, else turn left. */
export function TurnRandomlyDir8(x) {
  // TurnRandomlyDir8 (Z_04)
  let y = GetObjDir8Index(x);
  const a = ram[Random + 1 + x];
  if (a < 0xa0) {
    y = (y + 1) & 0xff;
    if (a < 0x50) y = (y - 2) & 0xff;
  }
  // @SetDir
  return SetDir8ForIndex(x, y & 0x07);
}

/** GetObjDir8Index (Z_04). X = object. @returns Y = index of ObjDir in Directions8 (0 if not found) */
export function GetObjDir8Index(x) {
  // GetObjDir8Index (Z_04)
  let y = 0x07;
  for (; y >= 0; y--) {
    if (ram[ObjDir + x] === directions8(y)) return y; // L133AC_Exit
  }
  return 0; // unverified code 133AB: INY from $FF
}
