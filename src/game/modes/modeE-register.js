// Modes $E (register your name) and $F (elimination): shared init and cursor handling, plus
// mode $E's update (Z_02). Package P24.
//   InitModeEandF (Z_07) -> InitModeEandF_Full: 5 submodes
//   UpdateModeERegister: name entry on the character board; Start over "End" writes files B.
// Cursors: the slot cursor is sprite 0, the name cursor is ObjX/ObjY[0] (sprite 1) and the
// char-board cursor is ObjX/ObjY[1] (sprite 2).

import { ram, poke, word } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import {
  CurSaveSlot, GameSubmode, GameMode, IsUpdatingMode, DynTileBuf, DynTileBufLen, Names,
  TileBufSelector, IsSaveSlotActive, Sprites, ButtonsPressed, ButtonsDown, Tune1, Tune0Request,
  Tune1Request, IsSaveFileBCommitted, CharBoardIndex, InitializedNameField, NameCharOffset,
  NameInputCharBuf, StillHoldingButton, SubsequentButtonRepeat, ButtonRepeatTimer, HeldButton,
  ModeE_WrappedAroundBoardY, ObjX, ObjY, FrameCounter,
} from '../../core/vars.js';
import { TurnOffAllVideo, TurnOffVideoAndClearArtifacts } from '../boot.js';
import { FetchFileBAddressSet, FormatFileB, CalculateAndStoreFileBChecksumUncommitted } from '../save/files.js';
import { Mode1_WriteLinkSprites } from './mode1-fileselect.js';
import { UpdateModeDSave_Sub2 } from './modeD-save.js';

// UpdateModeERegister names these bytes by address in the asm (they alias other mode-$E state).
const SaveSlotNameIndex = 0x0423; // [$0423]
const SaveFileNameIndex = 0x0425; // [$0425]
const FileBReadyToSave = 0x0426; // [$0426]

/** InitModeEandF_Full (Z_02): mode $E/$F init, one task per submode (0-4). */
export function InitModeEandF_Full() {
  // InitModeEandF_Full (Z_02)
  ram[CurSaveSlot] = 0x00;
  ModeE_ResetVariables(0x00);
  TurnOffAllVideo();
  const sub = ram[GameSubmode];
  if (sub === 0x00) {
    TurnOffVideoAndClearArtifacts();
    do {
      // @FormatSlotsB
      FetchFileBAddressSet();
      FormatFileB();
      ram[CurSaveSlot]++;
    } while (ram[CurSaveSlot] !== 0x03);
    ram[CurSaveSlot] = 0x00;
    const title = table(bus.rom, 'ModeFTitleTransferBuf');
    for (let x = 0x1c; x >= 0; x--) ram[DynTileBuf + x] = title.byte(x);
    if (ram[GameMode] === 0x0e) {
      // Overwrite "ELIMINATION MODE" with "REGISTER YOUR NAME".
      const patch = table(bus.rom, 'ModeFTitlePatchRegister');
      for (let y = 0x00; y !== 0x12; y++) ram[DynTileBuf + 7 + y] = patch.byte(y);
    }
    return setTransferBufLenAndIncSubmode(0x1d);
  }
  if (sub === 0x01) {
    const tmpl = table(bus.rom, 'ModeFSaveSlotTemplateTransferBuf');
    for (let x = 0x33; x >= 0; x--) ram[DynTileBuf + x] = tmpl.byte(x);
    let x = 0x00;
    let y = 0x00;
    do {
      // @OverwriteName: the names are all arranged one after another.
      ram[DynTileBuf + 3 + x] = ram[Names + y];
      x++;
      y++;
      if ((y & 0x07) === 0) x += 3; // skip the header of the next record
    } while (x !== 0x21);
    if (ram[GameMode] === 0x0e) {
      // Overwrite "ELIMINATION" with "REGISTER".
      const patch = table(bus.rom, 'ModeFSaveSlotTemplatePatchRegister');
      for (y = 0x00; y !== 0x0b; y++, x++) ram[DynTileBuf + 3 + x] = patch.byte(y);
    }
    return setTransferBufLenAndIncSubmode(0x34);
  }
  if (sub === 0x02) {
    return selectMenuBuf(0x16); // cue ModeFCharBoardTransferBuf
  }
  if (sub === 0x03) {
    // Cursor color: $15 in mode $E, $30 in mode $F (byte 1 of sprite palette row 3).
    const a = ram[GameMode] === 0x0f ? 0x30 : 0x15;
    poke(label('MenuPalettesTransferBuf').addr + 32, a);
    return selectMenuBuf(0x12);
  }
  // Submode 4
  if (ram[GameMode] !== 0x0f) {
    // Mode $E: look for the first inactive slot (CurSaveSlot = 3 if none).
    let x = 0x03;
    let y = 0xff;
    ram[CurSaveSlot] = y;
    do {
      y = (y + 1) & 0xff;
      ram[CurSaveSlot]++;
      if (ram[IsSaveSlotActive + y] === 0) break;
      x = (x - 1) & 0xff;
    } while (!(x & 0x80));
  }
  // @FoundInactiveSlot
  ModeEandF_SetUpCursorSprites();
  if (ram[CurSaveSlot] === 0x03) ram[Sprites + 8] = 0xf8; // "End": hide the char-board cursor
  ram[0x00] = 0x50; // X of Link objects
  ram[0x01] = 0x30; // base Y of Link objects
  ram[IsUpdatingMode]++;
  return Mode1_WriteLinkSprites();
}

