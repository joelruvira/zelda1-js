// P09 weapons — the sword and the rod held by Link, and the sword/magic shot they make.
// WieldSword (Z_05); UpdateSwordOrRod (with SetUpWeaponWithState and MakeSwordShot) and
// ResetObjState (Z_07).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  Items, ObjState, ObjAnimCounter, ObjDir, ObjX, ObjY, ObjQSpeedFrac, ObjGridOffset, Tune0Request,
  ForceSwordShot, HeartValues, HeartPartial,
} from '../../core/vars.js';
import { PlayEffect, PlaySample } from '../audio/requests.js';
import { GetOppositeDir } from '../movement/math.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { Anim_WriteItemSprites } from '../draw/items.js';
import { WieldWeapon, PlaceWeapon } from './wield.js';

/** WieldSword (Z_05): swings the sword (slot $0D, state 1 lasting 5 frames) if not in use. */
export function WieldSword() {
  // WieldSword (Z_05)
  if (ram[Items] === 0) return; // L14DFF_Exit: no sword
  const x = 0x0d;
  if (ram[ObjState + x] !== 0) return; // sword or rod in use
  ram[ObjAnimCounter + x] = 0x05;
  WieldWeapon(0x01, x);
  return PlayEffect(0x01); // sword sound effect
}

/**
 * UpdateSwordOrRod (Z_07). X = $0D (sword) or $12 (rod). Steps the 5 states of a swing (state 2
 * lasts 8 frames, the others 1), keeps the weapon next to Link and draws it; in state 3 it makes
 * the sword shot (full hearts) or the rod's magic shot (slot $0E).
 */
export function UpdateSwordOrRod(x) {
  // UpdateSwordOrRod (Z_07)
  let a, y;
  if ((ram[ObjState + x] & 0x0f) === 0) return; // @Exit
  ram[ObjAnimCounter + x]--;
  if (ram[ObjAnimCounter + x] === 0) {
    y = ram[ObjState + x] & 0x0f;
    a = 0x08;
    y = (y - 1) & 0xff;
    if (y !== 0) a = 0x01;
    ram[ObjAnimCounter] = a;
    ram[ObjAnimCounter + x] = a;
    ram[ObjState + x]++;
    if ((ram[ObjState + x] & 0x0f) >= 0x06) {
      ResetObjState(x);
      return; // @Exit
    }
  }
  // @DrawSwordOrRod
  ram[0x0f] = 0x00;
  y = ram[ObjState + x] & 0x0f;
  a = 0xfc;
  if (y === 0x05) return; // @Exit: state 5 is not drawn
  do {
    // @Add4: [00] = (state - 1) * 4
    a = (a + 0x04) & 0xff;
    y = (y - 1) & 0xff;
  } while (y !== 0);
  ram[0x00] = a;
  ram[ObjDir + x] = ram[ObjDir];
  y = (GetOppositeDir(ram[ObjDir]).y + ram[0x00]) & 0xff;
  a = (ram[ObjX] + table(bus.rom, 'PlayerToWeaponOffsetsX').byte(y)) & 0xff;
  ram[ObjX + x] = a;
  ram[0x00] = a;
  a = (ram[ObjY] + table(bus.rom, 'PlayerToWeaponOffsetsY').byte(y)) & 0xff;
  ram[ObjY + x] = a;
  ram[0x01] = a;

  // State 1 uses the up direction.
  y = ram[ObjState + x] & 0x0f;
  a = 0x08;
  y = (y - 1) & 0xff;
  if (y !== 0) a = ram[ObjDir + x];
  // @CalcAttrs
  y = GetOppositeDir(a).y;
  ram[0x0c] = table(bus.rom, 'RDirectionToWeaponFrame').byte(y);
  a = table(bus.rom, 'RDirectionToWeaponBaseAttribute').byte(y);
  if (x !== 0x0d) {
    a |= 0x01; // rod: palette row 5
  } else {
    a = (a + ram[Items] - 0x01) & 0xff; // @CalcSwordAttrs: (item value - 1) + base attribute
  }
  // @SetAttrs
  Anim_SetSpriteDescriptorAttributes(a);
  if (y === 0x02) ram[0x0f]++; // left: flip
  if ((ram[ObjState + x] & 0x0f) === 0x01) return; // L1F854_Exit: not shown in state 1

  Anim_WriteItemSprites(x, x === 0x0d ? 0x00 : 0x08); // sword slot / rod slot
  if ((ram[ObjState + x] & 0x0f) !== 0x03) return; // L1F854_Exit

  // State 3: make a shot.
  if (x !== 0x12) return MakeSwordShot();
  x = 0x0e;
  a = ram[ObjState + x];
  if (a !== 0 && (a & 0x80)) return; // L1F854_Exit: a magic shot is already active
  // @MakeMagicShot
  ram[Tune0Request] = 0x04;
  return SetUpWeaponWithState(0x80, x);
}

/**
 * SetUpWeaponWithState (Z_07, label inside UpdateSwordOrRod). A = shot state, X = $0E.
 * Places the shot next to Link; a horizontal shot too close to the edges is deactivated.
 */
function SetUpWeaponWithState(a, x) {
  ram[ObjState + x] = a;
  PlaceWeapon(0x10, x);
  if (ram[ObjDir + x] & 0x03) {
    a = ram[ObjX + x];
    if (a < 0x14) return ResetObjState(x);
    if (a >= 0xec) return ResetObjState(x);
  }
  // @ChooseSpeed: magic shot $A0, sword shot $C0
  ram[ObjQSpeedFrac + x] = ram[ObjState + x] & 0x80 ? 0xa0 : 0xc0;
  ram[ObjGridOffset + x] = ram[ObjGridOffset];
}

/**
 * MakeSwordShot (Z_07, label inside UpdateSwordOrRod): a sword shot in slot $0E (state $10) when
 * the hearts are full (or ForceSwordShot).
 */
function MakeSwordShot() {
  const x = 0x0e;
  if (ram[ObjState + x] !== 0) return; // L1F854_Exit
  if (ram[ForceSwordShot] === 0) {
    const a = ram[HeartValues];
    ram[0x00] = a & 0x0f;
    if (a >> 4 !== ram[0x00]) return; // full hearts <> containers - 1
    if (ram[HeartPartial] < 0x80) return; // partial heart less than half full
  }
  // @SetUp
  PlaySample(0x01); // sword shot sound effect
  return SetUpWeaponWithState(0x10, x);
}

/** ResetObjState (Z_07). X = object. @returns A = 0 */
export function ResetObjState(x) {
  // ResetObjState (Z_07)
  ram[ObjState + x] = 0x00;
  return 0x00;
}
