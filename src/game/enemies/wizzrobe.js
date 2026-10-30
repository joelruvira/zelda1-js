// P20 — enemies/wizzrobe (Z_04): blue wizzrobes walk and teleport (translucent) through obstacles and
// shoot magic shots $58 when lined up with Link; red wizzrobes fade in next to Link, shoot a magic
// shot $59 and fade out. X = object slot in every routine.
// BlueWizzrobe_Move is also Ganon's movement (P22).
import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  InvClock, ObjTimer, ObjRemDistance, FrameCounter, Wizzrobe_ObjLastTile, ObjDir, ObjX, ObjY,
  BlueWizzrobe_ObjTurnCounter, Random, ObjCollidedTile, ObjectFirstUnwalkableTile, Tune0Request,
  RedWizzrobe_ObjAnimCounter, RedWizzrobe_ObjFadeCounter, ObjState, ObjInvincibilityMask,
  ObjInvincibilityTimer,
} from '../../core/vars.js';
import { GetCollidableTileStill } from '../movement/tiles.js';
import { ShootLimited } from './shots.js';
import {
  GetObjectMiddle, CheckMonsterSwordShotOrMagicShotCollision, CheckMonsterBombOrFireCollision,
  CheckMonsterSwordCollision, CheckLinkCollision,
} from '../combat/collisions.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored } from '../draw/anim.js';

const tbl = (name) => table(bus.rom, name);

/**
 * UpdateBlueWizzrobe (Z_04). X = blue wizzrobe. With the clock it only draws and collides; otherwise
 * walks or teleports, tries to shoot, and draws (every other frame while teleporting).
 */
export function UpdateBlueWizzrobe(x) {
  // UpdateBlueWizzrobe (Z_04)
  if ($br('Z_04:7036', ram[InvClock] !== 0)) return L_Wizzrobe_DrawAndCheckCollisions(x);
  BlueWizzrobe_WalkOrTeleport(x);
  BlueWizzrobe_TryShooting(x);
  return Wizzrobe_DrawAndCheckCollisionsIntermittently(x); // falls through
}

/** Wizzrobe_DrawAndCheckCollisionsIntermittently (Z_04). Draws/collides only if ObjRemDistance is even. */
export function Wizzrobe_DrawAndCheckCollisionsIntermittently(x) {
  // Wizzrobe_DrawAndCheckCollisionsIntermittently (Z_04)
  $pxa('Z_04:7049', ObjRemDistance, x);
  if ($br('Z_04:7051', (ram[ObjRemDistance + x] & 0x01) !== 0)) return L11E17_Exit();
  return L_Wizzrobe_DrawAndCheckCollisions(x); // falls through
}

/** L_Wizzrobe_DrawAndCheckCollisions (Z_04). */
export function L_Wizzrobe_DrawAndCheckCollisions(x) {
  // L_Wizzrobe_DrawAndCheckCollisions (Z_04)
  return Wizzrobe_DrawAndCheckCollisions(x);
}

/**
 * BlueWizzrobe_WalkOrTeleport (Z_04). X = blue wizzrobe. Timer >= $10: walk every other frame;
 * timer 1: choose a teleport target; timer 0: teleport (ObjRemDistance pixels left) or, at the end,
 * align, randomize the timer and turn toward Link.
 */
export function BlueWizzrobe_WalkOrTeleport(x) {
  // BlueWizzrobe_WalkOrTeleport (Z_04)
  const a = ram[ObjTimer + x];
  if ($br('Z_04:7059', a !== 0)) {
    // @Walk
    if ($br('Z_04:7084', a >= 0x10)) return GoEveryOtherFrame(x);
    if ($br('Z_04:7086', a !== 0x01)) return L11E17_Exit();
    BlueWizzrobe_ChooseTeleportTarget(x);
    return L11E17_Exit();
  }
  $pxa('Z_04:7065', ObjRemDistance, x);
  if (!$br('Z_04:7066', ram[ObjRemDistance + x] === 0)) {
    ram[ObjRemDistance + x]--;
    return BlueWizzrobe_MoveAndCheckTile(x);
  }
  // @WalkAgain
  BlueWizzrobe_AlignWithNearestSquareAndRandomizeTimer(x);
  return BlueWizzrobe_TurnTowardLink(x);
}

