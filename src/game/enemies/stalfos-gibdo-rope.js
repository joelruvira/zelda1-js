// P19 — enemies/stalfos-gibdo-rope (Z_04): ropes, stalfos (2nd quest: sword shots) and gibdos.
// UpdateStalfos and UpdateGibdo were advanced by the wave-4 integrator. X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
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
  $pxa('Z_04:4542', QuestNumbers, ram[CurSaveSlot]);
  if (!$br('Z_04:4543', ram[QuestNumbers + ram[CurSaveSlot]] === 0)) ram[ObjHP + x] = 0x40;
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
  if (!$br('Z_04:4558', (ram[InvClock] | ram[ObjStunTimer + x]) !== 0)) {
    Walker_Move(x);
    $pxa('Z_04:4562', ObjGridOffset, x);
    const g = ram[ObjGridOffset + x] & 0x0f;
    if (!$br('Z_04:4564', g !== 0)) ram[ObjGridOffset + x] = g;
    $pxa('Z_04:4570', ObjQSpeedFrac, x);
    if (!$br('Z_04:4572', ram[ObjQSpeedFrac + x] === 0x60) && !$br('Z_04:4574', ram[ObjTimer + x] !== 0)) {
      ram[ObjTimer + x] = ram[Random + x] & 0x3f;
      _FaceUnblockedDir(x);
    }
  }
  // @CheckSpeed
  if (!$br('Z_04:4585', saved === ram[ObjDir + x])) ram[ObjQSpeedFrac + x] = 0x20; // PLA / CMP
  $pxa('Z_04:4590', ObjQSpeedFrac, x);
  let aligned = false;
  if (!$br('Z_04:4592', ram[ObjQSpeedFrac + x] !== 0x20)) {
    $pxa('Z_04:4593', ObjGridOffset, x);
    aligned = !$br('Z_04:4594', ram[ObjGridOffset + x] !== 0);
  }
  if (aligned) {
    let rush = false;
    let flip = false;
    if (!$br('Z_04:4603', Abs(ram[ObjX] - ram[ObjX + x]) >= 0x08)) {
      ram[ObjDir + x] = 0x08; // face up
      rush = true;
      flip = !$br('Z_04:4612', ram[ObjY] < ram[ObjY + x]); // BCC @Rush, else @FlipDir (down)
    } else if (!$br('Z_04:4657', Abs(ram[ObjY] - ram[ObjY + x]) >= 0x08)) {
      // @CheckVertical
      ram[ObjDir + x] = 0x02; // face left
      rush = true;
      flip = $br('Z_04:4667', ram[ObjX] >= ram[ObjX + x]); // BCS @FlipDir (right)
      if (!flip) $br('Z_04:4668', true); // BCC @Rush
    }
    if (flip) ram[ObjDir + x] >>= 1; // @FlipDir: LSR ObjDir, X
    if (rush) ram[ObjQSpeedFrac + x] = 0x60; // @Rush
  }
  // @Animate
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x0a, x);
  ram[0x0f] = (ram[ObjDir + x] & 0x02) >> 1;
  Anim_SetSpriteDescriptorAttributes(0x02);
  $pxa('Z_04:4637', QuestNumbers, ram[CurSaveSlot]);
  if (!$br('Z_04:4638', ram[QuestNumbers + ram[CurSaveSlot]] === 0)) Anim_SetSpriteDescriptorAttributes(ram[FrameCounter] & 0x03);
  // @Draw
  $pxa('Z_04:4645', ObjAnimFrame, x);
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
  $pxa('Z_04:4681', QuestNumbers, ram[CurSaveSlot]);
  if ($br('Z_04:4682', ram[QuestNumbers + ram[CurSaveSlot]] === 0)) return; // @Exit
  $pxa('Z_04:4687', ObjShootTimer, x);
  if (!$br('Z_04:4688', ram[ObjShootTimer + x] !== 0)) {
    if ($br('Z_04:4691', ram[Random + x] < 0xf8)) return; // @Exit
  }
  // @PrepareToShoot
  let speed = ram[0x01]; // PHA
  let y = 0x00;
  $pxa('Z_04:4699', ObjInvincibilityTimer, x);
  if (!$br('Z_04:4700', ram[ObjInvincibilityTimer + x] !== 0)) {
    $pxa('Z_04:4703', ObjShootTimer, x);
    y = (ram[ObjShootTimer + x] - 1) & 0xff;
    if (!$br('Z_04:4705', !(y & 0x80))) {
      $pxa('Z_04:4708', ObjWantsToShoot, x);
      if ($br('Z_04:4709', ram[ObjWantsToShoot + x] === 0)) {
        ram[ObjQSpeedFrac + x] = speed; // @SetSpeed
        return;
      }
      y = 0x30;
    }
  }
  // @SetShootTimer
  ram[ObjShootTimer + x] = y;
  if ($br('Z_04:4723', y === 0)) {
    ram[ObjQSpeedFrac + x] = speed; // @SetSpeed
    return;
  }
  let zero = true;
  if (!$br('Z_04:4728', y !== 0x10) && !$br('Z_04:4731', (ram[InvClock] | ram[ObjStunTimer + x]) !== 0)) {
    ram[0x00] = 0x57;
    const r = _ShootIfWanted(0x57, x, y);
    if (!$br('Z_04:4739', !r.c)) {
      x = r.x;
      ram[ObjTimer + x] = 0x80;
      ram[0x0437 + x] = (ram[0x0437 + x] - 1) & 0xff; // DEC $0437,X
      // @CheckResult: C = 1
      $br('Z_04:4752', false);
      ram[ObjWantsToShoot + x] = 0x00;
    } else {
      $br('Z_04:4752', true);
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
