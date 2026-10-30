// Mode 1: file selection menu (Z_02). Package P24.
//   InitMode1 (Z_07) -> InitMode1_Full: 7 submodes (validate files, palettes, slot lines, deaths)
//   UpdateMode1Menu: submode 0 = choose with Select/Start, submode 1 = load the chosen file.

import { ram, peek, poke, word } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  GameSubmode, IsUpdatingMode, GameMode, CurSaveSlot, IsSaveFileBCommitted, SaveFileOpenMarkers,
  SaveFileCloseMarkers, FileAChecksums, TileBufSelector, ForceSwordShot, RoomHistory, DynTileBuf,
  Names, SaveSlotHearts, DeathCounts, IsSaveSlotActive, CaveSourceRoomId, ButtonsPressed,
  Tune1Request, Tune1, Sprites, CurLevel, SelectedItemSlot, Items, SwordBlocked, ObjState, InvClock,
  LeftSpriteOffset, RightSpriteOffset, QuestNumbers,
} from '../../core/vars.js';
import { TurnOffAllVideo, TurnOffVideoAndClearArtifacts } from '../boot.js';
import { EndGameMode, GoToNextMode } from './dispatch.js';
import { Anim_SetSpriteDescriptorAttributes, Anim_WriteSpritePairNotFlashing } from '../draw/sprites.js';
import {
  FetchFileAAddressSet, FetchFileBAddressSet, CalculateFileAChecksum, CalculateFileBChecksum,
  CopyFileBToFileA, FormatFileA,
} from '../save/files.js';
// P11 (early port of these two routines) and P16 (early port of ResetRoomTileObjInfo)
import { FormatHeartsInTextBuf, FormatDecimalByte } from '../text/format.js';
import { ResetRoomTileObjInfo } from '../worldobj/tileobjects.js';
import { $br, $pxa } from '../../core/timing.js';

let initHandlers;
export function InitMode1_Full() {
  // InitMode1_Full (Z_02)
  TurnOffAllVideo();
  initHandlers ??= [UpdateMode0Demo_Sub1, InitMode1_Sub1, InitMode1_Sub2,
    InitMode1_FillAndTransferSlotTiles, InitMode1_FillAndTransferSlotTiles,
    InitMode1_FillAndTransferSlotTiles, InitMode1_Sub6];
  return tableJump(label('InitMode1_Full_JumpTable').addr, ram[GameSubmode], initHandlers);
}

/**
 * UpdateMode0Demo_Sub1 (Z_02): for each slot, commit a valid uncommitted file B to file A, and
 * format file A if its markers or checksum are wrong. Also mode 1 submode 0.
 */
export function UpdateMode0Demo_Sub1() {
  // UpdateMode0Demo_Sub1 (Z_02)
  TurnOffAllVideo();
  ram[CurSaveSlot] = 0x00;
  const sumsB = label('FileBChecksums').addr;
  for (;;) {
    let y = ram[CurSaveSlot];
    let committed = false;
    $pxa('Z_02:2266', IsSaveFileBCommitted, y);
    if (!$br('Z_02:2267', peek(IsSaveFileBCommitted + y) !== 0)) {
      FetchFileBAddressSet();
      CalculateFileBChecksum();
      y = (ram[CurSaveSlot] << 1) & 0xff;
      $pxa('Z_02:2273', sumsB, y);
      if (!$br('Z_02:2275', peek(sumsB + y) !== ram[0xce])) {
        $pxa('Z_02:2277', sumsB, y + 1);
        if (!$br('Z_02:2279', peek(sumsB + y + 1) !== ram[0xcf])) {
          CopyFileBToFileA();
          committed = true;
        }
      }
    }
    if (!committed) {
      // @CheckFileA
      FetchFileAAddressSet();
      CalculateFileAChecksum();
      y = ram[CurSaveSlot];
      let ok = false;
      $pxa('Z_02:2289', SaveFileOpenMarkers, y);
      if (!$br('Z_02:2291', peek(SaveFileOpenMarkers + y) !== 0x5a)) {
        $pxa('Z_02:2292', SaveFileCloseMarkers, y);
        if (!$br('Z_02:2294', peek(SaveFileCloseMarkers + y) !== 0xa5)) {
          y = (ram[CurSaveSlot] << 1) & 0xff;
          $pxa('Z_02:2298', FileAChecksums, y);
          if (!$br('Z_02:2300', peek(FileAChecksums + y) !== ram[0x0e])) {
            $pxa('Z_02:2302', FileAChecksums, y + 1);
            ok = $br('Z_02:2304', peek(FileAChecksums + y + 1) === ram[0x0f]);
          }
        }
      }
      if (!ok) {
        // @FormatA
        FetchFileAAddressSet();
        FormatFileA();
      }
    }
    ram[CurSaveSlot]++;
    if (!$br('Z_02:2314', ram[CurSaveSlot] !== 0x03)) break;
  }
  ram[GameSubmode]++;
}

