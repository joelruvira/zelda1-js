// P19 — enemies/stalfos-gibdo-rope (Z_04): ropes, stalfos (2nd quest: sword shots) and gibdos.
// UpdateStalfos and UpdateGibdo were advanced by the wave-4 integrator. X = object slot in every routine.
import { ram } from '../../core/ram.js';
import {
  CurSaveSlot, QuestNumbers, ObjShootTimer, Random, ObjInvincibilityTimer, ObjWantsToShoot, InvClock,
  ObjStunTimer, ObjTimer, ObjQSpeedFrac, ObjHP, ObjDir, ObjInputDir, ObjGridOffset, ObjX, ObjY,
  FrameCounter, ObjAnimFrame,
} from '../../core/vars.js';
import { UpdateCommonWanderer, InitWalker } from './common.js';
import { Walker_Move, _FaceUnblockedDir } from '../movement/walker.js';
import { Abs } from '../movement/math.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import {
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, Anim_SetObjHFlipForSpriteDescriptor,
  DrawObjectNotMirrored,
} from '../draw/anim.js';
import { AnimateAndDrawCommonObject } from './keese-bubble.js';
import { _ShootIfWanted } from './shots.js';

/** InitRope (Z_04). X = rope: $10 HP in the first quest, $40 in the second; then InitWalker. */
export function InitRope(x) {
  // InitRope (Z_04)
  ram[ObjHP + x] = 0x10;
  if (ram[QuestNumbers + ram[CurSaveSlot]] !== 0) ram[ObjHP + x] = 0x40;
  return InitWalker(x);
}

/**
 * UpdateRope (Z_04). X = rope. Walks (no clock, not stunned), turning to an unblocked direction on a
 * random timer unless rushing; slows to $20 on a turn; at a square, rushes ($60) towards Link when
 * aligned with him (|dX| or |dY| < 8). Draws (red; flashing in the second quest) and collides.
 */
export function UpdateRope(x) {
  // UpdateRope (Z_04)
  ram[ObjInputDir + x] = ram[ObjDir + x];
  const saved = ram[ObjDir + x]; // PHA
  if ((ram[InvClock] | ram[ObjStunTimer + x]) === 0) {
    Walker_Move(x);
    const g = ram[ObjGridOffset + x] & 0x0f;
    if (g === 0) ram[ObjGridOffset + x] = g;
    if (ram[ObjQSpeedFrac + x] !== 0x60 && ram[ObjTimer + x] === 0) {
      ram[ObjTimer + x] = ram[Random + x] & 0x3f;
      _FaceUnblockedDir(x);
    }
  }
  // @CheckSpeed
  if (saved !== ram[ObjDir + x]) ram[ObjQSpeedFrac + x] = 0x20; // PLA / CMP
  if (ram[ObjQSpeedFrac + x] === 0x20 && ram[ObjGridOffset + x] === 0) {
    let rush = false;
    let flip = false;
    if (Abs(ram[ObjX] - ram[ObjX + x]) < 0x08) {
      ram[ObjDir + x] = 0x08; // face up
      rush = true;
      flip = !(ram[ObjY] < ram[ObjY + x]); // BCC @Rush, else @FlipDir (down)
    } else if (Abs(ram[ObjY] - ram[ObjY + x]) < 0x08) {
      // @CheckVertical
      ram[ObjDir + x] = 0x02; // face left
      rush = true;
      flip = ram[ObjX] >= ram[ObjX + x]; // BCS @FlipDir (right)
    }
    if (flip) ram[ObjDir + x] >>= 1; // @FlipDir: LSR ObjDir, X
    if (rush) ram[ObjQSpeedFrac + x] = 0x60; // @Rush
  }
  // @Animate
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x0a, x);
  ram[0x0f] = (ram[ObjDir + x] & 0x02) >> 1;
  Anim_SetSpriteDescriptorAttributes(0x02);
  if (ram[QuestNumbers + ram[CurSaveSlot]] !== 0) Anim_SetSpriteDescriptorAttributes(ram[FrameCounter] & 0x03);
  // @Draw
  DrawObjectNotMirrored(ram[ObjAnimFrame + x], x);
  return CheckMonsterCollisions(x);
}

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
