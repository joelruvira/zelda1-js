// Status bar: selected item B, sword A, position markers on the status bar map; item sprites in the
// inventory (Z_01, Z_05, Z_07). Package P11.

import { ram, peek } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { switchBank } from '../../core/asm.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  GameMode, WhirlwindTeleportingState, RoomId, Sprites, CurLevel, LevelInfo_StatusBarMapXOffset,
  InvTriforce, FrameCounter, LevelInfo_TriforceRoomId, Items, SelectedItemSlot, Potion, InvLetter,
} from '../../core/vars.js';
import { Anim_WriteStaticItemSpritesWithAttributes } from '../draw/items.js';
import { HasCompass } from './map.js';
import { FindAndSelectOccupiedItemSlot } from './submenu.js';

// ------------------------------------------------------------------ position markers

/** UpdatePlayerPositionMarker (Z_01): Link's dot on the status bar map (sprite $15). */
export function UpdatePlayerPositionMarker() {
  // UpdatePlayerPositionMarker (Z_01): not in mode 9 nor while whirlwind teleporting.
  if ($br('Z_01:4133', ram[GameMode] === 0x09)) return; // L6AAF_Exit
  if ($br('Z_01:4135', ram[WhirlwindTeleportingState] !== 0)) return;
  return UpdatePositionMarker(ram[RoomId], 0x00);
}

/**
 * UpdatePositionMarker (Z_01): place a marker for room ID A on the status bar map.
 * X = 0 (Link, sprite $15) or 4 (triforce, sprite $16: flashes unless its piece is taken).
 */
export function UpdatePositionMarker(a, x) {
  // UpdatePositionMarker (Z_01)
  const roomId = a; // PHA
  // AND #$70 / LSR / LSR leave C = 0; ADC #$17
  ram[Sprites + 84 + x] = ((roomId & 0x70) >> 2) + 0x17;
  let y = ram[CurLevel];
  ram[0x00] = $br('Z_01:4151', y === 0) ? 0x11 : 0x12; // status bar map left: OW $11, UW $12
  a = roomId & 0x0f; // PLA
  // CPY #$00 sets C, the ASLs clear it (column < $10): plain additions below.
  if (!$br('Z_01:4158', y === 0)) a <<= 1; // UW columns are 8 pixels wide
  a <<= 2; // OW columns are 4 pixels wide
  a += ram[0x00];
  a = (a + peek(LevelInfo_StatusBarMapXOffset)) & 0xff; // no carry in from the previous ADC
  ram[Sprites + 87 + x] = a;
  ram[Sprites + 85 + x] = 0x3e; // position marker tile
  a = 0x00;
  if (!$br('Z_01:4170', x === 0x00)) {
    // Triforce marker: palette 3, flashing with palette 2 every 16 frames if the piece is missing
    // (always in level 9).
    a = 0x03;
    y = ram[CurLevel];
    let flash = true;
    if (!$br('Z_01:4175', y === 0x09)) {
      $pxa('Z_01:4177', label('LevelMasks').addr - 1, y);
      flash = !$br('Z_01:4178', (ram[InvTriforce] & table(bus.rom, 'LevelMasks').byte(y - 1)) !== 0);
    }
    if (flash && !$br('Z_01:4183', (ram[FrameCounter] & 0x1f) >= 0x10)) a = 0x02;
  }
  ram[Sprites + 86 + x] = a; // @SetAttr
}

/** UpdateTriforcePositionMarker (Z_07): in UW with the compass, mark the triforce room. */
export function UpdateTriforcePositionMarker() {
  // UpdateTriforcePositionMarker (Z_07)
  if ($br('Z_07:739', ram[CurLevel] === 0)) return; // Exit
  switchBank(5);
  if ($br('Z_07:743', HasCompass() === 0)) return;
  return UpdatePositionMarker(peek(LevelInfo_TriforceRoomId), 0x04);
}

// ------------------------------------------------------------------ item sprites

/** DrawItemInInventoryWithX (Z_05): X = item slot, [$00]/[$01] = X/Y position. */
export function DrawItemInInventoryWithX(x) {
  // DrawItemInInventoryWithX (Z_05): TXA / TAY
  return DrawItemInInventory(x, x);
}

/** DrawItemInInventory (Z_07): X = Y = item slot, [$00]/[$01] position; [$04] = Items[X]. */
export function DrawItemInInventory(x, y) {
  // DrawItemInInventory (Z_07): the item value doubles as palette attribute
  $pxa('Z_07:899', Items, x);
  ram[0x04] = ram[Items + x];
  return DrawItemBySlot(x, y); // falls through
}

