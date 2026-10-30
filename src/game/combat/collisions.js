// P07 combat — object-to-object collisions (Z_01, BANK_01_CODE run from WRAM): monsters against
// Link's weapons and against Link himself.
//
// Register conventions (docs/ARCHITECTURE.md §6): X = monster slot, Y = weapon slot. Every weapon
// check leaves its results in the temporaries like the original:
//   [00] weapon slot, [02]/[03] monster middle, [04]/[05] weapon/Link middle, [06] collision flag,
//   [07] damage points, [09] damage type, [0A]/[0B] distances, [0C] Link hit, [0D]/[0E] thresholds.

import { ram } from '../../core/ram.js';
import {
  ObjAttr, ObjX, ObjY, ObjDir, ObjState, ObjType, ObjMetastate, ObjRefId, ObjCaptureTimer,
  ObjInvincibilityTimer, ObjInvincibilityMask, ObjStunTimer, ObjHP, ObjAnimCounter,
  ShotCollidesWithLink, InvClock, InvMagicShield, InvArrow, LinkParalyzed, Items, Tune0Request,
} from '../../core/vars.js';
import { Abs } from '../movement/math.js';
import { HandleShotBlocked } from '../weapons/shots.js';
import { HandleMonsterWeaponCollision, DealDamage, ParryOrShove, PlayParryTune } from './damage.js';
import { HarmLink, BeginShove } from './link-harm.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';

/**
 * CheckMonsterCollisions (Z_01). X = monster slot. Checks Link's weapons against the monster (unless
 * it is invincible), then the monster against Link; destroys a dying goriya's boomerang and flags
 * the capture of Link by a wallmaster/like-like. May change the monster's facing direction.
 */
export function CheckMonsterCollisions(x) {
  // CheckMonsterCollisions (Z_01)
  GetObjectMiddle(x);
  $pxa('Z_01:5480', ObjAttr, x);
  if (!$br('Z_01:5482', (ram[ObjAttr + x] & 0x20) !== 0)) {
    // Not invincible. If temporarily invincible, return.
    $pxa('Z_01:5485', ObjInvincibilityTimer, x);
    if ($br('Z_01:5486', ram[ObjInvincibilityTimer + x] !== 0)) return;
    CheckMonsterBoomerangOrFoodCollision(x, 0x0f);
    CheckMonsterSwordShotOrMagicShotCollision(x, 0x0e);
    CheckMonsterBombOrFireCollision(x, 0x10);
    CheckMonsterBombOrFireCollision(x, 0x11);
    CheckMonsterSwordCollision(x, 0x0d);
    CheckMonsterArrowOrRodCollision(x, 0x12);
  }
  // @CheckLink
  CheckLinkCollision(x);
  $pxa('Z_01:5507', ObjType, x);
  const a = ram[ObjType + x];
  $pxa('Z_01:5508', ObjMetastate, x);
  if (!$br('Z_01:5509', ram[ObjMetastate + x] === 0)) {
    // Dying: a goriya that threw a boomerang destroys it.
    if (!$br('Z_01:5515', a === 0x05) && $br('Z_01:5517', a !== 0x06)) return;
    if ($br('Z_01:5520', !(ram[(ObjState + x) & 0xff] & 0x80))) return;
    $pxa('Z_01:5521', ObjRefId, x);
    const y = ram[ObjRefId + x];
    ram[ObjType + y] = 0x00;
    return;
  }
  // @CheckCaptors: wallmaster / like-like with a hit in [0C].
  if (!$br('Z_01:5532', a === 0x27) && $br('Z_01:5534', a !== 0x17)) return;
  if ($br('Z_01:5537', ram[0x0c] === 0)) return;
  ram[ObjCaptureTimer + x]++;
}

/**
 * GetObjectMiddle (Z_01). X = object. [02] = X + 8 (+4 for half-width objects), [03] = Y + 8.
 * The routine has no RTS: it runs into ObjTypeToDamagePoints, whose first byte is $60 (RTS).
 * @returns A = [03]
 */
