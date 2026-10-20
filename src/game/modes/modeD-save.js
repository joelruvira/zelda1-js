// Mode $D: save (Z_02, Z_05). Package P24.
//   InitModeD (Z_05): check save RAM (reset the game if it had to be initialized).
//   UpdateModeDSave: 3 submodes: write file B, commit it to file A, back to mode 0 submode 1.

import { ram, peek, poke, word } from '../../core/ram.js';
import { tableJump } from '../../core/asm.js';
import { label } from '../../core/rom.js';
import {
  GameSubmode, GameMode, CurSaveSlot, Items, DeathCounts, IsSaveSlotActive, QuestNumbers,
  HeartValues, HeartPartial, IsSaveFileBCommitted,
} from '../../core/vars.js';
import { TurnOffVideoAndClearArtifacts, InitSaveRam, JumpToIsrReset } from '../boot.js';
import { BeginUpdateMode } from './dispatch.js';
import {
  FetchFileAAddressSet, FetchFileBAddressSet, FormatFileB, FetchProfileNameAddress,
  StoreSaveSlotHearts, CalculateAndStoreFileBChecksumUncommitted, CalculateFileBChecksum,
  CopyFileBToFileA,
} from '../save/files.js';

/** InitModeD (Z_05) */
export function InitModeD() {
  // InitModeD (Z_05)
  TurnOffVideoAndClearArtifacts();
  // If save RAM had to be initialized (C = 1), it wasn't initialized before or something went
  // wrong: reset the game. JMP IsrReset never returns to the NMI in the original (it resets the
  // stack); JumpToIsrReset runs IsrReset and unwinds the rest of IsrNmi.
  if (!InitSaveRam()) return BeginUpdateMode();
  return JumpToIsrReset();
}

let handlers;
export function UpdateModeDSave() {
  // UpdateModeDSave (Z_02)
  handlers ??= [UpdateModeDSave_Sub0, UpdateModeDSave_Sub1, UpdateModeDSave_Sub2];
  return tableJump(label('UpdateModeDSave_JumpTable').addr, ram[GameSubmode], handlers);
}

/** UpdateModeDSave_Sub0 (Z_02): format file B, copy the profile to it, store checksum (uncommitted). */
export function UpdateModeDSave_Sub0() {
  // UpdateModeDSave_Sub0 (Z_02)
  FetchFileBAddressSet();
  FormatFileB();
  FetchFileBAddressSet();
  FetchFileAAddressSet(); // only for $067F in [$0E:0F]
  for (let y = 0x27; y >= 0; y--) poke(word(0xc0) + y, ram[Items + y]);
  let y = ram[CurSaveSlot];
  poke(word(0xca), ram[DeathCounts + y]);
  poke(word(0xc6), 0x01); // saving: the slot is active
  y = ram[CurSaveSlot];
  ram[IsSaveSlotActive + y] = 0x01;
  poke(word(0xcc), ram[QuestNumbers + y]);
  FetchProfileNameAddress();
  for (y = 0x07; y >= 0; y--) poke(word(0xc4) + y, peek(word(0x0c) + y));
  // Full hearts for the profile's heart containers.
  const containers = ram[HeartValues] & 0xf0; // PHA
  ram[0x0a] = containers >> 4;
  ram[HeartValues] = containers | ram[0x0a];
  ram[HeartPartial] = 0xff;
  StoreSaveSlotHearts();
  // World flags ($180 bytes) from the profile to file B.
  do {
    poke(word(0xc2), peek(word(0x0e)));
    if ((++ram[0xc2] & 0xff) === 0) ram[0xc3]++;
    if ((++ram[0x0e] & 0xff) === 0) ram[0x0f]++;
  } while (ram[0x0e] !== 0xff || ram[0x0f] !== 0x07);
  FetchFileBAddressSet();
  CalculateAndStoreFileBChecksumUncommitted();
  ram[GameSubmode]++;
}

/** UpdateModeDSave_Sub1 (Z_02): commit file B to file A if its checksum is valid. */
export function UpdateModeDSave_Sub1() {
  // UpdateModeDSave_Sub1 (Z_02)
  let y = ram[CurSaveSlot];
  if (peek(IsSaveFileBCommitted + y) === 0) {
    FetchFileBAddressSet();
    CalculateFileBChecksum();
    y = (ram[CurSaveSlot] << 1) & 0xff;
    const sums = label('FileBChecksums').addr;
    if (peek(sums + y) !== ram[0xce] || peek(sums + y + 1) !== ram[0xcf]) {
      // @DiscardFileB (unverified code A75A)
      y = ram[CurSaveSlot];
      poke(IsSaveFileBCommitted + y, 0xff);
      ram[GameSubmode]++;
      return;
    }
    CopyFileBToFileA();
  }
  ram[GameSubmode]++;
}

/** UpdateModeDSave_Sub2 (Z_02): go to mode 0 submode 1, keep updating. */
export function UpdateModeDSave_Sub2() {
  // UpdateModeDSave_Sub2 (Z_02)
  ram[GameMode] = 0x00;
  ram[GameSubmode] = 0x01;
  return 0x01;
}