function setTransferBufLenAndIncSubmode(a) {
  // InitModeEandF_Full@SetTransferBufLenAndIncSubmode
  ram[DynTileBufLen] = a;
  ram[GameSubmode]++;
}

function selectMenuBuf(a) {
  // InitModeEandF_Full@SelectMenuBuf
  ram[TileBufSelector] = a;
  ram[GameSubmode]++;
}

/** UpdateModeERegister (Z_02) */
export function UpdateModeERegister() {
  // UpdateModeERegister (Z_02)
  if (!(ram[ButtonsPressed] & 0x10) || ram[CurSaveSlot] !== 0x03) {
    // @Idle
    if (ram[CurSaveSlot] !== 0x03) ModeE_HandleDirections();
    UpdateModeEandF_Idle();
    ModeEandF_WriteNameCursorSpritePosition();
    ModeEandF_WriteCharBoardCursorSpritePosition();
    return ModeE_HandleAOrB();
  }
  // @ChoseEnd: Start over the "End" option.
  ram[Tune1] = 0x00; // silence tune channel 1
  ram[SaveFileNameIndex] = 0x00;
  ram[SaveSlotNameIndex] = 0x00;
  ram[CurSaveSlot] = 0x00;
  let x = 0x00; // the current slot number
  const sumsB = label('FileBChecksums').addr;
  const zelda = table(bus.rom, 'ZeldaString');
  do {
    // @LoopSaveSlot
    let y = ram[CurSaveSlot];
    poke(IsSaveFileBCommitted + y, 0xff); // mark file B committed
    y = (y << 1) & 0xff;
    ram[FileBReadyToSave] = 0x00;
    poke(sumsB + y, 0x00); // reset the checksum of file B
    y++;
    poke(sumsB + y, 0x00);
    const slot = x; // PHA
    FetchFileBAddressSet();
    x = slot; // PLA
    do {
      // @CopyName
      y = ram[SaveSlotNameIndex];
      const ch = ram[Names + y];
      y = ram[SaveFileNameIndex];
      poke(word(0xc4) + y, ch);
      if (ch !== 0x24 && ram[IsSaveSlotActive + x] === 0) {
        // The save slot is not active: 3 heart containers and 2 hearts, partial full, 8 bombs.
        poke(word(0xc0) + 0x18, 0x22);
        poke(word(0xc0) + 0x19, 0xff);
        poke(word(0xc0) + 0x25, 0x08);
        const saved = x; // PHA
        y = (x << 3) & 0xff; // offset of the name in save slot info
        let match = true;
        for (x = 0x00; x < 0x05; x++, y++) {
          if (ram[Names + y] !== zelda.byte(x)) { match = false; break; }
        }
        if (match) {
          x = saved; // PLA / PHA / TAX
          poke(word(0xcc), 0x01); // second quest in file B
        }
        x = saved; // @FlagBReady: PLA / TAX
        ram[FileBReadyToSave] = 0x01;
        poke(word(0xc6), 0x01); // IsSaveSlotActive in file B
      }
      // @NextChar
      ram[SaveSlotNameIndex]++;
      ram[SaveFileNameIndex]++;
    } while (ram[SaveFileNameIndex] !== 0x08);
    x = (x + 1) & 0xff;
    ram[SaveFileNameIndex] = 0x00;
    if (ram[FileBReadyToSave] !== 0) CalculateAndStoreFileBChecksumUncommitted();
    ram[CurSaveSlot]++;
  } while (ram[CurSaveSlot] !== 0x03);
  ram[FileBReadyToSave] = 0x00;
  ram[CurSaveSlot] = 0x00;
  ModeE_ResetVariables(0x00);
  ram[IsUpdatingMode] = 0x01; // make sure we stay updating
  return UpdateModeDSave_Sub2(); // go to mode 0 submode 1
}

