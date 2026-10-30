// Next room and subrooms: CalculateNextRoom (Z_07), CalculateNextRoomForDoor/CalcNextRoomByDir,
// CheckSubroom (leaving cellars and shortcut caves) and the mode $A set-up (Z_05). Package P13.

import { ram, peek } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { switchBank, tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  CurLevel, ObjDir, RoomId, NextRoomId, GameMode, ObjY, ObjX, ObjInputDir, LevelInfo_CellarRoomIdArray,
  LevelBlockAttrsA, LevelBlockAttrsB, LevelBlockAttrsC, ObjGridOffset, GameSubmode, IsUpdatingMode,
  ObjState, ObjShoveDir, ObjShoveDistance, ObjInvincibilityTimer,
} from '../../core/vars.js';
import { FindDoorTypeByDoorBit } from './doors.js';
import { GetUniqueRoomId, MarkRoomVisited } from './roomflags.js';
import { CheckMazes } from './warps.js';
import { CheckPersonBlocking } from '../npc/uwperson.js';
import { CheckScreenEdge } from '../movement/walker.js';
import { MaskCurPpuMaskGrayscale } from '../modes/mode5-play.js';
import { EndGameMode12 } from '../modes/mode12-endlevel.js';

const E7 = 0xe7; // [E7]: door bit / direction (unnamed in the asm)

/** The single-bit mask search of CalculateNextRoomForDoor / CalcNextRoomByDir: X for direction A. */
// `ref` is the loop's branch: BEQ back (taken = no match) in CalculateNextRoomForDoor, BNE out
// (taken = match) in CalcNextRoomByDir.
function directionIndex(a, ref, takenOnMatch) {
  ram[0x00] = 0x01;
  let x = 0x03;
  for (let n = 0; ; n++) {
    const match = (a & ram[0x00]) !== 0;
    if ($br(ref, takenOnMatch ? match : !match) === takenOnMatch) break;
    // The original loops forever without a direction bit in the low nibble.
    if (n > 0x100) throw new Error(`next room: direction $${a.toString(16)} has no bit (original hangs)`);
    ram[0x00] = (ram[0x00] << 1) & 0xff;
    x = (x - 1) & 0xff;
  }
  return x;
}

// ------------------------------------------------------------------ next room

let handlers;
/** CalculateNextRoom (Z_07): NextRoomId in Link's direction (via the door type in UW). */
export function CalculateNextRoom() {
  // CalculateNextRoom (Z_07)
  let a;
  let y;
  if ($br('Z_07:750', ram[CurLevel] === 0)) {
    // CalculateNextRoomOW: all directions are open.
    y = ram[ObjDir];
    a = 0x00;
    $br('Z_07:778', true);
  } else {
    // Door type for the player's direction.
    ram[0x02] = ram[ObjDir];
    switchBank(5);
    a = FindDoorTypeByDoorBit();
    y = ram[0x01]; // the same as [02]
  }
  // CalculateNextRoom_TableJump
  ram[E7] = y;
  handlers ??= [CalculateNextRoomForDoor, CalculateNoNextRoom, CalculateNextRoomForDoor,
    CalculateNextRoomForDoor, CalculateNextRoomForDoor, CalculateNextRoomForDoor, CalculateNextRoomForDoor,
    CalculateNextRoomForDoor, CalculateNoNextRoom];
  return tableJump(label('CalculateNextRoom_JumpTable').addr, a, handlers);
}

export function CalculateNoNextRoom() {
  // CalculateNoNextRoom (Z_05, unverified code in the asm)
  ram[E7] = 0x00;
  return 0x00;
}

/**
 * CalculateNextRoomForDoor (Z_05). [E7] = direction. NextRoomId = RoomId + offset; in the OW also
 * CheckMazes. An invalid next room falls into EndGameMode12 (reload the OW), else
 * MaskCurPpuMaskGrayscale.
 */
export function CalculateNextRoomForDoor() {
  // CalculateNextRoomForDoor (Z_05)
  // Door bit 1, 2, 4, 8 -> index 3, 2, 1, 0.
  const x = directionIndex(ram[E7], 'Z_05:7505', false);
  ram[0x04e4] = GetUniqueRoomId(); // UNKNOWN in the asm: holds room layout, unused
  $pxa('Z_05:7508', table(bus.rom, 'NextRoomIdOffsets').addr, x);
  ram[NextRoomId] = (table(bus.rom, 'NextRoomIdOffsets').byte(x) + ram[RoomId]) & 0xff;
  if (!$br('Z_05:7513', ram[CurLevel] !== 0)) CheckMazes();
  if ($br('Z_05:7517', !(ram[NextRoomId] & 0x80))) return MaskCurPpuMaskGrayscale();
  return EndGameMode12(); // falls through into MaskCurPpuMaskGrayscale
}

/** CalcNextRoomByDir (Z_05). A = direction. Uses [00]. @returns A = next room ID */
export function CalcNextRoomByDir(a) {
  // CalcNextRoomByDir (Z_05)
  const x = directionIndex(a & 0xff, 'Z_05:7549', true);
  $pxa('Z_05:7554', table(bus.rom, 'NextRoomIdOffsets').addr, x);
  return (table(bus.rom, 'NextRoomIdOffsets').byte(x) + ram[RoomId]) & 0xff;
}

