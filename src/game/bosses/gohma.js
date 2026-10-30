// P21 — bosses/gohma (Z_04): red ($33) and blue ($34) Gohma. X = object slot.
// Walks left/right/down in sprints of $20 pixels at half a pixel a frame; the eye opens now and then
// (fully open = eye state 3) and only an arrow flying up into its middle parts (3, 4) while the eye is
// fully open hurts it. Shoots an unblockable fireball ($56) every $41 frames.
import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjDir, ObjType, ObjState, ObjAnimCounter, ObjAnimFrame, ObjInvincibilityMask, Random,
  FrameCounter, SampleRequest, Tune0Request,
  Gohma_ObjShootTimer, Gohma_ObjDistTraveled, Gohma_ObjMoveAccum, Gohma_ObjNextOpenEyeCounter,
  Gohma_ObjEyeOpenTimer, Gohma_ObjGoStraight, Gohma_ObjSprints, Gohma_ObjEyeState, Gohma_ObjEyeAnimCounter,
} from '../../core/vars.js';
import { ResetObjMetastateAndTimer } from '../objects/slots.js';
import { ReverseObjDir8 } from '../enemies/flyer.js';
import { ShootFireball } from '../enemies/shots.js';
import { PlayBossDeathCryIfNeeded } from '../enemies/common.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { DealDamage } from '../combat/damage.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import {
  Anim_FetchObjPosForSpriteDescriptor, Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor,
  Anim_SetObjHFlipForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored,
} from '../draw/anim.js';
import { $br, $pxa } from '../../core/timing.js';

/**
 * InitGohma (Z_04). X = boss: roar, invincible to all but arrows, shoot timer + 1, at ($80,$70).
 * @returns A = 0 (ResetObjMetastateAndTimer)
 */
export function InitGohma(x) {
  // InitGohma (Z_04)
  ram[SampleRequest] = 0x20; // Dodongo/Gohma roar
  ram[ObjInvincibilityMask + x] = 0xfb;
  ram[Gohma_ObjShootTimer + x]++;
  ram[ObjX + x] = 0x80;
  ram[ObjY + x] = 0x70;
  return ResetObjMetastateAndTimer(x);
}

/**
 * UpdateGohma (Z_04). X = boss: choose a direction (Random >= $B0 right, >= $60 left, else down) or move
 * half a pixel (accumulator += $80); every $20 pixels reverse, and after every second sprint choose again.
 * Then animate the eye, shoot, draw and check collisions.
 */
export function UpdateGohma(x) {
  // UpdateGohma (Z_04)
  $pxa('Z_04:8195', Gohma_ObjGoStraight, x);
  if (!$br('Z_04:8196', ram[Gohma_ObjGoStraight + x] !== 0)) {
    let a = 0x01;
    const y = ram[Random + x];
    if (!$br('Z_04:8205', y >= 0xb0)) {
      a = 0x02;
      if (!$br('Z_04:8208', y >= 0x60)) a = 0x04;
    }
    // @ChangeDir
    ram[ObjDir + x] = a;
    ram[Gohma_ObjGoStraight + x]++;
  } else {
    // @Move
    cpu.c = 0;
    $pxa('Z_04:8222', Gohma_ObjMoveAccum, x);
    ram[Gohma_ObjMoveAccum + x] = cpu.adc(ram[Gohma_ObjMoveAccum + x], 0x80);
    if (!$br('Z_04:8228', !cpu.c)) {
      ram[Gohma_ObjDistTraveled + x]++;
      ram[0x02] = 0x01;
      const dir = ram[ObjDir + x];
      if (!$br('Z_04:8240', (dir & ram[0x02]) === 0)) ram[ObjX + x]++;
      ram[0x02] <<= 1;
      if (!$br('Z_04:8246', (dir & ram[0x02]) === 0)) ram[ObjX + x]--;
      ram[0x02] <<= 1;
      if (!$br('Z_04:8252', (dir & ram[0x02]) === 0)) ram[ObjY + x]++;
      ram[0x02] <<= 1;
      if (!$br('Z_04:8258', (dir & ram[0x02]) === 0)) ram[ObjY + x]--;
      $pxa('Z_04:8262', Gohma_ObjDistTraveled, x);
      if (!$br('Z_04:8264', ram[Gohma_ObjDistTraveled + x] !== 0x20)) {
        ram[Gohma_ObjDistTraveled + x] = 0x00;
        ReverseObjDir8(x);
        $pxa('Z_04:8271', Gohma_ObjSprints, x);
        const sprints = ram[Gohma_ObjSprints + x];
        ram[Gohma_ObjSprints + x]++;
        if (!$br('Z_04:8277', !(sprints & 0x01))) ram[Gohma_ObjGoStraight + x] = 0x00;
      }
    }
  }
  // @AnimateEye
  $pxa('Z_04:8290', Gohma_ObjNextOpenEyeCounter, x);
  if (!$br('Z_04:8291', ram[Gohma_ObjNextOpenEyeCounter + x] !== 0)) {
    ram[Gohma_ObjEyeOpenTimer + x] = 0x80;
    ram[Gohma_ObjNextOpenEyeCounter + x] = 0xc0 | ram[Random + x];
  }
  // @DecNextOpenEyeCounter
  if (!$br('Z_04:8302', !(ram[FrameCounter] & 0x01))) ram[Gohma_ObjNextOpenEyeCounter + x]--;
  $pxa('Z_04:8307', Gohma_ObjEyeOpenTimer, x);
  const a = ram[Gohma_ObjEyeOpenTimer + x];
  if ($br('Z_04:8308', a === 0)) {
    // @AnimateClosedEye
    ram[Gohma_ObjEyeAnimCounter + x]++;
    $pxa('Z_04:8349', Gohma_ObjEyeAnimCounter, x);
    if (!$br('Z_04:8351', ram[Gohma_ObjEyeAnimCounter + x] !== 0x08)) {
      ram[Gohma_ObjEyeAnimCounter + x] = 0x00;
      $pxa('Z_04:8357', Gohma_ObjEyeState, x);
      ram[Gohma_ObjEyeState + x] = (ram[Gohma_ObjEyeState + x] & 0x01) ^ 0x01; // @SetEyeStateAndShoot
    }
  } else {
    ram[Gohma_ObjEyeOpenTimer + x]--;
    let y = 0x02; // fully open
    if (!$br('Z_04:8317', a >= 0x70) && !$br('Z_04:8319', a < 0x10)) y = 0x03;
    ram[Gohma_ObjEyeState + x] = y; // @SetEyeStateAndShoot
  }
  // @ShootAnimateCollide
  ram[Gohma_ObjShootTimer + x]--;
  if (!$br('Z_04:8332', ram[Gohma_ObjShootTimer + x] !== 0)) {
    ram[Gohma_ObjShootTimer + x] = 0x41;
    ShootFireball(0x56, x);
  }
  // @AnimateAndCheckCollisions
  $pxa('Z_04:8340', Gohma_ObjEyeState, x);
  Gohma_AnimateAndDraw(ram[Gohma_ObjEyeState + x], x);
  return Gohma_CheckCollisions(x);
}

