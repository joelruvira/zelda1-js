// Modes $A, $B, $C: leave a cave or cellar, enter an OW cave, enter a shortcut cave
// (Z_05 InitModeA/B/C and the shared subroom submodes; Z_01 InitModeB_EnterCave_Bank5). Package P13.
// Their update is UpdateMode5Play.

import { ram } from '../../core/ram.js';
import { tableJump } from '../../core/asm.js';
import { label } from '../../core/rom.js';
import {
  GameSubmode, GameMode, CurRow, CurOpenedDoors, CurLevel, TileBufSelector, RoomId, IsSprite0CheckActive,
  ObjGridOffset, ObjDir, ObjInputDir, ObjX, ObjY, IsUpdatingMode, UndergroundExitType,
} from '../../core/vars.js';
import {
  LayoutCaveAndAvanceSubmode, LayoutShortcutAndAdvanceSubmode, LayoutRoom_SubmodeTask,
} from '../world/layout.js';
import { CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone } from '../world/tilemap.js';
import { MoveObject } from '../movement/walker.js';
import { Link_EndMoveAndAnimate } from '../link/anim.js';
import { DrawSpritesBetweenRooms, InitMode_EnterRoom, ResetInvObjState } from './mode4-6-enterleave.js';
import { WriteAndEnableSprite0, FillPlayAreaAttrs } from './mode7-scroll.js';
import {
  PatchAndCueLevelPalettesTransferAndAdvanceSubmode, InitMode3_Sub3_TransferTopHalfAttrs,
  InitMode3_Sub4_TransferBottomHalfAttrs,
} from './mode3-unfurl.js';
import { StartFadeCycleAndAnimate } from './mode9-cellar.js';
import { UpdateMode11Death_Sub8_AnimateFade } from './mode11-death.js';
import { Link_EndMoveAndAnimateInRoom } from './mode5-play.js';
import {
  RunCrossRoomTasksAndBeginUpdateMode, RunCrossRoomTasksAndBeginUpdateMode_PlayModesNoCellar,
} from './crossroom.js';

// ------------------------------------------------------------------ dispatchers

let handlersA, handlersB, handlersC;
export function InitModeA() {
  // InitModeA (Z_05): out of a cave or cellar
  handlersA ??= [InitModeSubroom_Sub0, InitModeA_Sub1, InitModeA_Sub2, InitModeSubroom_AnimateFade,
    LayoutRoom_SubmodeTask, CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone,
    InitModeA_Sub6_FillTileAttrsAndTransferTopHalf, InitModeAOrB_TransferBottomHalfAttrs, InitModeA_Sub8,
    InitModeSubroom_AnimateFade, InitModeA_SubA_GoToMode4];
  return tableJump(label('InitModeA_JumpTable').addr, ram[GameSubmode], handlersA);
}

export function InitModeB() {
  // InitModeB (Z_05): into an OW cave
  handlersB ??= [InitModeSubroom_Sub0, InitModeB_Sub1, InitModeSubroom_AdvanceSubmode,
    LayoutCaveAndAvanceSubmode, CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone,
    InitModeB_Sub5_FillTileAttrsAndTransferTopHalf, InitModeAOrB_TransferBottomHalfAttrs,
    InitModeB_EnterCave_Bank5, InitMode_WalkCave];
  return tableJump(label('InitModeB_JumpTable').addr, ram[GameSubmode], handlersB);
}

export function InitModeC() {
  // InitModeC (Z_05): into a shortcut cave
  handlersC ??= [InitModeSubroom_Sub0, InitModeB_Sub1, InitModeSubroom_AdvanceSubmode,
    LayoutShortcutAndAdvanceSubmode, CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone,
    InitModeB_Sub5_FillTileAttrsAndTransferTopHalf, InitModeAOrB_TransferBottomHalfAttrs,
    InitModeB_EnterCave_Bank5, InitMode_WalkCave];
  return tableJump(label('InitModeC_JumpTable').addr, ram[GameSubmode], handlersC);
}

// ------------------------------------------------------------------ shared subroom submodes

export function InitModeSubroom_Sub0() {
  // InitModeSubroom_Sub0 (Z_05)
  ram[CurRow] = 0x00;
  ram[CurOpenedDoors] = 0x00;
  if (ram[CurLevel] !== 0) return DrawSpritesBetweenRoomsAndAdvanceSubmode();
  DrawSpritesBetweenRoomsAndAdvanceSubmode();
  return WriteAndEnableSprite0();
}

