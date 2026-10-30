// Warps (Z_05): stairs, cave and level entrances under Link (mode $10 with a target mode), and the
// lost woods / mountain mazes (Z_01, BANK_01_CODE). Package P14.
// Contracts:
//   CheckWarps():       Link (X = 0) in mode 5; may start mode $10.
//   SetTargetMode(a):   A = target mode.
//   HandleWarpOW(a):    A = tile Link stands on (OW).
//   CheckMazes():       may set NextRoomId = RoomId (repeat the room) and MazeStep.
import { ram, peek } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import {
  UndergroundExitType, ObjGridOffset, CurLevel, RoomId, ObjX, ObjY, ObjCollidedTile,
  CellarSourceRoomId, LevelInfo_CellarRoomIdArray, LevelBlockAttrsA, LevelBlockAttrsB, TargetMode,
  Tune1Request, FluteTimer, GameMode, UndergroundEntranceTile, CaveSourceRoomId, MazeStep, ObjDir,
  NextRoomId,
} from '../../core/vars.js';
import { GetCollidableTileStill } from '../movement/tiles.js';
import { SaveKillCount } from './roomflags.js';
import { SilenceAllSound } from '../audio/requests.js';
import { MaskCurPpuMaskGrayscale } from '../modes/mode5-play.js';
import { EndPrepareMode } from './nextroom.js';
import { $br, $pxa } from '../../core/timing.js';

/**
 * CheckWarps (Z_05): when Link stands aligned on a stairs square (UW: go down to the cellar, mode 9)
 * or on a cave/level/stairs entrance (OW), start mode $10 with the target mode.
 */
export function CheckWarps() {
  // CheckWarps (Z_05)
  if ($br('Z_05:7252', (ram[UndergroundExitType] | ram[ObjGridOffset]) !== 0)) return; // L1746E_Exit
  if (!$br('Z_05:7257', ram[CurLevel] !== 0) && !$br('Z_05:7260', ram[RoomId] !== 0x22)) {
    // Level 6's entrance is wide: X only has to be a multiple of 8.
    if ($br('Z_05:7263', (ram[ObjX] & 0x07) !== 0)) return;
    $br('Z_05:7264', true);
  } else if ($br('Z_05:7270', (ram[ObjX] & 0x0f) !== 0)) {
    return; // @EnsureSquareX
  }
  // @EnsureSquareY
  if ($br('Z_05:7277', (ram[ObjY] & 0x0f) !== 0x0d)) return;
  GetCollidableTileStill(0x00);
  const a = ram[ObjCollidedTile];
  if ($br('Z_05:7285', ram[CurLevel] === 0)) return HandleWarpOW(a);

  // UW: stairs square (tiles $70-$73).
  if ($br('Z_05:7291', a < 0x70) || $br('Z_05:7293', a >= 0x74)) return;
  SaveKillCount();
  ram[CellarSourceRoomId] = ram[RoomId];
  // Find the cellar whose destination room A or B is this room.
  let x = 0xff;
  let y;
  for (;;) {
    x = (x + 1) & 0xff;
    $pxa('Z_05:7305', LevelInfo_CellarRoomIdArray, x);
    y = peek(LevelInfo_CellarRoomIdArray + x);
    $pxa('Z_05:7308', LevelBlockAttrsA, y);
    if ($br('Z_05:7309', ram[RoomId] === peek(LevelBlockAttrsA + y))) break;
    $pxa('Z_05:7310', LevelBlockAttrsB, y);
    if (!$br('Z_05:7311', ram[RoomId] !== peek(LevelBlockAttrsB + y))) break;
  }
  ram[RoomId] = y;
  return SetTargetMode(0x09);
}

/** SetTargetMode (Z_05). A = target mode: go to mode $10 (silencing the sound unless mode 9). */
export function SetTargetMode(a) {
  // SetTargetMode (Z_05)
  ram[TargetMode] = a;
  if (!$br('Z_05:7322', a === 0x09)) {
    a = SilenceAllSound();
    ram[Tune1Request] = a;
    ram[FluteTimer] = a;
  }
  ram[GameMode] = 0x10;
  MaskCurPpuMaskGrayscale();
  return EndPrepareMode();
}

/** HandleWarpOW (Z_05, part of CheckWarps). A = tile under Link: cave ($24, $88) or stairs ($70-$73). */
export function HandleWarpOW(a) {
  // HandleWarpOW (Z_05)
  ram[UndergroundEntranceTile] = a;
  if (!$br('Z_05:7352', a === 0x24) && !$br('Z_05:7354', a === 0x88)) {
    if ($br('Z_05:7356', a < 0x70) || $br('Z_05:7358', a >= 0x74)) return; // L1746E_Exit
    ram[ObjCollidedTile] = 0x70; // all the stairs tiles as $70
  }
  SaveKillCount();
  $pxa('Z_05:7369', LevelBlockAttrsB, ram[RoomId]);
  a = peek(LevelBlockAttrsB + ram[RoomId]) & 0xfc; // cave index
  if ($br('Z_05:7375', a < 0x40)) {
    // @LoadLevel
    ram[CurLevel] = a >> 2;
    ram[CaveSourceRoomId] = ram[RoomId];
    $br('Z_05:7399', true);
    return SetTargetMode(0x02);
  }
  let y = 0x0b; // regular cave
  if (!$br('Z_05:7380', a !== 0x50)) y++; // shortcut cave
  return SetTargetMode(y);
}

/**
 * CheckMazes (Z_01). In the forest maze ($61) and the mountain maze ($1B) leaving by the wrong
 * direction repeats the room (NextRoomId = RoomId); the right sequence plays the secret tune.
 */
export function CheckMazes() {
  // CheckMazes (Z_01)
  const x = ram[MazeStep];
  const a = ram[ObjDir];
  const y = ram[RoomId];
  const resetMazeStep = () => { ram[MazeStep] = 0x00; }; // @ResetMazeStep
  const setNextRoom = () => { ram[NextRoomId] = y; }; // @SetNextRoom
  const advance = () => { ram[MazeStep]++; setNextRoom(); }; // @AdvanceMaze
  const secretTune = () => { ram[Tune1Request] = 0x04; }; // @PlaySecretTune

  if (!$br('Z_01:4842', y !== 0x61)) {
    $pxa('Z_01:4843', label('ForestMazeDirs').addr, x);
    if (!$br('Z_01:4844', a !== table(bus.rom, 'ForestMazeDirs').byte(x))) {
      if ($br('Z_01:4848', x === 0x03)) return secretTune();
      return advance();
    }
    // @Mismatch
    if ($br('Z_01:4868', a === 0x01)) return; // going right leaves the forest
    resetMazeStep(); // @Reset
    $br('Z_01:4872', true);
    return setNextRoom();
  }
  // @CheckMountainMaze
  if ($br('Z_01:4876', y !== 0x1b)) return resetMazeStep();
  $pxa('Z_01:4877', label('MountainMazeDirs').addr, x);
  if ($br('Z_01:4878', a === table(bus.rom, 'MountainMazeDirs').byte(x))) {
    // @Match
    if ($br('Z_01:4885', x !== 0x03)) return advance();
    return secretTune();
  }
  if ($br('Z_01:4880', a !== 0x02)) {
    resetMazeStep(); // @Reset
    $br('Z_01:4872', true);
    return setNextRoom();
  }
  // going left leaves the mountain
}