/** L11E17_Exit (Z_04): RTS. */
export function L11E17_Exit() {
  // L11E17_Exit (Z_04)
}

/** GoEveryOtherFrame (Z_04). Odd frames: only turn toward Link if needed; even frames: also move. */
export function GoEveryOtherFrame(x) {
  // GoEveryOtherFrame (Z_04)
  if ($br('Z_04:7097', (ram[FrameCounter] & 0x01) !== 0)) return L_BlueWizzrobe_TurnTowardLinkIfNeeded(x);
  return BlueWizzrobe_TurnSometimesAndMoveAndCheckTile(x); // falls through
}

/** BlueWizzrobe_TurnSometimesAndMoveAndCheckTile (Z_04). */
export function BlueWizzrobe_TurnSometimesAndMoveAndCheckTile(x) {
  // BlueWizzrobe_TurnSometimesAndMoveAndCheckTile (Z_04)
  BlueWizzrobe_AdvanceCounterAndTurnTowardLinkIfNeeded(x);
  return BlueWizzrobe_MoveAndCheckTile(x); // falls through
}

/**
 * BlueWizzrobe_MoveAndCheckTile (Z_04). X = blue wizzrobe. Moves one pixel; on a block or water starts
 * teleporting (unless already teleporting); on a wall flips the direction and moves back.
 */
export function BlueWizzrobe_MoveAndCheckTile(x) {
  // BlueWizzrobe_MoveAndCheckTile (Z_04)
  BlueWizzrobe_Move(x);
  if ($br('Z_04:7107', !Wizzrobe_GetCollidableTile(x))) return; // @Exit (walkable)
  $pxa('Z_04:7110', Wizzrobe_ObjLastTile, x);
  const a = ram[Wizzrobe_ObjLastTile + x] & 0xfc;
  if ($br('Z_04:7113', a === 0xb0) || !$br('Z_04:7115', a < 0xf4)) {
    // @HitBlockOrWater
    $pxa('Z_04:7120', ObjRemDistance, x);
    if ($br('Z_04:7121', ram[ObjRemDistance + x] !== 0)) return L11E17_Exit();
    return BeginTeleporting(x);
  }
  // @HitWall
  let y = ram[ObjDir + x];
  if (!$br('Z_04:7132', (y & 0x0c) === 0)) {
    y ^= 0x0c;
    ram[ObjDir + x] = y;
  }
  // @CheckHorizontal
  if (!$br('Z_04:7142', (y & 0x03) === 0)) ram[ObjDir + x] = y ^ 0x03;
  // @Move
  return BlueWizzrobe_Move(x);
}

/** BlueWizzrobe_AdvanceCounterAndTurnTowardLinkIfNeeded (Z_04). */
export function BlueWizzrobe_AdvanceCounterAndTurnTowardLinkIfNeeded(x) {
  // BlueWizzrobe_AdvanceCounterAndTurnTowardLinkIfNeeded (Z_04)
  ram[BlueWizzrobe_ObjTurnCounter + x]++;
  return L_BlueWizzrobe_TurnTowardLinkIfNeeded(x); // falls through
}

/** L_BlueWizzrobe_TurnTowardLinkIfNeeded (Z_04). Turns only when the turn counter is a multiple of $40. */
export function L_BlueWizzrobe_TurnTowardLinkIfNeeded(x) {
  // L_BlueWizzrobe_TurnTowardLinkIfNeeded (Z_04)
  $pxa('Z_04:7167', BlueWizzrobe_ObjTurnCounter, x);
  if ($br('Z_04:7169', (ram[BlueWizzrobe_ObjTurnCounter + x] & 0x3f) !== 0)) return L11EAF_Exit();
  return BlueWizzrobe_TurnTowardLink(x); // falls through
}

