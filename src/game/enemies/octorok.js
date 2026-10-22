// P18 enemyow — enemies/octorok (Z_04): octorok init (also used by ghinis and leevers) and update.
// X = object slot in every routine.

import { ram } from '../../core/ram.js';
import {
  ObjQSpeedFrac, ObjTimer, ObjAnimFrame, ObjAnimCounter, ObjType, ObjTurnRate, ObjDir,
} from '../../core/vars.js';
import { ResetObjState } from '../weapons/sword.js';
import { InitWalker, Wanderer_TargetPlayer } from './common.js';
import { _TryShooting } from './shots.js';
import {
  Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored,
} from '../draw/anim.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';

/** InitSlowOctorockOrGhini (Z_04). X = object: q-speed $20. */
export function InitSlowOctorockOrGhini(x) {
  // InitSlowOctorockOrGhini (Z_04)
  return initOctorockWithQSpeed(0x20, x); // BNE :+
}

/** InitFastOctorock (Z_04). X = object: q-speed $30. */
export function InitFastOctorock(x) {
  // InitFastOctorock (Z_04)
  return initOctorockWithQSpeed(0x30, x);
}

/** InitFastOctorock@: (shared tail). A = q-speed. Spawn cloud timer ((slot + 1) * $10). */
function initOctorockWithQSpeed(a, x) {
  ram[ObjQSpeedFrac + x] = a;
  ram[ObjTimer + x] = ((x + 1) << 4) & 0xff;
  a = ResetObjState(x);
  ram[ObjAnimFrame + x] = a;
  ram[ObjAnimCounter + x] = 0x06;
  return InitWalker(x); // JMP
}

/**
 * UpdateOctorock (Z_04). X = octorock: wander (turn rate $A0 blue / $70 red), maybe shoot a flying
 * rock ($53), animate (frame sets 0/3, direction offsets 0/1/2) and draw, then check collisions.
 */
export function UpdateOctorock(x) {
  // UpdateOctorock (Z_04)
  let a = 0xa0;
  if (ram[ObjType + x] < 0x09) a = 0x70;
  ram[ObjTurnRate + x] = a;
  Wanderer_TargetPlayer(x);
  a = 0x20;
  const t = ram[ObjType + x];
  if (t !== 0x07 && t !== 0x09) a = 0x40; // ASL
  // @Shoot
  _TryShooting(a, x, 0x53);
  Anim_FetchObjPosForSpriteDescriptor(x);
  const y = ram[ObjDir + x];
  if (y & 0x0c) {
    a = y !== 0x08 ? 0x02 : 0x01;
  } else {
    // @CheckHorizontal
    if (y === 0x01) ram[0x0f]++;
    a = 0x00;
  }
  // @SaveOffset
  let pushed = a; // PHA
  ram[ObjAnimCounter + x]--;
  if (ram[ObjAnimCounter + x] === 0) {
    ram[ObjAnimCounter + x] = 0x06;
    ram[ObjAnimFrame + x] = 0x03 ^ ram[ObjAnimFrame + x]; // LSR (6 -> 3) / EOR
  }
  // @CalcFinalOffset
  pushed = (pushed + ram[ObjAnimFrame + x]) & 0xff;
  if ((ram[ObjDir + x] & 0x0c) === 0) {
    DrawObjectNotMirrored(pushed, x);
    return CheckMonsterCollisions(x);
  }
  // @DrawMirrored
  return DrawObjectMirroredAndCheckCollisions(pushed, x); // falls through
}

/** DrawObjectMirroredAndCheckCollisions (Z_04). A = frame image, X = object; [00]/[01] position. */
export function DrawObjectMirroredAndCheckCollisions(a, x) {
  // DrawObjectMirroredAndCheckCollisions (Z_04)
  DrawObjectMirrored(a, x);
  return CheckMonsterCollisions(x);
}
