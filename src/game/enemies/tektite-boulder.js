// P18 enemyow — enemies/tektite-boulder (Z_04): the "jumpers" (blue/red tektites and falling
// boulders) and the invisible boulder set ($21) that drops boulders from the top of the room.
// X = object slot in every routine.

import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ActiveBoulders, Random, ObjDir, ObjTimer, ObjX, ObjY, ObjType, ObjState, ObjShoveDir, InvClock,
  ObjStunTimer, ChaseTargetX, CurObjIndex, EmptyMonsterSlot, Jumper_ObjReversalCount, Jumper_ObjTargetY,
  Jumper_ObjSpeedWholeY, Jumper_ObjSpeedFracY, ObjAnimFrame,
} from '../../core/vars.js';
import {
  ResetObjMetastateAndTimer, FindEmptyMonsterSlot, SetTypeAndClearObject, DestroyMonster,
} from '../objects/slots.js';
import { ResetObjState } from '../weapons/sword.js';
import { Obj_Shove } from '../movement/shove.js';
import { Abs } from '../movement/math.js';
import { TurnTowardsPlayer8, BoundFlyer } from './flyer.js';
import {
  Anim_FetchObjPosForSpriteDescriptor, Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor,
} from '../draw/anim.js';
import { DrawObjectMirroredAndCheckCollisions } from './octorok.js';
import { DrawObjectNotMirroredAndCheckLinkCollision } from './ghini.js';

const tbl = (name) => table(bus.rom, name);

/** InitBoulderSet (Z_04). X = object: no active boulders yet. */
export function InitBoulderSet(x) {
  // InitBoulderSet (Z_04)
  ram[ActiveBoulders] = 0x00;
  return InitBoulder(x); // falls through
}

/** InitBoulder (Z_04). X = object: no spawn cloud. */
export function InitBoulder(x) {
  // InitBoulder (Z_04)
  ResetObjMetastateAndTimer(x);
  return InitTektite(x); // falls through
}

/** InitTektite (Z_04). X = object: random diagonal direction; timer = direction * 4. @returns A */
export function InitTektite(x) {
  // InitTektite (Z_04)
  const y = ram[Random + 1 + x] & 0x03;
  let a = tbl('TektiteStartingDirs').byte(y);
  ram[ObjDir + x] = a;
  a = (a << 2) & 0xff;
  ram[ObjTimer + x] = a;
  return a;
}

/**
 * UpdateBoulderSet (Z_04). X = boulder set: when its timer expires, make a boulder ($20) at the top
 * of the room in the chase target's half (up to 3 at a time), else randomize the timer.
 */
export function UpdateBoulderSet(x) {
  // UpdateBoulderSet (Z_04)
  if (ram[ObjTimer + x] !== 0) return; // @Exit
  if (ram[ActiveBoulders] === 0x03) {
    // @RandomizeTimer
    ram[ObjTimer + x] = ram[ObjTimer + x] + ram[Random + 1 + x];
    return;
  }
  if (FindEmptyMonsterSlot().y === 0) return;
  x = ram[EmptyMonsterSlot];
  ram[ActiveBoulders]++;
  SetTypeAndClearObject(0x20, x);
  let a = ram[Random + 1 + x];
  if (ram[ChaseTargetX] < 0x80) a &= 0x7f;
  else a |= 0x80; // @RightHalf
  // @SetX
  ram[ObjX + x] = a;
  ram[ObjY + x] = 0x40;
  x = ram[CurObjIndex];
  ram[ObjTimer + x] = (0x08 + ram[Random + 1 + x]) & 0x1f;
}

/**
 * UpdateTektiteOrBoulder (Z_04). X = jumper. State 0 (on the ground): when the timer expires, turn
 * towards the chase target and set up a jump. State 1: bounded jump with vertical acceleration,
 * one pixel a frame horizontally, landing near the target Y. Then animate, draw and check collisions.
 */
export function UpdateTektiteOrBoulder(x) {
  // UpdateTektiteOrBoulder (Z_04)
  if (ram[ObjShoveDir + x] !== 0) return Obj_Shove(x); // unverified code 108FC
  // @CheckStunned
  if ((ram[InvClock] | ram[ObjStunTimer + x]) !== 0) return Jumper_AnimateAndCheckCollisions(x);
  if (ram[ObjState + x] === 0) {
    // State 0. On the ground.
    if (ram[ObjTimer + x] !== 0) return Jumper_AnimateAndCheckCollisions(x); // @Animate
    TurnTowardsPlayer8(x);
    if ((ram[ObjDir + x] & 0x03) === 0) {
      let y = 0x02;
      if (ram[ChaseTargetX] >= ram[ObjX + x]) y--;
      ram[ObjDir + x] = y | ram[ObjDir + x];
    }
    // @SetStateJump
    ram[ObjState + x]++;
    return setUpJump(x);
  }
  // @State1. Jumping.
  BoundFlyer(x);
  if (ram[0x0f] === 0) {
    ram[Jumper_ObjReversalCount + x]++;
    return setUpJump(x);
  }
  Jumper_PointBoulderDownward(x);
  ram[Jumper_ObjReversalCount + x] = 0x00;
  let y = Jumper_GetKind(x);
  let a = tbl('JumperYAccelerationBaseOffsets').byte(y);
  cpu.c = 0; // CLC
  y = cpu.adc(a, ram[ObjDir + x]); // TAY; the carry goes on into Jumper_MoveY
  a = tbl('JumperYAccelerations').byte(y);
  Jumper_MoveY(a, x, 0x02); // max speed 2 pixels going down
  y = (ram[ObjDir + x] & 0x02) ? 0xff : 0x01;
  ram[ObjX + x] = y + ram[ObjX + x];
  if (ram[Jumper_ObjSpeedWholeY + x] & 0x80) return Jumper_AnimateAndCheckCollisions(x); // going up
  a = Abs((ram[ObjY + x] - ram[Jumper_ObjTargetY + x]) & 0xff);
  if (a >= 0x03) return Jumper_AnimateAndCheckCollisions(x);
  // Landed: state 0.
  a = ResetObjState(x);
  if (ram[ObjType + x] !== 0x20) {
    a = (0x10 + ram[Random + 1 + x]) & 0xff;
    if (a < 0x20) a = (a - 0x40) & 0xff;
    if (ram[ObjType + x] !== 0x0d) {
      a &= 0x7f;
      if (ram[Random + 1 + x] >= 0xa0) a &= 0x0f;
    }
  }
  // @SetTimerAndAnimate
  ram[ObjTimer + x] = a;
  return Jumper_AnimateAndCheckCollisions(x); // falls through
}

