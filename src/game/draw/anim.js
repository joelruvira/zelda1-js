// P04 draw — object animation (walking counters, meta-object clouds/sparks) and the
// DrawObject* family that looks frames up in ObjAnimations / ObjAnimFrameHeap / ObjAnimAttrHeap.
// Z_01 (RAM_01_CODE), Z_04, Z_05 and Z_07 routines.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjDir, ObjType, ObjAttr, ObjTimer, ObjMetastate, ObjAnimCounter, ObjAnimFrame,
  RollingSpriteIndex, LeftSpriteOffset, RightSpriteOffset,
} from '../../core/vars.js';
import {
  Anim_SetSpriteDescriptorAttributes, Anim_WriteHorizontallyFlippableSpritePair,
  Anim_WriteMirroredSpritePair, Anim_WriteSpritePair,
} from './sprites.js';
import { Anim_WriteItemSprites } from './items.js';
import { AnimateLinkObjState } from '../link/anim.js';
import { DrawCloud } from '../weapons/bomb.js';

// ---------------------------------------------------------------- DrawObject*

/** X object index. @returns X = [08] */
export function AnimateAndDrawObjectWalking(x) {
  // AnimateAndDrawObjectWalking (Z_01)
  const y = AnimateObjectWalking(x);
  return DrawObjectNotMirrored(y, x); // TYA / JMP
}

/** A frame image, X object index; [00]/[01] position. @returns X = [08] */
export function DrawObjectMirrored(a, x) {
  // DrawObjectMirrored (Z_01): [0C] = 1 (mirrored), then the common part of DrawObjectNotMirrored.
  ram[0x0c] = 0x01;
  return DrawObjectWithType(a, x, ram[ObjType + x]);
}

/** A frame image, X object index; [00]/[01] position, [0F] flip. @returns X = [08] */
export function DrawObjectNotMirrored(a, x) {
  // DrawObjectNotMirrored (Z_01)
  ram[0x0c] = 0x00;
  return DrawObjectWithType(a, x, ram[ObjType + x]);
}

/** A frame, X object index, Y object type. @returns X = [08] */
export function DrawObjectWithType(a, x, y) {
  // DrawObjectWithType (Z_01): animation index = type + 1 (Link uses two).
  return DrawObjectWithAnim(a, x, (y + 1) & 0xff);
}

/** A frame, X object index / cycle sprite index, Y animation index. @returns X = [08] */
export function DrawObjectWithAnim(a, x, y) {
  // DrawObjectWithAnim (Z_01)
  ram[0x0d] = a;
  ram[0x0e] = y;
  ram[0x08] = x;
  const offsets = table(bus.rom, 'SpriteOffsets');
  const i = ram[RollingSpriteIndex];
  ram[LeftSpriteOffset] = offsets.byte(i);
  a = offsets.byte(i + 1);
  if (x === 0) {
    // Link: hardcoded sprites $12/$13.
    ram[LeftSpriteOffset] = 0x48;
    a = 0x4c;
  }
  return DrawObjectWithAnimAndSpecificSprites(a, x);
}

/** A right sprite offset, X object index; [0D] frame, [0E] animation index. @returns X = [08] */
export function DrawObjectWithAnimAndSpecificSprites(a, x) {
  // DrawObjectWithAnimAndSpecificSprites (Z_01)
  ram[RightSpriteOffset] = a;
  let y = ram[0x0e];
  ram[0x07] = 0x01; // two sides
  ram[0x0a] = 0x08; // right side 8 pixels away
  y = (table(bus.rom, 'ObjAnimations').byte(y) + ram[0x0d]) & 0xff;
  a = table(bus.rom, 'ObjAnimFrameHeap').byte(y);
  ram[0x02] = a;
  ram[0x03] = a + 2;

  let useTableAttr = true;
  if (x !== 0 && x < 0x0d) {
    if (ram[ObjAttr + x] & 0x02) {
      // @DrawHalfWidth
      ram[0x07]--;
      return Anim_WriteSpritePair(x);
    }
    if (ram[ObjAttr + x] & 0x08) useTableAttr = false; // ignore sprite attribute table
  }
  if (useTableAttr) Anim_SetSpriteDescriptorAttributes(table(bus.rom, 'ObjAnimAttrHeap').byte(y));

  if (x === 0) return Anim_WriteHorizontallyFlippableSpritePair(x); // Link is never mirrored
  if (ram[0x0c] === 0) return Anim_WriteHorizontallyFlippableSpritePair(x);
  return Anim_WriteMirroredSpritePair(x);
}

/** A frame image, X object index. @returns X = [08] */
export function DrawObjectNotMirroredOverLink(a, x) {
  // DrawObjectNotMirroredOverLink (Z_04)
  return drawObjectOverLink(a, x, 0x00);
}

/** A frame image, X object index. @returns X = [08] */
export function DrawObjectMirroredOverLink(a, x) {
  // DrawObjectMirroredOverLink (Z_04)
  return drawObjectOverLink(a, x, 0x01);
}

