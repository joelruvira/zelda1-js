// P21 — bosses/manhandla (Z_04): Manhandla (levels 3 and 6 / second quest). X = object slot.
// Five segments in slots 1-5 (all type $3C): four hands (1-4) around the base (5). The base turns every
// $10 frames and passes its direction (and any bounce) to every segment; each hand that dies speeds
// the others up by $80; the base dies with the last hand.
import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjDir, ObjType, ObjTimer, ObjMetastate, ObjUninitialized, ObjAttr, ObjHP,
  ObjInvincibilityMask, ObjInvincibilityTimer, Random, SampleRequest,
  Manhandla_ObjSpeedAccum, Manhandla_ObjSpeedFrac, Manhandla_ObjSpeedWhole, Manhandla_ObjPrevFrame,
  Manhandla_ObjFrameAccum, Manhandla_ObjFrame, Manhandla_SegmentJustDied, Manhandla_BounceDir,
} from '../../core/vars.js';
import { PlayBossHitCryIfNeeded, PlayBossDeathCry } from '../enemies/common.js';
import { BoundFlyer, TurnTowardsPlayer8, TurnRandomlyDir8 } from '../enemies/flyer.js';
import { ShootFireball } from '../enemies/shots.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { ResetShoveInfo } from '../movement/shove.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored } from '../draw/anim.js';
import { moveBySpeedAccum } from './digdogger.js';
import { $br, $pxa } from '../../core/timing.js';

// $0384 (ObjMovingLimit+4 in other objects): the base's direction before moving; the asm names it by address.
const BASE_PREV_DIR = 0x0384;

/**
 * InitManhandla (Z_04). X = object: roar, random 8-way direction; segments 5..1 copy slot 1's direction,
 * attributes and HP, type $3C, invincible to boomerang/fire, base frame/attrs, positions around slot 5,
 * speed $0080. @returns A = $80
 */
export function InitManhandla(x) {
  // InitManhandla (Z_04)
  ram[SampleRequest] = 0x40; // Digdogger/Manhandla/Patra roar
  const d8 = table(bus.rom, 'Directions8');
  $pxa('Z_04:7746', d8.addr, ram[Random + x] & 0x07);
  ram[ObjDir + x] = d8.byte(ram[Random + x] & 0x07);
  const frames = table(bus.rom, 'ManhandlaBaseFrameImagesAndAttrs');
  const segX = table(bus.rom, 'ManhandlaSegmentOffsetsX');
  const segY = table(bus.rom, 'ManhandlaSegmentOffsetsY');
  for (let y = 0x04; ; ) {
    ram[ObjDir + 1 + y] = ram[ObjDir + 1];
    ram[ObjType + 1 + y] = 0x3c;
    ram[ObjInvincibilityMask + 1 + y] = 0xe2;
    ram[Manhandla_ObjFrame + 1 + y] = frames.byte(y);
    ram[ObjMetastate + 1 + y] = 0x00;
    ram[ObjUninitialized + 1 + y] = 0x00;
    ram[ObjAttr + 1 + y] = ram[ObjAttr + 1];
    ram[ObjHP + 1 + y] = ram[ObjHP + 1];
    $pxa('Z_04:7790', segX.addr, y);
    ram[ObjX + 1 + y] = ram[ObjX + 5] + segX.byte(y);
    $pxa('Z_04:7794', segY.addr, y);
    ram[ObjY + 1 + y] = ram[ObjY + 5] + segY.byte(y);
    ram[Manhandla_ObjSpeedFrac + 1 + y] = 0x80;
    y--;
    if (!$br('Z_04:7801', y >= 0)) break;
  }
  return 0x80;
}

/**
 * UpdateManhandla (Z_04). X = segment. The base (5): speed up all segments after a death, apply the bounce
 * direction, turn every $10 frames. Every segment: move, collisions, bounce direction if it changed,
 * animation frame from the frame accumulator; a hand whose frame changed to 0 may shoot a fireball $56
 * (Random+1 >= $E0 and slot 7 empty). Then draw.
 */