/** UpdateTektiteOrBoulder@SetUpJump: escape corners, then the jump's target Y and starting speed. */
function setUpJump(x) {
  if (ram[Jumper_ObjReversalCount + x] >= 0x02) {
    ram[ObjDir + x] = ram[ObjDir + x] ^ 0x03;
    ram[Jumper_ObjReversalCount + x] = 0x00;
  }
  // @FinishSetUpJump
  Jumper_PointBoulderDownward(x);
  let y = ram[ObjDir + x];
  ram[Jumper_ObjTargetY + x] = ram[ObjY + x] + tbl('JumperYOffsets').byte(y);
  y = Jumper_GetKind(x);
  ram[Jumper_ObjSpeedWholeY + x] = tbl('JumperStartSpeedsHi').byte(y);
  Jumper_ResetVSpeedFrac(x);
  return Jumper_AnimateAndCheckCollisions(x); // @Animate
}

/**
 * Jumper_AnimateAndCheckCollisions (Z_04). X = jumper. Tektites: frame 0/1 by state, or the movement
 * frame while waiting with timer >= $21. Boulders: animate, draw, check Link, destroy at Y >= $F0.
 */
export function Jumper_AnimateAndCheckCollisions(x) {
  // Jumper_AnimateAndCheckCollisions (Z_04)
  let a = Anim_FetchObjPosForSpriteDescriptor(x);
  ram[0x0d] = a; // not used afterwards
  if (ram[ObjType + x] === 0x20) {
    // @DrawBoulder
    Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x06, x);
    DrawObjectNotMirroredAndCheckLinkCollision(ram[ObjAnimFrame + x], x);
    if (ram[ObjY + x] < 0xf0) return; // L10A10_Exit
    ram[ActiveBoulders]--;
    return DestroyMonster(x);
  }
  a = ram[ObjState + x];
  if (a === 0 && ram[ObjTimer + x] >= 0x21) {
    Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x10, x);
    a = ram[ObjAnimFrame + x];
  }
  // @DrawTektite
  return DrawObjectMirroredAndCheckCollisions(a, x);
}

/** Jumper_GetKind (Z_04). X = jumper. @returns Y: 0 blue tektite, 1 red tektite, 2 boulder */
export function Jumper_GetKind(x) {
  // Jumper_GetKind (Z_04)
  let y = (ram[ObjType + x] - 0x0d) & 0xff;
  if (y >= 0x02) y = 0x02;
  return y; // L10A10_Exit
}

/** Jumper_PointBoulderDownward (Z_04). X = object: a boulder's direction always goes down. */
export function Jumper_PointBoulderDownward(x) {
  // Jumper_PointBoulderDownward (Z_04)
  if (ram[ObjType + x] !== 0x20) return;
  ram[ObjDir + x] = (ram[ObjDir + x] & 0x03) | 0x04;
}

/**
 * Jumper_MoveY (Z_04). A = acceleration, X = jumper, Y = max speed high byte, cpu.c = incoming carry
 * (the original has no CLC before adding the speed to Y). Uses [00], [02].
 */
export function Jumper_MoveY(a, x, y) {
  // Jumper_MoveY (Z_04)
  ram[0x00] = a;
  ram[0x02] = y;
  ram[ObjY + x] = cpu.adc(ram[Jumper_ObjSpeedWholeY + x], ram[ObjY + x]);
  cpu.c = 0;
  ram[Jumper_ObjSpeedFracY + x] = cpu.adc(ram[Jumper_ObjSpeedFracY + x], ram[0x00]);
  a = cpu.adc(ram[Jumper_ObjSpeedWholeY + x], 0x00);
  ram[Jumper_ObjSpeedWholeY + x] = a;
  if ((a - ram[0x02]) & 0x80) return; // CMP / BMI L10A52_Exit
  if (ram[Jumper_ObjSpeedFracY + x] < 0x80) return;
  ram[Jumper_ObjSpeedWholeY + x] = ram[0x02];
  return Jumper_ResetVSpeedFrac(x); // falls through
}

/** Jumper_ResetVSpeedFrac (Z_04). X = jumper. @returns A = 0 */
export function Jumper_ResetVSpeedFrac(x) {
  // Jumper_ResetVSpeedFrac (Z_04)
  ram[Jumper_ObjSpeedFracY + x] = 0x00;
  return 0x00;
}
