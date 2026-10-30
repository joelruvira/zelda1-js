// P18 enemyow — enemies/octorok (Z_04): octorok init (also used by ghinis and leevers) and update.
// X = object slot in every routine.

import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
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
  $br('Z_04:1863', true);
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
  $pxa('Z_04:2973', ObjType, x);
  if (!$br('Z_04:2975', ram[ObjType + x] >= 0x09)) a = 0x70;
  ram[ObjTurnRate + x] = a;
  Wanderer_TargetPlayer(x);
  a = 0x20;
  $pxa('Z_04:2984', ObjType, x);
  const t = ram[ObjType + x];
  if (!$br('Z_04:2986', t === 0x07) && !$br('Z_04:2988', t === 0x09)) a = 0x40; // ASL
  // @Shoot
  _TryShooting(a, x, 0x53);
  Anim_FetchObjPosForSpriteDescriptor(x);
  const y = ram[ObjDir + x];
  if (!$br('Z_04:3001', (y & 0x0c) === 0)) {
    if ($br('Z_04:3004', y !== 0x08)) a = 0x02;
    else {
      a = 0x01;
      $br('Z_04:3008', true); // BNE @SaveOffset
    }
  } else {
    // @CheckHorizontal
    if (!$br('Z_04:3013', y !== 0x01)) ram[0x0f]++;
    a = 0x00;
  }
  // @SaveOffset
  let pushed = a; // PHA
  ram[ObjAnimCounter + x]--;
  if (!$br('Z_04:3024', ram[ObjAnimCounter + x] !== 0)) {
    ram[ObjAnimCounter + x] = 0x06;
    $pxa('Z_04:3037', ObjAnimFrame, x);
    ram[ObjAnimFrame + x] = 0x03 ^ ram[ObjAnimFrame + x]; // LSR (6 -> 3) / EOR
  }
  // @CalcFinalOffset
  $pxa('Z_04:3044', ObjAnimFrame, x);
  pushed = (pushed + ram[ObjAnimFrame + x]) & 0xff;
  if (!$br('Z_04:3050', (ram[ObjDir + x] & 0x0c) !== 0)) {
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
