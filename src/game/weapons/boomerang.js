// P09 weapons — Link's boomerang and food in slot $0F: WieldBoomerang, WieldFood (Z_05) and
// UpdateBoomerangOrFood (Z_07). The flying boomerang itself is UpdateArrowOrBoomerang (arrow.js).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  InvBoomerang, InvMagicBoomerang, ObjState, ObjMovingLimit, ObjQSpeedFrac, ObjAnimCounter, ObjInputDir,
  ObjDir, ObjTimer, ObjX, ObjY, RoomObjTemplateType, ChaseTargetX, ChaseTargetY,
} from '../../core/vars.js';
import { Anim_FetchObjPosForSpriteDescriptor } from '../draw/anim.js';
import { Anim_WriteStaticItemSpritesWithAttributes } from '../draw/items.js';
import { PlaceWeaponForPlayerState, PlaceWeaponForPlayerStateAndAnimAndWeaponState } from './wield.js';
import { UpdateArrowOrBoomerang } from './arrow.js';
import { ResetObjState } from './sword.js';

/**
 * WieldBoomerang (Z_05): throws the boomerang (slot $0F, state $10) in the input direction (may be
 * diagonal) or Link's facing direction; its range comes from BoomerangLimits by boomerang kind.
 */
export function WieldBoomerang() {
  // WieldBoomerang (Z_05)
  if ((ram[InvBoomerang] | ram[InvMagicBoomerang]) === 0) return; // L14E71_Exit
  const x = 0x0f;
  const a = ram[ObjState + x];
  if (a !== 0 && (a & 0x80) === 0) return; // L14E71_Exit: in use (food has the high bit set)
  ram[ObjState + x] = 0x10;
  ram[ObjMovingLimit + x] = table(bus.rom, 'BoomerangLimits').byte(ram[InvMagicBoomerang]);
  PlaceWeaponForPlayerState(x);
  ram[ObjQSpeedFrac + x] = 0xc0; // 3 pixels a frame
  ram[ObjAnimCounter + x] = 0x03; // the first turning frame lasts 3 frames
  ram[ObjAnimCounter] = 0x01;
  let d = ram[ObjInputDir];
  if (d === 0) d = ram[ObjDir];
  ram[ObjDir + x] = d;
}

/** WieldFood (Z_05): sets the bait (slot $0F, state $80, first state $FF frames). */
export function WieldFood() {
  // WieldFood (Z_05)
  const x = 0x0f;
  if (ram[ObjState + x] !== 0) return; // L14EC6_Exit
  ram[ObjTimer + x] = 0xff;
  return PlaceWeaponForPlayerStateAndAnimAndWeaponState(0x80, x);
}

/**
 * UpdateBoomerangOrFood (Z_07). X = $0F. A boomerang (high bit clear) goes to UpdateArrowOrBoomerang;
 * food lasts 3 timer periods, attracts some monster kinds (ChaseTarget) and is drawn.
 */
export function UpdateBoomerangOrFood(x) {
  // UpdateBoomerangOrFood (Z_07)
  let a = ram[ObjState + x];
  if (a === 0) return; // L1F49F_Exit
  if ((a & 0x80) === 0) return UpdateArrowOrBoomerang(x);
  // Food.
  if (ram[ObjTimer + x] === 0) {
    ram[ObjState + x]++;
    if ((ram[ObjState + x] & 0x0f) === 0x03) return ResetObjState(x); // @Deactivate
    ram[ObjTimer + x] = 0xff;
  }
  // @CheckMonsterType: moblins..darknut-1, vire, keese chase the food.
  a = ram[RoomObjTemplateType];
  if (a >= 0x03 && (a < 0x0b || a === 0x12 || a === 0x1b || a === 0x1c)) {
    // @AttractMonsters
    ram[ChaseTargetX] = ram[ObjX + x];
    ram[ChaseTargetY] = ram[ObjY + x];
  }
  // @Draw: red sprite palette, food item slot
  Anim_FetchObjPosForSpriteDescriptor(x);
  return Anim_WriteStaticItemSpritesWithAttributes(0x02, x, 0x06);
}
