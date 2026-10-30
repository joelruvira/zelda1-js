// P09 weapons — arrows and boomerangs in flight (Z_07), Link's and the monsters' (X < $0D, arrow =
// ObjType $5B), and WieldArrow (Z_05).
//
// Major states: $10 flying away, $20 spark (blocked / limit reached), $30 boomerang slowing down,
// $40/$50 boomerang returning (slow/fast). The low bits are the boomerang's spinning cycle.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import {
  Bow, InvRupees, RupeesToSubtract, InvArrow, InvMagicBoomerang, ObjState, ObjDir, ObjType, ObjX, ObjY,
  ObjGridOffset, ObjMovingLimit, ObjAnimCounter, ObjQSpeedFrac, ObjRefId, ObjTimer, Random,
  ShotCollidesWithLink,
} from '../../core/vars.js';
import { MoveShot, DestroyCountedMonsterShot } from '../enemies/shots.js';
import { PlayEffect, PlayBoomerangSfx } from '../audio/requests.js';
import {
  GetOppositeDir, GetDirectionsAndDistancesToTarget, _CalcDiagonalSpeedIndex, SetBoomerangSpeed,
} from '../movement/math.js';
import { MoveObject } from '../movement/walker.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { Anim_WriteItemSprites } from '../draw/items.js';
import { CheckLinkCollision } from '../combat/collisions.js';
import { WieldWeapon, WieldNothing } from './wield.js';
import { ResetObjState } from './sword.js';
import { $br, $pxa } from '../../core/timing.js';

/**
 * Link's arrow (slot $12) or a monster's arrow (slot < $0D with type $5B). The refs are the asm's
 * CPX #$0D / BCS, LDA ObjType, X, CMP #$5B / BEQ and CPX #$12 / BEQ (or BNE when `linkBne`).
 */
function isArrow(x, rCpx, rPx, rType, rLink, linkBne = false) {
  if (!$br(rCpx, x >= 0x0d)) {
    $pxa(rPx, ObjType, x);
    if ($br(rType, ram[ObjType + x] === 0x5b)) return true;
  }
  return linkBne ? !$br(rLink, x !== 0x12) : $br(rLink, x === 0x12);
}

/** WieldArrow (Z_05): shoots an arrow (slot $12, state $10) for one rupee, if Link has the bow. */
export function WieldArrow() {
  // WieldArrow (Z_05)
  if ($br('Z_05:2957', ram[Bow] === 0)) return WieldNothing();
  const x = 0x12;
  const a = ram[ObjState + x];
  if (!$br('Z_05:2964', a === 0) && $br('Z_05:2966', (a & 0x80) === 0)) return WieldNothing(); // in use
  if ($br('Z_05:2970', ram[InvRupees] === 0)) return WieldNothing();
  PlayEffect(0x02); // boomerang/arrow sound effect
  ram[RupeesToSubtract]++;
  return WieldWeapon(0x10, x); // falls through
}

/**
 * UpdateArrowOrBoomerang (Z_07). X = weapon slot ($0F boomerang, $12 arrow, or a monster's).
 * State $1x: fly (horizontal then vertical component); blocked or at the boomerang's limit -> spark.
 */