export function UpdateManhandla(x) {
  // UpdateManhandla (Z_04)
  if (!$br('Z_04:7835', x !== 0x05)) {
    if (!$br('Z_04:7839', ram[Manhandla_SegmentJustDied] === 0)) {
      for (let y = 0x04; ;) {
        // @LoopSegment
        cpu.c = 0;
        $pxa('Z_04:7846', Manhandla_ObjSpeedFrac + 1, y);
        ram[Manhandla_ObjSpeedFrac + 1 + y] = cpu.adc(ram[Manhandla_ObjSpeedFrac + 1 + y], 0x80);
        $pxa('Z_04:7852', Manhandla_ObjSpeedWhole + 1, y);
        ram[Manhandla_ObjSpeedWhole + 1 + y] = cpu.adc(ram[Manhandla_ObjSpeedWhole + 1 + y], 0x00);
        y--;
        if (!$br('Z_04:7856', y >= 0)) break;
      }
      ram[Manhandla_SegmentJustDied] = 0x00;
    }
    // @BounceIfNeeded
    if (!$br('Z_04:7866', ram[Manhandla_BounceDir] === 0)) Manhandla_SetAllSegmentsDirection(ram[Manhandla_BounceDir]);
    // @TurnIfNeeded
    if (!$br('Z_04:7875', ram[ObjTimer + x] !== 0)) {
      ram[ObjTimer + x] = 0x10;
      if ($br('Z_04:7880', ram[Random + x] >= 0x80)) TurnTowardsPlayer8(x); // @TurnTowardLink
      else TurnRandomlyDir8(x);
      // @CopyDirToHands
      ram[Manhandla_BounceDir] = ram[ObjDir + 5];
      Manhandla_SetAllSegmentsDirection(ram[ObjDir + 5]);
    }
  }
  // @MoveBase
  if (!$br('Z_04:7895', x !== 0x05)) ram[BASE_PREV_DIR] = ram[ObjDir + x];
  Manhandla_Move(x);
  Manhandla_CheckCollisions(x);
  let a = ram[ObjDir + x];
  if (!$br('Z_04:7906', a === ram[BASE_PREV_DIR])) ram[Manhandla_BounceDir] = a;
  $pxa('Z_04:7911', Manhandla_ObjFrameAccum, x);
  ram[0x00] = (ram[Manhandla_ObjFrameAccum + x] & 0x10) >> 4;
  $pxa('Z_04:7921', Manhandla_ObjFrame, x);
  ram[Manhandla_ObjFrame + x] = (ram[Manhandla_ObjFrame + x] & 0xfe) | ram[0x00];
  if (!$br('Z_04:7928', x === 0x05)) {
    $pxa('Z_04:7935', Manhandla_ObjFrame, x); $pxa('Z_04:7936', Manhandla_ObjPrevFrame, x);
    a = ram[Manhandla_ObjFrame + x];
    if (!$br('Z_04:7937', a === ram[Manhandla_ObjPrevFrame + x])) {
      ram[Manhandla_ObjPrevFrame + x] = a;
      if (!$br('Z_04:7947', (a & 0x01) !== 0) && !$br('Z_04:7955', ram[Random + 1 + x] < 0xe0)
        && !$br('Z_04:7957', ram[ObjType + 7] !== 0)) {
        ShootFireball(0x56, x); // unblockable fireball
      }
    }
  }
  // @Draw
  return Manhandla_Draw(x);
}

/**
 * Manhandla_CheckCollisions (Z_04). X = segment: collisions without letting them change direction or
 * timer; the base is never temporarily invincible and never dies on its own. A dying hand becomes a dead
 * dummy, or if it was the last one the base does ($5D, metastate $10, timer $10, death cry); either way
 * Manhandla_SegmentJustDied++.
 */
