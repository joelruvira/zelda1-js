// P06 movement — generic walker movement (Z_07): Walker_Move (Link and walking monsters), MoveObject
// (quarter-speed movement), tile collision with the search for an unblocked direction, the screen
// edge that sends Link to the next room.
//
// Walker_CheckTileCollision is a web of jumps in the original (CheckTiles -> GoWalkableDir ->
// CheckBoundary -> CheckObjAttr10AndAltDir -> TryNextDir -> CheckTiles ...); each label is a function
// here and each JMP/fall-through a tail call. The loop ends after at most 4 alternate directions.
//
// This module also re-exports the rest of the movement package for convenience.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { switchBank, tableJump } from '../../core/asm.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjShoveDir, ObjGridOffset, ObjInputDir, ObjDir, InvClock, ObjStunTimer, ObjState, ObjType,
  DoorwayDir, GameMode, CurLevel, PositiveGridCellSize, NegativeGridCellSize, ObjX, ObjY,
  ObjAttr, ObjectFirstUnwalkableTile, ButtonsPressed, LadderSlot, GameSubmode, IsUpdatingMode,
  ObjShoveDistance, ObjInvincibilityTimer, Random,
} from '../../core/vars.js';
import {
  GetOppositeDir, reverseDirections, AddQSpeedToPositionFraction, SubQSpeedFromPositionFraction,
} from './math.js';
import { BoundByRoom } from './bounds.js';
import { GetCollidingTileMoving } from './tiles.js';
import { Obj_Shove } from './shove.js';
import { CheckTileObjectsBlocking, CheckPassiveTileObjects } from '../worldobj/tileobjects.js';
import { CheckPersonBlocking } from '../npc/uwperson.js';
import { CheckSubroom } from '../world/nextroom.js';
import { CheckDoorway } from '../world/doors.js';
import { CheckLadder } from '../link/ladder.js';

export * from './math.js';
export * from './bounds.js';
export * from './tiles.js';
export * from './shove.js';

/**
 * Walker_Move (Z_07). X = object (0 = Link). Chooses the moving direction [0F], checks blockers,
 * bounds, doorways and tiles, then moves the object (falls into MoveObject).
 * @returns X at the end (Link: the ladder's slot when CheckLadder put the ladder away, else 0)
 */
export function Walker_Move(x) {
  // Walker_Move (Z_07)
  if (!$br('Z_07:2603', ram[(ObjShoveDir + x) & 0xff] === 0)) {
    Obj_Shove(x); // JMP Obj_Shove
    return x;
  }
  // @ChooseObjDirOrInputDir
  let a = -1;
  if (!$br('Z_07:2628', x !== 0) && !$br('Z_07:2630', ram[ObjGridOffset] === 0)) {
    if ($br('Z_07:2632', ram[ObjInputDir] === 0)) a = 0; // @ZeroMovingDir
    else if ($br('Z_07:2634', ram[ObjDir] !== 0)) a = ram[ObjDir];
  }
  if (a < 0) {
    // @CheckStunned
    if (!$br('Z_07:2638', x === 0)
      && $br('Z_07:2641', (ram[InvClock] | ram[(ObjStunTimer + x) & 0xff]) !== 0)) return x; // L1EFCF_Exit
    // @FilterInput: keep a single direction of a diagonal.
    $pxa('Z_07:2644', ObjInputDir, x);
    a = ram[ObjInputDir + x];
    if (!$br('Z_07:2645', a === 0)) {
      a = reverseDirections(GetOppositeDir(a).y, 'Z_07:2647');
      if (!$br('Z_07:2648', a !== 0)) a = 0;
    }
  }
  // @SetMovingDir
  ram[0x0f] = a & 0x0f;
  ram[0x0e] = 0x00;
  if (!$br('Z_07:2668', x !== 0)) {
    const s = ram[(ObjState + x) & 0xff] & 0xf0;
    if ($br('Z_07:2672', s === 0x10) || !$br('Z_07:2674', s !== 0x20)) ram[0x0f] = x; // using or catching an item
  }

  let checkBoundary = true;
  if (!$br('Z_07:2681', x !== 0)) {
    // @OnlyLink
    switchBank(1);
    CheckTileObjectsBlocking(); // returns with X = 0 (its loop ends at slot 0)
    x = 0;
    const t = ram[ObjType + 1];
    if ($br('Z_07:2691', t === 0x36) || (!$br('Z_07:2693', t < 0x4b) && !$br('Z_07:2695', t >= 0x53))) CheckPersonBlocking();
    // @CheckSubroomOrDoorways
    if ($br('Z_07:2703', ram[DoorwayDir] !== 0)) {
      checkBoundary = false;
    } else {
      const m = ram[GameMode];
      let skip = false;
      if ($br('Z_07:2708', m === 0x09) || $br('Z_07:2710', m === 0x0b) || !$br('Z_07:2712', m !== 0x0c)) {
        // @InSubroom
        switchBank(5);
        CheckSubroom();
        if ($br('Z_07:2723', ram[GameMode] === 0x09)) skip = true;
      }
      // @SkipSubroom
      if (skip || $br('Z_07:2727', ram[CurLevel] === 0) || $br('Z_07:2729', ram[DoorwayDir] !== 0)) checkBoundary = false;
    }
  }
  if (checkBoundary) BoundByRoom(x); // @CheckBoundary

  // @CheckDoorways
  if (!$br('Z_07:2742', x !== 0) && !$br('Z_07:2744', ram[CurLevel] === 0) && !$br('Z_07:2747', ram[GameMode] === 0x09)) {
    switchBank(5);
    CheckDoorway();
    x = 0x00; // restore Link's object index
  }
  // @CheckTiles
  Walker_CheckTileCollision(x);
  if ($br('Z_07:2759', x !== 0)) return MoveObject(x);
  switchBank(5);
  x = CheckLadder(); // X = ladder slot if it was put away, else 0
  return MoveObject(x); // falls through
}