/** A frame image, X object index; unverified copy of DrawObjectNotMirroredOverLink. */
export function Unused_DrawObjectNotMirroredOverLink_Bank5(a, x) {
  // Unused_DrawObjectNotMirroredOverLink_Bank5 (Z_05): LDY #0 / BEQ (the LDY #1 after it is dead).
  return Unused_DrawObjectMirroredOverLink_Bank5(a, x, 0x00);
}

/** A frame image, X object index, Y mirrored flag (the routine has no LDY of its own). */
export function Unused_DrawObjectMirroredOverLink_Bank5(a, x, y) {
  // Unused_DrawObjectMirroredOverLink_Bank5 (Z_05)
  return drawObjectOverLink(a, x, y);
}

// Common body of the *OverLink variants: sprites $10/$11 (records $40/$44), under Link.
function drawObjectOverLink(a, x, mirrored) {
  ram[0x0c] = mirrored;
  const y = (ram[ObjType + x] + 1) & 0xff;
  ram[0x0d] = a;
  ram[0x0e] = y;
  ram[0x08] = x;
  ram[LeftSpriteOffset] = 0x40;
  return DrawObjectWithAnimAndSpecificSprites(0x44, x);
}

// ---------------------------------------------------------------- animation (Z_07)

/** X object index. */
export function AnimateAndDrawMetaObject(x) {
  // AnimateAndDrawMetaObject (Z_07): spawn cloud (metastate 1..4) or death spark ($10..$14).
  Anim_FetchObjPosForSpriteDescriptor(x);
  let a = ram[ObjMetastate + x];
  if (a < 0x10) {
    DrawCloud(a & 0x0f, x);
  } else {
    // @AnimateSpark
    a &= 0x0f;
    if (a === 0) return incMetastate(x);
    ram[0x0c] = a & 0x01; // frame image 1, 0, 1
    Anim_SetSpriteDescriptorAttributes(0x01);
    Anim_WriteItemSprites(x, 0x24); // death spark
  }
  // @CheckMetaObjTimer
  if (ram[ObjTimer + x] !== 0) return;
  return incMetastate(x);
}

function incMetastate(x) {
  // AnimateAndDrawMetaObject@IncMetastate: next metastate lasts 6 frames.
  ram[ObjTimer + x] = 0x06;
  ram[ObjMetastate + x]++;
}

/** X object index. @returns Y = animation frame; [00]/[01] position, [0F] flip */
export function AnimateObjectWalking(x) {
  // AnimateObjectWalking (Z_07)
  ram[ObjAnimCounter + x]--;
  if (ram[ObjAnimCounter + x] === 0) {
    if (x === 0) AnimateLinkObjState();
    ram[0x00] = 0x06; // roll over the counter (6 frames)
    RollOverAnimCounter(x);
  }
  return SetUpWalkingSprites(x);
}

/** X object index. @returns Y = animation frame (label inside AnimateObjectWalking; AnimateLinkBase jumps here) */
export function SetUpWalkingSprites(x) {
  // SetUpWalkingSprites (Z_07)
  Anim_FetchObjPosForSpriteDescriptor(x);
  const a = ram[ObjDir + x] & 0x0c;
  if (a === 0) return SetUpHorizontalWalkingSprites(x);
  // Up: frame 3; down: frame 2.
  const y = a & 0x08 ? 0x03 : 0x02;
  Anim_SetObjHFlipForSpriteDescriptor(x);
  return y;
}

/** X object index. @returns A = ObjAnimFrame[X] ([0F]) */
export function Anim_SetObjHFlipForSpriteDescriptor(x) {
  // Anim_SetObjHFlipForSpriteDescriptor (Z_07): [0F] = movement frame.
  const a = ram[ObjAnimFrame + x];
  ram[0x0f] = a;
  return a;
}

/** X object index. @returns Y = animation frame (0 legs apart, 1 legs together) */
export function SetUpHorizontalWalkingSprites(x) {
  // SetUpHorizontalWalkingSprites (Z_07, label inside AnimateObjectWalking)
  let y = 0;
  if (ram[ObjAnimFrame + x] !== 0) y++;
  if ((ram[ObjDir + x] & 0x01) === 0) ram[0x0f]++; // facing left: flip
  return y;
}

/** A new counter value, X object index. @returns A = 0 */
export function Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(a, x) {
  // Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor (Z_07)
  ram[0x00] = a;
  ram[ObjAnimCounter + x]--;
  if (ram[ObjAnimCounter + x] === 0) RollOverAnimCounter(x);
  return Anim_FetchObjPosForSpriteDescriptor(x);
}

/** X object index. @returns A = 0; [00] X, [01] Y, [0F] = 0 */
export function Anim_FetchObjPosForSpriteDescriptor(x) {
  // Anim_FetchObjPosForSpriteDescriptor (Z_07)
  ram[0x00] = ram[ObjX + x];
  ram[0x01] = ram[ObjY + x];
  ram[0x0f] = 0;
  return 0;
}

/** X object index; [00] new counter value. @returns A = new ObjAnimFrame[X] */
export function RollOverAnimCounter(x) {
  // RollOverAnimCounter (Z_07)
  ram[ObjAnimCounter + x] = ram[0x00];
  const a = ram[ObjAnimFrame + x] ^ 0x01;
  ram[ObjAnimFrame + x] = a;
  return a;
}