export function UpdateArrowOrBoomerang(x) {
  // UpdateArrowOrBoomerang (Z_07)
  if ($br('Z_07:3860', ram[ObjState + x] === 0)) return; // L1F49F_Exit
  ram[0x00] = 0x00; // axes with distance <= 8 (states $40/$50)
  const a = ram[ObjState + x] & 0xf0;
  if (!$br('Z_07:3872', a === 0x10)) return CheckState20(a, x);
  // @State10: [0E] = 0 -> MoveShot updates the grid offset; $80 out = blocked.
  ram[0x0e] = 0x00;
  if (!$br('Z_07:3888', (ram[ObjDir + x] & 0x03) === 0)) {
    MoveShot(ram[ObjDir + x] & 0x03, x);
    ram[0x0e]++;
  }
  if ($br('Z_07:3895', (ram[0x0e] & 0x80) !== 0)) return HandleArrowOrBoomerangBlocked(x);
  if (!$br('Z_07:3901', (ram[ObjDir + x] & 0x0c) === 0)) MoveShot(ram[ObjDir + x] & 0x0c, x);
  if ($br('Z_07:3907', (ram[0x0e] & 0x80) !== 0)) return HandleArrowOrBoomerangBlocked(x);
  if (isArrow(x, 'Z_07:3911', 'Z_07:3912', 'Z_07:3914', 'Z_07:3918')) return DrawArrow(x);
  // Boomerang: distance traveled = |grid offset|.
  $pxa('Z_07:3922', ObjGridOffset, x);
  let d = ram[ObjGridOffset + x];
  if (!$br('Z_07:3923', (d & 0x80) === 0)) d = ((d ^ 0xff) + 1) & 0xff;
  // @CompareLimit
  $pxa('Z_07:3937', ObjMovingLimit, x);
  if ($br('Z_07:3938', d < ram[ObjMovingLimit + x])) return AnimateBoomerangAndCheckCollision(x);
  ram[ObjMovingLimit + x] = 0x10;
  ram[ObjState + x] = 0x20;
  return HandleArrowOrBoomerangBlocked(x); // @HandleBlocked
}

/** DrawArrow (Z_07). X = arrow slot. Frame and base attribute by direction (flipped when left). */
export function DrawArrow(x) {
  // DrawArrow (Z_07)
  ram[0x0f] = 0x00;
  const a = ram[ObjDir + x];
  if (!$br('Z_07:3958', a !== 0x02)) ram[0x0f]++;
  const { y } = GetOppositeDir(a);
  $pxa('Z_07:3964', label('RDirectionToWeaponFrame').addr, y);
  ram[0x0c] = table(bus.rom, 'RDirectionToWeaponFrame').byte(y);
  $pxa('Z_07:3968', label('RDirectionToWeaponBaseAttribute').addr, y);
  return SetAttrAndDrawArrow(table(bus.rom, 'RDirectionToWeaponBaseAttribute').byte(y), x, y); // falls through
}

/**
 * SetAttrAndDrawArrow (Z_07). A = base attribute, X = arrow slot, Y = reverse direction index.
 * Monster arrow: palette row 6 (+2); Link's: + arrow kind - 1 (wooden row 4, silver row 5).
 */
export function SetAttrAndDrawArrow(a, x, y) {
  // SetAttrAndDrawArrow (Z_07)
  ram[0x04] = a;
  let player = true;
  if (!$br('Z_07:3979', x >= 0x0d)) {
    $pxa('Z_07:3980', ObjType, x);
    a = ram[ObjType + x];
    if (!$br('Z_07:3982', a !== 0x5b)) {
      a = (ram[0x04] + 0x02) & 0xff;
      player = !$br('Z_07:3986', a !== 0); // BNE @SetAttr (falls into @PlayerArrow only with a 0 sum)
    }
  }
  if (player) a = (a + ram[InvArrow] - 0x01) & 0xff; // @PlayerArrow
  // @SetAttr
  ram[0x04] = a;
  ram[0x05] = ram[0x04];
  return OffsetAndDrawArrow(x, y);
}

/**
 * CheckState20 (Z_07). A = major state, X = weapon slot. State $2x: spark for 3 frames (state $28),
 * then arrows are deactivated (a monster's arrow destroyed) and boomerangs start returning.
 */
export function CheckState20(a, x) {
  // CheckState20 (Z_07)
  if ($br('Z_07:4005', a !== 0x20)) return CheckState30(a, x);
  ram[ObjState + x] = 0x28;
  ram[ObjAnimCounter + x]--;
  if ($br('Z_07:4018', ram[ObjAnimCounter + x] !== 0)) return DrawArrowOrBoomerangAndCheckCollisions(x);
  ram[ObjState + x] = 0x40;
  if (!isArrow(x, 'Z_07:4030', 'Z_07:4031', 'Z_07:4033', 'Z_07:4037', true)) return HandleArrowOrBoomerangBlocked(x); // @CheckBoomerangBlocked
  // @Deactivate
  ResetObjState(x);
  if (!$br('Z_07:4045', x >= 0x0d)) DestroyCountedMonsterShot(x);
}

