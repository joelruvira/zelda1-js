// P04 draw — OAM writers ($0200-$02FF, `Sprites`), sprite index rotation and sprite-pair writers.
// Bank 1 (RAM_01_CODE, runs from WRAM) and bank 4/5 helpers. Tables are read from the ROM by label.
//
// Sprite descriptor (zero-page temporaries shared by every writer, as in the original):
//   [00] X  [01] Y  [02] left tile  [03] right tile  [04] left attr  [05] right attr
//   [07] "has two sides" counter  [08] object index / cycle-sprite-index flag  [0A] X separation
//   [0C] mirrored / frame  [0D] frame  [0E] animation index  [0F] flip horizontally
//   LeftSpriteOffset / RightSpriteOffset ($343/$344): OAM record offsets of the two sides.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  Sprites, FirstSpriteIndex, RollingSpriteIndex, LeftSpriteOffset, RightSpriteOffset,
  ObjX, ObjY, ObjInvincibilityTimer, FrameCounter,
} from '../../core/vars.js';

export function HideObjectSprites() {
  // HideObjectSprites (Z_01): hide sprites $18..$3F (Y = $F8) and cycle the starting sprite index.
  for (let x = 0x60; x !== 0x00; x = (x + 4) & 0xff) ram[Sprites + x] = 0xf8;
  ram[FirstSpriteIndex] = CycleSpriteIndexInA(ram[FirstSpriteIndex]);
}

/** @returns A = new RollingSpriteIndex */
export function CycleCurSpriteIndex() {
  // CycleCurSpriteIndex (Z_01): RollingSpriteIndex goes 0..$27 and wraps.
  return CycleSpriteIndexInA(ram[RollingSpriteIndex]);
}

/** @returns A = the new index, also stored in RollingSpriteIndex */
export function CycleSpriteIndexInA(a) {
  // CycleSpriteIndexInA (Z_01)
  a = (a + 1) & 0xff;
  if (a === 0x28) return ResetCurSpriteIndex();
  ram[RollingSpriteIndex] = a;
  return a;
}

/** @returns A = 0 */
export function ResetCurSpriteIndex() {
  // ResetCurSpriteIndex (Z_01)
  ram[RollingSpriteIndex] = 0;
  return 0;
}

export function ShowLinkSpritesBehindHorizontalDoors() {
  // ShowLinkSpritesBehindHorizontalDoors (Z_01): Link's sprites ($10/$11, records $40/$44) get
  // priority "behind BG" when their X is at the room's left/right edge (< $10 or >= $E9).
  const ext = table(bus.rom, 'SpriteRelativeExtents');
  let y = 0x0a;
  ram[0x00] = ram[ObjX + 0];
  let x = 1;
  do {
    const a = (ram[0x00] + ext.byte(x)) & 0xff;
    if (a >= 0xe9 || a < 0x10) ram[Sprites + 64 + y] = ram[Sprites + 64 + y] | 0x20; // @AddPriority
    y = (y + 4) & 0xff;
    if (y === 0) y = 0x20; // UNKNOWN in the asm: looks unreachable
    x = (x - 1) & 0xff;
  } while (!(x & 0x80));
}

export function WriteBlankPrioritySprites() {
  // WriteBlankPrioritySprites (Z_01): fill sprites 0..$0F with the two-record template
  // (transparent tile $1C, behind BG) so they mask everything drawn after them.
  const t = table(bus.rom, 'BlankPrioritySpriteTemplates');
  let x = 0;
  for (let y = 0; y !== 0x40; y++) {
    ram[Sprites + y] = t.byte(x);
    x = (x + 1) & 0x07;
  }
}

export function HideSpritesOverLink() {
  // HideSpritesOverLink (Z_04): hide sprites $10 and $11.
  ram[Sprites + 64] = 0xf8;
  ram[Sprites + 68] = 0xf8;
}

export function Unused_HideSpritesOverLink_Bank5() {
  // Unused_HideSpritesOverLink_Bank5 (Z_05): unverified copy of HideSpritesOverLink.
  ram[Sprites + 64] = 0xf8;
  ram[Sprites + 68] = 0xf8;
}

// ---------------------------------------------------------------- sprite pairs

/**
 * Params: X object index; descriptor [00]-[0A], [0F].
 * @returns X = [08] (object index), like the original's final LDX $08
 */