/**
 * MoveObject (Z_07). X = object, [0F] = direction. Applies the quarter speed 4 times.
 * @returns X
 */
export function MoveObject(x) {
  // MoveObject (Z_07)
  let a = 0x08; // limits +8/-8 for Link
  let y = 0xf8;
  if (!$br('Z_07:2772', x === 0)) {
    a = 0x10; // +$10/-$10 for other objects
    y = 0xf0;
  }
  ram[PositiveGridCellSize] = a;
  ram[NegativeGridCellSize] = y;
  if ($br('Z_07:2779', ram[0x0f] === 0)) return x; // @Exit
  for (let i = 0; i < 4; i++) applyQSpeedToPosition(x);
  return x;
}

/** MoveObject@ApplyQSpeedToPosition. */
function applyQSpeedToPosition(x) {
  const d = ram[0x0f];
  const X = (ObjX + x) & 0xff, Y = (ObjY + x) & 0xff; // zp,X
  if ($br('Z_07:2790', (d & 0x01) !== 0)) {
    ram[X] = ram[X] + AddQSpeedToPositionFraction(x); // @Right
  } else if ($br('Z_07:2792', (d & 0x02) !== 0)) {
    ram[X] = ram[X] - (1 - SubQSpeedFromPositionFraction(x)); // @Left
  } else if ($br('Z_07:2794', (d & 0x04) !== 0)) {
    ram[Y] = ram[Y] + AddQSpeedToPositionFraction(x); // @Down
  } else {
    ram[Y] = ram[Y] - (1 - SubQSpeedFromPositionFraction(x)); // Up
  }
}

/**
 * Walker_CheckTileCollision (Z_07). X = object, [0E] = $FF if blocked by a door, [0F] = direction.
 * Leaves [0F] untouched, or changed if blocked; may set ObjDir or go to the next mode (Link).
 */
export function Walker_CheckTileCollision(x) {
  // Walker_CheckTileCollision (Z_07)
  if (!$br('Z_07:2864', x !== 0)) {
    if (!$br('Z_07:2866', ram[DoorwayDir] === 0)) return GoWalkableDir(x);
    if ($br('Z_07:2870', (ram[0x0e] & 0x80) !== 0)) return; // blocked by a door: L1F148_Exit
  }
  // @CheckGridOffset
  $pxa('Z_07:2874', ObjGridOffset, x);
  const g = ram[ObjGridOffset + x];
  if ($br('Z_07:2875', g !== 0)) return;
  ram[0x0e] = g; // reset the alternate direction search step
  if ($br('Z_07:2886', ram[0x0f] !== 0)) return CheckTiles(x);
  if ($br('Z_07:2891', x === 0)) return;
  $pxa('Z_07:2899', ObjAttr, x);
  if ($br('Z_07:2901', (ram[ObjAttr + x] & 0x10) !== 0)) return Reverse(x);
  $pxa('Z_07:2902', ObjInputDir, x);
  ram[0x0f] = ram[ObjInputDir + x];
  return TryNextDir(x);
}

