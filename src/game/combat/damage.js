// P07 combat — damage dealt to monsters, their death, parries (Z_01, BANK_01_CODE run from WRAM).
// X = monster slot, Y = weapon slot, [07] = damage points, [09] = damage type.

import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjInvincibilityMask, ObjInvincibilityTimer, ObjType, ObjDir, ObjHP, ObjStunTimer,
  Tune0Request, WorldKillCount, HelpDropCount, HelpDropValue,
} from '../../core/vars.js';
import { Gohma_HandleWeaponCollision } from '../bosses/gohma.js';
import { UpdateDeadDummy } from '../objects/metaobject.js';
import { SetShoveInfoWith0 } from '../movement/shove.js';
import { BeginShove } from './link-harm.js';

/**
 * HandleMonsterWeaponCollision (Z_01). X = monster slot, Y = weapon slot, [07]/[09] set.
 * Immune monsters parry; Gohma handles its own hits; zol/vire turn to the weapon's direction;
 * a darknut facing the weapon parries; the rest take damage.
 */
export function HandleMonsterWeaponCollision(x, y) {
  // HandleMonsterWeaponCollision (Z_01)
  $pxa('Z_01:5924', ObjInvincibilityMask, x);
  if ($br('Z_01:5926', (ram[ObjInvincibilityMask + x] & ram[0x09]) !== 0)) return L_PlayParrySoundForDamageType();
  $pxa('Z_01:5930', ObjType, x);
  const t = ram[ObjType + x];
  if ($br('Z_01:5932', t === 0x33) || !$br('Z_01:5934', t !== 0x34)) return Gohma_HandleWeaponCollision(x, y);
  // @CheckZolVire
  if ($br('Z_01:5944', t === 0x13) || !$br('Z_01:5946', t !== 0x12)) {
    if ($br('Z_01:5949', y === 0x0f)) return DealDamage(x);
    $pxa('Z_01:5950', ObjDir, y);
    ram[(ObjDir + x) & 0xff] = ram[ObjDir + y];
    return DealDamage(x);
  }
  // @CheckDarknut
  if ($br('Z_01:5958', t === 0x0b) || !$br('Z_01:5960', t !== 0x0c)) {
    $pxa('Z_01:5962', ObjDir, y);
    const d = ram[ObjDir + y] | ram[(ObjDir + x) & 0xff];
    if ($br('Z_01:5965', d === 0x0c) || $br('Z_01:5967', d === 0x03)) return L_PlayParrySoundForDamageType();
  }
  return DealDamage(x); // falls through
}

/** DealDamage (Z_01). X = monster slot, [07] = damage points: "harmed" tune, HP -= [07]. */
export function DealDamage(x) {
  // DealDamage (Z_01)
  ram[Tune0Request] = 0x02;
  $pxa('Z_01:5976', ObjHP, x);
  const hp = ram[ObjHP + x];
  if ($br('Z_01:5978', hp < ram[0x07])) return HandleMonsterDied(x);
  ram[ObjHP + x] = hp - ram[0x07];
  if ($br('Z_01:5982', ram[ObjHP + x] === 0)) return HandleMonsterDied(x);
}

/** L_PlayParrySoundForDamageType (Z_01, part of HandleMonsterWeaponCollision): not for fire/bombs. */
export function L_PlayParrySoundForDamageType() {
  // L_PlayParrySoundForDamageType (Z_01)
  const a = ram[0x09];
  if ($br('Z_01:5991', a === 0x20) || $br('Z_01:5993', a === 0x08)) return; // fire, bomb
  return PlayParryTune();
}

/**
 * HandleMonsterDied (Z_01, part of DealDamage). Counts the kill and the help drop counter
 * (a bomb drop is armed when it reaches $A with a bomb kill), starts the death spark.
 */
export function HandleMonsterDied(x) {
  // HandleMonsterDied (Z_01)
  ram[WorldKillCount]++;
  if (!$br('Z_01:6003', ram[HelpDropCount] >= 0x0a)) {
    ram[HelpDropCount]++;
    if (!$br('Z_01:6010', ram[HelpDropCount] !== 0x0a) && !$br('Z_01:6013', ram[0x09] !== 0x08)) ram[HelpDropValue]++;
  }
  // @SetDyingMetastate
  UpdateDeadDummy(x);
  ram[(ObjStunTimer + x) & 0xff] = 0x00; // zp,X
  return ResetShoveInfoAndInvincibilityTimer(0x00, x); // falls through
}

/** ResetShoveInfoAndInvincibilityTimer (Z_01). A = 0, X = object. @returns A */
export function ResetShoveInfoAndInvincibilityTimer(a, x) {
  // ResetShoveInfoAndInvincibilityTimer (Z_01)
  a = SetShoveInfoWith0(a, x);
  ram[ObjInvincibilityTimer + x] = a;
  return a;
}

/**
 * ParryOrShove (Z_01). X = monster slot, Y = weapon slot. A darknut facing the weapon parries;
 * otherwise the monster is shoved.
 */
export function ParryOrShove(x, y) {
  // ParryOrShove (Z_01)
  $pxa('Z_01:6318', ObjType, x);
  const t = ram[ObjType + x];
  if ($br('Z_01:6320', t === 0x0b) || !$br('Z_01:6322', t !== 0x0c)) {
    $pxa('Z_01:6324', ObjDir, y);
    const d = ram[ObjDir + y] | ram[(ObjDir + x) & 0xff];
    if ($br('Z_01:6327', d === 0x0c) || $br('Z_01:6329', d === 0x03)) return PlayParryTune();
  }
  return BeginShove(x);
}

/** PlayParryTune (Z_01). @returns A = 1 */
export function PlayParryTune() {
  // PlayParryTune (Z_01)
  ram[Tune0Request] = 0x01;
  return 0x01;
}
