// P17 enemycore — enemies/shots (Z_04, MoveShot from Z_01): monster projectiles (flying rocks,
// fireballs, arrows, sword/magic shots, boomerangs), their bounce off Link's shield, and shooting.
// X = object slot in every routine.

import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjGridOffset, ObjQSpeedFrac, ObjDir, ObjState, ObjType, ObjTimer, ObjectFirstUnwalkableTile,
  FrameCounter, ActiveMonsterShots, Shot_ObjBounceDir, Shot_ObjBounceDist, ObjX, ObjY,
  ShotCollidesWithLink, Fireball_ObjPosFracX, Fireball_ObjPosFracY, Fireball_ObjDirToTargetX,
  Fireball_ObjDirToTargetY, Fireball_ObjQSpeedX, Fireball_ObjQSpeedY, ObjPosFrac, ObjShootTimer,
  Random, ObjInvincibilityTimer, ObjWantsToShoot, InvClock, ObjStunTimer, ObjRefId, EmptyMonsterSlot,
  CurObjIndex,
} from '../../core/vars.js';
import { BoundByRoomWithA, BoundByRoom } from '../movement/bounds.js';
import { MoveObject } from '../movement/walker.js';
import { GetCollidingTileMoving } from '../movement/tiles.js';
import { GetOppositeDir, GetDirectionsAndDistancesToTarget, _CalcDiagonalSpeedIndex } from '../movement/math.js';
import { FindEmptyMonsterSlot, SetTypeAndClearObject, DestroyMonster, ResetObjMetastate } from '../objects/slots.js';
import { CheckLinkCollision } from '../combat/collisions.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { UpdateArrowOrBoomerang, DrawArrow } from '../weapons/arrow.js';
import { DrawSwordShotOrMagicShot } from '../weapons/shots.js';

/** C flag result helper: sets cpu.c and returns the register contract. */
function ret(c, x, y, a = 0) {
  cpu.c = c;
  return { a, c, x, y };
}

/**
 * MoveShot (Z_01). A = direction, X = object, [0E] = 0 to add the movement to the grid offset (else
 * keep it). Moves as if the grid offset were 0. Leaves [0E] = $80 if a room bound was crossed, [0F] =
 * direction or 0.
 */
export function MoveShot(a, x) {
  // MoveShot (Z_01)
  if ($br('Z_01:3650', BoundByRoomWithA(a, x) === 0)) {
    // @ReturnBlocked
    ram[0x0e] = 0x80;
    return 0x80;
  }
  $pxa('Z_01:3653', ObjGridOffset, x);
  const saved = ram[ObjGridOffset + x]; // PHA
  ram[ObjGridOffset + x] = 0x00;
  x = MoveObject(x);
  a = saved; // PLA
  if (!$br('Z_01:3663', ram[0x0e] !== 0)) {
    $pxa('Z_01:3665', ObjGridOffset, x);
    a = (a + ram[ObjGridOffset + x]) & 0xff;
  }
  ram[ObjGridOffset + x] = a;
  return a;
}

/** InitMonsterShot (Z_04). X = shot: q-speed $C0 (3 pixels a frame). @returns A = 0 */
export function InitMonsterShot(x) {
  // InitMonsterShot (Z_04)
  $br('Z_04:200', true); // LDA #$C0 / BNE :+
  return initShotSpeed(0xc0, x);
}

/** _InitMonsterShot_Unknown54 (Z_04, unverified). X = shot: q-speed $E0 (3.5 pixels a frame). @returns A = 0 */
export function _InitMonsterShot_Unknown54(x) {
  // _InitMonsterShot_Unknown54 (Z_04)
  return initShotSpeed(0xe0, x);
}

function initShotSpeed(a, x) {
  ram[ObjQSpeedFrac + x] = a;
  return ResetObjMetastate(x);
}

/**
 * ShootFireball (Z_04). A = object type, X = shooter. Creates the fireball in an empty monster slot at
 * the shooter's position (X + 4). Uses [00].
 * @returns {{a:number, y:number}} Y = new slot, or 0 if there was none
 */
