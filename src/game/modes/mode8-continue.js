// Mode 8: CONTINUE / SAVE / RETRY question after Link's death (Z_05). Package P25.
// The text and attributes come from Mode8TextTileBuffer (bank 6, TileBufSelector $04).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  GameSubmode, GameMode, UndergroundExitType, TileBufSelector, ButtonsPressed, Tune0Request, Sprites,
  ObjTimer, DynTileBuf, HeartValues, HeartPartial, IsUpdatingMode,
} from '../../core/vars.js';
import { TurnOffAllVideo, TurnOffVideoAndClearArtifacts } from '../boot.js';
import { BeginUpdateMode, EndGameMode } from './dispatch.js';
import { PatchAndCueLevelPalettesTransferAndAdvanceSubmode } from './mode3-unfurl.js';
import { ClearRoomHistory } from '../objects/killcounts.js';
import { ResetPlayerState } from './mode4-6-enterleave.js';
import { SilenceAllSound } from '../audio/requests.js';

/** InitMode8 (Z_05): submode 0 = palettes + reset room history; then cue the mode 8 text. */
export function InitMode8() {
  // InitMode8 (Z_05)
  TurnOffAllVideo();
  const a = ram[GameSubmode];
  if (a === 0) {
    ram[UndergroundExitType] = a; // reset
    TurnOffVideoAndClearArtifacts();
    PatchAndCueLevelPalettesTransferAndAdvanceSubmode();
    return ClearRoomHistory();
  }
  ram[TileBufSelector] = 0x04; // transfer of text and attributes for mode 8
  return BeginUpdateMode();
}

/**
 * UpdateMode8ContinueQuestion_Full (Z_05). GameSubmode = selection (0..2); bit 7 = Start pressed
 * (the selection flashes for $40 frames of ObjTimer[1], then the next mode starts).
 */
export function UpdateMode8ContinueQuestion_Full() {
  // UpdateMode8ContinueQuestion_Full (Z_05)
  if (ram[GameSubmode] & 0x80) return Mode8AnimateSelection();
  if (ram[ButtonsPressed] & 0x10) {
    // @ActivateOption
    ram[GameSubmode] |= 0x80;
    ram[ObjTimer + 1] = 0x40;
    return;
  }
  if (ram[ButtonsPressed] & 0x20) {
    ram[Tune0Request] = 0x01; // short sound for Select
    ram[GameSubmode]++;
    if (ram[GameSubmode] === 0x03) ram[GameSubmode] = 0x00;
  }
  // @DrawCursor
  const base = table(bus.rom, 'Mode8BaseSpriteValues');
  for (let y = 2; y >= 0; y--) ram[Sprites + 1 + y] = base.byte(y);
  ram[Sprites] = table(bus.rom, 'Mode8SpriteYs').byte(ram[GameSubmode]);
}

// @AnimateSelection and @HandleActivated of UpdateMode8ContinueQuestion_Full.
function Mode8AnimateSelection() {
  if (ram[ObjTimer + 1] === 0) {
    // @HandleActivated
    ram[GameSubmode] &= 0x03;
    ResetPlayerState();
    let y = ram[GameSubmode];
    ram[GameMode] = table(bus.rom, 'Mode8SelectionToMode').byte(y); // 3 continue, $D save, 0 retry
    ram[HeartValues] = (ram[HeartValues] & 0xf0) | 0x02; // 3 full hearts
    ram[HeartPartial] = 0xff;
    EndGameMode();
    if (y === 0x02) {
      y--;
      ram[GameSubmode] = y; // retry: next mode starts in submode 1, updating
      ram[IsUpdatingMode]++;
    }
    return SilenceAllSound();
  }
  const rec = table(bus.rom, 'Mode8FlashTransferRecord');
  for (let y = 4; y >= 0; y--) ram[DynTileBuf + y] = rec.byte(y);
  ram[DynTileBuf + 1] = table(bus.rom, 'Mode8FlashAttrsAddrLo').byte(ram[GameSubmode] & 0x03);
  ram[DynTileBuf + 3] = (ram[ObjTimer + 1] & 0x04) ? 0x55 : 0x00; // every 4 frames, another palette
}
