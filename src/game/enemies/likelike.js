// P19 — enemies/likelike (Z_04): Like Like swallows Link and eats the magic shield. X = object slot.
import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjCaptureTimer, ObjAnimCounter, ObjAnimFrame, ObjX, ObjY, ObjTimer, ObjMetastate, ObjShoveDir,
  ObjShoveDistance, LinkParalyzed, InvMagicShield,
} from '../../core/vars.js';
import { UpdateCommonWanderer } from './common.js';
import {
  Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored, DrawObjectMirroredOverLink,
} from '../draw/anim.js';
import { HideSpritesOverLink } from '../draw/sprites.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';

/**
 * UpdateLikeLike (Z_04). X = like like. Free: wander (turn rate $80) with a 4-frame animation cycle,
 * draw, collide; on capturing Link, move onto him, stop him and paralyze him. Captured: animate up to
 * frame 3, count the capture time (after $60 frames the magic shield is gone; timer held at $C0), draw
 * over Link; when killed, free Link.
 */
export function UpdateLikeLike(x) {
  // UpdateLikeLike (Z_04)
  $pxa('Z_04:6818', ObjCaptureTimer, x);
  if ($br('Z_04:6819', ram[ObjCaptureTimer + x] !== 0)) return handleCaptured(x);
  UpdateCommonWanderer(0x80, x);
  ram[ObjAnimCounter + x]--;
  if (!$br('Z_04:6826', ram[ObjAnimCounter + x] !== 0)) {
    ram[ObjAnimCounter + x] = 0x08;
    $pxa('Z_04:6829', ObjAnimFrame, x);
    ram[ObjAnimFrame + x] = (ram[ObjAnimFrame + x] + 1) & 0x03;
  }
  // @Draw
  Anim_FetchObjPosForSpriteDescriptor(x);
  $pxa('Z_04:6838', ObjAnimFrame, x);
  DrawObjectMirrored(ram[ObjAnimFrame + x], x);
  CheckMonsterCollisions(x);
  $pxa('Z_04:6843', ObjCaptureTimer, x);
  if ($br('Z_04:6844', ram[ObjCaptureTimer + x] === 0)) return; // @Exit
  ram[ObjX + x] = ram[ObjX];
  ram[ObjY + x] = ram[ObjY];
  ram[ObjTimer] = 0x00;
  ram[ObjMetastate] = 0x00;
  ram[ObjShoveDir] = 0x00;
  ram[ObjShoveDistance] = 0x00;
  ram[ObjAnimFrame + x] = 0x00;
  ram[ObjAnimCounter + x] = 0x04;
  ram[LinkParalyzed]++;
}

/** UpdateLikeLike@HandleCaptured. */
function handleCaptured(x) {
  $pxa('Z_04:6874', ObjAnimFrame, x);
  if (!$br('Z_04:6875', 0x02 < ram[ObjAnimFrame + x])) { // LDA #2 / CMP ObjAnimFrame / BCC
    ram[ObjAnimCounter + x]--;
    if (!$br('Z_04:6877', ram[ObjAnimCounter + x] !== 0)) {
      ram[ObjAnimCounter + x] = 0x04; // ASL: 2 << 1
      ram[ObjAnimFrame + x]++;
    }
  }
  // @IncCaptureTime
  ram[ObjCaptureTimer + x]++;
  $pxa('Z_04:6887', ObjCaptureTimer, x);
  if (!$br('Z_04:6889', ram[ObjCaptureTimer + x] < 0x60)) {
    ram[InvMagicShield] = 0x00;
    ram[ObjCaptureTimer + x] = 0xc0;
  }
  // @DrawAfterCapture
  Anim_FetchObjPosForSpriteDescriptor(x);
  $pxa('Z_04:6901', ObjAnimFrame, x);
  DrawObjectMirroredOverLink(ram[ObjAnimFrame + x], x);
  CheckMonsterCollisions(x);
  $pxa('Z_04:6907', ObjMetastate, x);
  if ($br('Z_04:6908', ram[ObjMetastate + x] === 0)) return; // @Exit
  ram[LinkParalyzed] = 0x00;
  return HideSpritesOverLink();
}
