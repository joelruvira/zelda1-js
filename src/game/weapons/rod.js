// P09 weapons — slot $12, shared by the rod (states $3x) and the arrow ($1x/$2x):
// UpdateRodOrArrow (Z_07) and WieldRod (Z_05).

import { ram } from '../../core/ram.js';
import { ObjState, ObjAnimCounter } from '../../core/vars.js';
import { UpdateSwordOrRod } from './sword.js';
import { UpdateArrowOrBoomerang } from './arrow.js';
import { WieldWeapon } from './wield.js';

/** UpdateRodOrArrow (Z_07). X = $12. */
export function UpdateRodOrArrow(x) {
  // UpdateRodOrArrow (Z_07)
  if ((ram[ObjState + x] & 0xf0) >= 0x30) return UpdateSwordOrRod(x);
  return UpdateArrowOrBoomerang(x);
}

/** WieldRod (Z_05): swings the rod (slot $12, state $31, first state 5 frames) if the slot is free. */
export function WieldRod() {
  // WieldRod (Z_05)
  const x = 0x12;
  if (ram[ObjState + x] !== 0) return; // L14EC6_Exit
  ram[ObjAnimCounter + x] = 0x05;
  return WieldWeapon(0x31, x);
}
