// P19 — enemies/darknut (Z_04): red ($0B) and blue ($0C) darknuts. X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjInvincibilityMask, ObjType, ObjQSpeedFrac, ObjStunTimer, ObjDir, ObjAnimFrame,
} from '../../core/vars.js';
import { InitWalker, UpdateCommonWanderer } from './common.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';

/**
 * InitDarknut (Z_04). X = darknut: invincible to all but sword and bomb (mask $F6); q-speed $20 (red)
 * or $28 (blue); then InitWalker.
 */
export function InitDarknut(x) {
  // InitDarknut (Z_04)
  ram[ObjInvincibilityMask + x] = 0xf6;
  let a = 0x20;
  $pxa('Z_04:6455', ObjType, x);
  if (!$br('Z_04:6457', ram[ObjType + x] === 0x0b)) a = 0x28;
  ram[ObjQSpeedFrac + x] = a;
  return InitWalker(x);
}

/**
 * UpdateDarknut (Z_04). X = darknut: wander (turn rate $80), collide, never stunned; frame image by
 * direction (2 up, 1 down, 0 horizontal; +3 on movement frame 1), flipped facing left and, on the second
 * movement frame, facing up.
 */
export function UpdateDarknut(x) {
  // UpdateDarknut (Z_04)
  UpdateCommonWanderer(0x80, x);
  CheckMonsterCollisions(x);
  ram[ObjStunTimer + x] = 0x00;
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x08, x);
  let a = ram[ObjDir + x];
  if (!$br('Z_04:6489', a !== 0x02)) ram[0x0f]++;
  a >>= 2; // LSR / LSR
  $pxa('Z_04:6499', ObjAnimFrame, x);
  if (!$br('Z_04:6500', ram[ObjAnimFrame + x] === 0)) {
    a = (a + 0x03) & 0xff;
    if (!$br('Z_04:6510', ram[ObjDir + x] !== 0x08)) ram[0x0f]++;
  }
  return DrawObjectNotMirrored(a, x);
}
