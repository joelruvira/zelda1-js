// P09 weapons — using the B-button item and placing a weapon next to Link.
// WieldItem and its jump table, WieldWeapon/WieldNothing/WieldPotion (Z_05); PlaceWeapon* and
// ChooseOffsetForDirectionH (Z_01, BANK_01_CODE run from WRAM).
// The other entries of WieldItem_JumpTable live with their weapon: WieldBoomerang/WieldFood
// (boomerang.js), WieldBomb (bomb.js), WieldArrow (arrow.js), WieldCandle (fire.js),
// WieldFlute (flute.js), WieldRod (rod.js).

import { ram } from '../../core/ram.js';
import { label } from '../../core/rom.js';
import { tableJump } from '../../core/asm.js';
import {
  SelectedItemSlot, ObjState, ObjQSpeedFrac, ObjAnimCounter, ObjDir, ObjX, ObjY, Potion,
  World_IsFillingHearts, Paused,
} from '../../core/vars.js';
import { WieldBoomerang, WieldFood } from './boomerang.js';
import { WieldBomb } from './bomb.js';
import { WieldArrow } from './arrow.js';
import { WieldCandle } from './fire.js';
import { WieldFlute } from './flute.js';
import { WieldRod } from './rod.js';
import { $br } from '../../core/timing.js';

/** WieldItem (Z_05): uses the selected B item (nothing for the letter slot $0F). */
export function WieldItem() {
  // WieldItem (Z_05)
  const a = ram[SelectedItemSlot];
  if ($br('Z_05:2887', a === 0x0f)) return; // L14E71_Exit
  return tableJump(label('WieldItem_JumpTable').addr, a, [
    WieldBoomerang, WieldBomb, WieldArrow, WieldNothing, WieldCandle, WieldFlute, WieldFood,
    WieldPotion, WieldRod,
  ]);
}

/**
 * WieldWeapon (Z_05). A = initial state, X = weapon slot. Q-speed $C0, placed next to Link (Link's
 * state $10, anim counter 1); a vertical weapon is moved 3 pixels right.
 */
export function WieldWeapon(a, x) {
  // WieldWeapon (Z_05)
  ram[ObjState + x] = a;
  ram[ObjQSpeedFrac + x] = 0xc0;
  PlaceWeaponForPlayerStateAndAnim(x);
  if ($br('Z_05:2994', (ram[ObjDir + x] & 0x0c) === 0)) return WieldNothing();
  ram[ObjX + x] = ram[ObjX + x] + 0x03;
  return WieldNothing(); // falls through
}

/** WieldNothing (Z_05): RTS. */
export function WieldNothing() {
  // WieldNothing (Z_05)
}

/** WieldPotion (Z_05): drinks one potion level: fill the hearts with the game paused (Paused = 2). */
export function WieldPotion() {
  // WieldPotion (Z_05)
  if ($br('Z_05:3022', ram[Potion] === 0)) return; // L14EC6_Exit
  ram[Potion]--;
  ram[World_IsFillingHearts] = 0x01;
  ram[Paused] = 0x02;
}

/** PlaceWeaponForPlayerStateAndAnimAndWeaponState (Z_01). A = weapon state, X = weapon slot. */
export function PlaceWeaponForPlayerStateAndAnimAndWeaponState(a, x) {
  // PlaceWeaponForPlayerStateAndAnimAndWeaponState (Z_01)
  ram[ObjState + x] = a;
  return PlaceWeaponForPlayerStateAndAnim(x); // falls through
}

/** PlaceWeaponForPlayerStateAndAnim (Z_01). X = weapon slot. Link's anim counter = 1 (ends the pose soon). */
export function PlaceWeaponForPlayerStateAndAnim(x) {
  // PlaceWeaponForPlayerStateAndAnim (Z_01)
  ram[ObjAnimCounter] = 0x01;
  return PlaceWeaponForPlayerState(x); // falls through
}

/** PlaceWeaponForPlayerState (Z_01). X = weapon slot. Link's state = $10 (wielding). */
export function PlaceWeaponForPlayerState(x) {
  // PlaceWeaponForPlayerState (Z_01)
  ram[ObjState] = 0x10;
  return PlaceWeapon(0x10, x); // falls through with A = $10
}

/**
 * PlaceWeapon (Z_01). A = offset for right/down ([01]; [02] = -$10 for left/up), X = weapon slot.
 * The weapon takes Link's direction and is placed at Link's position + the offset for it.
 * @returns A = the weapon's new Y
 */
export function PlaceWeapon(a, x) {
  // PlaceWeapon (Z_01)
  ram[0x01] = a;
  ram[0x02] = 0xf0;
  ram[ObjDir + x] = ram[ObjDir];
  ram[ObjX + x] = ChooseOffsetForDirectionH(ram[ObjDir]) + ram[ObjX];
  // The vertical bits shifted into the horizontal ones.
  ram[ObjY + x] = ChooseOffsetForDirectionH(ram[ObjDir] >> 2) + ram[ObjY];
  return ram[ObjY + x];
}

/**
 * ChooseOffsetForDirectionH (Z_01). A = direction; [01] = value for right, [02] = value for left.
 * Sets [00] = 0 (the value for a vertical direction). @returns A = chosen value (C = 0)
 */
export function ChooseOffsetForDirectionH(a) {
  // ChooseOffsetForDirectionH (Z_01)
  let y = 0;
  ram[0x00] = y;
  a &= 0x03;
  if (!$br('Z_01:3973', a === 0)) {
    y++; // horizontal
    if (!$br('Z_01:3976', (a & 0x01) !== 0)) y++; // left
  }
  return ram[0x00 + y];
}