export function ShootFireball(a, x) {
  // ShootFireball (Z_04)
  ram[0x00] = a;
  const f = FindEmptyMonsterSlot();
  if ($br('Z_04:799', f.y === 0)) return { a: f.a, y: f.y };
  const y = f.y;
  SetTypeAndClearObject(ram[0x00], y);
  ram[ObjX + y] = ram[ObjX + x] + 0x04;
  a = ram[ObjY + x];
  ram[ObjY + y] = a;
  return { a, y };
}

/**
 * UpdateMonsterShot (Z_04). X = shot. Flying (state $1x): move, destroy at a room bound / unwalkable
 * tile (flying rocks) / on hurting Link; other states bounce. Then draw (L_DrawShot).
 */
export function UpdateMonsterShot(x) {
  // UpdateMonsterShot (Z_04)
  ram[0x0f] = ram[ObjDir + x];
  if ($br('Z_04:837', (ram[ObjState + x] & 0xf0) !== 0x10)) return BounceShot(x);
  let checkOnlyLink = false;
  $pxa('Z_04:841', ObjType, x);
  if (!$br('Z_04:843', ram[ObjType + x] >= 0x55)) {
    if ($br('Z_04:848', ram[ObjTimer + x] !== 0)) checkOnlyLink = true;
    else if ($br('Z_04:853', GetCollidingTileMoving(x) >= ram[ObjectFirstUnwalkableTile])) return DestroyMonsterShot(x);
  }
  if (!checkOnlyLink) {
    // @CheckBoundary
    if ($br('Z_04:858', BoundByRoom(x) === 0)) return DestroyMonsterShot(x);
    MoveObject(x);
  }
  // @CheckLinkCollision
  CheckShotLinkCollision(x);
  if ($br('Z_04:867', ram[0x06] !== 0)) return DestroyMonsterShot(x);
  return L_DrawShot(x); // falls through
}

/** L_DrawShot (Z_04). X = shot: arrows, sword/magic shots, or the others (flashing unless a rock). */
export function L_DrawShot(x) {
  // L_DrawShot (Z_04)
  $pxa('Z_04:871', ObjType, x);
  const t = ram[ObjType + x];
  if (!$br('Z_04:873', t !== 0x5b)) return DrawArrow(x);
  if (!$br('Z_04:878', t < 0x57) && !$br('Z_04:880', t >= 0x5a)) return DrawSwordShotOrMagicShot(x);
  // @DrawOthers
  ram[0x0d] = Anim_FetchObjPosForSpriteDescriptor(x);
  let a = ram[FrameCounter] & 0x03;
  $pxa('Z_04:895', ObjType, x);
  if (!$br('Z_04:897', ram[ObjType + x] >= 0x55)) {
    for (let y = 3; ;) { // 4 pixels right
      ram[0x00]++;
      y = (y - 1) & 0xff;
      if (!$br('Z_04:902', !(y & 0x80))) break;
    }
    a = 0x00;
  }
  // @Draw
  Anim_SetSpriteDescriptorAttributes(a);
  return DrawObjectNotMirrored(ram[0x0d], x);
}

/** DestroyMonsterShot (Z_04, part of UpdateMonsterShot). Fireballs ($55/$56) are not counted. */
export function DestroyMonsterShot(x) {
  $pxa('Z_04:912', ObjType, x);
  const t = ram[ObjType + x];
  if ($br('Z_04:914', t === 0x55) || $br('Z_04:916', t === 0x56)) return DestroyMonster(x);
  return DestroyCountedMonsterShot(x); // falls through
}

/** DestroyCountedMonsterShot (Z_04). X = shot: one active shot less, destroy it. */
export function DestroyCountedMonsterShot(x) {
  // DestroyCountedMonsterShot (Z_04)
  ram[ActiveMonsterShots]--;
  return DestroyMonster(x);
}