export function Manhandla_CheckCollisions(x) {
  // Manhandla_CheckCollisions (Z_04)
  const dir = ram[ObjDir + x]; // PHA
  const timer = ram[ObjTimer + x]; // PHA
  CheckMonsterCollisions(x);
  ram[ObjTimer + x] = timer; // PLA
  ram[ObjDir + x] = dir; // PLA
  if (!$br('Z_04:7982', x !== 0x05)) ram[ObjInvincibilityTimer + x] = 0x00;
  PlayBossHitCryIfNeeded(x);
  $pxa('Z_04:7989', ObjMetastate, x);
  if ($br('Z_04:7990', ram[ObjMetastate + x] === 0)) return; // @Exit
  const a = ResetShoveInfo(x);
  if (!$br('Z_04:7998', x !== 0x05)) {
    ram[ObjMetastate + x] = a;
    return;
  }
  // @CountHands
  ram[0x00] = 0x00;
  for (let y = 0x03; ;) {
    $pxa('Z_04:8015', ObjType + 1, y);
    if (!$br('Z_04:8017', ram[ObjType + 1 + y] !== 0x3c)) ram[0x00]++;
    y--;
    if (!$br('Z_04:8021', y >= 0)) break;
  }
  ram[0x00]--;
  if (!$br('Z_04:8028', (ram[0x00] & 0x80) !== 0) && $br('Z_04:8029', ram[0x00] !== 0)) {
    // @MakeDeadDummy
    ram[ObjType + x] = 0x5d;
  } else {
    // The last hand died: kill the base.
    PlayBossDeathCry();
    ram[ObjType + 5] = 0x5d;
    ram[ObjMetastate + 5] = 0x10;
    ram[ObjTimer + 5] = 0x10;
  }
  // @FlagHandDied
  ram[Manhandla_SegmentJustDied]++;
}

/** Manhandla_SetAllSegmentsDirection (Z_04). A = direction for slots 5..1. */
export function Manhandla_SetAllSegmentsDirection(a) {
  // Manhandla_SetAllSegmentsDirection (Z_04)
  for (let y = 0x04; ;) { ram[ObjDir + 1 + y] = a; y--; if (!$br('Z_04:8064', y >= 0)) break; }
}

/**
 * Manhandla_Move (Z_04). X = segment: speed accumulator movement (see Digdogger_Move), frame accumulator
 * += (Random+1 & 3) + [03] (+ carry), room bounds. @returns A = 0 (Anim_FetchObjPosForSpriteDescriptor)
 */
export function Manhandla_Move(x) {
  // Manhandla_Move (Z_04)
  moveBySpeedAccum(x, Manhandla_ObjSpeedFrac, Manhandla_ObjSpeedWhole, Manhandla_ObjSpeedAccum,
    ['Z_04:8084', 'Z_04:8087', 'Z_04:8091', 'Z_04:8107', 'Z_04:8118', 'Z_04:8128', 'Z_04:8138']);
  // @IncFrameAccum
  cpu.c = 0;
  const a = cpu.adc(ram[Random + 1 + x] & 0x03, ram[0x03]);
  $pxa('Z_04:8151', Manhandla_ObjFrameAccum, x);
  ram[Manhandla_ObjFrameAccum + x] = cpu.adc(a, ram[Manhandla_ObjFrameAccum + x]);
  BoundFlyer(x);
  return Anim_FetchObjPosForSpriteDescriptor(x);
}

/**
 * Manhandla_Draw (Z_04). X = segment: blue palette, vertical flip from bit 7 and horizontal from bit 6 of
 * Manhandla_ObjFrame; frame images 2/3 (horizontal hands) not mirrored, the others mirrored.
 */
export function Manhandla_Draw(x) {
  // Manhandla_Draw (Z_04)
  Anim_FetchObjPosForSpriteDescriptor(x);
  $pxa('Z_04:8162', Manhandla_ObjFrame, x);
  const f = ram[Manhandla_ObjFrame + x]; // PHA
  Anim_SetSpriteDescriptorAttributes((f & 0x80) | 0x01);
  if (!$br('Z_04:8175', (f & 0x40) === 0)) ram[0x0f]++;
  const a = f & 0x0f;
  if ($br('Z_04:8186', a === 0x02) || $br('Z_04:8188', a === 0x03)) return DrawObjectNotMirrored(a, x);
  return DrawObjectMirrored(a, x);
}