export function DrawSpritesBetweenRoomsAndAdvanceSubmode() {
  // DrawSpritesBetweenRoomsAndAdvanceSubmode (Z_05)
  ram[GameSubmode]++;
  return DrawSpritesBetweenRooms();
}

/** L1712E_SelectTransferBufAndAdvanceSubmode (Z_05). A = TileBufSelector. */
export function L1712E_SelectTransferBufAndAdvanceSubmode(a) {
  // L1712E_SelectTransferBufAndAdvanceSubmode (Z_05)
  ram[TileBufSelector] = a;
  return InitModeSubroom_AdvanceSubmode(); // falls through
}

export function InitModeSubroom_AdvanceSubmode() {
  // InitModeSubroom_AdvanceSubmode (Z_05)
  ram[GameSubmode]++;
}

export function InitModeSubroom_AnimateFade() {
  // InitModeSubroom_AnimateFade (Z_05)
  if (ram[CurLevel] === 0) return InitModeSubroom_AdvanceSubmode();
  return UpdateMode11Death_Sub8_AnimateFade();
}

export function InitModeA_Sub2() {
  // InitModeA_Sub2 (Z_05): light cellar -> dark cellar cycle
  return StartFadeCycleAndAnimate(0x20);
}

export function InitModeA_Sub8() {
  // InitModeA_Sub8 (Z_05): dark cellar -> light level cycle
  return StartFadeCycleAndAnimate(0x80);
}

export function InitModeB_Sub1() {
  // InitModeB_Sub1 (Z_05): transfer the cave BG palette rows
  return L1712E_SelectTransferBufAndAdvanceSubmode(0x3e);
}

export function InitModeA_Sub1() {
  // InitModeA_Sub1 (Z_05)
  if (ram[CurLevel] !== 0) return InitModeSubroom_AdvanceSubmode();
  // Transfer the OW palette again: it was changed for a cave.
  return PatchAndCueLevelPalettesTransferAndAdvanceSubmode();
}

export function InitModeA_SubA_GoToMode4() {
  // InitModeA_SubA_GoToMode4 (Z_05)
  ResetInvObjState();
  ram[GameSubmode] = 0x00;
  ram[GameMode] = 0x04;
}

export function InitModeA_Sub6_FillTileAttrsAndTransferTopHalf() {
  // InitModeA_Sub6_FillTileAttrsAndTransferTopHalf (Z_05)
  FillPlayAreaAttrs(ram[RoomId]);
  return InitMode3_Sub3_TransferTopHalfAttrs();
}

export function InitModeB_Sub5_FillTileAttrsAndTransferTopHalf() {
  // InitModeB_Sub5_FillTileAttrsAndTransferTopHalf (Z_05): $44 = an OW room with a cave's NT attributes
  FillPlayAreaAttrs(0x44);
  return InitMode3_Sub3_TransferTopHalfAttrs();
}

export function InitModeAOrB_TransferBottomHalfAttrs() {
  // InitModeAOrB_TransferBottomHalfAttrs (Z_05)
  InitMode3_Sub4_TransferBottomHalfAttrs();
  // (The asm's unverified `INC GameSubmode` after the JMP is unreachable.)
  // @DisableSprite0Check
  ram[IsSprite0CheckActive] = 0x00;
}

export function InitMode_WalkCave() {
  // InitMode_WalkCave (Z_05)
  if (ram[ObjGridOffset] === 0) return RunCrossRoomTasksAndBeginUpdateMode(); // end of the walk
  // Move and draw facing up.
  const d = ram[ObjDir];
  ram[ObjInputDir] = d;
  ram[0x0f] = d;
  MoveObject(0x00);
  return Link_EndMoveAndAnimateInRoom();
}

/** InitModeB_EnterCave_Bank5 (Z_01): enter the room, put Link at the cave entrance ($70, $DD) facing up. */
export function InitModeB_EnterCave_Bank5() {
  // InitModeB_EnterCave_Bank5 (Z_01); FileBChecksums is a label inside it
  const submode = ram[GameSubmode]; // PHA
  InitMode_EnterRoom();
  ResetInvObjState();
  ram[ObjX] = 0x70;
  ram[ObjY] = 0xdd;
  ram[ObjDir] = 0x08;
  Link_EndMoveAndAnimate();
  RunCrossRoomTasksAndBeginUpdateMode_PlayModesNoCellar();
  ram[GameSubmode] = submode; // PLA
  ram[IsUpdatingMode] = 0x00; // still initializing (a routine above changed it)
  ram[GameSubmode]++;
  ram[ObjGridOffset] = 0x30; // walk this number of pixels automatically
  ram[UndergroundExitType] = 0x01; // needed when coming out of the cave
}
