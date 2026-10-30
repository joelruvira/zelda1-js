// Mode $12: end of level, Link lifts the triforce piece (Z_05). Package P25.
// EndGameMode12 is also reached from CalculateNextRoomForDoor (P13) when Link leaves a level.
import { ram } from '../../core/ram.js';
import { write } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { label } from '../../core/rom.js';
import {
  GameMode, CurLevel, UndergroundExitType, Tune0Request, SongRequest, ObjX, ObjTimer, IsUpdatingMode,
  ItemTypeToLift, GameSubmode, TileBufSelector, World_IsFillingHearts, CurPpuControl_2000, PpuControl_2000,
} from '../../core/vars.js';
import { HideAllSprites } from '../boot.js';
import { EndGameMode } from './dispatch.js';
import { MaskCurPpuMaskGrayscale, UpdateHeartsAndRupees } from './mode5-play.js';
import { UpdateWorldCurtainEffect } from './mode3-unfurl.js';
import { FillTileMap } from '../world/tilemap.js';
import { HideObjectSprites } from '../draw/sprites.js';
import { SetUpAndDrawLinkLiftingItem, DrawLinkLiftingItem } from '../items/roomitem.js';
import { $br } from '../../core/timing.js';

/** InitMode12 (Z_05): end level song, blank tile map, Link lifts the triforce. */
export function InitMode12() {
  // InitMode12 (Z_05)
  ram[SongRequest] = 0x04; // "End Level" song
  ram[ObjX + 12] = 0x20; // decreasing column for UpdateWorldCurtainEffect
  ram[ObjX + 13] = 0x01; // increasing column
  ram[ObjTimer] = 0x30; // delay $2F frames when updating
  ram[0x0a] = 0x24; // fill the tile map with blanks
  FillTileMap();
  ram[IsUpdatingMode]++;
  HideObjectSprites();
  ram[ItemTypeToLift] = 0x1b; // triforce
  return SetUpAndDrawLinkLiftingItem();
}

let handlers;
export function UpdateMode12EndLevel_Full() {
  // UpdateMode12EndLevel_Full (Z_05)
  HideObjectSprites();
  DrawLinkLiftingItem();
  handlers ??= [UpdateMode12EndLevel_Sub0, UpdateMode12EndLevel_Sub1, UpdateMode12EndLevel_Sub2,
    UpdateMode12EndLevel_Sub3, UpdateMode12EndLevel_Sub4];
  return tableJump(label('UpdateMode12EndLevel_Full_JumpTable').addr, ram[GameSubmode], handlers);
}

/** UpdateMode12EndLevel_Sub0 (Z_05): wait, then flash for $2F frames. */
export function UpdateMode12EndLevel_Sub0() {
  // UpdateMode12EndLevel_Sub0 (Z_05)
  if ($br('Z_05:5562', ram[ObjTimer] !== 0)) return; // L16887_Exit
  ram[ObjTimer] = 0x30;
  $br('Z_05:5565', true); // BNE L1688C_IncSubmode
  ram[GameSubmode]++; // L1688C_IncSubmode
}

/** UpdateMode12EndLevel_Sub1 (Z_05): flash the screen; then StartFillingHearts. */
export function UpdateMode12EndLevel_Sub1() {
  // UpdateMode12EndLevel_Sub1 (Z_05)
  let y = 0x18; // LevelPaletteTransferBuf
  const a = ram[ObjTimer];
  if ($br('Z_05:5573', a === 0)) {
    // StartFillingHearts (UNKNOWN: why 2? any non-zero works)
    ram[World_IsFillingHearts] = 0x02;
    ram[GameSubmode]++; // L1688C_IncSubmode
    return;
  }
  if (!$br('Z_05:5576', (a & 0x07) < 0x04)) y = 0x78; // WhitePaletteBottomHalfTransferBuf
  ram[TileBufSelector] = y;
}

/** UpdateMode12EndLevel_Sub2 (Z_05): fill the hearts; when done, $7F frames delay. */
export function UpdateMode12EndLevel_Sub2() {
  // UpdateMode12EndLevel_Sub2 (Z_05)
  UpdateHeartsAndRupees();
  if (!$br('Z_05:5598', ram[World_IsFillingHearts] === 0)) return;
  return Mode12SetDelayIncSubmode();
}

/** UpdateMode12EndLevel_Sub3 (Z_05): close the curtain until the left column reaches the middle. */
export function UpdateMode12EndLevel_Sub3() {
  // UpdateMode12EndLevel_Sub3 (Z_05)
  if ($br('Z_05:5603', ram[ObjTimer] !== 0)) return;
  UpdateWorldCurtainEffect();
  if ($br('Z_05:5607', ram[ObjX + 12] >= 0x11)) return;
  return Mode12SetDelayIncSubmode();
}

// Anonymous label of UpdateMode12EndLevel_Sub3 (also the tail of Sub2): $7F frames delay, INC submode.
function Mode12SetDelayIncSubmode() {
  ram[ObjTimer] = 0x80;
  ram[GameSubmode]++;
}

/** UpdateMode12EndLevel_Sub4 (Z_05): back to the OW (EndGameMode12). */
export function UpdateMode12EndLevel_Sub4() {
  // UpdateMode12EndLevel_Sub4 (Z_05)
  if ($br('Z_05:5617', ram[ObjTimer] !== 0)) return;
  HideAllSprites();
  const a = ram[CurPpuControl_2000] & 0xfb; // VRAM address increment 1
  ram[CurPpuControl_2000] = a;
  write(PpuControl_2000, a);
  return EndGameMode12();
}

/** EndGameMode12 (Z_05): back to the OW through mode 2 (dungeon exit), then MaskCurPpuMaskGrayscale. */
export function EndGameMode12() {
  // EndGameMode12 (Z_05)
  const a = EndGameMode();
  ram[0xe7] = a; // UNKNOWN in the asm: mode 2 does not depend on [E7]
  ram[CurLevel] = a; // OW (level 0)
  ram[GameMode] = 0x02;
  ram[UndergroundExitType] = 0x02; // type 2: dungeon level
  ram[Tune0Request] = 0x80; // silence the song
  return MaskCurPpuMaskGrayscale(); // falls through
}
