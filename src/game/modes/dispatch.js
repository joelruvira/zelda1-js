// Game mode state machine: init/update dispatch and thin per-mode wrappers (Z_07, Z_01). Package P01.
// Protocol (docs/PORT_MAP.md §2.3): with IsUpdatingMode = 0 each NMI runs InitMode[GameMode]; when the
// init finishes it sets IsUpdatingMode and each NMI runs UpdateMode[GameMode].

import { ram, sram } from '../../core/ram.js';
import { switchBank, tableJump } from '../../core/asm.js';
import { label } from '../../core/rom.js';
import {
  InitializedGame, SaveRamBegin, SaveRamEnd, GameMode, GameSubmode, IsUpdatingMode,
  TransferredCommonPatterns, TransferredDemoPatterns, LevelKillCounts, IsSprite0CheckActive,
  _Unknown_F3, ObjDir,
} from '../../core/vars.js';
import { CopyCommonCodeToRam, CopyCommonDataToRam, SetMMC1Control, TurnOffAllVideo } from '../boot.js';
// P03 loaders
import { TransferCommonPatterns, TransferDemoPatterns, TransferLevelPatternBlocks } from '../loaders/patterns.js';
import { InitMode2_Submodes, UpdateMode2Load_Full } from './mode2-load.js';
// P23 title
import { InitDemo_RunTasks, UpdateMode0Demo } from './mode0-title.js';
// P24 files
import { InitMode1_Full, UpdateMode1Menu } from './mode1-fileselect.js';
import { InitModeEandF_Full, UpdateModeERegister } from './modeE-register.js';
import { UpdateModeFElimination } from './modeF-eliminate.js';
import { InitModeD, UpdateModeDSave } from './modeD-save.js';
// P05 objects / play
import { InitMode5Play, UpdateMode5Play } from './mode5-play.js';
import { ClearRoomHistory } from '../objects/killcounts.js';
// P13 transitions
import { InitMode3, UpdateMode3Unfurl } from './mode3-unfurl.js';
import { InitMode4, InitMode6, UpdateMode4and6EnterLeave } from './mode4-6-enterleave.js';
import { InitMode7Submodes, UpdateMode7SubmodeAndDrawLink } from './mode7-scroll.js';
import { InitMode9 } from './mode9-cellar.js';
import { InitModeA, InitModeB, InitModeC } from './modeA-B-C-cave.js';
import { InitMode10, UpdateMode10Stairs_Full } from './mode10-stairs.js';
// P25 endings
import { InitMode8, UpdateMode8ContinueQuestion_Full } from './mode8-continue.js';
import { InitMode11, UpdateMode11Death_Full } from './mode11-death.js';
import { InitMode12, UpdateMode12EndLevel_Full } from './mode12-endlevel.js';
import { InitMode13_Full, UpdateMode13WinGame } from './mode13-ending.js';

// ------------------------------------------------------------------ init

export function InitializeGameOrMode() {
  // InitializeGameOrMode (Z_07)
  if (ram[InitializedGame] !== 0) return InitMode();
  switchBank(1);
  CopyCommonCodeToRam();
  switchBank(6);
  CopyCommonDataToRam();
  // Mark Save RAM initialized, so we can check after reset.
  sram[SaveRamBegin - 0x6000] = 0x5a;
  sram[SaveRamEnd - 0x6000] = 0xa5;
  ram[InitializedGame]++;
}

let initHandlers; // built lazily: the mode modules import this one
export function InitMode() {
  // InitMode (Z_07, part of InitializeGameOrMode)
  switchBank(5);
  initHandlers ??= [InitMode0, InitMode1, InitMode2, InitMode3, InitMode4, InitMode5Play, InitMode6,
    InitMode7, InitMode8, InitMode9, InitModeA, InitModeB, InitModeC, InitModeD, InitModeEandF,
    InitModeEandF, InitMode10, InitMode11, InitMode12, InitMode13];
  return tableJump(label('InitMode_JumpTable').addr, ram[GameMode], initHandlers);
}

export function InitMode0() {
  // InitMode0 (Z_07)
  if (ram[TransferredCommonPatterns] !== 0x5a) {
    switchBank(2);
    return TransferCommonPatterns();
  }
  if (ram[TransferredDemoPatterns] !== 0xa5) {
    switchBank(1);
    return TransferDemoPatterns();
  }
  switchBank(2);
  return InitDemo_RunTasks();
}

export function InitMode1() {
  // InitMode1 (Z_07)
  switchBank(2);
  return InitMode1_Full();
}