/** Reverse (Z_07, part of Walker_CheckTileCollision; unverified code 1F110, attribute $10 unused). */
function Reverse(x) {
  ReverseObjDir(x);
  return CheckBoundary(x);
}

/** CheckTiles (Z_07, part of Walker_CheckTileCollision). */
function CheckTiles(x) {
  if ($br('Z_07:2926', GetCollidingTileMoving(x) < ram[ObjectFirstUnwalkableTile])) return GoWalkableDir(x);
  if ($br('Z_07:2933', x === 0)) return PlayerUnwalkable(x);
  return CheckObjAttr10AndAltDir(x); // falls through
}

/** CheckObjAttr10AndAltDir (Z_07, part of Walker_CheckTileCollision). */
function CheckObjAttr10AndAltDir(x) {
  $pxa('Z_07:2939', ObjAttr, x);
  if ($br('Z_07:2941', (ram[ObjAttr + x] & 0x10) !== 0)) return Reverse(x);
  return TryNextDir(x); // falls through
}

/** TryNextDir (Z_07). X = object, [0E] = search step. Sets [0F] to the next alternate direction. */
export function TryNextDir(x) {
  // TryNextDir (Z_07)
  ram[0x0f] = Walker_GetNextAltDir(x);
  if ($br('Z_07:2949', ram[0x0e] !== 0)) return CheckTiles(x);
}

/** PlayerUnwalkable (Z_07, part of Walker_CheckTileCollision): Link hit an unwalkable tile. */
function PlayerUnwalkable(x) {
  if (!$br('Z_07:2959', ram[CurLevel] !== 0)) {
    switchBank(1);
    CheckPassiveTileObjects(); // returns with X = 0
  }
  // @StopMoving
  ram[ButtonsPressed] = ResetMovingDir();
  if ($br('Z_07:2971', ram[CurLevel] === 0)) return GoWalkableDir(x);
}

/** ResetMovingDir (Z_07). [0F] = 0. @returns A = 0 */
export function ResetMovingDir() {
  // ResetMovingDir (Z_07)
  ram[0x0f] = 0x00;
  return 0x00;
}

/**
 * GoWalkableDir (Z_07). X = object. Not Link: check bounds (CheckBoundary). Link: check the screen
 * edge in mode 5 when not on the ladder and on the grid.
 */
export function GoWalkableDir(x) {
  // GoWalkableDir (Z_07)
  if ($br('Z_07:2990', x !== 0)) return CheckBoundary(x);
  if ($br('Z_07:2997', ram[GameMode] !== 0x05)) return 0; // ExitX0
  if ($br('Z_07:2999', ram[LadderSlot] !== 0)) return; // L1F148_Exit
  if ($br('Z_07:3003', ram[ObjGridOffset] !== 0)) return 0; // ExitX0
  return CheckScreenEdge(); // falls through
}

/**
 * CheckScreenEdge (Z_07). If Link stands on the screen edge in his single input direction, face it
 * and go to the next mode. Uses [00]. @returns X = 0
 */
export function CheckScreenEdge() {
  // CheckScreenEdge (Z_07)
  let xr = ram[ObjY];
  if ($br('Z_07:3010', ram[ObjInputDir] === 0)) return 0; // ExitX0
  const { y } = GetOppositeDir(ram[ObjInputDir]); // a single moving direction
  if (!$br('Z_07:3017', (reverseDirections(y, 'Z_07:3015') & 0x0c) !== 0)) xr = ram[ObjX];
  ram[0x00] = xr;
  const edges = table(bus.rom, 'PlayerScreenEdgeBounds');
  $pxa('Z_07:3025', edges.addr, y);
  if ($br('Z_07:3026', ram[0x00] !== edges.byte(y))) return 0; // ExitX0
  ram[ObjDir] = reverseDirections(y, 'Z_07:3030');
  return GoToNextModeFromPlay(); // falls through
}