/**
 * BlueWizzrobe_TurnTowardLink (Z_04). Bit 6 of the turn counter picks the axis (0 horizontal);
 * faces Link on it and, if the direction changed, aligns with the nearest square.
 */
export function BlueWizzrobe_TurnTowardLink(x) {
  // BlueWizzrobe_TurnTowardLink (Z_04)
  let a;
  $pxa('Z_04:7174', BlueWizzrobe_ObjTurnCounter, x);
  if (!$br('Z_04:7176', (ram[BlueWizzrobe_ObjTurnCounter + x] & 0x40) !== 0)) {
    a = 0x02;
    if (!$br('Z_04:7182', ram[ObjX + x] >= ram[ObjX])) a >>= 1;
  } else {
    // @TurnVertically
    a = 0x08;
    if (!$br('Z_04:7192', ram[ObjY + x] >= ram[ObjY])) a >>= 1;
  }
  // @SetDir
  if ($br('Z_04:7198', a === ram[ObjDir + x])) return L11EAF_Exit();
  ram[ObjDir + x] = a;
  return BlueWizzrobe_AlignWithNearestSquare(x);
}

/**
 * BlueWizzrobe_Move (Z_04). X = object: adds BlueWizzrobeTeleportOffsetsX/Y[ObjDir] to its position
 * (one pixel in each of the direction's components). Also Ganon's movement.
 */
export function BlueWizzrobe_Move(x) {
  // BlueWizzrobe_Move (Z_04)
  const y = ram[ObjDir + x];
  $pxa('Z_04:7221', tbl('BlueWizzrobeTeleportOffsetsX').addr, y);
  ram[ObjX + x] = ram[ObjX + x] + tbl('BlueWizzrobeTeleportOffsetsX').byte(y);
  $pxa('Z_04:7225', tbl('BlueWizzrobeTeleportOffsetsY').addr, y);
  ram[ObjY + x] = ram[ObjY + x] + tbl('BlueWizzrobeTeleportOffsetsY').byte(y);
  return L11EAF_Exit();
}

/** L11EAF_Exit (Z_04): RTS. */
export function L11EAF_Exit() {
  // L11EAF_Exit (Z_04)
}

/**
 * BlueWizzrobe_ChooseTeleportTarget (Z_04). X = blue wizzrobe. Tests a random diagonal $20 pixels
 * away; if walkable, starts teleporting that way, else only aligns and randomizes the timer.
 */
export function BlueWizzrobe_ChooseTeleportTarget(x) {
  // BlueWizzrobe_ChooseTeleportTarget (Z_04)
  const y = ram[Random + x] & 0x03;
  const savedX = ram[ObjX + x]; // PHA
  $pxa('Z_04:7253', tbl('BlueWizzrobeTeleportMaxOffsetsX').addr, y);
  ram[ObjX + x] = savedX + tbl('BlueWizzrobeTeleportMaxOffsetsX').byte(y);
  const savedY = ram[ObjY + x]; // PHA
  $pxa('Z_04:7261', tbl('BlueWizzrobeTeleportMaxOffsetsY').addr, y);
  ram[ObjY + x] = savedY + tbl('BlueWizzrobeTeleportMaxOffsetsY').byte(y);
  $pxa('Z_04:7267', tbl('BlueWizzrobeTeleportDirs').addr, y);
  const c = Wizzrobe_GetCollidableTileForDir(x, tbl('BlueWizzrobeTeleportDirs').byte(y));
  ram[ObjY + x] = savedY; // PLA
  ram[ObjX + x] = savedX; // PLA
  if ($br('Z_04:7278', !!c)) return BlueWizzrobe_AlignWithNearestSquareAndRandomizeTimer(x);
  $pxa('Z_04:7281', tbl('BlueWizzrobeTeleportDirs').addr, y);
  ram[ObjDir + x] = tbl('BlueWizzrobeTeleportDirs').byte(y);
  return BeginTeleporting(x); // falls through
}

