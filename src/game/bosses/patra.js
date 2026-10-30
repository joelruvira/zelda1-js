// P22 — bosses/patra (Z_04): Patra (types $47/$48) and its 8 orbiting children ($25/$26) in slots 2-9.
// X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjDir, ObjType, ObjState, ObjTimer, ObjMetastate, ObjAttr, ObjInvincibilityMask,
  ObjInvincibilityTimer, ObjAngleWhole, ObjRefId, ObjAnimFrame, Flyer_ObjSpeed, Flyer_ObjFlyingState,
  Flyer_ObjTurns, Flyer_ObjOffsetX, Flyer_ObjOffsetY, FlyingMaxSpeedFrac, SampleRequest, Random,
  Patra_ObjManeuverIndex,
} from '../../core/vars.js';
import { MoveFlyer, Flyer_SpeedUp, Flyer_Chase, Flyer_Wander } from '../enemies/flyer.js';
import { AnimateAndDrawCommonObject } from '../enemies/keese-bubble.js';
import { CheckMonsterCollisions, CheckLinkCollision } from '../combat/collisions.js';
import { PlayBossHitCryIfNeeded, PlayBossDeathCryIfNeeded, DecreaseObjectAngle, RotateObjectLocation } from '../enemies/common.js';
import { Anim_SetSpriteDescriptorRedPaletteRow } from '../draw/sprites.js';
import { Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';
import { SetDeadDummyObjType } from './zelda.js';
import { $br, $pxa } from '../../core/timing.js';

/**
 * InitPatra (Z_04). X = Patra: weak only to the sword, at ($80, $70) facing up, speed $1F (max $40),
 * roar, maneuver timer $FF (ObjTimer+1,X); children $25 (Patra $47) or $26 in slots 2-9.
 */
export function InitPatra(x) {
  // InitPatra (Z_04)
  ram[ObjInvincibilityMask + x] = 0xfe;
  ram[ObjX + x] = 0x80;
  ram[ObjY + x] = 0x70;
  ram[ObjDir + x] = 0x08;
  ram[Flyer_ObjSpeed + x] = 0x1f;
  ram[FlyingMaxSpeedFrac] = 0x40;
  ram[SampleRequest] = 0x40;
  ram[ObjTimer + 1 + x] = 0xff;
  let a = $br('Z_04:9555', ram[ObjType + 1] === 0x47) ? 0x25 : 0x26;
  ram[0x00] = a;
  for (let y = 2; ;) {
    ram[ObjType + y] = ram[0x00];
    ram[ObjInvincibilityMask + y] = 0xfe;
    y++;
    if (!$br('Z_04:9568', y !== 0x0a)) break;
  }
}

/**
 * Y as CheckMonsterCollisions leaves it (its port does not return Y): 0 (the caller's Y) when it
 * returns early for a temporarily invincible object, else ObjMetastate,X — or the goriya's ObjRefId
 * when a dying goriya with a boomerang destroys it.
 */
function cmcY(x, y, earlyExit) {
  if (earlyExit) return y;
  const m = ram[ObjMetastate + x];
  if (m === 0) return m;
  const t = ram[ObjType + x];
  if ((t === 0x05 || t === 0x06) && (ram[ObjState + x] & 0x80)) return ram[ObjRefId + x];
  return m;
}

/**
 * UpdatePatra (Z_04). X = Patra: fly (offsets reset first, for the children), draw. With children left
 * only Link can be hurt; without them it can be hit. Flips the maneuver when its timer and the angle of
 * slot 3 are 0 (the time comes from PatraManeuverTimes,Y with the Y the collision routines leave).
 */
export function UpdatePatra(x) {
  // UpdatePatra (Z_04)
  ControlPatraFlight(x);
  ram[Flyer_ObjOffsetX + x] = 0x00;
  ram[Flyer_ObjOffsetY + x] = 0x00;
  MoveFlyer(x);
  AnimateAndDrawCommonObject(0x02, x);
  let y = 0x08;
  let child = false;
  do {
    $pxa('Z_04:10049', ObjType + 1, y);
    const t = ram[ObjType + 1 + y];
    if ($br('Z_04:10051', t === 0x25) || $br('Z_04:10053', t === 0x26)) { child = true; break; }
    y--;
  } while ($br('Z_04:10055', y !== 0));
  if (!child) {
    const early = (ram[ObjAttr + x] & 0x20) === 0 && ram[ObjInvincibilityTimer + x] !== 0;
    CheckMonsterCollisions(x);
    y = cmcY(x, y, early);
    PlayBossHitCryIfNeeded(x);
    PlayBossDeathCryIfNeeded(x);
  } else {
    CheckLinkCollision(x);
    y = 0x00; // CheckLinkCollision always leaves Y = [00] = 0
  }
  // @TryChangeManeuver
  if ($br('Z_04:10073', (ram[ObjTimer + 1 + x] | ram[ObjAngleWhole + 3]) !== 0)) return;
  $pxa('Z_04:10074', Patra_ObjManeuverIndex, x);
  ram[Patra_ObjManeuverIndex + x] ^= 0x01;
  const times = table(bus.rom, 'PatraManeuverTimes');
  $pxa('Z_04:10081', times.addr, y);
  ram[ObjTimer + 1 + x] = times.byte(y); // TYA (not TAY): Y is used
}

/** ControlPatraFlight (Z_04). X = Patra: dispatch on the flying state. */
export function ControlPatraFlight(x) {
  // ControlPatraFlight (Z_04)
  $pxa('Z_04:10088', Flyer_ObjFlyingState, x);
  return tableJump(label('ControlPatraFlight_JumpTable').addr, ram[Flyer_ObjFlyingState + x], [
    () => Flyer_SpeedUp(x), () => Flyer_PatraDecideState(x), () => Flyer_Chase(x), () => Flyer_Wander(x),
  ]);
}

/** Flyer_PatraDecideState (Z_04). X = Patra: state 2 (Random >= $40) or 3, 8 turns. @returns A = 8 */
export function Flyer_PatraDecideState(x) {
  // Flyer_PatraDecideState (Z_04)
  let y = 0x02;
  if (!$br('Z_04:10106', ram[Random + x] >= 0x40)) y++;
  ram[Flyer_ObjFlyingState + x] = y;
  ram[Flyer_ObjTurns + x] = 0x08;
  return 0x08;
}

/**
 * UpdatePatraChild (Z_04). X = child. State 0: appear at the top of the orbit one at a time (slot 2
 * first, the others when slot 2 reaches PatraChildStartAngles[X-3]); the last one (9) frees Patra.
 */
export function UpdatePatraChild(x) {
  // UpdatePatraChild (Z_04)
  if ($br('Z_04:10130', ram[ObjState + x] !== 0)) return PatraChild_State1(x);
  if (!$br('Z_04:10137', x === 0x02)) {
    if ($br('Z_04:10145', ram[ObjState + 2] === 0)) return;
    const y = (x - 3) & 0xff;
    const starts = table(bus.rom, 'PatraChildStartAngles');
    $pxa('Z_04:10160', starts.addr, y);
    if ($br('Z_04:10161', ram[ObjAngleWhole + 2] !== starts.byte(y))) return;
  }
  // @Ready
  if (!$br('Z_04:10167', x !== 0x09)) ram[ObjState + 1]++;
  ram[ObjState + x]++;
  ram[ObjDir + x] = 0x80;
  ram[ObjAngleWhole + x] = 0x18; // N
  ram[ObjX + x] = ram[ObjX + 1];
  $pxa('Z_04:10190', ObjType, x);
  ram[0x00] = $br('Z_04:10192', ram[ObjType + x] === 0x25) ? 0x2c : 0x18;
  ram[ObjY + x] = ram[ObjY + 1] - ram[0x00];
}

/**
 * PatraChild_State1 (Z_04, part of UpdatePatraChild). Follow Patra, orbit (angle -$70 for $25, -$60
 * for $26; bit counts by maneuver), draw; once all children are out, collide (killed: dead dummy).
 */
export function PatraChild_State1(x) {
  ram[ObjX + x] = ram[ObjX + x] + ram[Flyer_ObjOffsetX + 1];
  ram[ObjY + x] = ram[ObjY + x] + ram[Flyer_ObjOffsetY + 1];
  ram[0x0b] = 0x00;
  $pxa('Z_04:10225', ObjType, x);
  DecreaseObjectAngle($br('Z_04:10227', ram[ObjType + x] === 0x25) ? 0x70 : 0x60, x);
  let y = ram[Patra_ObjManeuverIndex + 1];
  let a;
  $pxa('Z_04:10239', ObjType, x);
  if (!$br('Z_04:10241', ram[ObjType + x] !== 0x25)) {
    const cos = table(bus.rom, 'PatraChild1RotationCosineBits');
    const sin = table(bus.rom, 'PatraChild1RotationSineBits');
    $pxa('Z_04:10242', cos.addr, y);
    a = cos.byte(y);
    $pxa('Z_04:10244', sin.addr, y);
    y = sin.byte(y);
  } else {
    // @UsePatraChild2Bits
    const bits = table(bus.rom, 'PatraChild2RotationBits');
    $pxa('Z_04:10253', bits.addr, y);
    a = bits.byte(y);
    y = a;
  }
  // @Rotate
  ram[ObjY + x] = RotateObjectLocation(a, x, y);
  PatraChild_Draw(x);
  if ($br('Z_04:10264', ram[ObjState + 1] === 0)) return;
  CheckMonsterCollisions(x);
  $pxa('Z_04:10268', ObjMetastate, x);
  if ($br('Z_04:10269', ram[ObjMetastate + x] === 0)) return;
  SetDeadDummyObjType(x);
}

/** PatraChild_Draw (Z_04). X = child: red palette row, animate (counter 2) and draw. */
export function PatraChild_Draw(x) {
  // PatraChild_Draw (Z_04)
  const a = Anim_SetSpriteDescriptorRedPaletteRow(); // returns A = 2
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(a, x);
  $pxa('Z_04:10281', ObjAnimFrame, x);
  return DrawObjectNotMirrored(ram[ObjAnimFrame + x], x);
}