export function Anim_WriteHorizontallyFlippableSpritePair(x) {
  // Anim_WriteHorizontallyFlippableSpritePair (Z_01): if [0F], swap the tiles and flip both attrs.
  if (ram[0x0f] !== 0) {
    const left = ram[0x02]; // PHA
    ram[0x02] = ram[0x03];
    ram[0x03] = left; // PLA
    ram[0x04] = ram[0x04] ^ 0x40;
    ram[0x05] = ram[0x05] ^ 0x40;
  }
  return Anim_WriteSpritePair(x);
}

/** @returns X = [08] */
export function Anim_WriteSpritePair(x) {
  // Anim_WriteSpritePair (Z_01): while invincible, the palette bits flash with the timer.
  if (ram[ObjInvincibilityTimer + x] !== 0) {
    for (let y = 1; y >= 0; y--) {
      ram[0x04 + y] = ram[0x04 + y] & 0xfc;
      ram[0x04 + y] = (ram[ObjInvincibilityTimer + x] & 0x03) | ram[0x04 + y];
    }
  }
  return Anim_WriteSpritePairNotFlashing();
}

/** @returns X = [08] */
export function Anim_WriteSpritePairNotFlashing() {
  // Anim_WriteSpritePairNotFlashing (Z_01): writes one ([07]=0) or two ([07]=1) OAM records;
  // cycles RollingSpriteIndex after each one if [08] != 0.
  let x = ram[LeftSpriteOffset];
  let y = 0;
  do {
    ram[Sprites + 1 + x] = ram[0x02 + y];
    ram[Sprites + x] = ram[0x01];
    ram[Sprites + 3 + x] = ram[0x00];
    ram[0x00] = ram[0x00] + ram[0x0a];
    ram[Sprites + 2 + x] = ram[0x04 + y];
    x = ram[RightSpriteOffset];
    if (ram[0x08] !== 0) CycleCurSpriteIndex();
    y++;
    ram[0x07]--;
  } while (!(ram[0x07] & 0x80));
  return ram[0x08];
}

/** @returns X = [08] */
export function Anim_WriteMirroredSpritePair(x) {
  // Anim_WriteMirroredSpritePair (Z_01): right side = left tile, flipped horizontally.
  ram[0x03] = ram[0x02];
  ram[0x05] = ram[0x05] ^ 0x40;
  return Anim_WriteSpritePair(x);
}

/** @returns A = 2 */
export function Anim_SetSpriteDescriptorRedPaletteRow() {
  // Anim_SetSpriteDescriptorRedPaletteRow (Z_01)
  return Anim_SetSpriteDescriptorAttributes(0x02);
}

/** @returns A unchanged */
export function Anim_SetSpriteDescriptorAttributes(a) {
  // Anim_SetSpriteDescriptorAttributes (Z_01): [04] = [05] = A.
  ram[0x04] = a;
  ram[0x05] = a;
  return a;
}

// ---------------------------------------------------------------- single sprites

/** A tile, X object index. @returns A = new RollingSpriteIndex */
export function Anim_WriteLevelPaletteSprite(a, x) {
  // Anim_WriteLevelPaletteSprite (Z_01): attributes = palette row 3.
  ram[0x03] = 0x03;
  return Anim_WriteSprite(a, x);
}

/** A tile, X object index, [03] attributes. @returns A = new RollingSpriteIndex */
export function Anim_WriteSprite(a, x) {
  // Anim_WriteSprite (Z_01)
  const tile = a; // PHA
  if (ram[ObjInvincibilityTimer + x] !== 0) ram[0x03] = ram[FrameCounter] & 0x03;
  const y = table(bus.rom, 'SpriteOffsets').byte(ram[RollingSpriteIndex]);
  return Anim_WriteSpecificSprite(tile, x, y); // PLA
}

/** A tile, X object index, Y OAM record offset. @returns A = new RollingSpriteIndex */
export function Anim_WriteSpecificSprite(a, x, y) {
  // Anim_WriteSpecificSprite (Z_01)
  ram[Sprites + 1 + y] = a;
  ram[Sprites + 3 + y] = ram[ObjX + x];
  return Anim_EndWriteSprite(ram[ObjY + x], y);
}

/** A sprite Y, Y OAM record offset, [03] attributes. @returns A = new RollingSpriteIndex */
export function Anim_EndWriteSprite(a, y) {
  // Anim_EndWriteSprite (Z_01)
  ram[Sprites + y] = a;
  ram[Sprites + 2 + y] = ram[0x03];
  return CycleCurSpriteIndex();
}
