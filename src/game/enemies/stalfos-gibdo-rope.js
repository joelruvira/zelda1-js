// P19 — enemies/stalfos-gibdo-rope (Z_04). UpdateStalfos and UpdateGibdo were advanced by the wave-4
// integrator (level 1 and the dark-room/cellar movies need them); the rope routines are still stubs for
// P19. X = object slot in every routine.
import { ram } from '../../core/ram.js';
import {
  CurSaveSlot, QuestNumbers, ObjShootTimer, Random, ObjInvincibilityTimer, ObjWantsToShoot, InvClock,
  ObjStunTimer, ObjTimer, ObjQSpeedFrac,
} from '../../core/vars.js';
import { UpdateCommonWanderer } from './common.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import {
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, Anim_SetObjHFlipForSpriteDescriptor,
  DrawObjectNotMirrored,
} from '../draw/anim.js';
import { AnimateAndDrawCommonObject } from './keese-bubble.js';
import { _ShootIfWanted } from './shots.js';
import { stubX } from '../stub.js';

export const InitRope = stubX('InitRope');
export const UpdateRope = stubX('UpdateRope');

/**
 * UpdateStalfos (Z_04). X = stalfos: wander (turn rate $80), collide, draw. In the second quest it
 * stops and shoots a sword shot ($57) on a $30-frame shoot timer.
 */
export function UpdateStalfos(x) {
  // UpdateStalfos (Z_04)
  UpdateCommonWanderer(0x80, x);
  CheckMonsterCollisions(x);
  AnimateAndDrawCommonObject(0x08, x);
  ram[0x01] = 0x20;
  if (ram[QuestNumbers + ram[CurSaveSlot]] === 0) return; // @Exit
  if (ram[ObjShootTimer + x] === 0) {
    if (ram[Random + x] < 0xf8) return; // @Exit
  }
  // @PrepareToShoot
  let speed = ram[0x01]; // PHA
  let y = 0x00;
  if (ram[ObjInvincibilityTimer + x] === 0) {
    y = (ram[ObjShootTimer + x] - 1) & 0xff;
    if (y & 0x80) {
      if (ram[ObjWantsToShoot + x] === 0) {
        ram[ObjQSpeedFrac + x] = speed; // @SetSpeed
        return;
      }
      y = 0x30;
    }
  }
  // @SetShootTimer
  ram[ObjShootTimer + x] = y;
  if (y === 0) {
    ram[ObjQSpeedFrac + x] = speed; // @SetSpeed
    return;
  }
  let zero = true;
  if (y === 0x10 && (ram[InvClock] | ram[ObjStunTimer + x]) === 0) {
    ram[0x00] = 0x57;
    const r = _ShootIfWanted(0x57, x, y);
    if (r.c) {
      x = r.x;
      ram[ObjTimer + x] = 0x80;
      ram[0x0437 + x] = (ram[0x0437 + x] - 1) & 0xff; // DEC $0437,X
      // @CheckResult: C = 1
      ram[ObjWantsToShoot + x] = 0x00;
    } else {
      zero = false; // @CheckResult: C = 0 -> @SetSpeed
    }
  }
  if (zero) speed = 0x00; // @ZeroSpeed
  ram[ObjQSpeedFrac + x] = speed; // @SetSpeed
}

/** UpdateGibdo (Z_04). X = gibdo: wander (turn rate $80), collide, animate every 8 frames, draw. */
export function UpdateGibdo(x) {
  // UpdateGibdo (Z_04)
  UpdateCommonWanderer(0x80, x);
  CheckMonsterCollisions(x);
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x08, x);
  Anim_SetObjHFlipForSpriteDescriptor(x);
  return DrawObjectNotMirrored(0x00, x);
}
