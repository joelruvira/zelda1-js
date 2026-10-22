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
  if (ram[ObjShoveDir + x] !== 0) {
    Obj_Shove(x); // JMP Obj_Shove
    return x;
  }
  // @ChooseObjDirOrInputDir
  let a = -1;
  if (x === 0 && ram[ObjGridOffset] !== 0) {
    if (ram[ObjInputDir] === 0) a = 0; // @ZeroMovingDir
    else if (ram[ObjDir] !== 0) a = ram[ObjDir];
  }
  if (a < 0) {
    // @CheckStunned
    if (x !== 0 && (ram[InvClock] | ram[ObjStunTimer + x]) !== 0) return x; // L1EFCF_Exit
    // @FilterInput: keep a single direction of a diagonal.
    a = ram[ObjInputDir + x];
    if (a !== 0) a = reverseDirections(GetOppositeDir(a).y);
  }
  // @SetMovingDir
  ram[0x0f] = a & 0x0f;
  ram[0x0e] = 0x00;
  if (x === 0) {
    const s = ram[ObjState + x] & 0xf0;
    if (s === 0x10 || s === 0x20) ram[0x0f] = x; // using or catching an item
  }

  let checkBoundary = true;
  if (x === 0) {
    // @OnlyLink
    switchBank(1);
    CheckTileObjectsBlocking(); // returns with X = 0 (its loop ends at slot 0)
    x = 0;
    if (isPersonBlockingType(ram[ObjType + 1])) CheckPersonBlocking();
    // @CheckSubroomOrDoorways
    if (ram[DoorwayDir] !== 0) {
      checkBoundary = false;
    } else {
      const m = ram[GameMode];
      let skip = false;
      if (m === 0x09 || m === 0x0b || m === 0x0c) {
        // @InSubroom
        switchBank(5);
        CheckSubroom();
        if (ram[GameMode] === 0x09) skip = true;
      }
      // @SkipSubroom
      if (skip || ram[CurLevel] === 0 || ram[DoorwayDir] !== 0) checkBoundary = false;
    }
  }
  if (checkBoundary) BoundByRoom(x); // @CheckBoundary

  // @CheckDoorways
  if (x === 0 && ram[CurLevel] !== 0 && ram[GameMode] !== 0x09) {
    switchBank(5);
    CheckDoorway();
    x = 0x00; // restore Link's object index
  }
  // @CheckTiles
  Walker_CheckTileCollision(x);
  if (x !== 0) return MoveObject(x);
  switchBank(5);
  x = CheckLadder(); // X = ladder slot if it was put away, else 0
  return MoveObject(x); // falls through
}

/** Grumble ($36) or a person ($4B..$52) in slot 1. */
function isPersonBlockingType(t) {
  return t === 0x36 || (t >= 0x4b && t < 0x53);
}

/**
 * MoveObject (Z_07). X = object, [0F] = direction. Applies the quarter speed 4 times.
 * @returns X
 */
export function MoveObject(x) {
  // MoveObject (Z_07)
  let a = 0x08; // limits +8/-8 for Link
  let y = 0xf8;
  if (x !== 0) {
    a = 0x10; // +$10/-$10 for other objects
    y = 0xf0;
  }
  ram[PositiveGridCellSize] = a;
  ram[NegativeGridCellSize] = y;
  if (ram[0x0f] === 0) return x; // @Exit
  for (let i = 0; i < 4; i++) applyQSpeedToPosition(x);
  return x;
}

/** MoveObject@ApplyQSpeedToPosition. */
function applyQSpeedToPosition(x) {
  const d = ram[0x0f];
  if (d & 0x01) {
    ram[ObjX + x] = ram[ObjX + x] + AddQSpeedToPositionFraction(x); // @Right
  } else if (d & 0x02) {
    ram[ObjX + x] = ram[ObjX + x] - (1 - SubQSpeedFromPositionFraction(x)); // @Left
  } else if (d & 0x04) {
    ram[ObjY + x] = ram[ObjY + x] + AddQSpeedToPositionFraction(x); // @Down
  } else {
    ram[ObjY + x] = ram[ObjY + x] - (1 - SubQSpeedFromPositionFraction(x)); // Up
  }
}

/**
 * Walker_CheckTileCollision (Z_07). X = object, [0E] = $FF if blocked by a door, [0F] = direction.
 * Leaves [0F] untouched, or changed if blocked; may set ObjDir or go to the next mode (Link).
 */
