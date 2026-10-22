// Whirlwind summoned by the recorder (flute) and level teleporting (Z_01, BANK_01_CODE). Package P16.
// Routines: InitWhirlwind, SetUpWhirlwind, UpdateWhirlwind_Full, DestroyWhirlwind, SummonWhirlwind,
// AdvanceTeleportingLevelIndex (+ its RTS L6104_Exit), DrawWhirlwind, CheckInitWhirlwindAndBeginUpdate.
// Tables read from the ROM: WhirlwindPrevRoomIdList, TeleportYs, LevelMasks (Z_07).

import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjDir, ObjType, ObjState, ObjShoveDir, ObjShoveDistance, ObjTimer, ObjInvincibilityTimer,
  ObjUninitialized, ObjMetastate, UndergroundExitType, Sprites, WhirlwindTeleportingState,
  WhirlwindPrevRoomId, TeleportingLevelIndex, SummonedWhirlwind, InvTriforce, GameMode, FrameCounter,
} from '../../core/vars.js';
import { FindEmptyMonsterSlot } from '../objects/slots.js';
import { GoToNextModeFromPlay } from '../movement/walker.js';
import { UpdatePlayerPositionMarker } from '../hud/statusbar.js';
import { BeginUpdateMode } from '../modes/dispatch.js';
import {
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, Anim_SetObjHFlipForSpriteDescriptor,
  DrawObjectNotMirrored,
} from '../draw/anim.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { CheckLinkCollision } from '../combat/collisions.js';

/** InitWhirlwind (Z_01). A = Y coordinate (stored as Link's Y first), X = object slot. @returns A = $2E */
export function InitWhirlwind(a, x) {
  // InitWhirlwind (Z_01)
  ram[ObjY] = a;
  return SetUpWhirlwind(x); // falls through
}

/** SetUpWhirlwind (Z_01). X = object slot: Y = Link's Y, X = 0, type $2E. @returns A = $2E */
export function SetUpWhirlwind(x) {
  // SetUpWhirlwind (Z_01)
  ram[ObjY + x] = ram[ObjY];
  ram[ObjX + x] = 0x00;
  ram[ObjType + x] = 0x2e;
  return 0x2e;
}

/** UpdateWhirlwind_Full (Z_01). X = whirlwind slot. */
export function UpdateWhirlwind_Full(x) {
  // UpdateWhirlwind_Full (Z_01)
  let y = ram[ObjState] & 0x40; // Link's halted state
  let a = (0x02 + ram[ObjX + x]) & 0xff;
  ram[ObjX + x] = a;

  let checkCollision = true;
  if (y === 0x40) {
    y = ram[WhirlwindTeleportingState];
    if (y !== 0) checkCollision = false;
  }

  if (!checkCollision) {
    // Link is halted and teleporting state <> 0: carry him.
    ram[ObjX] = a;
    y = (y - 1) & 0xff; // DEY
    if (y !== 0 && a === 0x80) {
      // Teleporting state 2 and whirlwind X = $80: drop Link off.
      a = (a << 1) & 0xff; // ASL -> 0
      ram[ObjState] = a;
      ram[WhirlwindTeleportingState] = a;
      ram[ObjType + x] = a;
      UpdatePlayerPositionMarker(); // TXA/PHA ... PLA/TAX
      return DrawWhirlwind(x);
    }
  } else {
    // @CheckCollision
    CheckLinkCollision(x);
    if (ram[0x06] !== 0) {
      ram[ObjDir] = 0x01;
      a = 0x00; // LSR
      ram[ObjShoveDir] = a;
      ram[ObjShoveDistance] = a;
      ram[UndergroundExitType] = a;
      ram[ObjState] = 0x40;
      ram[Sprites + 72] = 0xf8;
      ram[Sprites + 76] = 0xf8;
      y = ram[TeleportingLevelIndex] & 0x07;
      ram[WhirlwindPrevRoomId] = table(bus.rom, 'WhirlwindPrevRoomIdList').byte(y);
      ram[WhirlwindTeleportingState]++;
    }
  }

  // @CheckRightEdge
  if (ram[ObjX + x] >= 0xf0) {
    DestroyWhirlwind(x);
    if (ram[WhirlwindTeleportingState] !== 0) {
      GoToNextModeFromPlay(); // TXA/PHA ... PLA/TAX
    }
  }
  // @Draw
  return DrawWhirlwind(x);
}