/** HandleArrowOrBoomerangBlocked (Z_07). X = weapon slot. State += $10 (anim counter 3), draw. */
export function HandleArrowOrBoomerangBlocked(x) {
  // HandleArrowOrBoomerangBlocked (Z_07)
  ram[ObjAnimCounter + x] = 0x03;
  ram[ObjState + x] = ram[ObjState + x] + 0x10;
  return DrawArrowOrBoomerangAndCheckCollisions(x); // falls through
}

/** DrawArrowOrBoomerangAndCheckCollisions (Z_07, part of HandleArrowOrBoomerangBlocked). */
function DrawArrowOrBoomerangAndCheckCollisions(x) {
  if (!isArrow(x, 'Z_07:4065', 'Z_07:4066', 'Z_07:4068', 'Z_07:4072')) return DrawBoomerangAndCheckCollision(x); // @DrawPlayerWeapon
  // @PrepareArrow: spark frame, no flipping, base attribute 0.
  ram[0x0c] = 0x02;
  ram[0x0f] = 0x00;
  const { y } = GetOppositeDir(ram[ObjDir + x]);
  return SetAttrAndDrawArrow(0x00, x, y);
}

/** CheckState30 (Z_07, part of CheckState20). States $3x (slow down) and $40/$50 (return). */
function CheckState30(a, x) {
  if (!$br('Z_07:4095', a !== 0x30)) {
    // State $3x: slow down at 1 pixel a frame.
    ram[ObjGridOffset + x] = 0x00;
    ram[ObjQSpeedFrac + x] = 0x40;
    a = ram[ObjDir + x];
    ram[0x0f] = a;
    let state40 = !$br('Z_07:4113', (a & 0x02) === 0) && $br('Z_07:4116', ram[ObjX + x] < 0x02); // too close to the left edge
    if (!state40) {
      // @MoveBoomerang
      MoveObject(x);
      ram[ObjMovingLimit + x]--;
      if ($br('Z_07:4125', ram[ObjMovingLimit + x] !== 0)) return AnimateBoomerangAndCheckCollision(x);
    }
    // @SetState40
    ram[ObjMovingLimit + x] = 0x20;
    ram[ObjState + x] = 0x40;
    return AnimateBoomerangAndCheckCollision(x);
  }
  // @CheckOtherStates: return to the thrower ($40 slow, $50 fast).
  ram[ObjGridOffset + x] = 0x00;
  a = 0x00; // Link
  if (!$br('Z_07:4150', x >= 0x0d)) { $pxa('Z_07:4151', ObjRefId, x); a = ram[ObjRefId + x]; } // monster thrower
  GetDirectionsAndDistancesToTarget(a, x);
  if (!$br('Z_07:4159', ram[0x00] !== 0x02)) {
    // Reached the thrower.
    ram[ObjMovingLimit + x] = 0x00;
    if ($br('Z_07:4168', x < 0x0d)) {
      // @CatchBoomerang: the thrower's timer by a random value: < $30: $30, < $70: $50, else $70.
      let y = 0x30;
      a = ram[Random + x];
      if (!$br('Z_07:4204', a < 0x30)) {
        y = 0x50;
        if (!$br('Z_07:4207', a < 0x70)) y = 0x70;
      }
      // @SetThrowerTimer
      a = y;
      $pxa('Z_07:4212', ObjRefId, x);
      y = ram[ObjRefId + x];
      ram[ObjTimer + y] = a;
      ram[ObjState + y] = 0x00;
      return DestroyCountedMonsterShot(x);
    }
    // Link caught it: state |= $20 (catch pose, or $30 = end of using an item).
    ram[ObjState] = ram[ObjState] | 0x20;
    ram[ObjAnimCounter] = 0x01;
    ram[ObjState + 0x0f] = 0x00;
    return;
  }
  // @MoveTowardThrower (speed index 4 = as fast in X as in Y)
  const y = _CalcDiagonalSpeedIndex(0x04);
  $pxa('Z_07:4229', label('BoomerangQSpeedFracsY').addr, y);
  SetBoomerangSpeed(table(bus.rom, 'BoomerangQSpeedFracsY').byte(y), x);
  ram[0x0f] = ram[0x0a]; // vertical direction
  ram[ObjDir + x] = ram[0x0a];
  MoveObject(x);
  SetBoomerangSpeed(table(bus.rom, 'BoomerangQSpeedFracsX').byte(y), x);
  ram[0x0f] = ram[0x0b]; // horizontal direction
  ram[ObjDir + x] = ram[0x0b];
  MoveObject(x);
  return AnimateBoomerangAndCheckCollision(x); // falls through
}