/** InitMode1_Sub1 (Z_02): Link colors by ring for each slot, cue menu palettes, clear video. */
export function InitMode1_Sub1() {
  // InitMode1_Sub1 (Z_02)
  ram[CurSaveSlot] = 0x00;
  FetchFileAAddressSet();
  const colors = table(bus.rom, 'LinkColors');
  const pal = label('MenuPalettesTransferBuf').addr; // BANK_06_DATA, in SRAM
  let y = 0x0b; // the ring is at this offset in the Items block
  let x = 0x00;
  for (;;) {
    const ringOffset = y; // PHA
    $pxa('Z_02:2569', word(0x00), y);
    const ring = peek(word(0x00) + y);
    $pxa('Z_02:2571', colors.addr, ring);
    poke(pal + 20 + x, colors.byte(ring));
    y = (ringOffset + 0x28) & 0xff; // the ring of the next slot
    x = (x + 0x04) & 0xff; // next palette row
    if (!$br('Z_02:2585', x < 0x0c)) break;
  }
  ResetRoomTileObjInfo();
  ram[TileBufSelector] = 0x12; // cue transfer of menu palettes
  ram[GameSubmode]++;
  TurnOffVideoAndClearArtifacts();
  ram[ForceSwordShot] = 0x00;
  for (y = 0x04; ;) { ram[RoomHistory + y] = 0x00; y--; if (!$br('Z_02:2597', y >= 0)) break; }
  return 0x00;
}

/** InitMode1_Sub2 (Z_02): cue TileBufSelector $14. */
export function InitMode1_Sub2() {
  // InitMode1_Sub2 (Z_02)
  ram[TileBufSelector] = 0x14;
  ram[GameSubmode]++;
}

/** InitMode1_FillAndTransferSlotTiles (Z_02): name and hearts line of slot CurSaveSlot. */
export function InitMode1_FillAndTransferSlotTiles() {
  // InitMode1_FillAndTransferSlotTiles (Z_02)
  const tmpl = table(bus.rom, 'Mode1SlotLineTransferBuf');
  for (let i = 0x1f; ;) { $pxa('Z_02:2612', tmpl.addr, i); ram[DynTileBuf + i] = tmpl.byte(i); i--; if (!$br('Z_02:2615', i >= 0)) break; }
  let y = ram[CurSaveSlot];
  for (;;) {
    // Add $60 * (CurSaveSlot + 1) to the PPU address of each record; the high byte takes the
    // carry of the second addition only.
    ram[DynTileBuf + 1] = (ram[DynTileBuf + 1] + 0x60) & 0xff;
    const sum = ram[DynTileBuf + 21] + 0x60;
    ram[DynTileBuf + 21] = sum & 0xff;
    const a = (ram[DynTileBuf] + (sum > 0xff ? 1 : 0)) & 0xff;
    ram[DynTileBuf] = a;
    ram[DynTileBuf + 20] = a;
    y = (y - 1) & 0xff;
    if (!$br('Z_02:2632', !(y & 0x80))) break;
  }
  let x = (ram[CurSaveSlot] << 3) & 0xff;
  for (y = 0x03; ;) {
    $pxa('Z_02:2644', Names, x);
    ram[DynTileBuf + y] = ram[Names + x];
    x = (x + 1) & 0xff; y++;
    if (!$br('Z_02:2649', y !== 0x0b)) break;
  }
  y = (ram[CurSaveSlot] << 1) & 0xff;
  $pxa('Z_02:2656', SaveSlotHearts, y);
  ram[0x0e] = ram[SaveSlotHearts + y];
  $pxa('Z_02:2659', SaveSlotHearts, y + 1);
  ram[0x0f] = ram[SaveSlotHearts + y + 1];
  FormatHeartsInTextBuf(0x0c);
  ram[CurSaveSlot]++;
  ram[GameSubmode]++;
}

