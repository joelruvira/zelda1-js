// Mode 9: go down into an UW cellar (Z_05 InitMode9 and its submodes). Package P13.
// The update is UpdateMode5Play (the scene keeps "playing" while the init works).

import { ram, peek } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  GameSubmode, RoomId, CellarSourceRoomId, LevelBlockAttrsA, ObjX, ObjY, ObjDir, ObjGridOffset,
  IsUpdatingMode, DoorwayDir, ObjInputDir, ObjState, UndergroundExitType, CurLevel,
} from '../../core/vars.js';
import { LayoutCellarAndAdvanceSubmode } from '../world/layout.js';
import { CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone } from '../world/tilemap.js';
import { InitMode_EnterRoom, ResetInvObjState, SetFadeCycleAndAdvanceSubmode } from './mode4-6-enterleave.js';
import {
  InitModeSubroom_Sub0, InitModeSubroom_AnimateFade, InitModeSubroom_AdvanceSubmode,
  L1712E_SelectTransferBufAndAdvanceSubmode,
} from './modeA-B-C-cave.js';
import { UpdatePlayer } from './mode5-play.js';

let handlers;
export function InitMode9() {
  // InitMode9 (Z_05)
  handlers ??= [InitModeSubroom_Sub0, InitMode9_FadeToDark, InitModeSubroom_AnimateFade,
    LayoutCellarAndAdvanceSubmode, CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone,
    InitMode9_TransferAttrs, InitMode9_FadeToLight, InitModeSubroom_AnimateFade,
    InitMode9_EnterCellar, InitMode9_WalkCellar];
  return tableJump(label('InitMode9_JumpTable').addr, ram[GameSubmode], handlers);
}

export function InitMode9_TransferAttrs() {
  // InitMode9_TransferAttrs (Z_05): cellar NT attributes
  return L1712E_SelectTransferBufAndAdvanceSubmode(0x26);
}

/**
 * The ':' label of InitMode9_FadeToDark (Z_05), also reached by InitMode9_FadeToLight, InitModeA_Sub2
 * and InitModeA_Sub8: in the OW only advance the submode; otherwise start fade cycle A and fall into
 * InitModeSubroom_AnimateFade.
 */
export function StartFadeCycleAndAnimate(a) {
  if ($br('Z_05:6624', ram[CurLevel] === 0)) return InitModeSubroom_AdvanceSubmode();
  SetFadeCycleAndAdvanceSubmode(a);
  return InitModeSubroom_AnimateFade(); // falls through
}

export function InitMode9_FadeToDark() {
  // InitMode9_FadeToDark (Z_05): light level -> dark cellar cycle
  return StartFadeCycleAndAnimate(0x00);
}

export function InitMode9_FadeToLight() {
  // InitMode9_FadeToLight (Z_05): dark cellar -> light cellar cycle (BNE always taken)
  $br('Z_05:6634', true);
  return StartFadeCycleAndAnimate(0xa0);
}

export function InitMode9_EnterCellar() {
  // InitMode9_EnterCellar (Z_05)
  const submode = ram[GameSubmode]; // PHA
  InitMode_EnterRoom();
  ResetInvObjState();
  ram[GameSubmode] = submode; // PLA
  // Came from the cellar's room A: ladder on the left (index 0), else on the right.
  let x = 0;
  $pxa('Z_05:6722', LevelBlockAttrsA, ram[RoomId]);
  if (!$br('Z_05:6723', ram[CellarSourceRoomId] === peek(LevelBlockAttrsA + ram[RoomId]))) x = 1;
  $pxa('Z_05:6726', table(bus.rom, 'CellarLadderXs').addr, x);
  ram[ObjX] = table(bus.rom, 'CellarLadderXs').byte(x);
  ram[ObjY] = 0x41; // facing down at Y = $41
  ram[ObjDir] = 0x04;
  ram[ObjGridOffset] = 0xe4; // ($5D - $41) = $1C = ($100 - $E4)
  ram[IsUpdatingMode] = 0x00;
  ram[DoorwayDir] = 0x00;
  ram[GameSubmode]++;
}

export function InitMode9_WalkCellar() {
  // InitMode9_WalkCellar (Z_05): walk down the cellar stairs until Y = $5D
  ram[ObjInputDir] = ram[ObjDir];
  UpdatePlayer();
  if ($br('Z_05:6754', ram[ObjY] !== 0x5d)) return;
  ram[ObjState] = 0x00; // reset player state
  ram[UndergroundExitType] = 0x01; // remember that this is a cellar
  ram[IsUpdatingMode] = 0x01; // start updating the mode
}
