// P07 combat — damage dealt to monsters, their death, parries (Z_01, BANK_01_CODE run from WRAM).
// X = monster slot, Y = weapon slot, [07] = damage points, [09] = damage type.

import { ram } from '../../core/ram.js';
import {
  ObjInvincibilityMask, ObjInvincibilityTimer, ObjType, ObjDir, ObjHP, ObjStunTimer,
  Tune0Request, WorldKillCount, HelpDropCount, HelpDropValue,
} from '../../core/vars.js';
import { stub } from '../stub.js';
import * as Gohma from '../bosses/gohma.js';
import { UpdateDeadDummy } from '../objects/metaobject.js';
import { SetShoveInfoWith0 } from '../movement/shove.js';
import { BeginShove } from './link-harm.js';

// Gohma_HandleWeaponCollision (Z_04) belongs to P21 (bosses/gohma.js, a later wave). A namespace
// import keeps this module loadable whether or not that export exists yet. Called with X, Y.
const GohmaStub = stub('Gohma_HandleWeaponCollision');
function Gohma_HandleWeaponCollision(x, y) {
  return Gohma.Gohma_HandleWeaponCollision ? Gohma.Gohma_HandleWeaponCollision(x, y) : GohmaStub(ram[ObjType + x], x, y);
}

/**
 * HandleMonsterWeaponCollision (Z_01). X = monster slot, Y = weapon slot, [07]/[09] set.
 * Immune monsters parry; Gohma handles its own hits; zol/vire turn to the weapon's direction;
 * a darknut facing the weapon parries; the rest take damage.
 */
export function HandleMonsterWeaponCollision(x, y) {
  // HandleMonsterWeaponCollision (Z_01)
  if (ram[ObjInvincibilityMask + x] & ram[0x09]) return L_PlayParrySoundForDamageType();
  const t = ram[ObjType + x];
  if (t === 0x33 || t === 0x34) return Gohma_HandleWeaponCollision(x, y);
  // @CheckZolVire
  if (t === 0x13 || t === 0x12) {
    if (y === 0x0f) return DealDamage(x);
    ram[ObjDir + x] = ram[ObjDir + y];
    return DealDamage(x);
  }
  // @CheckDarknut
  if (t === 0x0b || t === 0x0c) {
    const d = ram[ObjDir + y] | ram[ObjDir + x];
    if (d === 0x0c || d === 0x03) return L_PlayParrySoundForDamageType();
  }
  return DealDamage(x); // falls through
}

/** DealDamage (Z_01). X = monster slot, [07] = damage points: "harmed" tune, HP -= [07]. */
export function DealDamage(x) {
  // DealDamage (Z_01)
  ram[Tune0Request] = 0x02;
  const hp = ram[ObjHP + x];
  if (hp < ram[0x07]) return HandleMonsterDied(x);
  ram[ObjHP + x] = hp - ram[0x07];
  if (ram[ObjHP + x] === 0) return HandleMonsterDied(x);
}

/** L_PlayParrySoundForDamageType (Z_01, part of HandleMonsterWeaponCollision): not for fire/bombs. */
export function L_PlayParrySoundForDamageType() {
  // L_PlayParrySoundForDamageType (Z_01)
  const a = ram[0x09];
  if (a === 0x20 || a === 0x08) return; // fire, bomb
  return PlayParryTune();
}

/**
 * HandleMonsterDied (Z_01, part of DealDamage). Counts the kill and the help drop counter
 * (a bomb drop is armed when it reaches $A with a bomb kill), starts the death spark.
 */
export function HandleMonsterDied(x) {
  // HandleMonsterDied (Z_01)
  ram[WorldKillCount]++;
  if (ram[HelpDropCount] < 0x0a) {
    ram[HelpDropCount]++;
    if (ram[HelpDropCount] === 0x0a && ram[0x09] === 0x08) ram[HelpDropValue]++;
  }
  // @SetDyingMetastate
  UpdateDeadDummy(x);
  ram[ObjStunTimer + x] = 0x00;
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
  const t = ram[ObjType + x];
  if (t === 0x0b || t === 0x0c) {
    const d = ram[ObjDir + y] | ram[ObjDir + x];
    if (d === 0x0c || d === 0x03) return PlayParryTune();
  }
  return BeginShove(x);
}

/** PlayParryTune (Z_01). @returns A = 1 */
export function PlayParryTune() {
  // PlayParryTune (Z_01)
  ram[Tune0Request] = 0x01;
  return 0x01;
}