/** InitMode1_Sub6 (Z_02): death counts, then pick the first active slot and start updating. */
export function InitMode1_Sub6() {
  // InitMode1_Sub6 (Z_02)
  const tmpl = table(bus.rom, 'Mode1DeathCountsTransferBuf');
  for (let i = 0x12; ;) { $pxa('Z_02:2673', tmpl.addr, i); ram[DynTileBuf + i] = tmpl.byte(i); i--; if (!$br('Z_02:2676', i >= 0)) break; }
  ram[0x0a] = 0x00; // the save slot
  ram[0x0b] = 0x03; // offset of the string in the transfer record
  for (;;) {
    let y = ram[0x0a];
    $pxa('Z_02:2684', DeathCounts, y);
    FormatDecimalByte(ram[DeathCounts + y]);
    const x = ram[0x0b];
    ram[DynTileBuf + x] = ram[0x01];
    ram[DynTileBuf + 1 + x] = ram[0x02];
    let a = ram[0x03];
    if (!$br('Z_02:2692', a !== 0)) {
      if ($br('Z_02:2698', ram[0x01] !== 0x24) || $br('Z_02:2701', ram[0x02] !== 0x24)) a = 0x00; // @Emit0
      else {
        y = ram[0x0a];
        $pxa('Z_02:2703', IsSaveSlotActive, y);
        if ($br('Z_02:2704', ram[IsSaveSlotActive + y] !== 0)) a = 0x00;
        else { a = 0x24; $br('Z_02:2706', true); }
      }
    }
    ram[DynTileBuf + 2 + x] = a;
    ram[0x0b] = (x + 0x06) & 0xff;
    ram[0x0a]++;
    if (!$br('Z_02:2720', ram[0x0a] !== 0x03)) break;
  }
  let y = 0xff;
  ram[CurSaveSlot] = y;
  ram[CaveSourceRoomId] = y; // room $FF: mode 3 puts the player at StartRoomId
  for (;;) {
    y = (y + 1) & 0xff;
    ram[CurSaveSlot]++;
    $pxa('Z_02:2728', IsSaveSlotActive, y);
    if (!$br('Z_02:2729', ram[IsSaveSlotActive + y] === 0)) break;
  }
  ram[GameSubmode] = 0x00;
  ram[IsUpdatingMode]++;
}

let updateHandlers;
export function UpdateMode1Menu() {
  // UpdateMode1Menu (Z_02)
  updateHandlers ??= [UpdateMode1Menu_Sub0, UpdateMode1Menu_Sub1];
  return tableJump(label('UpdateMode1Menu_JumpTable').addr, ram[GameSubmode], updateHandlers);
}

/** UpdateMode1Menu_Sub0 (Z_02): Select cycles the active choices, Start confirms. */
export function UpdateMode1Menu_Sub0() {
  // UpdateMode1Menu_Sub0 (Z_02)
  if ($br('Z_02:2752', (ram[ButtonsPressed] & 0x10) !== 0)) {
    ram[GameSubmode]++; // @Exit
    return;
  }
  let change = !$br('Z_02:2755', (ram[ButtonsPressed] & 0x20) === 0);
  for (;;) {
    if (change) {
      // @ChangeSelection
      ram[Tune1Request] = 0x01;
      ram[CurSaveSlot]++;
      if (!$br('Z_02:2763', ram[CurSaveSlot] !== 0x05)) ram[CurSaveSlot] = 0x00;
    }
    // IsSaveSlotActive continues with IsRegister/IsEliminateSaveFileOptionEnabled.
    $pxa('Z_02:2773', IsSaveSlotActive, ram[CurSaveSlot]);
    if (!$br('Z_02:2774', ram[IsSaveSlotActive + ram[CurSaveSlot]] === 0)) break;
    change = true;
  }
  const trip = table(bus.rom, 'Mode1CursorSpriteTriplet');
  for (let y = 0x02; ;) { $pxa('Z_02:2778', trip.addr, y); ram[Sprites + 1 + y] = trip.byte(y); y--; if (!$br('Z_02:2781', y >= 0)) break; }
  const ys = table(bus.rom, 'Mode1CursorSpriteYs');
  $pxa('Z_02:2783', ys.addr, ram[CurSaveSlot]);
  ram[Sprites] = ys.byte(ram[CurSaveSlot]);
  ram[0x01] = 0x58; // base Y of Link sprites
  ram[0x00] = 0x30; // X of Link sprites
  return Mode1_WriteLinkSprites();
}

