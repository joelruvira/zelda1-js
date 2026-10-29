// P19 — enemies/likelike (Z_04): Like Like swallows Link and eats the magic shield. X = object slot.
import { ram } from '../../core/ram.js';
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
  if (ram[ObjCaptureTimer + x] !== 0) return handleCaptured(x);
  UpdateCommonWanderer(0x80, x);
  ram[ObjAnimCounter + x]--;
  if (ram[ObjAnimCounter + x] === 0) {
    ram[ObjAnimCounter + x] = 0x08;
    ram[ObjAnimFrame + x] = (ram[ObjAnimFrame + x] + 1) & 0x03;
  }
  // @Draw
  Anim_FetchObjPosForSpriteDescriptor(x);
  DrawObjectMirrored(ram[ObjAnimFrame + x], x);
  CheckMonsterCollisions(x);
  if (ram[ObjCaptureTimer + x] === 0) return; // @Exit
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
  if (!(0x02 < ram[ObjAnimFrame + x])) { // LDA #2 / CMP ObjAnimFrame / BCC
    ram[ObjAnimCounter + x]--;
    if (ram[ObjAnimCounter + x] === 0) {
      ram[ObjAnimCounter + x] = 0x04; // ASL: 2 << 1
      ram[ObjAnimFrame + x]++;
    }
  }
  // @IncCaptureTime
  ram[ObjCaptureTimer + x]++;
  if (ram[ObjCaptureTimer + x] >= 0x60) {
    ram[InvMagicShield] = 0x00;
    ram[ObjCaptureTimer + x] = 0xc0;
  }
  // @DrawAfterCapture
  Anim_FetchObjPosForSpriteDescriptor(x);
  DrawObjectMirroredOverLink(ram[ObjAnimFrame + x], x);
  CheckMonsterCollisions(x);
  if (ram[ObjMetastate + x] === 0) return; // @Exit
  ram[LinkParalyzed] = 0x00;
  return HideSpritesOverLink();
}