/**
 * AnimateBoomerangAndCheckCollision (Z_07). X = boomerang slot. Every 2 frames advances the spin
 * (state & $77) and, for Link's, plays the boomerang sound.
 */
export function AnimateBoomerangAndCheckCollision(x) {
  // AnimateBoomerangAndCheckCollision (Z_07)
  ram[ObjAnimCounter + x]--;
  if (!$br('Z_07:4254', ram[ObjAnimCounter + x] !== 0)) {
    ram[ObjAnimCounter + x] = 0x02;
    ram[ObjState + x]++;
    ram[ObjState + x] = ram[ObjState + x] & 0x77;
    if ($br('Z_07:4262', x < 0x0d)) return CalcBoomerangFrame(x);
    PlayBoomerangSfx(0x02);
  }
  return DrawBoomerangAndCheckCollision(x); // falls through
}

/**
 * DrawBoomerangAndCheckCollision (Z_07). X = boomerang slot. A monster's boomerang that hits Link
 * turns into a spark (state $20, anim counter 3).
 */
export function DrawBoomerangAndCheckCollision(x) {
  // DrawBoomerangAndCheckCollision (Z_07)
  if (!$br('Z_07:4272', x >= 0x0d)) {
    CheckLinkCollision(x);
    if (!$br('Z_07:4275', ram[ShotCollidesWithLink] === 0)) {
      ram[ObjAnimCounter + x] = 0x03;
      ram[ObjState + x] = 0x20;
    }
  }
  return CalcBoomerangFrame(x); // falls through
}

/** CalcBoomerangFrame (Z_07, part of DrawBoomerangAndCheckCollision): frame/attribute by spin. */
function CalcBoomerangFrame(x) {
  ram[0x00] = 0x00;
  let y = ram[ObjState + x] & 0x0f;
  ram[0x01] = 0x00;
  $pxa('Z_07:4294', label('BoomerangFrameCycle').addr, y);
  ram[0x0c] = table(bus.rom, 'BoomerangFrameCycle').byte(y);
  $pxa('Z_07:4299', label('BoomerangBaseSpriteAttrCycle').addr, y);
  const a = table(bus.rom, 'BoomerangBaseSpriteAttrCycle').byte(y);
  ram[0x04] = a;
  // Base attribute 8 never occurs: + magic boomerang (palette row 4 or 5).
  y = 0x00;
  if (!$br('Z_07:4317', a === 0x08)) y = ram[InvMagicBoomerang];
  ram[0x04] = (y + ram[0x04]) & 0xff;
  return L_DrawArrowOrBoomerang(x, 0x1d); // boomerang item slot
}

/** OffsetAndDrawArrow (Z_07). X = arrow slot, Y = reverse direction index. */
export function OffsetAndDrawArrow(x, y) {
  // OffsetAndDrawArrow (Z_07)
  $pxa('Z_07:4333', label('RDirectionToOffsetsX').addr, y);
  ram[0x00] = table(bus.rom, 'RDirectionToOffsetsX').byte(y);
  $pxa('Z_07:4335', label('RDirectionToOffsetsY').addr, y);
  ram[0x01] = table(bus.rom, 'RDirectionToOffsetsY').byte(y);
  return L_DrawArrowOrBoomerang(x, 0x02); // arrow item slot; falls through
}

/**
 * L_DrawArrowOrBoomerang (Z_07). X = weapon slot, Y = item slot, [00]/[01] = offsets.
 * A spark (state $2x) uses palette row 5. @returns X = [08]
 */
export function L_DrawArrowOrBoomerang(x, y) {
  // L_DrawArrowOrBoomerang (Z_07)
  ram[0x00] = ram[ObjX + x] + ram[0x00];
  ram[0x01] = ram[ObjY + x] + ram[0x01];
  if (!$br('Z_07:4355', (ram[ObjState + x] & 0xf0) !== 0x20)) Anim_SetSpriteDescriptorAttributes(0x01);
  return Anim_WriteItemSprites(x, y);
}