/** UpdateMode1Menu_Sub1 (Z_02): go to register/eliminate, or load the chosen file A. */
export function UpdateMode1Menu_Sub1() {
  // UpdateMode1Menu_Sub1 (Z_02)
  ram[Tune1] = 0x00;
  ram[CurLevel] = 0x00; // begin in OW
  ram[SelectedItemSlot] = 0x00;
  TurnOffAllVideo();
  if (!$br('Z_02:2804', ram[CurSaveSlot] < 0x03)) {
    ram[GameMode] = (ram[CurSaveSlot] + 0x0b) & 0xff; // $E register, $F eliminate
    return EndGameMode();
  }
  // @ChoseSlot
  TurnOffAllVideo();
  FetchFileAAddressSet();
  for (let y = 0x27; ;) {
    $pxa('Z_02:2818', word(0x00), y);
    ram[Items + y] = peek(word(0x00) + y);
    y--; if (!$br('Z_02:2821', y >= 0)) break;
  }
  ram[SwordBlocked] = 0x00;
  ram[ObjState] = 0x00;
  ram[InvClock] = 0x00;
  // Copy the WorldFlags block from file A to the profile: [$0E:0F] counts $067F..$07FE.
  for (;;) {
    $pxa('Z_02:2831', word(0x02), 0);
    poke(word(0x0e), peek(word(0x02)));
    ram[0x02]++;
    if (!$br('Z_02:2834', ram[0x02] !== 0)) ram[0x03]++;
    ram[0x0e]++;
    if (!$br('Z_02:2838', ram[0x0e] !== 0)) ram[0x0f]++;
    if ($br('Z_02:2843', ram[0x0e] !== 0xff)) continue;
    if (!$br('Z_02:2846', ram[0x0f] !== 0x07)) break;
  }
  return GoToNextMode();
}

/**
 * Mode1_WriteLinkSprites (Z_02): [$00] = X, [$01] = base Y. Draws a Link per slot (sprites 4-9)
 * with palettes 4-6, and a sword (sprites $20-$23) next to second-quest slots.
 */
export function Mode1_WriteLinkSprites() {
  // Mode1_WriteLinkSprites (Z_02)
  ram[0x02] = 0x08; // left tile of Link
  ram[0x03] = 0x0a; // right tile of Link
  Anim_SetSpriteDescriptorAttributes(0x00);
  ram[LeftSpriteOffset] = 0x08;
  for (;;) {
    ram[LeftSpriteOffset] = (ram[LeftSpriteOffset] + 0x08) & 0xff;
    ram[RightSpriteOffset] = (ram[LeftSpriteOffset] + 0x04) & 0xff;
    ram[0x07] = 0x01; // two sides
    ram[0x0a] = 0x08; // 8 pixels apart
    const savedX = ram[0x00]; // PHA
    Anim_WriteSpritePairNotFlashing();
    ram[0x00] = savedX; // PLA
    $pxa('Z_02:2887', QuestNumbers, ram[0x04]);
    if (!$br('Z_02:2888', ram[QuestNumbers + ram[0x04]] === 0)) {
      const y = ram[LeftSpriteOffset];
      ram[Sprites + 128 + y] = (ram[0x01] - 0x03) & 0xff; // sword 3 pixels above Link's Y
      ram[Sprites + 129 + y] = 0x20; // sword tile
      ram[Sprites + 130 + y] = 0x03; // palette 7
      ram[Sprites + 131 + y] = (ram[0x00] + 0x0c) & 0xff;
    }
    ram[0x01] = (ram[0x01] + 0x18) & 0xff;
    ram[0x04]++;
    ram[0x05]++;
    if (!$br('Z_02:2912', ram[0x04] !== 0x03)) break;
  }
}