export function GetObjectMiddle(x) {
  // GetObjectMiddle (Z_01)
  ram[0x02] = 0x08;
  ram[0x03] = 0x08;
  $pxa('Z_01:5557', ObjAttr, x);
  if (!$br('Z_01:5559', (ram[ObjAttr + x] & 0x40) === 0)) ram[0x02] >>= 1; // half width
  ram[0x02] = ram[(ObjX + x) & 0xff] + ram[0x02];
  ram[0x03] = ram[(ObjY + x) & 0xff] + ram[0x03];
  return ram[0x03];
}

/**
 * CheckLinkCollision (Z_01). X = monster slot. Resets ShotCollidesWithLink, [06], [09], [0C] and
 * [00] (= Link's slot), and checks for a collision unless Link, the clock or a stun forbids it.
 * Results: [06]/[0C] = 1 on a harmful hit, ShotCollidesWithLink for projectiles.
 */
export function CheckLinkCollision(x) {
  // CheckLinkCollision (Z_01)
  GetObjectMiddle(x);
  ram[ShotCollidesWithLink] = 0;
  ram[0x06] = 0;
  ram[0x09] = 0;
  ram[0x0c] = 0;
  ram[0x00] = 0;
  if ($br('Z_01:5617', (ram[ObjInvincibilityTimer] | ram[InvClock] | ram[ObjStunTimer] | ram[(ObjStunTimer + x) & 0xff]) !== 0)) return;
  return CheckLinkCollisionPreinit(x); // falls through
}

/**
 * CheckLinkCollisionPreinit (Z_01). X = monster slot, [02]/[03] = its middle, [00] = 0.
 * Ganon calls it directly.
 */
export function CheckLinkCollisionPreinit(x) {
  // CheckLinkCollisionPreinit (Z_01)
  if ($br('Z_01:5623', ram[ObjState] === 0x40)) return; // Link halted
  if ($br('Z_01:5625', ram[LinkParalyzed] !== 0)) return;
  // A monster shot only harms in its flying state ($1x).
  $pxa('Z_01:5629', ObjType, x);
  if (!$br('Z_01:5631', ram[ObjType + x] < 0x53)
    && $br('Z_01:5635', (ram[(ObjState + x) & 0xff] & 0xf0) !== 0x10)) return;
  ram[0x04] = ram[ObjX] + 0x08;
  ram[0x05] = ram[ObjY] + 0x08;
  if ($br('Z_01:5650', DoObjectsCollide(0x09) === 0)) return;
  $pxa('Z_01:5655', ObjType, x);
  const t = ram[ObjType + x];
  if ($br('Z_01:5657', t < 0x53)) return HarmLink(x);
  // A monster's shot/projectile.
  ram[ShotCollidesWithLink]++;
  if ($br('Z_01:5666', t === 0x56) || $br('Z_01:5668', t === 0x5a)) return HarmLink(x);
  if ($br('Z_01:5671', (ram[ObjState] & 0xf0) !== 0)) return HarmLink(x);
  // Facing opposite directions? (one component of a diagonal direction is enough)
  const dx = (ObjDir + x) & 0xff; // zp,X
  if (!$br('Z_01:5682', ((ram[ObjDir] | ram[dx]) & 0x0c) === 0x0c)
      && $br('Z_01:5687', ((ram[ObjDir] | ram[dx]) & 0x03) !== 0x03)) return HarmLink(x);
  // @FacingOpposite: rocks, $54, arrows and boomerangs are always parried; the rest need the
  // magic shield.
  $pxa('Z_01:5696', ObjType, x);
  const t2 = ram[ObjType + x];
  if (!$br('Z_01:5698', t2 < 0x55) && !$br('Z_01:5700', t2 >= 0x5b)
    && $br('Z_01:5705', ram[InvMagicShield] === 0)) return HarmLink(x);
  // @Parry
  ram[Tune0Request] = 0x01;
  ram[0x06] = 0x00;
}

/**
 * CheckMonsterBoomerangOrFoodCollision (Z_01). X = monster slot, Y = weapon slot ($0F).
 * Food (state bit 7) never collides.
 */
