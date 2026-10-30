// Mode 3: first room of a level or of the OW, status bar, then the curtain that unfurls
// (Z_07 InitMode3/UpdateMode3Unfurl, Z_05 submodes, Z_01 curtain). Package P13.

import { ram, peek, poke } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { switchBank, tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  GameSubmode, CurLevel, CaveSourceRoomId, LevelInfo_StartRoomId, RoomId, CurSaveSlot,
  LevelInfo_PalettesTransferBuf, TileBufSelector, LevelInfo_LevelNumber, ObjX, ObjDir, ObjY,
  LevelInfo_StartY, UndergroundExitType, ObjTimer, CurColumn,
} from '../../core/vars.js';
import {
  TurnOffAllVideo, TurnOffVideoAndClearArtifacts, SetMMC1Control, SetMMC1Control_Local5,
  SwitchBank_Local5, SwitchBank_Local2,
} from '../boot.js';
import { BeginUpdateMode } from './dispatch.js';
import { ClearRoomHistory } from '../objects/killcounts.js';
import { HasMap } from '../hud/map.js';
import { LayOutRoom } from '../world/layout.js';
import { CopyColumnToTileBuf } from '../world/tilemap.js';
import { FillPlayAreaAttrs, CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0 } from './mode7-scroll.js';
import { GoToNextModePlayLevelSong, GoToNextModeResetGridOffset } from './mode4-6-enterleave.js';

// ------------------------------------------------------------------ init (9 submodes)

let initHandlers;
export function InitMode3() {
  // InitMode3 (Z_07)
  switchBank(5);
  TurnOffAllVideo();
  initHandlers ??= [InitMode3_Sub0, InitMode3_Sub1, InitMode3_Sub2, InitMode3_Sub3_TransferTopHalfAttrs,
    InitMode3_Sub4_TransferBottomHalfAttrs, InitMode3_Sub5, InitMode3_Sub6, InitMode3_Sub7, InitMode3_Sub8];
  return tableJump(label('InitMode3_JumpTable').addr, ram[GameSubmode], initHandlers);
}

export function InitMode3_Sub0() {
  // InitMode3_Sub0 (Z_07): falls into ClearRoomHistory (P05)
  ram[0x17] = 0x01; // TODO in the asm: [17] ?
  ram[GameSubmode]++;
  TurnOffVideoAndClearArtifacts();
  return ClearRoomHistory();
}

export function InitMode3_Sub1() {
  // InitMode3_Sub1 (Z_07)
  let a;
  if (!$br('Z_07:1444', ram[CurLevel] !== 0) && $br('Z_07:1447', ram[CaveSourceRoomId] !== 0xff)) {
    a = ram[CaveSourceRoomId]; // @SetRoomId: start where the cave was entered
  } else {
    a = peek(LevelInfo_StartRoomId); // @UseStartRoomId
  }
  ram[RoomId] = a;
  if (!$br('Z_07:1455', a !== ram[CaveSourceRoomId])) ram[CaveSourceRoomId] = 0xff; // keep it invalid by default
  return PatchAndCueLevelPalettesTransferAndAdvanceSubmode();
}

/** PatchAndCueLevelPalettesTransferAndAdvanceSubmode (Z_07): Link's color of the save slot, level palettes. */
export function PatchAndCueLevelPalettesTransferAndAdvanceSubmode() {
  // PatchAndCueLevelPalettesTransferAndAdvanceSubmode (Z_07)
  const x = ram[CurSaveSlot];
  $pxa('Z_07:1461', table(bus.rom, 'SaveSlotToPaletteRowOffset').addr, x);
  const y = table(bus.rom, 'SaveSlotToPaletteRowOffset').byte(x);
  // MenuPalettesTransferBuf is BANK_06_DATA, read in WRAM like the original.
  $pxa('Z_07:1466', label('MenuPalettesTransferBuf').addr + 20, y);
  const a = peek(label('MenuPalettesTransferBuf').addr + 20 + y);
  poke(LevelInfo_PalettesTransferBuf + 20, a);
  ram[TileBufSelector] = 0x18; // cue transfer of level palettes
  ram[GameSubmode]++;
}

export function InitMode3_Sub2() {
  // InitMode3_Sub2 (Z_05)
  FillPlayAreaAttrs(ram[RoomId]);
  $br('Z_05:6369', true);
  return SelectTransferBuf(0x18); // BNE always taken
}