/** Gohma_AnimateAndDraw (Z_04). A = eye frame image, X = boss: the eye, then the right and left legs. */
export function Gohma_AnimateAndDraw(a, x) {
  // Gohma_AnimateAndDraw (Z_04)
  const eye = a; // PHA
  Anim_FetchObjPosForSpriteDescriptor(x);
  Gohma_SetSpriteAttributes(x);
  DrawObjectMirrored(eye, x); // PLA
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x10, x);
  Gohma_DrawLegsOneSide(0x01, x); // right legs
  return Gohma_DrawLegsOneSide(0x00, x); // left legs: falls through
}

/** Gohma_DrawLegsOneSide (Z_04). Y = side (0 left, 1 right), X = boss: leg frame image 4 or 5. */
export function Gohma_DrawLegsOneSide(y, x) {
  // Gohma_DrawLegsOneSide (Z_04)
  const legX = table(bus.rom, 'GohmaLegOffsetsX');
  $pxa('Z_04:8397', legX.addr, y);
  ram[0x00] = ram[ObjX + x] + legX.byte(y);
  ram[0x01] = ram[ObjY + x];
  Gohma_SetSpriteAttributes(x);
  Anim_SetObjHFlipForSpriteDescriptor(x);
  $pxa('Z_04:8418', ObjAnimFrame, x);
  const a = (((y + ram[ObjAnimFrame + x]) & 0x01) + 0x04) & 0xff;
  return DrawObjectNotMirrored(a, x);
}

/** Gohma_SetSpriteAttributes (Z_04). X = boss: palette row = type - $32 (1 red, 2 blue). @returns A */
export function Gohma_SetSpriteAttributes(x) {
  // Gohma_SetSpriteAttributes (Z_04)
  cpu.c = 1;
  $pxa('Z_04:8429', ObjType, x);
  return Anim_SetSpriteDescriptorAttributes(cpu.sbc(ram[ObjType + x], 0x32));
}

/** Gohma_CheckCollisions (Z_04). X = boss: collisions at five parts 8 pixels apart from X-$10 ([0F] = 5..1). */
export function Gohma_CheckCollisions(x) {
  // Gohma_CheckCollisions (Z_04)
  const savedX = ram[ObjX + x]; // PHA
  ram[ObjX + x] = savedX - 0x10;
  ram[0x0f] = 0x05;
  do {
    // @LoopSprite
    CheckMonsterCollisions(x);
    ram[ObjX + x] = ram[ObjX + x] + 0x08;
    ram[0x0f]--;
  } while ($br('Z_04:8459', ram[0x0f] !== 0));
  ram[ObjX + x] = savedX; // PLA
  return savedX;
}

/**
 * Gohma_HandleWeaponCollision (Z_04). X = boss, Y = weapon slot, [0F] = part (from Gohma_CheckCollisions).
 * An arrow (slot $12) turns into a spark. Damage only for parts 3/4, eye state 3 and a weapon going up;
 * the parry tune is always requested.
 */
export function Gohma_HandleWeaponCollision(x, y) {
  // Gohma_HandleWeaponCollision (Z_04)
  if (!$br('Z_04:8469', y !== 0x12)) {
    ram[ObjState + y] = 0x28;
    ram[ObjAnimCounter + y] = 0x04;
  }
  // @CheckHitEye
  const part = ram[0x0f];
  if (($br('Z_04:8479', part === 0x03) || !$br('Z_04:8481', part !== 0x04))
    && ($pxa('Z_04:8485', Gohma_ObjEyeState, x), !$br('Z_04:8487', ram[Gohma_ObjEyeState + x] !== 0x03))
    && ($pxa('Z_04:8490', ObjDir, y), !$br('Z_04:8492', ram[ObjDir + y] !== 0x08))) {
    ram[SampleRequest] = 0x02; // boss hit
    DealDamage(x);
    PlayBossDeathCryIfNeeded(x);
  }
  // @PlayParryTune
  ram[Tune0Request] = 0x01;
  return 0x01;
}