export function CheckMonsterBoomerangOrFoodCollision(x, y) {
  // CheckMonsterBoomerangOrFoodCollision (Z_01)
  $pxa('Z_01:5837', ObjState, y);
  if ($br('Z_01:5839', (ram[ObjState + y] & 0x80) !== 0)) return; // ASL / BCS to an RTS
  ram[0x00] = y;
  ram[0x09] = 0x02; // boomerang damage type
  ram[0x0d] = 0x0a;
  ram[0x0e] = 0x0a;
  $pxa('Z_01:5852', ObjX, y);
  ram[0x04] = ram[ObjX + y] + 0x04;
  $pxa('Z_01:5858', ObjY, y);
  return CheckMonsterWeaponCollision(ram[ObjY + y] + 0x08, x); // falls through
}

/**
 * CheckMonsterWeaponCollision (Z_01). A = weapon middle Y, X = monster slot, [00] = weapon slot,
 * [02]-[04], [07], [09], [0D], [0E] set up. Sets [05] and [06].
 * @returns Y (the weapon slot loaded from [00]; callers keep using it)
 */
export function CheckMonsterWeaponCollision(a, x) {
  // CheckMonsterWeaponCollision (Z_01)
  ram[0x05] = a;
  ram[0x06] = 0x00;
  const y = ram[0x00];
  $pxa('Z_01:5887', ObjState, y);
  if ($br('Z_01:5888', ram[ObjState + y] === 0)) return y;
  if ($br('Z_01:5892', DoObjectsCollideWithThresholds() === 0)) return y;
  if ($br('Z_01:5896', y !== 0x0f)) {
    HandleMonsterWeaponCollision(x, y);
    return y;
  }
  // The boomerang: parry sound if the monster is immune to it; it returns fast to the thrower.
  $pxa('Z_01:5900', ObjInvincibilityMask, x);
  if (!$br('Z_01:5902', (ram[ObjInvincibilityMask + x] & ram[0x09]) === 0)) PlayParryTune();
  ram[ObjState + y] = 0x50;
  $pxa('Z_01:5910', ObjInvincibilityMask, x);
  if ($br('Z_01:5912', (ram[ObjInvincibilityMask + x] & ram[0x09]) !== 0)) return y;
  // It stuns: no damage points, stun timer $10 ($A0 frames).
  ram[0x07] = 0x00;
  ram[(ObjStunTimer + x) & 0xff] = 0x10;
  HandleMonsterWeaponCollision(x, y);
  return y;
}

/**
 * CheckMonsterSwordShotOrMagicShotCollision (Z_01). X = monster slot, Y = weapon slot ($0E).
 * A spreading sword shot does not collide; a hit shot is blocked (HandleShotBlocked).
 */
export function CheckMonsterSwordShotOrMagicShotCollision(x, y) {
  // CheckMonsterSwordShotOrMagicShotCollision (Z_01)
  ram[0x00] = y;
  ram[0x09] = 0x10; // magic shot damage type
  $pxa('Z_01:6047', ObjState, y);
  if ($br('Z_01:6049', (ram[ObjState + y] & 0x01) !== 0)) return; // sword shot spreading out
  ram[0x0d] = 0x0c;
  let dmg = 0x20;
  $pxa('Z_01:6056', ObjState, y);
  if (!$br('Z_01:6059', (ram[ObjState + y] & 0x80) !== 0)) {
    // A sword shot: sword damage type and points by sword.
    ram[0x09] = 0x01;
    const s = ram[Items];
    dmg = $br('Z_01:6074', s === 0x03) ? 0x40 : $br('Z_01:6077', s === 0x02) ? 0x20 : 0x10;
  }
  // @CheckCollision
  CheckMonsterShotCollision(dmg, x);
  if ($br('Z_01:6086', ram[0x06] === 0)) return;
  HandleShotBlocked(0x0e); // X = shot slot; TXA/PHA ... PLA/TAX keep the monster slot
}