/** GoToNextModeFromPlay (Z_07). @returns X = 0 (Link's slot) */
export function GoToNextModeFromPlay() {
  // GoToNextModeFromPlay (Z_07)
  ram[GameMode]++;
  ram[GameSubmode] = 0x00;
  ram[IsUpdatingMode] = 0x00;
  ram[0x0f] = 0x00;
  ram[ObjState] = 0x00;
  ram[ObjShoveDir] = 0x00;
  ram[ObjShoveDistance] = 0x00;
  ram[ObjInvincibilityTimer] = 0x00;
  return 0; // ExitX0
}

/**
 * CheckBoundary (Z_07). X = object, [0F] = direction. If crossing a room bound, try another direction;
 * else face the moving direction.
 */
export function CheckBoundary(x) {
  // CheckBoundary (Z_07)
  const a = BoundByRoom(x);
  if ($br('Z_07:3056', a === 0)) return CheckObjAttr10AndAltDir(x);
  ram[(ObjDir + x) & 0xff] = a;
}

/**
 * Walker_GetNextAltDir (Z_07). X = object, [0E] = current step (incremented).
 * Leaves $00-$03 as TableJump does. @returns A = direction for this step, or 0 at the end
 */
export function Walker_GetNextAltDir(x) {
  // Walker_GetNextAltDir (Z_07)
  const a = ram[0x0e];
  ram[0x0e]++;
  return tableJump(label('Walker_GetNextAltDir_JumpTable').addr, a, [
    () => Walker_AltDir_GetRandomObjPerpendicularDir(x),
    () => Walker_AltDir_GetMovingOppositeDir(),
    () => ReverseObjDir(x),
    () => Walker_AltDir_EndLoop(),
  ]);
}

/** Walker_AltDir_GetRandomObjPerpendicularDir (Z_07). X = object. @returns A = a perpendicular direction */
export function Walker_AltDir_GetRandomObjPerpendicularDir(x) {
  // Walker_AltDir_GetRandomObjPerpendicularDir (Z_07)
  let y = 0;
  if (!$br('Z_07:3087', (ram[(Random + x) & 0xff] & 0x80) !== 0)) y++; // ASL / BCS
  if (!$br('Z_07:3092', (ram[(ObjDir + x) & 0xff] & 0x0c) === 0)) y += 2;
  return reverseDirections(y, 'Z_07:3096');
}

/** Walker_AltDir_GetMovingOppositeDir (Z_07). [0F] = direction. @returns A = opposite of [0F] */
export function Walker_AltDir_GetMovingOppositeDir() {
  // Walker_AltDir_GetMovingOppositeDir (Z_07)
  const a = ram[0x0f];
  if (!$br('Z_07:3103', (a & 0x0a) === 0)) return a >> 1; // left/up -> right/down
  return (a << 1) & 0xff; // @IncreasingDir
}

/** ReverseObjDir (Z_07). X = object. ObjDir and [0F] = opposite of ObjDir. @returns A */
export function ReverseObjDir(x) {
  // ReverseObjDir (Z_07)
  const a = GetOppositeDir(ram[(ObjDir + x) & 0xff]).a;
  ram[(ObjDir + x) & 0xff] = a;
  ram[0x0f] = a;
  return a;
}

/** Walker_AltDir_EndLoop (Z_07). [0E] = 0. @returns A = 0 */
export function Walker_AltDir_EndLoop() {
  // Walker_AltDir_EndLoop (Z_07)
  ram[0x0e] = 0x00;
  return 0x00;
}

/** _FaceUnblockedDir (Z_07). X = object. On a square boundary, face the first unblocked direction. */
export function _FaceUnblockedDir(x) {
  // _FaceUnblockedDir (Z_07)
  $pxa('Z_07:3134', ObjGridOffset, x);
  const g = ram[ObjGridOffset + x];
  if ($br('Z_07:3135', g !== 0)) return; // L1F1FC_Exit
  ram[0x0e] = g;
  for (;;) {
    // @LoopSearchStep
    const a = Walker_GetNextAltDir(x);
    ram[0x0f] = a;
    if ($br('Z_07:3147', a === 0)) return;
    if ($br('Z_07:3153', GetCollidingTileMoving(x) >= ram[ObjectFirstUnwalkableTile])) continue;
    const b = BoundByRoom(x);
    if ($br('Z_07:3155', b === 0)) continue;
    ram[(ObjDir + x) & 0xff] = b;
    return;
  }
}
