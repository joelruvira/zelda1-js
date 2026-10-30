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
import { $br, $pxa } from '../../core/timing.js';

/** InitMode8 (Z_05): submode 0 = palettes + reset room history; then cue the mode 8 text. */
export function InitMode8() {
  // InitMode8 (Z_05)
  TurnOffAllVideo();
  const a = ram[GameSubmode];
  if (!$br('Z_05:1372', a !== 0)) {
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
  if ($br('Z_05:2205', (ram[GameSubmode] & 0x80) !== 0)) return Mode8AnimateSelection();
  if ($br('Z_05:2208', (ram[ButtonsPressed] & 0x10) !== 0)) {
    // @ActivateOption
    ram[GameSubmode] |= 0x80;
    ram[ObjTimer + 1] = 0x40;
    return;
  }
  if (!$br('Z_05:2211', (ram[ButtonsPressed] & 0x20) === 0)) {
    ram[Tune0Request] = 0x01; // short sound for Select
    ram[GameSubmode]++;
    if (!$br('Z_05:2220', ram[GameSubmode] !== 0x03)) ram[GameSubmode] = 0x00;
  }
  // @DrawCursor
  const base = table(bus.rom, 'Mode8BaseSpriteValues');
  for (let y = 2; ;) { $pxa('Z_05:2227', base.addr, y); ram[Sprites + 1 + y] = base.byte(y); y--; if (!$br('Z_05:2230', y >= 0)) break; }
  const ys = table(bus.rom, 'Mode8SpriteYs');
  $pxa('Z_05:2234', ys.addr, ram[GameSubmode]);
  ram[Sprites] = ys.byte(ram[GameSubmode]);
}

// @AnimateSelection and @HandleActivated of UpdateMode8ContinueQuestion_Full.
function Mode8AnimateSelection() {
  if ($br('Z_05:2248', ram[ObjTimer + 1] === 0)) {
    // @HandleActivated
    ram[GameSubmode] &= 0x03;
    ResetPlayerState();
    let y = ram[GameSubmode];
    const modes = table(bus.rom, 'Mode8SelectionToMode');
    $pxa('Z_05:2290', modes.addr, y);
    ram[GameMode] = modes.byte(y); // 3 continue, $D save, 0 retry
    ram[HeartValues] = (ram[HeartValues] & 0xf0) | 0x02; // 3 full hearts
    ram[HeartPartial] = 0xff;
    EndGameMode();
    if (!$br('Z_05:2300', y !== 0x02)) {
      y--;
      ram[GameSubmode] = y; // retry: next mode starts in submode 1, updating
      ram[IsUpdatingMode]++;
    }
    return SilenceAllSound();
  }
  const rec = table(bus.rom, 'Mode8FlashTransferRecord');
  for (let y = 4; ;) { $pxa('Z_05:2254', rec.addr, y); ram[DynTileBuf + y] = rec.byte(y); y--; if (!$br('Z_05:2257', y >= 0)) break; }
  const lo = table(bus.rom, 'Mode8FlashAttrsAddrLo');
  $pxa('Z_05:2265', lo.addr, ram[GameSubmode] & 0x03);
  ram[DynTileBuf + 1] = lo.byte(ram[GameSubmode] & 0x03);
  ram[DynTileBuf + 3] = !$br('Z_05:2273', (ram[ObjTimer + 1] & 0x04) === 0) ? 0x55 : 0x00; // every 4 frames, another palette
}