/**
 * CheckMonsterBombOrFireCollision (Z_01). X = monster slot, Y = weapon slot ($10/$11).
 * Fire: type $20, $10 points, threshold $E. Detonating bomb (state $13): type 8, $40 points, $18.
 */
export function CheckMonsterBombOrFireCollision(x, y) {
  // CheckMonsterBombOrFireCollision (Z_01)
  ram[0x00] = y;
  ram[0x09] = 0x20;
  ram[0x07] = 0x10;
  ram[0x0d] = 0x0e;
  $pxa('Z_01:6121', ObjState, y);
  const st = ram[ObjState + y];
  if (!$br('Z_01:6123', st >= 0x20)) {
    if ($br('Z_01:6125', st !== 0x13)) return;
    ram[0x09] = 0x08;
    ram[0x07] = 0x40;
    ram[0x0d] = 0x18;
  }
  // @SetHotspot
  $pxa('Z_01:6138', ObjX, y);
  ram[0x04] = ram[ObjX + y] + 0x08;
  $pxa('Z_01:6142', ObjY, y);
  ram[0x05] = ram[ObjY + y] + 0x08;
  if ($br('Z_01:6150', DoObjectsCollide(ram[0x0d]) === 0)) return;
  HandleMonsterWeaponCollision(x, ram[0x00]); // Y = [00] (DoObjectsCollideWithThresholds)
  $pxa('Z_01:6154', ObjInvincibilityMask, x);
  if ($br('Z_01:6156', (ram[ObjInvincibilityMask + x] & ram[0x09]) !== 0)) return;
  BeginShove(x);
}

/** CheckMonsterSwordCollision (Z_01). X = monster slot, Y = weapon slot ($0D): fully extended sword. */
export function CheckMonsterSwordCollision(x, y) {
  // CheckMonsterSwordCollision (Z_01)
  ram[0x00] = y;
  ram[0x09] = 0x01; // sword damage type
  $pxa('Z_01:6183', ObjState, y);
  if ($br('Z_01:6185', ram[ObjState + y] !== 0x02)) return;
  // LDA SwordDamagePoints-1, Y (Y = Items)
  const sdp = table(bus.rom, 'SwordDamagePoints');
  $pxa('Z_01:6189', label('SwordDamagePoints').addr - 1, ram[Items]); // run address (WRAM)
  const a = sdp.byte(ram[Items] - 1);
  return CheckMonsterStabbingCollision(a, x); // falls through
}

/**
 * CheckMonsterStabbingCollision (Z_01). A = damage points, X = monster slot, [00] = weapon slot,
 * [09] = damage type. Thresholds by Link's direction.
 */
export function CheckMonsterStabbingCollision(a, x) {
  // CheckMonsterStabbingCollision (Z_01)
  ram[0x07] = a;
  if (!$br('Z_01:6210', (ram[ObjDir] & 0x0c) === 0)) {
    ram[0x0d] = 0x0c;
    ram[0x0e] = 0x10;
  } else {
    // @Horizontal
    ram[0x0d] = 0x10;
    ram[0x0e] = 0x0c;
  }
  const y = CheckMonsterSlenderWeaponCollision2(x);
  if ($br('Z_01:6229', ram[0x06] === 0)) return;
  return ParryOrShove(x, y);
}

/** CheckMonsterArrowOrRodCollision (Z_01). X = monster slot, Y = weapon slot ($12). */
export function CheckMonsterArrowOrRodCollision(x, y) {
  // CheckMonsterArrowOrRodCollision (Z_01)
  ram[0x00] = y;
  $pxa('Z_01:6244', ObjState, y);
  const st = ram[ObjState + y];
  if (!$br('Z_01:6249', st < 0x30)) {
    // The rod: a stab with $20 points.
    ram[0x09] = 0x01;
    $br('Z_01:6253', true); // BNE CheckMonsterStabbingCollision (always)
    return CheckMonsterStabbingCollision(0x20, x);
  }
  if ($br('Z_01:6257', st >= 0x20)) return; // the arrow is no longer flying
  ram[0x09] = 0x04; // arrow damage type
  let a = 0x20;
  if (!$br('Z_01:6267', ram[InvArrow] === 0x01)) a = (a << 1) & 0xff; // silver arrow
  ram[0x0d] = 0x0b;
  return CheckMonsterShotCollision(a, x); // falls through
}