/** BeginTeleporting (Z_04). $20 pixels to go, flip the turn axis, timer 0, align. */
export function BeginTeleporting(x) {
  // BeginTeleporting (Z_04)
  ram[ObjRemDistance + x] = 0x20;
  $pxa('Z_04:7290', BlueWizzrobe_ObjTurnCounter, x);
  ram[BlueWizzrobe_ObjTurnCounter + x] ^= 0x40;
  $br('Z_04:7297', true); // LDA #$00 / BEQ :+
  ram[ObjTimer + x] = 0x00;
  return BlueWizzrobe_AlignWithNearestSquare(x);
}

/** BlueWizzrobe_AlignWithNearestSquareAndRandomizeTimer (Z_04). Timer = Random | $70, then align. */
export function BlueWizzrobe_AlignWithNearestSquareAndRandomizeTimer(x) {
  // BlueWizzrobe_AlignWithNearestSquareAndRandomizeTimer (Z_04)
  ram[ObjTimer + x] = ram[Random + x] | 0x70;
  return BlueWizzrobe_AlignWithNearestSquare(x); // falls through
}

/** BlueWizzrobe_AlignWithNearestSquare (Z_04). Rounds X to a multiple of $10 and Y to $10*n - 3. */
export function BlueWizzrobe_AlignWithNearestSquare(x) {
  // BlueWizzrobe_AlignWithNearestSquare (Z_04)
  ram[ObjX + x] = (ram[ObjX + x] + 0x08) & 0xf0;
  return RedWizzrobe_AlignAndSetY((ram[ObjY + x] + 0x08) & 0xff, x); // falls through
}

/** RedWizzrobe_AlignAndSetY (Z_04). A = Y coordinate. ObjY = (A & $F0) - 3. @returns A = new Y */
export function RedWizzrobe_AlignAndSetY(a, x) {
  // RedWizzrobe_AlignAndSetY (Z_04)
  a = ((a & 0xf0) - 0x03) & 0xff;
  ram[ObjY + x] = a;
  return a;
}

/** Wizzrobe_GetCollidableTile (Z_04). Tile ahead in ObjDir. @returns C (true = not walkable) */
export function Wizzrobe_GetCollidableTile(x) {
  // Wizzrobe_GetCollidableTile (Z_04)
  return Wizzrobe_GetCollidableTileForDir(x, ram[ObjDir + x]); // falls through
}

/**
 * Wizzrobe_GetCollidableTileForDir (Z_04). Y = 8-way direction: tests the tile at the
 * WizzrobeCollisionOffsetsX/Y[dir - 1] offset. @returns C (true = not walkable)
 */
export function Wizzrobe_GetCollidableTileForDir(x, y) {
  // Wizzrobe_GetCollidableTileForDir (Z_04)
  y = (y - 1) & 0xff;
  const savedX = ram[ObjX + x]; // PHA
  $pxa('Z_04:7364', tbl('WizzrobeCollisionOffsetsX').addr, y);
  ram[ObjX + x] = savedX + tbl('WizzrobeCollisionOffsetsX').byte(y);
  const savedY = ram[ObjY + x]; // PHA
  $pxa('Z_04:7371', tbl('WizzrobeCollisionOffsetsY').addr, y);
  ram[ObjY + x] = savedY + tbl('WizzrobeCollisionOffsetsY').byte(y);
  const c = Wizzrobe_GetBaseCollidableTile(x);
  ram[ObjY + x] = savedY; // PLA
  ram[ObjX + x] = savedX; // PLA
  return c;
}

/** Wizzrobe_GetBaseCollidableTile (Z_04). Stores the tile in Wizzrobe_ObjLastTile. @returns C */
export function Wizzrobe_GetBaseCollidableTile(x) {
  // Wizzrobe_GetBaseCollidableTile (Z_04)
  GetCollidableTileStill(x);
  $pxa('Z_04:7388', ObjCollidedTile, x);
  const a = ram[ObjCollidedTile + x];
  const c = a >= ram[ObjectFirstUnwalkableTile];
  ram[Wizzrobe_ObjLastTile + x] = a;
  return c;
}

/**
 * BlueWizzrobe_TryShooting (Z_04). Every $20 frames while walking: shoots a magic shot $58 if it faces
 * Link in the same square row (or, through the original's column check, X column).
 */
