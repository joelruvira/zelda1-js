// P18 enemyow — enemies/ghini (Z_04): the graveyard ghini (a wanderer whose death kills every flying
// ghini) and the flying ghinis that come out of the graves. X = object slot in every routine.

import { ram } from '../../core/ram.js';
import { tableJump } from '../../core/asm.js';
import { label } from '../../core/rom.js';
import {
  ObjMetastate, ObjType, ObjDir, InvClock, Flyer_ObjFlyingState, Random,
} from '../../core/vars.js';
import { UpdateCommonWanderer } from './common.js';
import {
  MoveFlyer, Flyer_SpeedUp, Flyer_Chase, Flyer_Wander, Flyer_SlowDown, Flyer_Delay,
} from './flyer.js';
import { Flyer_SetFlyingStateAnd6Turns } from './peahat.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';
import { CheckMonsterCollisions, CheckLinkCollision } from '../combat/collisions.js';

/** UpdateGhini (Z_04). X = ghini: wander (turn rate $FF), draw, collisions; dying kills flying ghinis. */
export function UpdateGhini(x) {
  // UpdateGhini (Z_04)
  UpdateCommonWanderer(0xff, x);
  DrawGhiniAndCheckCollisions(x);
  CheckMonsterCollisions(x);
  if (ram[ObjMetastate + x] === 0) return; // @Exit
  for (let y = 0x0b; y !== 0; y--) {
    // @LoopObject
    if (ram[ObjType + y] === 0x22) ram[ObjMetastate + y] = 0x11;
  }
}

/**
 * DrawGhiniAndCheckCollisions (Z_04). X = ghini: frame 0 (back) when going up, else 1 (front);
 * flipped by the horizontal component (up: left bit; otherwise: right bit). Checks Link only.
 */
export function DrawGhiniAndCheckCollisions(x) {
  // DrawGhiniAndCheckCollisions (Z_04)
  ram[0x0d] = Anim_FetchObjPosForSpriteDescriptor(x);
  if (ram[ObjDir + x] & 0x08) {
    // @CheckHorizontalFlip
    if (ram[ObjDir + x] & 0x02) ram[0x0f]++; // @SetHorizontalFlip
  } else {
    ram[0x0d]++;
    if (ram[ObjDir + x] & 0x01) ram[0x0f]++; // @SetHorizontalFlip
  }
  // @DrawAndCheckCollisions
  return DrawObjectNotMirroredAndCheckLinkCollision(ram[0x0d], x); // falls through
}

/**
 * DrawObjectNotMirroredAndCheckLinkCollision (Z_04). A = frame image, X = object; [00]/[01] position,
 * [0F] flip. Results of CheckLinkCollision in [00], [06], [09], [0C], ShotCollidesWithLink.
 */
export function DrawObjectNotMirroredAndCheckLinkCollision(a, x) {
  // DrawObjectNotMirroredAndCheckLinkCollision (Z_04)
  DrawObjectNotMirrored(a, x);
  return CheckLinkCollision(x);
}

/** UpdateFlyingGhini (Z_04). X = flying ghini: fly (unless the clock), draw, check Link. */
export function UpdateFlyingGhini(x) {
  // UpdateFlyingGhini (Z_04)
  if (ram[InvClock] === 0) {
    ControlFlyingGhiniFlight(x);
    MoveFlyer(x);
  }
  Anim_FetchObjPosForSpriteDescriptor(x);
  // LDA Flyer_ObjDistTraveled, X / AND #$01: unused (clobbered by the next call)
  return DrawGhiniAndCheckCollisions(x);
}

/** ControlFlyingGhiniFlight (Z_04). X = flying ghini: ControlFlyingGhiniFlight_JumpTable by state. */
export function ControlFlyingGhiniFlight(x) {
  // ControlFlyingGhiniFlight (Z_04)
  return tableJump(label('ControlFlyingGhiniFlight_JumpTable').addr, ram[Flyer_ObjFlyingState + x], [
    () => Flyer_SpeedUp(x),
    () => Flyer_GhiniDecideState(x),
    () => Flyer_Chase(x),
    () => Flyer_Wander(x),
    () => Flyer_SlowDown(x),
    () => Flyer_Delay(x),
  ]);
}

/** Flyer_GhiniDecideState (Z_04). X = flying ghini: random next state 2 (>= $A0), 3 (>= 8) or 4. */
export function Flyer_GhiniDecideState(x) {
  // Flyer_GhiniDecideState (Z_04)
  let y = 0x02;
  const a = ram[Random + x];
  if (a < 0xa0) {
    y++;
    if (a < 0x08) y++;
  }
  return Flyer_SetFlyingStateAnd6Turns(x, y); // JMP
}