/** BounceShot (Z_04). X = shot: move it back from the bounce direction; destroy after $20 pixels. */
export function BounceShot(x) {
  // BounceShot (Z_04)
  $pxa('Z_04:925', Shot_ObjBounceDir, x);
  const { y } = GetOppositeDir(ram[Shot_ObjBounceDir + x]);
  const hs = table(bus.rom, 'ShotBounceHeights');
  const ws = table(bus.rom, 'ShotBounceWidths');
  $pxa('Z_04:932', hs.addr, y);
  ram[ObjY + x] = ram[ObjY + x] + hs.byte(y);
  $pxa('Z_04:936', ws.addr, y);
  ram[ObjX + x] = ram[ObjX + x] + ws.byte(y);
  $pxa('Z_04:941', Shot_ObjBounceDist, x);
  const a = (ram[Shot_ObjBounceDist + x] + 0x02) & 0xff;
  ram[Shot_ObjBounceDist + x] = a;
  if ($br('Z_04:949', a >= 0x20)) return DestroyMonsterShot(x);
  $br('Z_04:950', true); // BCC L_DrawShot
  return L_DrawShot(x);
}

/**
 * CheckShotLinkCollision (Z_04). X = shot. Resets the bounce distance and checks the collision with
 * Link ([06]/[0C] = 1 if harmed). If the shield blocked it: bounce direction = Link's facing, state $30.
 */
export function CheckShotLinkCollision(x) {
  // CheckShotLinkCollision (Z_04)
  ram[Shot_ObjBounceDist + x] = 0x00;
  CheckLinkCollision(x);
  if ($br('Z_04:969', ram[ShotCollidesWithLink] === 0)) return;
  ram[Shot_ObjBounceDir + x] = ram[ObjDir];
  ram[ObjState + x] = 0x30;
}

/**
 * UpdateFireball (Z_04). X = fireball. State 0: aim at Link (diagonal speeds from FireballQSpeedsX/Y),
 * wait $10 frames. State 1: move along each axis, destroy at a room bound or on hitting Link.
 */
export function UpdateFireball(x) {
  // UpdateFireball (Z_04)
  let a = ram[ObjState + x];
  if (!$br('Z_04:990', a !== 0)) {
    ram[Fireball_ObjPosFracX + x] = a;
    ram[Fireball_ObjPosFracY + x] = a;
    GetDirectionsAndDistancesToTarget(a, x); // target: Link (slot 0)
    ram[Fireball_ObjDirToTargetX + x] = ram[0x0b];
    a = ram[0x0a];
    ram[Fireball_ObjDirToTargetY + x] = a;
    ram[ObjDir + x] = a | ram[0x0b];
    const y = _CalcDiagonalSpeedIndex(0x04);
    const qx = table(bus.rom, 'FireballQSpeedsX');
    const qy = table(bus.rom, 'FireballQSpeedsY');
    $pxa('Z_04:1014', qx.addr, y);
    ram[Fireball_ObjQSpeedX + x] = qx.byte(y);
    $pxa('Z_04:1016', qy.addr, y);
    ram[Fireball_ObjQSpeedY + x] = qy.byte(y);
    ram[ObjState + x] = 0x10;
    ram[ObjTimer + x] = 0x10;
    return;
  }
  // @State1
  if (!$br('Z_04:1032', ram[ObjTimer + x] !== 0)) {
    if (!$br('Z_04:1037', BoundByRoomWithA(ram[ObjDir + x], x) !== 0)) return DestroyMonster(x);
    // @Move
    $pxa('Z_04:1047', Fireball_ObjDirToTargetX, x);
    ram[0x0f] = ram[Fireball_ObjDirToTargetX + x];
    $pxa('Z_04:1052', Fireball_ObjQSpeedX, x);
    $pxa('Z_04:1053', Fireball_ObjPosFracX, x);
    ram[Fireball_ObjPosFracX + x] = Fireball_MoveOneAxis(ram[Fireball_ObjQSpeedX + x], x, ram[Fireball_ObjPosFracX + x]);
    $pxa('Z_04:1058', Fireball_ObjDirToTargetY, x);
    ram[0x0f] = ram[Fireball_ObjDirToTargetY + x];
    $pxa('Z_04:1063', Fireball_ObjQSpeedY, x);
    $pxa('Z_04:1064', Fireball_ObjPosFracY, x);
    ram[Fireball_ObjPosFracY + x] = Fireball_MoveOneAxis(ram[Fireball_ObjQSpeedY + x], x, ram[Fireball_ObjPosFracY + x]);
  }
  // @CheckCollisionAndDraw
  CheckShotLinkCollision(x);
  if ($br('Z_04:1072', ram[ShotCollidesWithLink] !== 0)) return DestroyMonster(x);
  return L_DrawShot(x);
}

