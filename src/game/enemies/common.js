// P17 enemycore — enemies/common (Z_04): boss cries, walker init, the common wanderer AI (turn towards
// the chase target and flag "wants to shoot"), and the rotation helpers used by Patra's children and the
// pond fairy's hearts. X = object slot in every routine.
//
// L_Walker_SetInputDirAndTryShootingBoomerang belongs to P19 (enemies/goriya.js). It is looked up in that
// module at call time (a namespace import, so the cycle goriya.js <-> common.js is harmless) and falls
// back to a stub until P19 exports it.

import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjInvincibilityTimer, SampleRequest, EffectRequest, ObjMetastate, ObjTimer, ObjDir, ChaseTargetX,
  ChaseTargetY, ObjX, ObjY, ObjTurnRate, ObjShoveDir, InvClock, ObjStunTimer, ObjType, ObjState,
  ObjTurnTimer, ObjQSpeedFrac, ObjGridOffset, Random, ObjWantsToShoot, ObjAngleWhole, ObjAngleFrac,
} from '../../core/vars.js';
import { Obj_Shove } from '../movement/shove.js';
import { Walker_Move } from '../movement/walker.js';
import * as goriya from './goriya.js';
import { stubX } from '../stub.js';

const walkerSetInputDirStub = stubX('L_Walker_SetInputDirAndTryShootingBoomerang');
/** L_Walker_SetInputDirAndTryShootingBoomerang (Z_04, P19): the real port when it exists. */
function L_Walker_SetInputDirAndTryShootingBoomerang(x) {
  return (goriya.L_Walker_SetInputDirAndTryShootingBoomerang ?? walkerSetInputDirStub)(x);
}

/** PlayBossHitCryIfNeeded (Z_04). X = boss: the boss cry when its invincibility timer is exactly $10. */
export function PlayBossHitCryIfNeeded(x) {
  // PlayBossHitCryIfNeeded (Z_04)
  const a = ram[ObjInvincibilityTimer + x];
  if (a !== 0x10) return a;
  ram[SampleRequest] = 0x02;
  return 0x02;
}

/** PlayBossDeathCryIfNeeded (Z_04). X = boss: the death cry once it is dying (metastate <> 0). */
export function PlayBossDeathCryIfNeeded(x) {
  // PlayBossDeathCryIfNeeded (Z_04)
  const a = ram[ObjMetastate + x];
  if (a === 0) return a; // the RTS of PlayBossHitCryIfNeeded
  return PlayBossDeathCry();
}

/** PlayBossDeathCry (Z_04): boss cry sample and the death effect. @returns A = $80 */
export function PlayBossDeathCry() {
  // PlayBossDeathCry (Z_04)
  ram[SampleRequest] = 0x02;
  ram[EffectRequest] = 0x80;
  return 0x80;
}

/** Unused_10021 (Z_04, unverified, unreferenced): object timer $80, then InitWalker. */
export function Unused_10021(x) {
  // Unused_10021 (Z_04)
  ram[ObjTimer + x] = 0x80;
  return InitWalker(x); // falls through
}

/**
 * InitWalker (Z_04). X = object. If no facing direction is set yet, face along the axis with the
 * longer distance to the chase target (unsigned compare, as the original). Uses [00]/[01].
 */
export function InitWalker(x) {
  // InitWalker (Z_04)
  if (ram[ObjDir + x] !== 0) return; // @Exit
  let y = 0x02;
  let d = ram[ChaseTargetX] - ram[ObjX + x];
  if (d < 0) y--; // BCS
  ram[0x00] = d;
  ram[0x01] = y;
  ram[ObjDir + x] = y;
  y = 0x04;
  d = ram[ChaseTargetY] - ram[ObjY + x];
  if (d < 0) y = 0x08;
  ram[ObjDir + x] = y;
  if ((d & 0xff) < ram[0x00]) return; // BCC @Exit
  ram[ObjDir + x] = ram[0x01];
}