/** ModeE_ResetVariables (Z_02): A (always 0) -> CharBoardIndex, InitializedNameField, NameCharOffset. */
export function ModeE_ResetVariables(a) {
  // ModeE_ResetVariables (Z_02)
  ram[CharBoardIndex] = a;
  ram[InitializedNameField] = a;
  ram[NameCharOffset] = a;
  return a;
}

/** ModeE_HandleDirections (Z_02) */
export function ModeE_HandleDirections() {
  // ModeE_HandleDirections (Z_02)
  const a = ram[ButtonsDown] & 0x0f;
  if (a !== 0) return ModeE_HandleDirectionButton(a);
  return ResetButtonRepeatState(a); // falls through
}

/** ResetButtonRepeatState (Z_02): A -> StillHoldingButton, SubsequentButtonRepeat, ButtonRepeatTimer. */
export function ResetButtonRepeatState(a) {
  // ResetButtonRepeatState (Z_02)
  ram[StillHoldingButton] = a;
  ram[SubsequentButtonRepeat] = a;
  ram[ButtonRepeatTimer] = a;
  return a;
}

/** ModeE_HandleDirectionButton (Z_02): A = direction buttons down. Moves the char-board cursor. */
export function ModeE_HandleDirectionButton(a) {
  // ModeE_HandleDirectionButton (Z_02)
  let y = a; // TAY
  if (ram[StillHoldingButton] === 0) {
    ram[HeldButton] = y;
    ram[StillHoldingButton]++;
  }
  // @CheckSameButton
  if ((ram[ButtonsDown] & 0x0f) !== ram[HeldButton]) ResetButtonRepeatState(0x00);
  // @CheckRepeat
  if (ram[ButtonRepeatTimer] !== 0) {
    ram[ButtonRepeatTimer]--;
    return;
  }
  // @ChooseRepeatDelay: $10 frames for the first repeat, then 8.
  y = ram[SubsequentButtonRepeat] !== 0 ? 0x08 : 0x10;
  ram[ButtonRepeatTimer] = y;
  a = ram[ButtonsDown] & 0x0f;
  if (a === 0x01) {
    // Right
    ram[CharBoardIndex]++;
    ram[ObjX + 1] = (ram[ObjX + 1] + 0x10) & 0xff;
    if (ram[ObjX + 1] === 0xe0) {
      ram[ObjX + 1] = 0x30;
      CycleCharBoardCursorY(0x00);
      if (ram[ModeE_WrappedAroundBoardY] !== 0) ram[CharBoardIndex] = 0x00;
    }
  } else if (a === 0x02) {
    // Left
    ram[CharBoardIndex]--;
    ram[ObjX + 1] = (ram[ObjX + 1] - 0x10) & 0xff;
    if (ram[ObjX + 1] === 0x20) {
      ram[ObjX + 1] = 0xd0;
      CycleCharBoardCursorY(0x03);
      if (ram[ModeE_WrappedAroundBoardY] !== 0) ram[CharBoardIndex] = 0x2b;
    }
  } else if (a === 0x04) {
    // Down: one row ($B characters) down
    ram[CharBoardIndex] = (ram[CharBoardIndex] + 0x0b) & 0xff;
    CycleCharBoardCursorY(0x00);
    if (ram[ModeE_WrappedAroundBoardY] !== 0) ram[CharBoardIndex] = (ram[CharBoardIndex] - 0x2c) & 0xff;
  } else if (a === 0x08) {
    // Up
    ram[CharBoardIndex] = (ram[CharBoardIndex] - 0x0b) & 0xff;
    CycleCharBoardCursorY(0x03);
    if (ram[ModeE_WrappedAroundBoardY] !== 0) ram[CharBoardIndex] = (ram[CharBoardIndex] + 0x2c) & 0xff;
  } else {
    return; // @Exit: no single direction
  }
  // @FinishInput
  ram[SubsequentButtonRepeat] = 0x01;
  ram[Tune1Request] = 0x01; // "selection changed"
}