/**
 * Fireball_MoveOneAxis (Z_04). A = q-speed, X = object, Y = position fraction, [0F] = direction.
 * @returns A = updated position fraction
 */
export function Fireball_MoveOneAxis(a, x, y) {
  // Fireball_MoveOneAxis (Z_04)
  ram[ObjQSpeedFrac + x] = a;
  ram[ObjPosFrac + x] = y;
  x = MoveObject(x);
  $pxa('Z_04:1092', ObjPosFrac, x);
  return ram[ObjPosFrac + x];
}

/**
 * _TryShooting (Z_04). A = monster q-speed, X = monster, Y = shot object type. Runs the shoot timer:
 * stops the monster while it shoots and shoots when the timer reaches $10. Uses [00], [01].
 */
export function _TryShooting(a, x, y) {
  // _TryShooting (Z_04)
  ram[0x01] = a;
  $pxa('Z_04:1973', ObjType, x);
  const t = ram[ObjType + x];
  if (!$br('Z_04:1975', t === 0x03) && !$br('Z_04:1977', t === 0x01)
    && !$br('Z_04:1979', t === 0x09) && !$br('Z_04:1981', t === 0x0a)) {
    $pxa('Z_04:1982', ObjShootTimer, x);
    if (!$br('Z_04:1983', ram[ObjShootTimer + x] !== 0)) {
      if ($br('Z_04:1988', ram[Random + x] < 0xf8)) return; // @Exit
    }
  }
  // @TryShootingNow
  ram[0x00] = y;
  let pushed = ram[0x01]; // PHA
  y = 0x00;
  let setSpeed = false;
  $pxa('Z_04:2018', ObjInvincibilityTimer, x);
  if (!$br('Z_04:2019', ram[ObjInvincibilityTimer + x] !== 0)) {
    $pxa('Z_04:2022', ObjShootTimer, x);
    y = (ram[ObjShootTimer + x] - 1) & 0xff;
    if (!$br('Z_04:2028', !(y & 0x80))) {
      $pxa('Z_04:2029', ObjWantsToShoot, x);
      if ($br('Z_04:2030', ram[ObjWantsToShoot + x] === 0)) setSpeed = true;
      else y = 0x30;
    }
  }
  if (!setSpeed) {
    // @SetShootTimer
    ram[ObjShootTimer + x] = y;
    if (!$br('Z_04:2039', y === 0)) {
      let zero = true;
      if (!$br('Z_04:2044', y !== 0x10) && !$br('Z_04:2050', (ram[InvClock] | ram[ObjStunTimer + x]) !== 0)) {
        const r = _ShootIfWanted2(ram[0x00], x);
        x = r.x;
        if ($br('Z_04:2057', !r.c)) zero = false; // BCC @SetSpeed
        else ram[ObjWantsToShoot + x] = 0x00;
      }
      if (zero) pushed = 0x00; // @ZeroSpeed
    }
  }
  // @SetSpeed
  ram[ObjQSpeedFrac + x] = pushed;
}

/**
 * _ShootIfWanted2 (Z_04). A = shot type, X = shooter. On success also object timer $80 and DEC [0437][X].
 * @returns {{a, c, x, y}} C = 1 if it shot; Y = shot slot; X = CurObjIndex after a shot (also cpu.c)
 */
export function _ShootIfWanted2(a, x) {
  // _ShootIfWanted2 (Z_04)
  const r = _ShootIfWanted(a, x);
  if ($br('Z_04:2090', !r.c)) return r; // L1083E_Exit
  x = r.x;
  ram[ObjTimer + x] = 0x80;
  ram[0x0437 + x]--; // [0437][X]: only ever decremented
  cpu.c = 1;
  return { ...r, a: 0x80, x };
}

/**
 * UpdateMonsterArrow (Z_04). X = arrow. Waits while its timer runs (flies at once if the shooter is
 * gone), then runs the base arrow (P09 UpdateArrowOrBoomerang) and bounces off the shield.
 */