export function InitMode2() {
  // InitMode2 (Z_07)
  TurnOffAllVideo();
  if (ram[GameSubmode] === 0) {
    // Submode 0: transfer level pattern blocks and copy common code.
    ClearRoomHistory();
    const a = 0x00; // ClearRoomHistory returns A = 0 (LDA #$00)
    for (let y = 0x7f; y >= 0; y--) ram[LevelKillCounts + y] = a; // clear level kill counts
    switchBank(3);
    TransferLevelPatternBlocks();
    switchBank(1);
    CopyCommonCodeToRam();
  }
  switchBank(6);
  return InitMode2_Submodes();
}

export function InitMode7() {
  // InitMode7 (Z_07)
  switchBank(5);
  InitMode7Submodes();
  if (ram[IsSprite0CheckActive] === 0) return;
  // After the last submode (5 or 6), sprite-0 check was enabled: set the mirroring for scrolling.
  if (ram[_Unknown_F3] !== 0) return;
  ram[_Unknown_F3]++;
  // Facing horizontally: vertical mirroring ($0E); else horizontal ($0F).
  return SetMMC1Control(ram[ObjDir] < 0x04 ? 0x0e : 0x0f);
}

export function InitModeEandF() {
  // InitModeEandF (Z_07)
  switchBank(2);
  return InitModeEandF_Full();
}

export function InitMode13() {
  // InitMode13 (Z_07)
  SetMMC1Control(0x0f); // make sure horizontal mirroring is on
  switchBank(2);
  return InitMode13_Full();
}

// ------------------------------------------------------------------ update

let updateHandlers;
export function UpdateMode() {
  // UpdateMode (Z_07)
  switchBank(2);
  updateHandlers ??= [UpdateMode0Demo, UpdateMode1Menu, UpdateMode2Load, UpdateMode3Unfurl,
    UpdateMode4and6EnterLeave, UpdateMode5Play, UpdateMode4and6EnterLeave, UpdateMode7Scroll,
    UpdateMode8ContinueQuestion, UpdateMode5Play, UpdateMode5Play, UpdateMode5Play, UpdateMode5Play,
    UpdateModeDSave, UpdateModeERegister, UpdateModeFElimination, UpdateMode10Stairs,
    UpdateMode11Death, UpdateMode12EndLevel, UpdateMode13WinGame];
  return tableJump(label('UpdateMode_JumpTable').addr, ram[GameMode], updateHandlers);
}

export function UpdateMode7Scroll() {
  // UpdateMode7Scroll (Z_07)
  switchBank(5);
  UpdateMode7SubmodeAndDrawLink();
  const a = ram[IsSprite0CheckActive];
  if (a !== 0) return; // still checking sprite 0
  ram[_Unknown_F3] = a; // reset [$F3]
  return SetMMC1Control(0x0f); // horizontal mirroring, normal PRG bank mode
}

export function UpdateMode8ContinueQuestion() {
  // UpdateMode8ContinueQuestion (Z_07)
  switchBank(5);
  return UpdateMode8ContinueQuestion_Full();
}

export function UpdateMode10Stairs() {
  // UpdateMode10Stairs (Z_07)
  switchBank(5);
  return UpdateMode10Stairs_Full();
}

export function UpdateMode11Death() {
  // UpdateMode11Death (Z_07)
  switchBank(5);
  return UpdateMode11Death_Full();
}

export function UpdateMode12EndLevel() {
  // UpdateMode12EndLevel (Z_07)
  switchBank(5);
  return UpdateMode12EndLevel_Full();
}

export function UpdateMode2Load() {
  // UpdateMode2Load (Z_07): falls through into GoToNextMode
  TurnOffAllVideo();
  switchBank(6);
  UpdateMode2Load_Full();
  return GoToNextMode();
}

/** GoToNextMode (Z_07): INC GameMode, then EndGameMode. Returns A = 0. */
export function GoToNextMode() {
  // GoToNextMode (Z_07)
  ram[GameMode]++;
  return EndGameMode();
}

/** EndGameMode (Z_07): IsUpdatingMode = 0, GameSubmode = 0. Returns A = 0. */
export function EndGameMode() {
  // EndGameMode (Z_07)
  ram[IsUpdatingMode] = 0x00;
  ram[GameSubmode] = 0x00;
  return 0x00;
}

/** BeginUpdateMode (Z_01, BANK_01_CODE): GameSubmode = 0, INC IsUpdatingMode. Returns A = 0. */
export function BeginUpdateMode() {
  // BeginUpdateMode (Z_01); L6506_Exit is its RTS
  ram[GameSubmode] = 0x00;
  ram[IsUpdatingMode]++;
  return 0x00;
}