/**
 * CycleCharBoardCursorY (Z_02): X = 0 (down) or 3 (up).
 * Sets ModeE_WrappedAroundBoardY = 1 if the cursor wrapped around, else 0.
 */
export function CycleCharBoardCursorY(x) {
  // CycleCharBoardCursorY (Z_02)
  const t = table(bus.rom, 'ModeE_CharBoardYOffsetsAndBounds');
  let y = 0x00;
  const a = (ram[ObjY + 1] + t.byte(x)) & 0xff;
  ram[ObjY + 1] = a;
  x++;
  if (a === t.byte(x)) {
    x++;
    ram[ObjY + 1] = t.byte(x);
    y++;
  }
  ram[ModeE_WrappedAroundBoardY] = y;
  return LA10A_Exit();
}

/** LA10A_Exit (Z_02): a shared RTS. */
export function LA10A_Exit() {
  // LA10A_Exit (Z_02)
}

/** ModeE_HandleAOrB (Z_02): A writes the highlighted character, A or B advance the name cursor. */
export function ModeE_HandleAOrB() {
  // ModeE_HandleAOrB (Z_02)
  if (ram[InitializedNameField] === 0) {
    let y = ram[CurSaveSlot];
    if (y === 0x03) return LA10A_Exit(); // "End" option
    ram[NameCharOffset] = table(bus.rom, 'SlotToNameOffset').byte(y);
    let x = table(bus.rom, 'SlotToInitialNameCharTransferHeaderEndOffsets').byte(y);
    const headers = table(bus.rom, 'SlotToInitialNameCharTransferHeaders');
    for (y = 0x02; y >= 0; y--, x--) ram[NameInputCharBuf + y] = headers.byte(x);
    ram[InitializedNameField]++;
  }
  // @CheckAB
  const a = ram[ButtonsPressed] & 0xc0;
  if (a !== 0) {
    if (a === 0x80) {
      // A: click tune, then write the character.
      ram[Tune0Request] = 0x20;
      for (let y = 0x02; y >= 0; y--) ram[DynTileBuf + y] = ram[NameInputCharBuf + y];
      ram[DynTileBuf + 4] = 0xff; // end marker (STY with Y = $FF)
      const x = ram[NameCharOffset];
      const ch = table(bus.rom, 'ModeE_CharMap').byte(ram[CharBoardIndex]);
      ram[DynTileBuf + 3] = ch;
      ram[Names + x] = ch;
    }
    // @MoveCursor
    ram[ObjX] = (ram[ObjX] + 0x08) & 0xff;
    ram[NameCharOffset]++;
    ram[NameInputCharBuf + 1]++;
    // Name fields start at VRAM addresses ending in $E; a 6 means past the end of the field.
    if ((ram[NameInputCharBuf + 1] & 0x0f) === 0x06) {
      ram[NameInputCharBuf + 1] = (ram[NameInputCharBuf + 1] - 0x08) & 0xff;
      ram[NameCharOffset] = table(bus.rom, 'SlotToNameOffset').byte(ram[CurSaveSlot]);
      if (ram[ObjX] === 0xb0) ram[ObjX] = 0x70;
    }
  }
  // @Exit
  return ModeE_SetNameCursorSpriteX();
}