// ------------------------------------------------------------------ subrooms

/**
 * CheckSubroom (Z_05). [0F] = movement direction; leaves it untouched or 0. Link in a cellar
 * (mode 9: climbing up at the top leaves to room A or B) or a cave (modes $B/$C: shortcut stairs,
 * screen edge).
 */
export function CheckSubroom() {
  // CheckSubroom (Z_05)
  const mode = ram[GameMode];
  if (!$br('Z_05:3060', mode !== 0x09)) {
    // In a cellar: leave when Y < $40 and going up.
    if ($br('Z_05:3067', ram[ObjY] >= 0x40)) return; // L14EC6_Exit
    if ($br('Z_05:3070', !(ram[ObjInputDir] & 0x08))) return;
    // Look for this room's ID in the 6-element cellar room array (the index is not used).
    const room = ram[RoomId]; // PHA
    let y = 0x06;
    do {
      y = (y - 1) & 0xff;
      $pxa('Z_05:3078', LevelInfo_CellarRoomIdArray, y);
    } while ($br('Z_05:3079', room !== peek(LevelInfo_CellarRoomIdArray + y)));
    // Destination: attributes A if Link's X < $80, else B.
    y = room;
    let dest;
    if ($br('Z_05:3090', ram[ObjX] >= 0x80)) { $pxa('Z_05:3095', LevelBlockAttrsB, y); dest = peek(LevelBlockAttrsB + y); }
    else { $pxa('Z_05:3091', LevelBlockAttrsA, y); dest = peek(LevelBlockAttrsA + y); }
    GoToModeAFromCellar(dest);
    // Link's position in the destination room, from the cellar's attributes C.
    $pxa('Z_05:3102', LevelBlockAttrsC, room);
    const c = peek(LevelBlockAttrsC + room); // PLA / TAY
    ram[ObjX] = c & 0xf0;
    ram[ObjY] = ((c << 4) & 0xff) | 0x0d;
    return;
  }

  // @InCave: is a person blocking the upper half of the room?
  CheckPersonBlocking();
  if ($br('Z_05:3125', mode !== 0x0c)) return CheckCaveEdge();
  // Shortcut cave (mode $C).
  if ($br('Z_05:3131', ram[ObjGridOffset] !== 0)) return; // L14F72_Exit
  if ($br('Z_05:3136', ram[ObjY] !== 0x9d)) return CheckCaveEdge();
  // On one of the 3 shortcut stairs? X = $50: 1, $80: 2, $B0: 3.
  let y;
  const x = ram[ObjX];
  if ($br('Z_05:3147', x === 0x50)) y = 1;
  else if ($br('Z_05:3150', x === 0x80)) y = 2;
  else if (!$br('Z_05:3153', x !== 0xb0)) y = 3;
  else return;
  ram[0x00] = y;
  const room = ram[RoomId];
  y = 0xff;
  do {
    y = (y + 1) & 0xff;
    $pxa('Z_05:3161', LevelInfo_CellarRoomIdArray, y);
  } while ($br('Z_05:3162', room !== peek(LevelInfo_CellarRoomIdArray + y)));
  // One of the three shortcut rooms after the current one, wrapping around.
  y = ((y + ram[0x00]) & 0xff) & 0x03;
  $pxa('Z_05:3176', LevelInfo_CellarRoomIdArray, y);
  return GoToModeAFromCellar(peek(LevelInfo_CellarRoomIdArray + y));
}

/** GoToModeAFromCellar (Z_05). A = destination room ID. Falls into GoToModeAFromCave. */
export function GoToModeAFromCellar(a) {
  // GoToModeAFromCellar (Z_05)
  ram[RoomId] = a;
  MarkRoomVisited();
  return GoToModeAFromCave();
}

/** GoToModeAFromCave (Z_05, label in GoToModeAFromCellar): GameMode = $A; falls into EndPrepareMode. */
function GoToModeAFromCave() {
  ram[GameMode] = 0x0a;
  return EndPrepareMode();
}

/** EndPrepareMode (Z_05): start initializing the mode; [0F] = 0; reset Link's state, shove, invincibility. */
export function EndPrepareMode() {
  // EndPrepareMode (Z_05)
  const a = 0x00;
  ram[GameSubmode] = a;
  ram[IsUpdatingMode] = a;
  ram[0x0f] = a;
  ram[ObjState] = a;
  ram[ObjShoveDir] = a;
  ram[ObjShoveDistance] = a;
  ram[ObjInvincibilityTimer] = a;
  return a;
}

/** CheckCaveEdge (Z_05, part of CheckSubroom): touching the screen edge leaves the cave (mode $A). */
function CheckCaveEdge() {
  CheckScreenEdge();
  if ($br('Z_05:3208', ram[IsUpdatingMode] === 0)) return GoToModeAFromCave();
}