export function BlueWizzrobe_TryShooting(x) {
  // BlueWizzrobe_TryShooting (Z_04)
  $pxa('Z_04:7400', ObjRemDistance, x);
  if ($br('Z_04:7401', ram[ObjRemDistance + x] !== 0)) return L11F7E_Exit();
  if ($br('Z_04:7404', (ram[FrameCounter] & 0x1f) !== 0)) return L11F7E_Exit();
  ram[0x00] = ram[ObjY + x] & 0xf0;
  if ($br('Z_04:7414', (ram[ObjY] & 0xf0) !== ram[0x00])) return BlueWizzrobe_CheckSquareColumn(x);
  let a = 0x02;
  if (!$br('Z_04:7421', ram[ObjX + x] >= ram[ObjX])) a >>= 1;
  if ($br('Z_04:7427', a === ram[ObjDir + x])) return ShootMagicShot58(x);
  return L11F7E_Exit();
}

/** L11F7E_Exit (Z_04): RTS. */
export function L11F7E_Exit() {
  // L11F7E_Exit (Z_04)
}

/**
 * BlueWizzrobe_CheckSquareColumn (Z_04). Compares Link's X (not masked, as the original) with the
 * monster's square column; shoots if it faces Link vertically.
 */
export function BlueWizzrobe_CheckSquareColumn(x) {
  // BlueWizzrobe_CheckSquareColumn (Z_04)
  ram[0x00] = ram[ObjX + x] & 0xf0;
  if ($br('Z_04:7440', ram[ObjX] !== ram[0x00])) return L11F7E_Exit();
  let a = 0x08;
  if (!$br('Z_04:7447', ram[ObjY + x] >= ram[ObjY])) a >>= 1;
  if ($br('Z_04:7453', a !== ram[ObjDir + x])) return L11F7E_Exit();
  return ShootMagicShot58(x); // falls through
}

/** ShootMagicShot58 (Z_04). */
export function ShootMagicShot58(x) {
  // ShootMagicShot58 (Z_04)
  return ShootMagicShot(0x58, x); // falls through
}

/** ShootMagicShot (Z_04). A = shot type: unless the clock is held, magic sound and ShootLimited. */
export function ShootMagicShot(a, x) {
  // ShootMagicShot (Z_04)
  ram[0x00] = a;
  if ($br('Z_04:7466', ram[InvClock] !== 0)) return L11F7E_Exit();
  ram[Tune0Request] = 0x04;
  return ShootLimited(x);
}

/**
 * UpdateRedWizzrobe (Z_04). X = red wizzrobe. With the clock it only draws and collides; otherwise
 * advances the animation counter, decrements the state and runs the state group (state >> 6).
 */
export function UpdateRedWizzrobe(x) {
  // UpdateRedWizzrobe (Z_04)
  if (!$br('Z_04:7476', ram[InvClock] === 0)) return Wizzrobe_DrawAndCheckCollisions(x);
  ram[RedWizzrobe_ObjAnimCounter + x]++;
  ram[ObjState + x]--;
  return tableJump(label('UpdateRedWizzrobe_JumpTable').addr, ram[ObjState + x] >> 6, [
    () => UpdateRedWizzrobe_0(x),
    () => UpdateRedWizzrobe_1(x),
    () => UpdateRedWizzrobe_2(x),
    () => UpdateRedWizzrobe_3(x),
  ]);
}

/** UpdateRedWizzrobe_1 (Z_04). States $40-$7F (fading): skips $30 frames at $7F; draws intermittently. */
export function UpdateRedWizzrobe_1(x) {
  // UpdateRedWizzrobe_1 (Z_04)
  if (!$br('Z_04:7518', ram[ObjState + x] !== 0x7f)) ram[ObjState + x] = 0x4f;
  ram[RedWizzrobe_ObjFadeCounter + x]++;
  return Wizzrobe_DrawAndCheckCollisionsIntermittently(x);
}