/** ModeEandF_SetUpCursorSprites (Z_02) */
export function ModeEandF_SetUpCursorSprites() {
  // ModeEandF_SetUpCursorSprites (Z_02): almost 3 sprite records (all but sprite 0's Y).
  const spr = table(bus.rom, 'ModeEandFCursorSprites');
  for (let y = 0x0a; y >= 0; y--) ram[Sprites + 1 + y] = spr.byte(y);
  const a = table(bus.rom, 'ModeEandFSlotCursorYs').byte(ram[CurSaveSlot]);
  ram[ObjY] = a;
  ram[Sprites] = a;
  if (ram[GameMode] === 0x0f) return;
  ram[Sprites + 1] = 0xf3; // heart tile for the slot cursor
  ram[Sprites + 4] = (ram[ObjY] - 0x08) & 0xff; // the block cursor's visible part is the bottom
  ram[ObjX] = 0x70; // base name cursor X
  ram[ObjY + 1] = 0x87; // base char-board cursor Y
  ram[ObjX + 1] = 0x30; // base char-board cursor X
}

/** ModeEandF_WriteNameCursorSpritePosition (Z_02) */
export function ModeEandF_WriteNameCursorSpritePosition() {
  // ModeEandF_WriteNameCursorSpritePosition (Z_02)
  if (ram[ObjY] === 0x77) {
    ram[Sprites + 4] = 0xf8; // "End": hide the name cursor
    return;
  }
  ram[Sprites + 4] = ModifyFlashingCursorY(ram[ObjY]);
  return ModeE_SetNameCursorSpriteX(); // falls through
}

/** ModeE_SetNameCursorSpriteX (Z_02) */
export function ModeE_SetNameCursorSpriteX() {
  // ModeE_SetNameCursorSpriteX (Z_02)
  ram[Sprites + 7] = ram[ObjX];
  return ram[ObjX];
}

/** ModeEandF_WriteCharBoardCursorSpritePosition (Z_02) */
export function ModeEandF_WriteCharBoardCursorSpritePosition() {
  // ModeEandF_WriteCharBoardCursorSpritePosition (Z_02)
  if (ram[ObjY] === 0x77) {
    ram[Sprites + 8] = 0xf8;
    return;
  }
  ram[Sprites + 8] = ModifyFlashingCursorY(ram[ObjY + 1]);
  ram[Sprites + 11] = ram[ObjX + 1];
}

/** ModifyFlashingCursorY (Z_02): A = cursor Y. @returns Y = A - 8, or $F8 (hidden) 8 frames of 16. */
export function ModifyFlashingCursorY(a) {
  // ModifyFlashingCursorY (Z_02)
  let y = (a - 0x08) & 0xff;
  if (!(ram[FrameCounter] & 0x08)) y = 0xf8;
  return y;
}

/** UpdateModeEandF_Idle (Z_02): Select moves to the next slot (in mode $E, skipping active ones). */
export function UpdateModeEandF_Idle() {
  // UpdateModeEandF_Idle (Z_02)
  if (!(ram[ButtonsPressed] & 0x20)) return;
  const ys = table(bus.rom, 'ModeEandFSlotCursorYs');
  for (;;) {
    // @ChangeSelection
    ram[Tune1Request] = 0x01;
    ram[CurSaveSlot]++;
    let y = ram[CurSaveSlot];
    if (y === 0x04) {
      y = 0x00;
      ram[CurSaveSlot] = y;
    }
    ram[Sprites] = ys.byte(y);
    if (ram[GameMode] === 0x0f) return;
    let a = (ram[ObjY] + 0x18) & 0xff; // move the name cursor down $18 pixels
    ram[ObjY] = a;
    if (a === 0x8f) {
      a = 0x2f; // past "End": wrap around
      ram[ObjY] = a;
    }
    ram[Sprites] = a; // it seems that this should be Sprites+4
    ram[Sprites + 7] = 0x70;
    ram[ObjX] = 0x70;
    ram[InitializedNameField] = 0x00;
    ram[NameCharOffset] = 0x00;
    y = ram[CurSaveSlot];
    if (y === 0x03) return;
    if (ram[IsSaveSlotActive + y] === 0) return;
  }
}