/**
 * UpdateCommonWanderer (Z_04). A = turn rate, X = object. Shove if being shoved; otherwise, without
 * the clock and not stunned, Wanderer_TargetPlayer.
 */
export function UpdateCommonWanderer(a, x) {
  // UpdateCommonWanderer (Z_04)
  ram[ObjTurnRate + x] = a;
  if (ram[ObjShoveDir + x] !== 0) return Obj_Shove(x);
  if ((ram[InvClock] | ram[ObjStunTimer + x]) !== 0) return; // Exit
  return Wanderer_TargetPlayer(x);
}

/** Unused_10082 (Z_04, unverified, unreferenced): turn rate by type, then Wanderer_TargetPlayer. */
export function Unused_10082(x) {
  // Unused_10082 (Z_04)
  let a = 0x70;
  if (ram[ObjType + x] !== 0x05) a = 0xa0;
  ram[ObjTurnRate + x] = a;
  if (ram[ObjState + x] & 0x80) return; // BMI Exit
  return Wanderer_TargetPlayer(x); // falls through
}

/**
 * Wanderer_TargetPlayer (Z_04). X = object. Walk; on a square boundary maybe turn towards the chase
 * target (then "wants to shoot" = 1) or turn perpendicular when the turn timer expires; finally set the
 * input direction (L_Walker_SetInputDirAndTryShootingBoomerang). Exit is its RTS.
 */
export function Wanderer_TargetPlayer(x) {
  // Wanderer_TargetPlayer (Z_04)
  if (ram[ObjTurnTimer + x] !== 0) ram[ObjTurnTimer + x]--;
  Walker_Move(x);
  if (ram[ObjShoveDir + x] !== 0) return; // Exit
  if (ram[ObjQSpeedFrac + x] === 0) return L_Walker_SetInputDirAndTryShootingBoomerang(x);
  const g = ram[ObjGridOffset + x] & 0x0f;
  if (g !== 0) return L_Walker_SetInputDirAndTryShootingBoomerang(x);
  ram[ObjGridOffset + x] = g;

  let step; // which label to continue at
  if (ram[ObjTurnRate + x] < ram[Random + 1 + x]) step = 'turnIfTime';
  else if (ram[ObjState] === 0xff) step = 'turnIfTime';
  else {
    let d = (ram[ChaseTargetX] - ram[ObjX + x]) & 0xff;
    if (d & 0x80) d = ((d ^ 0xff) + 1) & 0xff;
    if (d < 0x09) step = 'vertical';
    else {
      // @CheckVerticalDistance
      d = (ram[ChaseTargetY] - ram[ObjY + x]) & 0xff;
      if (d & 0x80) d = ((d ^ 0xff) + 1) & 0xff;
      step = d >= 0x09 ? 'turnIfTime' : 'horizontal';
    }
  }
  if (step === 'turnIfTime') {
    // @TurnIfTime
    ram[ObjWantsToShoot + x] = 0x00;
    if (ram[ObjTurnTimer + x] !== 0) return L_Walker_SetInputDirAndTryShootingBoomerang(x);
    step = (ram[ObjDir + x] & 0x0c) !== 0 ? 'horizontal' : 'vertical';
  }
  let y;
  if (step === 'vertical') {
    // @TurnVertically
    y = ram[ChaseTargetY] < ram[ObjY + x] ? 0x08 : 0x04;
  } else {
    // @TurnHorizontally
    y = ram[ChaseTargetX] >= ram[ObjX + x] ? 0x01 : 0x02;
  }
  // @SetDirTowardTarget
  ram[ObjDir + x] = y;
  ram[ObjTurnTimer + x] = ram[Random + x];
  ram[ObjWantsToShoot + x] = 0x01;
  return L_Walker_SetInputDirAndTryShootingBoomerang(x);
}

// Coordinate fractions used by RotateObjectLocation: the asm addresses them as $0412,X / $041F,X.
const ROT_FRAC_X = 0x0412;
const ROT_FRAC_Y = 0x041f;