/**
 * UpdateRedWizzrobe_3 (Z_04). States $C0-$FF: fade as in group 1, except at $FF, where it appears at
 * a random offset from Link facing a random direction (state + 1 to retry if in a wall or unwalkable).
 */
export function UpdateRedWizzrobe_3(x) {
  // UpdateRedWizzrobe_3 (Z_04)
  if ($br('Z_04:7533', ((ram[ObjState + x] + 1) & 0xff) !== 0)) return UpdateRedWizzrobe_1(x);
  const r = ram[Random + x]; // PHA
  $pxa('Z_04:7542', tbl('RedWizzrobeDirections').addr, r & 0x03);
  ram[ObjDir + x] = tbl('RedWizzrobeDirections').byte(r & 0x03);
  const y = r & 0x0f; // PLA
  // ADC without CLC: C = 0 here (TableJump's ASL of an index < $80).
  $pxa('Z_04:7552', tbl('RedWizzrobeOffsetsX').addr, y);
  ram[ObjX + x] = (ram[ObjX] + tbl('RedWizzrobeOffsetsX').byte(y)) & 0xf0;
  let a = ram[ObjY] + 0x03; // CLC / ADC #$03
  const c = a > 0xff ? 1 : 0;
  $pxa('Z_04:7560', tbl('RedWizzrobeOffsetsY').addr, y);
  a = ((a & 0xff) + tbl('RedWizzrobeOffsetsY').byte(y) + c) & 0xff;
  a = RedWizzrobe_AlignAndSetY(a, x);
  if (!$br('Z_04:7566', a < 0x5d) && !$br('Z_04:7568', a >= 0xc4)) {
    if ($br('Z_04:7573', !Wizzrobe_GetCollidableTile(x))) return UpdateRedWizzrobe_0(x);
  }
  ram[ObjState + x]++;
  return UpdateRedWizzrobe_0(x);
}

/** UpdateRedWizzrobe_0 (Z_04). States $00-$3F: invisible, nothing to do. */
export function UpdateRedWizzrobe_0(x) {
  // UpdateRedWizzrobe_0 (Z_04)
}

/** UpdateRedWizzrobe_2 (Z_04). States $80-$BF: visible; shoots a magic shot $59 at state $B0. */
export function UpdateRedWizzrobe_2(x) {
  // UpdateRedWizzrobe_2 (Z_04)
  if (!$br('Z_04:7586', ram[ObjState + x] !== 0xb0)) ShootMagicShot(0x59, x);
  return Wizzrobe_DrawAndCheckCollisions(x);
}

/**
 * Wizzrobe_DrawAndCheckCollisions (Z_04). X = wizzrobe. Hurt only by sword, sword/magic shots and
 * bombs/fire; always harms Link. Draws frame (anim counter >> 2) & 1, +2 mirrored when facing up.
 */
export function Wizzrobe_DrawAndCheckCollisions(x) {
  // Wizzrobe_DrawAndCheckCollisions (Z_04)
  ram[ObjInvincibilityMask + x] = 0xf6;
  GetObjectMiddle(x);
  $pxa('Z_04:7597', ObjInvincibilityTimer, x);
  if (!$br('Z_04:7598', ram[ObjInvincibilityTimer + x] !== 0)) {
    CheckMonsterSwordShotOrMagicShotCollision(x, 0x0e);
    CheckMonsterBombOrFireCollision(x, 0x10);
    CheckMonsterBombOrFireCollision(x, 0x11);
    CheckMonsterSwordCollision(x, 0x0d);
  }
  CheckLinkCollision(x);
  $pxa('Z_04:7613', RedWizzrobe_ObjAnimCounter, x);
  const frame = (ram[RedWizzrobe_ObjAnimCounter + x] >> 2) & 0x01; // PHA
  Anim_FetchObjPosForSpriteDescriptor(x);
  if (!$br('Z_04:7623', (ram[ObjDir + x] & 0x08) !== 0)) {
    ram[0x0f] = (ram[ObjDir + x] >> 1) & 0x01;
    return DrawObjectNotMirrored(frame, x);
  }
  return DrawObjectMirrored(frame + 0x02, x);
}