export function Walker_CheckTileCollision(x) {
  // Walker_CheckTileCollision (Z_07)
  if (x === 0) {
    if (ram[DoorwayDir] !== 0) return GoWalkableDir(x);
    if (ram[0x0e] & 0x80) return; // blocked by a door: L1F148_Exit
  }
  // @CheckGridOffset
  const g = ram[ObjGridOffset + x];
  if (g !== 0) return;
  ram[0x0e] = g; // reset the alternate direction search step
  if (ram[0x0f] !== 0) return CheckTiles(x);
  if (x === 0) return;
  if (ram[ObjAttr + x] & 0x10) return Reverse(x);
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
  if (GetCollidingTileMoving(x) < ram[ObjectFirstUnwalkableTile]) return GoWalkableDir(x);
  if (x === 0) return PlayerUnwalkable(x);
  return CheckObjAttr10AndAltDir(x); // falls through
}

/** CheckObjAttr10AndAltDir (Z_07, part of Walker_CheckTileCollision). */
function CheckObjAttr10AndAltDir(x) {
  if (ram[ObjAttr + x] & 0x10) return Reverse(x);
  return TryNextDir(x); // falls through
}

/** TryNextDir (Z_07). X = object, [0E] = search step. Sets [0F] to the next alternate direction. */
export function TryNextDir(x) {
  // TryNextDir (Z_07)
  ram[0x0f] = Walker_GetNextAltDir(x);
  if (ram[0x0e] !== 0) return CheckTiles(x);
}

/** PlayerUnwalkable (Z_07, part of Walker_CheckTileCollision): Link hit an unwalkable tile. */
function PlayerUnwalkable(x) {
  if (ram[CurLevel] === 0) {
    switchBank(1);
    CheckPassiveTileObjects(); // returns with X = 0
  }
  // @StopMoving
  ram[ButtonsPressed] = ResetMovingDir();
  if (ram[CurLevel] === 0) return GoWalkableDir(x);
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
  if (x !== 0) return CheckBoundary(x);
  if (ram[GameMode] !== 0x05) return 0; // ExitX0
  if (ram[LadderSlot] !== 0) return; // L1F148_Exit
  if (ram[ObjGridOffset] !== 0) return 0; // ExitX0
  return CheckScreenEdge(); // falls through
}

/**
 * CheckScreenEdge (Z_07). If Link stands on the screen edge in his single input direction, face it
 * and go to the next mode. Uses [00]. @returns X = 0
 */
export function CheckScreenEdge() {
  // CheckScreenEdge (Z_07)
  let xr = ram[ObjY];
  if (ram[ObjInputDir] === 0) return 0; // ExitX0
  const { y } = GetOppositeDir(ram[ObjInputDir]); // a single moving direction
  if ((reverseDirections(y) & 0x0c) === 0) xr = ram[ObjX];
  ram[0x00] = xr;
  if (ram[0x00] !== table(bus.rom, 'PlayerScreenEdgeBounds').byte(y)) return 0; // ExitX0
  ram[ObjDir] = reverseDirections(y);
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
  if (a === 0) return CheckObjAttr10AndAltDir(x);
  ram[ObjDir + x] = a;
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
  if (!(ram[Random + x] & 0x80)) y++; // ASL / BCS
  if (ram[ObjDir + x] & 0x0c) y += 2;
  return reverseDirections(y);
}

/** Walker_AltDir_GetMovingOppositeDir (Z_07). [0F] = direction. @returns A = opposite of [0F] */
export function Walker_AltDir_GetMovingOppositeDir() {
  // Walker_AltDir_GetMovingOppositeDir (Z_07)
  const a = ram[0x0f];
  if (a & 0x0a) return a >> 1; // left/up -> right/down
  return (a << 1) & 0xff; // @IncreasingDir
}

/** ReverseObjDir (Z_07). X = object. ObjDir and [0F] = opposite of ObjDir. @returns A */
export function ReverseObjDir(x) {
  // ReverseObjDir (Z_07)
  const a = GetOppositeDir(ram[ObjDir + x]).a;
  ram[ObjDir + x] = a;
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
  const g = ram[ObjGridOffset + x];
  if (g !== 0) return; // L1F1FC_Exit
  ram[0x0e] = g;
  for (;;) {
    // @LoopSearchStep
    const a = Walker_GetNextAltDir(x);
    ram[0x0f] = a;
    if (a === 0) return;
    if (GetCollidingTileMoving(x) >= ram[ObjectFirstUnwalkableTile]) continue;
    const b = BoundByRoom(x);
    if (b === 0) continue;
    ram[ObjDir + x] = b;
    return;
  }
}