export function UpdateMonsterArrow(x) {
  // UpdateMonsterArrow (Z_04)
  ram[ObjQSpeedFrac + x] = 0x80;
  if ($br('Z_04:2106', ram[ObjTimer + x] !== 0)) {
    // @CheckShooter (unverified code 1085C)
    $pxa('Z_04:2133', ObjRefId, x);
    const y = ram[ObjRefId + x];
    $pxa('Z_04:2134', ObjType, y);
    const a = ram[ObjType + y];
    if (!$br('Z_04:2135', a !== 0)) ram[ObjTimer + x] = a;
    return DrawArrow(x);
  }
  $pxa('Z_04:2109', ObjState, x);
  let s = ram[ObjState + x] & 0xf0;
  if (!$br('Z_04:2112', s === 0x20)) {
    if ($br('Z_04:2117', s !== 0x10)) return monsterArrowCheckBounce(s, x);
    ram[0x0f] = ram[ObjDir + x];
  }
  // @UpdateBase
  UpdateArrowOrBoomerang(x);
  $pxa('Z_04:2146', ObjState, x);
  s = ram[ObjState + x] & 0xf0;
  if ($br('Z_04:2149', s !== 0x10)) return monsterArrowCheckBounce(s, x);
  CheckShotLinkCollision(x);
  if ($br('Z_04:2156', ram[0x06] === 0)) return; // L1083E_Exit
  return DestroyCountedMonsterShot(x);
}

/** UpdateMonsterArrow@CheckBounce: A = state & $F0. */
function monsterArrowCheckBounce(a, x) {
  if ($br('Z_04:2164', a !== 0x30)) return; // L1083E_Exit
  return BounceShot(x);
}

/**
 * _ShootIfWanted (Z_04). A = shot type, X = shooter, Y passed through on failure. Shoots only if the
 * monster "wants to shoot". @returns {{a, c, x, y}} as Shoot / ReturnDidNotShoot (also cpu.c)
 */
export function _ShootIfWanted(a, x, y = 0) {
  // _ShootIfWanted (Z_04)
  ram[0x00] = a;
  $pxa('Z_04:11323', ObjWantsToShoot, x);
  if ($br('Z_04:11324', ram[ObjWantsToShoot + x] === 0)) return ReturnDidNotShoot(x, y, 0);
  return ShootLimited(x); // falls through
}

/**
 * ShootLimited (Z_04). [00] = shot type, X = shooter. Needs an empty slot; true projectiles (>= $53)
 * are limited to 4 active. @returns {{a, c, x, y}} (also cpu.c)
 */
export function ShootLimited(x = 0) {
  // ShootLimited (Z_04)
  const f = FindEmptyMonsterSlot();
  if ($br('Z_04:11340', f.y === 0)) return ReturnDidNotShoot(x, f.y, f.a);
  let a = ram[0x00];
  if (!$br('Z_04:11346', a < 0x53)) {
    a = ram[ActiveMonsterShots];
    if ($br('Z_04:11349', a >= 0x04)) return ReturnDidNotShoot(x, f.y, a);
    ram[ActiveMonsterShots]++;
  }
  return Shoot(); // falls through
}

/**
 * Shoot (Z_04). [00] = shot type, [59] EmptyMonsterSlot = shot slot, CurObjIndex = shooter. The shot
 * starts in state $10 with the shooter's direction and position.
 * @returns {{a, c, x, y}} C = 1, X = CurObjIndex, Y = shot slot (also cpu.c)
 */
export function Shoot() {
  // Shoot (Z_04)
  SetTypeAndClearObject(ram[0x00], ram[EmptyMonsterSlot]);
  const y = ram[EmptyMonsterSlot];
  const x = ram[CurObjIndex];
  ram[ObjState + y] = 0x10;
  ram[ObjTimer + y] = 0x00;
  ram[ObjDir + y] = ram[ObjDir + x];
  ram[ObjX + y] = ram[ObjX + x];
  const a = ram[ObjY + x];
  ram[ObjY + y] = a;
  return ret(1, x, y, a);
}

/** ReturnDidNotShoot (Z_04, part of _ShootIfWanted): C = 0. */
export function ReturnDidNotShoot(x, y, a) {
  return ret(0, x, y, a);
}
