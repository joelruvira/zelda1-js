// P04 draw — object animation (walking counters, meta-object clouds/sparks) and the
// DrawObject* family that looks frames up in ObjAnimations / ObjAnimFrameHeap / ObjAnimAttrHeap.
// Z_01 (RAM_01_CODE), Z_04, Z_05 and Z_07 routines.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';  // label().addr: run address (RAM_01_CODE copy) for page-cross hints
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
import { $br, $pxa } from '../../core/timing.js';

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
  $br('Z_01:5028', true); // LDY #$01 / BNE :+
  ram[0x0c] = 0x01;
  $pxa('Z_01:5043', ObjType, x);
  return DrawObjectWithType(a, x, ram[ObjType + x]);
}

/** A frame image, X object index; [00]/[01] position, [0F] flip. @returns X = [08] */
export function DrawObjectNotMirrored(a, x) {
  // DrawObjectNotMirrored (Z_01)
  ram[0x0c] = 0x00;
  $pxa('Z_01:5043', ObjType, x);
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
  $pxa('Z_01:5083', label('SpriteOffsets').addr, i); ram[LeftSpriteOffset] = offsets.byte(i);
  $pxa('Z_01:5085', label('SpriteOffsets').addr + 1, i); a = offsets.byte(i + 1);
  if (!$br('Z_01:5089', x !== 0)) {
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
  const anims = table(bus.rom, 'ObjAnimations');
  $pxa('Z_01:5101', label('ObjAnimations').addr, y);
  y = (anims.byte(y) + ram[0x0d]) & 0xff;
  const heap = table(bus.rom, 'ObjAnimFrameHeap');
  $pxa('Z_01:5105', label('ObjAnimFrameHeap').addr, y);
  a = heap.byte(y);
  ram[0x02] = a;
  ram[0x03] = a + 2;

  let useTableAttr = true;
  if (!$br('Z_01:5114', x === 0) && !$br('Z_01:5116', x >= 0x0d)) {
    $pxa('Z_01:5120', ObjAttr, x);
    if ($br('Z_01:5122', (ram[ObjAttr + x] & 0x02) !== 0)) {
      // @DrawHalfWidth
      ram[0x07]--;
      return Anim_WriteSpritePair(x);
    }
    $pxa('Z_01:5126', ObjAttr, x);
    if ($br('Z_01:5128', (ram[ObjAttr + x] & 0x08) !== 0)) useTableAttr = false; // ignore sprite attribute table
  }
  if (useTableAttr) {
    const attrs = table(bus.rom, 'ObjAnimAttrHeap');
    $pxa('Z_01:5131', label('ObjAnimAttrHeap').addr, y);
    Anim_SetSpriteDescriptorAttributes(attrs.byte(y));
  }

  if ($br('Z_01:5136', x === 0)) return Anim_WriteHorizontallyFlippableSpritePair(x); // Link is never mirrored
  if ($br('Z_01:5143', ram[0x0c] === 0)) return Anim_WriteHorizontallyFlippableSpritePair(x);
  return Anim_WriteMirroredSpritePair(x);
}

/** A frame image, X object index. @returns X = [08] */
export function DrawObjectNotMirroredOverLink(a, x) {
  // DrawObjectNotMirroredOverLink (Z_04)
  $br('Z_04:767', true); // LDY #$00 / BEQ :+
  return drawObjectOverLink(a, x, 0x00, 'Z_04:780');
}

/** A frame image, X object index. @returns X = [08] */
export function DrawObjectMirroredOverLink(a, x) {
  // DrawObjectMirroredOverLink (Z_04)
  return drawObjectOverLink(a, x, 0x01, 'Z_04:780');
}

/** A frame image, X object index; unverified copy of DrawObjectNotMirroredOverLink. */
export function Unused_DrawObjectNotMirroredOverLink_Bank5(a, x) {
  // Unused_DrawObjectNotMirroredOverLink_Bank5 (Z_05): LDY #0 / BEQ (the LDY #1 after it is dead).
  $br('Z_05:3630', true);
  return Unused_DrawObjectMirroredOverLink_Bank5(a, x, 0x00);
}

/** A frame image, X object index, Y mirrored flag (the routine has no LDY of its own). */
export function Unused_DrawObjectMirroredOverLink_Bank5(a, x, y) {
  // Unused_DrawObjectMirroredOverLink_Bank5 (Z_05)
  return drawObjectOverLink(a, x, y, 'Z_05:3639');
}

// Common body of the *OverLink variants: sprites $10/$11 (records $40/$44), under Link.
function drawObjectOverLink(a, x, mirrored, typeRef) {
  ram[0x0c] = mirrored;
  $pxa(typeRef, ObjType, x);
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
  $pxa('Z_07:5013', ObjMetastate, x);
  let a = ram[ObjMetastate + x];
  if (!$br('Z_07:5015', a >= 0x10)) {
    DrawCloud(a & 0x0f, x);
  } else {
    // @AnimateSpark
    a &= 0x0f;
    if ($br('Z_07:5039', a === 0)) return incMetastate(x);
    ram[0x0c] = a & 0x01; // frame image 1, 0, 1
    Anim_SetSpriteDescriptorAttributes(0x01);
    Anim_WriteItemSprites(x, 0x24); // death spark
  }
  // @CheckMetaObjTimer
  if ($br('Z_07:5025', ram[(ObjTimer + x) & 0xff] !== 0)) return;
  return incMetastate(x);
}

function incMetastate(x) {
  // AnimateAndDrawMetaObject@IncMetastate: next metastate lasts 6 frames.
  ram[(ObjTimer + x) & 0xff] = 0x06;
  ram[ObjMetastate + x]++;
}

/** X object index. @returns Y = animation frame; [00]/[01] position, [0F] flip */
export function AnimateObjectWalking(x) {
  // AnimateObjectWalking (Z_07)
  ram[ObjAnimCounter + x]--;
  if (!$br('Z_07:5080', ram[ObjAnimCounter + x] !== 0)) {
    if (!$br('Z_07:5085', x !== 0)) AnimateLinkObjState();
    ram[0x00] = 0x06; // roll over the counter (6 frames)
    RollOverAnimCounter(x);
  }
  return SetUpWalkingSprites(x);
}

/** X object index. @returns Y = animation frame (label inside AnimateObjectWalking; AnimateLinkBase jumps here) */
export function SetUpWalkingSprites(x) {
  // SetUpWalkingSprites (Z_07)
  Anim_FetchObjPosForSpriteDescriptor(x);
  const a = ram[(ObjDir + x) & 0xff] & 0x0c;
  if ($br('Z_07:5100', a === 0)) return SetUpHorizontalWalkingSprites(x);
  // Up: frame 3; down: frame 2.
  const y = $br('Z_07:5105', (a & 0x08) !== 0) ? 0x03 : 0x02;
  Anim_SetObjHFlipForSpriteDescriptor(x);
  return y;
}

/** X object index. @returns A = ObjAnimFrame[X] ([0F]) */
export function Anim_SetObjHFlipForSpriteDescriptor(x) {
  // Anim_SetObjHFlipForSpriteDescriptor (Z_07): [0F] = movement frame.
  $pxa('Z_07:5117', ObjAnimFrame, x);
  const a = ram[ObjAnimFrame + x];
  ram[0x0f] = a;
  return a;
}

/** X object index. @returns Y = animation frame (0 legs apart, 1 legs together) */
export function SetUpHorizontalWalkingSprites(x) {
  // SetUpHorizontalWalkingSprites (Z_07, label inside AnimateObjectWalking)
  let y = 0;
  $pxa('Z_07:5124', ObjAnimFrame, x);
  if (!$br('Z_07:5125', ram[ObjAnimFrame + x] === 0)) y++;
  if (!$br('Z_07:5130', (ram[(ObjDir + x) & 0xff] & 0x01) !== 0)) ram[0x0f]++; // facing left: flip
  return y;
}

/** A new counter value, X object index. @returns A = 0 */
export function Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(a, x) {
  // Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor (Z_07)
  ram[0x00] = a;
  ram[ObjAnimCounter + x]--;
  if (!$br('Z_07:5148', ram[ObjAnimCounter + x] !== 0)) RollOverAnimCounter(x);
  return Anim_FetchObjPosForSpriteDescriptor(x);
}

/** X object index. @returns A = 0; [00] X, [01] Y, [0F] = 0 */
export function Anim_FetchObjPosForSpriteDescriptor(x) {
  // Anim_FetchObjPosForSpriteDescriptor (Z_07)
  ram[0x00] = ram[(ObjX + x) & 0xff]; // LDA zp,X wraps in page 0 (out-of-range X, e.g. X = $FF)
  ram[0x01] = ram[(ObjY + x) & 0xff];
  ram[0x0f] = 0;
  return 0;
}

/** X object index; [00] new counter value. @returns A = new ObjAnimFrame[X] */
export function RollOverAnimCounter(x) {
  // RollOverAnimCounter (Z_07)
  ram[ObjAnimCounter + x] = ram[0x00];
  $pxa('Z_07:5177', ObjAnimFrame, x);
  const a = ram[ObjAnimFrame + x] ^ 0x01;
  ram[ObjAnimFrame + x] = a;
  return a;
}