/** DestroyWhirlwind (Z_01). X = object slot. @returns A = 1 */
export function DestroyWhirlwind(x) {
  // DestroyWhirlwind (Z_01)
  ram[ObjType + x] = 0x00;
  ram[ObjShoveDir + x] = 0x00;
  ram[ObjShoveDistance + x] = 0x00;
  ram[ObjTimer + x] = 0x00;
  ram[ObjState + x] = 0x00;
  ram[ObjInvincibilityTimer + x] = 0x00;
  ram[ObjUninitialized + x] = 0xff;
  ram[ObjMetastate + x] = 0x01;
  return 0x01;
}

/** SummonWhirlwind (Z_01): called by WieldFlute. Makes a whirlwind if Link has a triforce piece. */
export function SummonWhirlwind() {
  // SummonWhirlwind (Z_01)
  if (ram[GameMode] !== 0x05) return; // L6104_Exit
  AdvanceTeleportingLevelIndex();
  let y = ram[TeleportingLevelIndex] & 0x07;
  ram[0x00] = table(bus.rom, 'LevelMasks').byte(y);

  // @LoopTriforcePiece
  for (;;) {
    const a = ram[InvTriforce];
    if (a === 0) return; // L6104_Exit
    if (a & ram[0x00]) break; // BIT $00 / BNE @MakeWhirlwind
    AdvanceTeleportingLevelIndex();
    if (ram[ObjDir] & 0x09) {
      cpu.aslMem(0x00);
      if (!cpu.c) continue;
      cpu.rolMem(0x00);
    } else {
      // @DecreasingDir
      cpu.lsrMem(0x00);
      if (!cpu.c) continue;
      cpu.rorMem(0x00);
    }
  }

  // @MakeWhirlwind
  if ((ram[SummonedWhirlwind] | ram[WhirlwindTeleportingState]) !== 0) return;
  const r = FindEmptyMonsterSlot();
  if (r.y === 0) return;
  ram[SummonedWhirlwind]++;
  return SetUpWhirlwind(r.y); // TYA / TAX / JMP
}

/** AdvanceTeleportingLevelIndex (Z_01): +1 facing right/down, else -1. L6104_Exit is its RTS. */
export function AdvanceTeleportingLevelIndex() {
  // AdvanceTeleportingLevelIndex (Z_01)
  ram[TeleportingLevelIndex]++;
  if (ram[ObjDir] & 0x09) return; // L6104_Exit
  ram[TeleportingLevelIndex]--;
  ram[TeleportingLevelIndex]--;
}

/** DrawWhirlwind (Z_01). X = object slot. @returns X */
export function DrawWhirlwind(x) {
  // DrawWhirlwind (Z_01)
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x01, x);
  Anim_SetSpriteDescriptorAttributes(ram[FrameCounter] & 0x03);
  Anim_SetObjHFlipForSpriteDescriptor(x);
  return DrawObjectNotMirrored(0x00, x);
}

/** CheckInitWhirlwindAndBeginUpdate (Z_01): puts the whirlwind in slot 9 of the destination room. */
export function CheckInitWhirlwindAndBeginUpdate() {
  // CheckInitWhirlwindAndBeginUpdate (Z_01)
  if (ram[WhirlwindTeleportingState] !== 0) {
    ram[WhirlwindTeleportingState]++;
    ram[ObjState] = 0x40;
    const y = ram[TeleportingLevelIndex] & 0x07;
    InitWhirlwind(table(bus.rom, 'TeleportYs').byte(y), 0x09);
  }
  return BeginUpdateMode();
}
