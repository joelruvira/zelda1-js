// P04 draw — item sprite writers (Z_01, RAM_01_CODE): item slot -> tiles from
// Anim_ItemFrameOffsets / Anim_ItemFrameTiles (read from the ROM).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';  // label().addr: run address (RAM_01_CODE copy) for page-cross hints
import {
  RollingSpriteIndex, LeftSpriteOffset, RightSpriteOffset, ProcessedNarrowObj, LeftAlignHalfWidthObj,
} from '../../core/vars.js';
import {
  Anim_SetSpriteDescriptorAttributes, Anim_WriteSpritePair, Anim_WriteMirroredSpritePair,
  Anim_WriteHorizontallyFlippableSpritePair,
} from './sprites.js';
import { $br, $pxa } from '../../core/timing.js';

/**
 * A sprite attributes, X cycle sprite index / object index, Y item slot; [00] X, [01] Y.
 * @returns X = [08]
 */
export function Anim_WriteStaticItemSpritesWithAttributes(a, x, y) {
  // Anim_WriteStaticItemSpritesWithAttributes (Z_01)
  Anim_SetSpriteDescriptorAttributes(a);
  ram[0x0f] = 0; // no horizontal flipping
  ram[0x0c] = 0; // frame 0
  return Anim_WriteItemSprites(x, y);
}

/**
 * X cycle sprite index / object index, Y item slot; [00]/[01] position, [04]/[05] attrs,
 * [0C] frame, [0F] flip. Sets ProcessedNarrowObj. @returns X = [08]
 */
export function Anim_WriteItemSprites(x, y) {
  // Anim_WriteItemSprites (Z_01)
  ram[ProcessedNarrowObj] = 0;
  const offsets = table(bus.rom, 'SpriteOffsets');
  const i = ram[RollingSpriteIndex];
  $pxa('Z_01:5291', label('SpriteOffsets').addr, i); ram[LeftSpriteOffset] = offsets.byte(i);
  $pxa('Z_01:5293', label('SpriteOffsets').addr + 1, i); ram[RightSpriteOffset] = offsets.byte(i + 1);
  return Anim_WriteSpecificItemSprites(x, y);
}

/** Same as Anim_WriteItemSprites with LeftSpriteOffset/RightSpriteOffset already set. @returns X = [08] */
export function Anim_WriteSpecificItemSprites(x, y) {
  // Anim_WriteSpecificItemSprites (Z_01)
  ram[0x08] = x;
  ram[0x07] = 0x01; // two sides
  ram[0x0a] = 0x08; // 8 pixels apart
  const fo = table(bus.rom, 'Anim_ItemFrameOffsets');
  $pxa('Z_01:5319', label('Anim_ItemFrameOffsets').addr, y);
  y = (fo.byte(y) + ram[0x0c]) & 0xff;
  const ft = table(bus.rom, 'Anim_ItemFrameTiles');
  $pxa('Z_01:5323', label('Anim_ItemFrameTiles').addr, y);
  let a = ft.byte(y);
  ram[0x02] = a;
  ram[0x03] = a + 2;

  // Left tile $F3 or in [$20, $62): narrow (half-width) object.
  a = ram[0x02];
  if ($br('Z_01:5333', a === 0xf3) || (!$br('Z_01:5335', a < 0x20) && !$br('Z_01:5337', a >= 0x62))) {
    // @Narrow
    if (!$br('Z_01:5341', ram[LeftAlignHalfWidthObj] !== 0)) ram[0x00] = ram[0x00] + 4; // center it
    ram[ProcessedNarrowObj]++;
    ram[0x07] = 0;
    return Anim_WriteSpritePair(x);
  }
  // @Wide
  if ($br('Z_01:5354', a < 0x6c)) {
    ram[0x0a] = 0x07; // @_Slim: both sides overlap one pixel
    return Anim_WriteMirroredSpritePair(x);
  }
  if ($br('Z_01:5356', a < 0x7c)) return Anim_WriteMirroredSpritePair(x);
  return Anim_WriteHorizontallyFlippableSpritePair(x);
}