/** DrawItemBySlot (Z_07): X = Y = item slot, [$00]/[$01] position, [$04] item value / attribute. */
export function DrawItemBySlot(x, y) {
  // DrawItemBySlot (Z_07)
  $pxa('Z_07:910', label('ItemSlotToPaletteOffsetsOrValues').addr, x);
  let a = peek(label('ItemSlotToPaletteOffsetsOrValues').addr + x); // WRAM copy (BANK_01_CODE)
  if ($br('Z_07:912', x === 0x16) || $br('Z_07:914', x === 0x1a) || $br('Z_07:916', x === 0x1b) || !$br('Z_07:918', x !== 0x19)) {
    // @Flash: palettes 5/6 every 8 frames (LSRs leave C = 0)
    a = ((ram[FrameCounter] & 0x08) >> 3) + 0x01;
  }
  if ($br('Z_07:930', x === 0x00) || $br('Z_07:932', x === 0x04) || $br('Z_07:934', x === 0x02) || $br('Z_07:936', x === 0x07) || $br('Z_07:938', x === 0x0b)) {
    // @AddItemAndTableValue: palette offset + item value
    a = (a + ram[0x04]) & 0xff;
    if (!$br('Z_07:968', x !== 0x00) && !$br('Z_07:970', a !== 0x02)) y = 0x20; // master sword image
  }
  // @WriteSprites
  ram[0x0c] = 0x00; // frame 0
  return Anim_WriteStaticItemSpritesWithAttributes(a, 0x0f, y);
}

// ------------------------------------------------------------------ status bar items

/**
 * DrawStatusBarItemsAndEnsureItemSelected (Z_07): draw the B item and the sword in the status bar,
 * making SelectedItemSlot an occupied, equippable slot (potion/letter, boomerangs fallbacks).
 * Internal labels: DrawStatusBarPotion, DrawStatusBarItemB, DrawStatusBarBoomerang,
 * FindItemOrDrawSword, CheckMissingItem.
 */
export function DrawStatusBarItemsAndEnsureItemSelected() {
  // DrawStatusBarItemsAndEnsureItemSelected (Z_07)
  let x = ram[SelectedItemSlot];
  if ($br('Z_07:992', x === 0)) {
    // DrawStatusBarBoomerang: magic boomerang first.
    for (x = 0x1e; ;) {
      $pxa('Z_07:1017', Items, x);
      const a = ram[Items + x];
      if ($br('Z_07:1018', a !== 0)) return DrawStatusBarItemB(a, x);
      x--;
      if (!$br('Z_07:1021', x !== 0x1c)) break;
    }
    return EnsureSelectedItem(0x00);
  }
  $pxa('Z_07:993', Items, x);
  let a = ram[Items + x];
  if ($br('Z_07:994', a === 0)) {
    // CheckMissingItem
    if ($br('Z_07:1057', x !== 0x07)) return FindItemOrDrawSword(x);
    if ($br('Z_07:1059', ram[InvLetter] === 0)) return EnsureSelectedItem(x);
    x = 0x0f; // have the letter: select it
    ram[SelectedItemSlot] = x;
    $br('Z_07:1062', true);
    return FindItemOrDrawSword(x);
  }
  if ($br('Z_07:996', x !== 0x0f)) return DrawStatusBarItemB(a, x);
  if ($br('Z_07:998', ram[Potion] !== 0)) {
    // DrawStatusBarPotion
    x = 0x07;
    ram[SelectedItemSlot] = x;
    $br('Z_07:978', true);
    return DrawStatusBarItemB(a, x);
  }
  a = (a >> 1) | 0x01; // only the letter: palette attribute 1
  return DrawStatusBarItemB(a, x);
}

/** DrawStatusBarItemB (part of DrawStatusBarItemsAndEnsureItemSelected, Z_07). */
function DrawStatusBarItemB(a, x) {
  ram[0x04] = a;
  ram[0x01] = 0x1f; // "B" item at ($7C, $1F)
  ram[0x00] = 0x7c;
  switchBank(5);
  DrawItemInInventoryWithX(x);
  return DrawStatusBarSword();
}

/** FindItemOrDrawSword (part of DrawStatusBarItemsAndEnsureItemSelected, Z_07). */
function FindItemOrDrawSword(x) {
  // An item in this slot: SelectedItemSlot was just set; it is drawn next frame.
  $pxa('Z_07:1026', Items, x);
  if ($br('Z_07:1031', ram[Items + x] !== 0)) return DrawStatusBarSword();
  return EnsureSelectedItem(x); // falls through
}

/** EnsureSelectedItem (Z_07): X = slot to search back from. */
export function EnsureSelectedItem(x) {
  // EnsureSelectedItem (Z_07)
  const y = x;
  switchBank(5);
  FindAndSelectOccupiedItemSlot(0x02, y); // backwards
  return DrawStatusBarSword(); // falls through
}

/** DrawStatusBarSword (Z_07): the "A" item at ($94, $1F) if there is a sword. */
export function DrawStatusBarSword() {
  // DrawStatusBarSword (Z_07)
  const x = 0x00;
  $pxa('Z_07:1044', Items, x);
  if ($br('Z_07:1045', ram[Items + x] === 0)) return; // L1E847_Exit
  ram[0x01] = 0x1f;
  ram[0x00] = 0x94;
  switchBank(5);
  return DrawItemInInventoryWithX(x);
}
