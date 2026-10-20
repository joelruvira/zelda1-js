// Mode $F: elimination (delete a save slot) (Z_02). Package P24.
// Shares its init and cursor handling with mode $E (modeE-register.js).

import { ram, poke, word } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ButtonsPressed, CurSaveSlot, GameMode, IsUpdatingMode, GameSubmode, SampleRequest, DynTileBuf,
} from '../../core/vars.js';
import { UpdateModeEandF_Idle, ModeE_ResetVariables } from './modeE-register.js';
import { FetchFileAAddressSet, FormatFileA, FetchProfileNameAddress } from '../save/files.js';

/** UpdateModeFElimination (Z_02): Start deletes the chosen slot, or over "End" goes to mode $E. */
export function UpdateModeFElimination() {
  // UpdateModeFElimination (Z_02)
  if (ram[ButtonsPressed] !== 0x10) return UpdateModeEandF_Idle();
  if (ram[CurSaveSlot] !== 0x03) return DeleteSlot();
  // "End" was chosen: go to mode $E (register).
  ram[GameMode] = 0x0e;
  ram[IsUpdatingMode] = 0x00;
  ram[GameSubmode] = 0x00;
  return ModeE_ResetVariables(0x00); // falls through with A = 0
}

/** DeleteSlot (Z_02): blank the slot's name on screen, format its file A, clear its name. */
export function DeleteSlot() {
  // DeleteSlot (Z_02)
  ram[SampleRequest] = 0x08; // "hurt" sound effect
  let x = table(bus.rom, 'SlotToBlankNameTransferBufEndOffset').byte(ram[CurSaveSlot]);
  const buf = table(bus.rom, 'DeletedSlotBlankNameTransferBuf');
  for (let y = 0x04; y >= 0; y--, x--) ram[DynTileBuf + y] = buf.byte(x);
  FetchFileAAddressSet();
  FormatFileA();
  FetchProfileNameAddress();
  for (let y = 0x07; y >= 0; y--) poke(word(0x0c) + y, 0x24); // clear the name in save slot info
  return 0x24;
}