export function InitMode3_Sub3_TransferTopHalfAttrs() {
  // InitMode3_Sub3_TransferTopHalfAttrs (Z_05)
  return CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0(0xd0, 0x17);
}

export function InitMode3_Sub4_TransferBottomHalfAttrs() {
  // InitMode3_Sub4_TransferBottomHalfAttrs (Z_05): BNE always taken back to the JMP above
  $br('Z_05:6380', true);
  return CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0(0xe8, 0x2f);
}

export function InitMode3_Sub5() {
  // InitMode3_Sub5 (Z_05): cue transfer of static elements of the status bar
  return SelectTransferBuf(0x0e);
}

/** SelectTransferBuf (Z_05, label in InitMode3_Sub5): TileBufSelector = A; L1701A_Exit: INC GameSubmode. */
function SelectTransferBuf(a) {
  ram[TileBufSelector] = a;
  return L1701A_Exit();
}

function L1701A_Exit() {
  ram[GameSubmode]++;
}

export function InitMode3_Sub6() {
  // InitMode3_Sub6 (Z_05)
  if (!$br('Z_05:6394', ram[CurLevel] === 0)) {
    if ($br('Z_05:6396', HasMap() === 0)) return L1701A_Exit(); // no map: next submode
  }
  $br('Z_05:6399', true);
  return SelectTransferBuf(0x44); // map in the status bar
}

export function InitMode3_Sub7() {
  // InitMode3_Sub7 (Z_05)
  const a = peek(LevelInfo_LevelNumber);
  if ($br('Z_05:6403', a === 0)) return L1701A_Exit(); // OW
  poke(label('LevelNumberTransferBuf').addr + 9, a); // patch "LEVEL-X"
  $br('Z_05:6406', true);
  return SelectTransferBuf(0x0c);
}

export function InitMode3_Sub8() {
  // InitMode3_Sub8 (Z_05)
  LayOutRoom();
  // Column numbers for the curtain effect.
  ram[ObjX + 12] = 0x10;
  ram[ObjX + 13] = 0x11;
  ram[0x17] = 0x00; // TODO in the asm: ?
  ram[ObjDir] = 0x08; // Link faces up
  ram[ObjX] = 0x78;
  ram[ObjY] = peek(LevelInfo_StartY);
  return BeginUpdateMode();
}

// ------------------------------------------------------------------ update

export function UpdateMode3Unfurl() {
  // UpdateMode3Unfurl (Z_07)
  UpdateWorldCurtainEffect();
  if ($br('Z_07:1737', ram[ObjX + 12] !== 0)) return; // L1EBF8_Exit: left column hasn't reached the left edge
  SetMMC1Control(0x0f); // horizontal mirroring
  if (!$br('Z_07:1741', ram[UndergroundExitType] === 0)) return GoToNextModeResetGridOffset();
  return GoToNextModePlayLevelSong();
}

export function UpdateWorldCurtainEffect_Bank2() {
  // UpdateWorldCurtainEffect_Bank2 (Z_01)
  UpdateWorldCurtainEffect();
  return SwitchBank_Local2(0x02);
}

/**
 * UpdateWorldCurtainEffect (Z_01). ObjX[$C] / ObjX[$D] = column indexes (+1) that decrease / increase.
 * Every 5 frames copies both columns to DynTileBuf. Switches to bank 5.
 */
export function UpdateWorldCurtainEffect() {
  // UpdateWorldCurtainEffect (Z_01)
  if ($br('Z_01:4210', ram[ObjTimer] !== 0)) return; // delay until ObjTimer[0] expires
  ram[0x0a] = 0x01;
  do {
    // @LoopColumn
    const x = ram[0x0a];
    ram[CurColumn] = ram[ObjX + 12 + x];
    SwitchBank_Local5(0x05);
    SetMMC1Control_Local5(0x0e); // vertical mirroring
    CopyColumnToTileBuf();
    ram[0x0a]--;
  } while ($br('Z_01:4224', !(ram[0x0a] & 0x80)));
  ram[CurColumn] = 0xff;
  ram[ObjTimer] = 0x05;
  ram[ObjX + 12]--;
  ram[ObjX + 13]++;
}