/**
 * CheckMonsterShotCollision (Z_01). A = damage points, X = monster slot, [00] = weapon slot,
 * [09] = damage type, [0D] = threshold (both axes).
 */
export function CheckMonsterShotCollision(a, x) {
  // CheckMonsterShotCollision (Z_01)
  const y = CheckMonsterSlenderWeaponCollision(a, x);
  if ($br('Z_01:6290', ram[0x06] === 0)) return;
  if (!$br('Z_01:6299', y !== 0x12)) {
    // An arrow. Pol's Voice dies for sure.
    $pxa('Z_01:6300', ObjType, x);
    if (!$br('Z_01:6302', ram[ObjType + x] !== 0x16)) {
      ram[ObjHP + x] = 0x00;
      return DealDamage(x);
    }
    // The arrow turns into a spark.
    ram[ObjState + y] = 0x20;
    ram[ObjAnimCounter + y] = 0x03;
  }
  return ParryOrShove(x, y);
}

/**
 * CheckMonsterSlenderWeaponCollision (Z_01). A = damage points -> [07]; [0E] = [0D].
 * @returns Y (weapon slot)
 */
export function CheckMonsterSlenderWeaponCollision(a, x) {
  // CheckMonsterSlenderWeaponCollision (Z_01)
  ram[0x07] = a;
  ram[0x0e] = ram[0x0d];
  return CheckMonsterSlenderWeaponCollision2(x); // falls through
}

/**
 * CheckMonsterSlenderWeaponCollision2 (Z_01). X = monster slot, [00] = weapon slot. The weapon's
 * middle depends on Link's direction (not the weapon's).
 * @returns Y (weapon slot)
 */
export function CheckMonsterSlenderWeaponCollision2(x) {
  // CheckMonsterSlenderWeaponCollision2 (Z_01)
  const y = ram[0x00];
  let a;
  if (!$br('Z_01:6383', (ram[ObjDir] & 0x0c) === 0)) {
    $pxa('Z_01:6384', ObjX, y);
    ram[0x04] = ram[ObjX + y] + 0x06;
    $pxa('Z_01:6388', ObjY, y);
    a = (ram[ObjY + y] + 0x08) & 0xff;
  } else {
    // @CheckHorizontal
    $pxa('Z_01:6399', ObjX, y);
    ram[0x04] = ram[ObjX + y] + 0x08;
    $pxa('Z_01:6403', ObjY, y);
    a = (ram[ObjY + y] + 0x06) & 0xff;
  }
  return CheckMonsterWeaponCollision(a, x);
}

/**
 * DoObjectsCollide (Z_01). A = threshold for both axes ([0D] and [0E]).
 * @returns A = [06] (1 if the objects collide; Z flag = A === 0)
 */
export function DoObjectsCollide(a) {
  // DoObjectsCollide (Z_01)
  ram[0x0d] = a;
  ram[0x0e] = a;
  return DoObjectsCollideWithThresholds(); // falls through
}

/**
 * DoObjectsCollideWithThresholds (Z_01). [02]/[03] vs [04]/[05], thresholds [0D]/[0E].
 * Sets [06], [0A] (|dx|) and [0B] (|dy|, only if [0A] < [0D]).
 * @returns A = [06] (Y = [00])
 */
export function DoObjectsCollideWithThresholds() {
  // DoObjectsCollideWithThresholds (Z_01)
  ram[0x06] = 0x00;
  ram[0x0a] = Abs((ram[0x02] - ram[0x04]) & 0xff);
  if ($br('Z_01:6464', ram[0x0a] >= ram[0x0d])) return ram[0x06];
  ram[0x0b] = Abs((ram[0x03] - ram[0x05]) & 0xff);
  if ($br('Z_01:6475', ram[0x0b] >= ram[0x0e])) return ram[0x06];
  ram[0x06]++;
  return ram[0x06];
}