/**
 * RotateObjectLocation (Z_04). A = high bits of cosine (Y increment), X = object, Y = high bits of sine
 * (X increment). Moves ObjX along the circle; uses [00]-[03], [05], [06].
 * @returns A = new Y coordinate (the caller stores it)
 */
export function RotateObjectLocation(a, x, y) {
  // RotateObjectLocation (Z_04)
  const sines = table(bus.rom, 'PatraSines');
  ram[0x06] = a;
  ram[0x05] = y;
  ram[0x00] = sines.byte(ram[ObjAngleWhole + x] & 0x0f);
  ShiftMultiply(ram[ObjQSpeedFrac + x], ram[0x05]);
  let r;
  if ((ram[ObjAngleWhole + x] & 0x18) >= 0x10) {
    r = ram[ROT_FRAC_X + x] - ram[0x02];
    const c = r >= 0 ? 1 : 0;
    ram[ROT_FRAC_X + x] = r;
    r = ram[ObjX + x] - ram[0x03] - (1 - c);
  } else {
    // @AddToX
    r = ram[ROT_FRAC_X + x] + ram[0x02];
    const c = r >> 8;
    ram[ROT_FRAC_X + x] = r;
    r = ram[ObjX + x] + ram[0x03] + c;
  }
  // @SetXRotateY
  ram[ObjX + x] = r;
  ram[0x00] = sines.byte((ram[ObjAngleWhole + x] + 0x08) & 0x0f);
  ShiftMultiply(ram[ObjQSpeedFrac + x], ram[0x06]);
  if (((ram[ObjAngleWhole + x] - 0x08) & 0x18) >= 0x10) {
    r = ram[ROT_FRAC_Y + x] - ram[0x02];
    const c = r >= 0 ? 1 : 0;
    ram[ROT_FRAC_Y + x] = r;
    r = ram[ObjY + x] - ram[0x03] - (1 - c);
    cpu.c = r >= 0 ? 1 : 0;
    return r & 0xff;
  }
  // @AddToY
  r = ram[ROT_FRAC_Y + x] + ram[0x02];
  const c = r >> 8;
  ram[ROT_FRAC_Y + x] = r;
  r = ram[ObjY + x] + ram[0x03] + c;
  cpu.c = r >> 8;
  return r & 0xff;
}

/**
 * ShiftMultiply (Z_04). A = multiplicand, Y = number of high bits of [00] to use (0 = 256), [00] =
 * multiplier (shifted out). Leaves [01] = multiplicand, [02:03] = product. @returns A
 */
export function ShiftMultiply(a, y) {
  // ShiftMultiply (Z_04)
  ram[0x01] = a;
  a = 0x00;
  ram[0x02] = a;
  ram[0x03] = a;
  y &= 0xff;
  do {
    // @Loop
    let c = ram[0x02] >> 7; // ASL $02
    ram[0x02] = ram[0x02] << 1;
    ram[0x03] = (ram[0x03] << 1) | c; // ROL $03 (its carry out is overwritten by the next ASL)
    c = ram[0x00] >> 7; // ASL $00
    ram[0x00] = ram[0x00] << 1;
    if (c) {
      a = ram[0x02] + ram[0x01];
      ram[0x02] = a;
      if (a > 0xff) ram[0x03]++; // unverified code 13453
      a &= 0xff;
    }
    // @Next
    y = (y - 1) & 0xff;
  } while (y !== 0);
  return a;
}

/**
 * DecreaseObjectAngle (Z_04). A = low amount, X = object, [0B] = high amount. Subtracts the 16-bit
 * amount from the angle; the whole part is capped to $1F. Uses [0A]. @returns A = new whole angle
 */
export function DecreaseObjectAngle(a, x) {
  // DecreaseObjectAngle (Z_04)
  ram[0x0a] = a;
  const f = ram[ObjAngleFrac + x] - ram[0x0a];
  const c = f >= 0 ? 1 : 0;
  ram[ObjAngleFrac + x] = f;
  a = (ram[ObjAngleWhole + x] - ram[0x0b] - (1 - c)) & 0x1f;
  ram[ObjAngleWhole + x] = a;
  return a;
}
