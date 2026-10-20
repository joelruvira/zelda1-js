// Save files A/B: address sets, checksums, formatting, commit (B -> A), profile helpers
// (Z_01, Z_02). Package P24.
//
// The game keeps two copies of each of the 3 save slots in battery SRAM:
//   file A ($6000-$652F): the committed copy, guarded by static markers and a checksum.
//   file B ($6880-$6D9B): written while saving (mode $D) or registering (mode $E), then
//                         committed by copying it to file A when its checksum is valid.
// Pointers to the pieces of the current file are kept in $00-$0F (file A) and $C0-$CF (file B).

import { ram, cpu, peek, poke, word } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import {
  CurSaveSlot, WorldFlags, IsSaveSlotActive, QuestNumbers, DeathCounts, IsSaveFileBCommitted,
  SaveFileOpenMarkers, SaveFileCloseMarkers, FileAChecksums, HeartValues,
  HeartPartial, Items, MaxBombs,
} from '../../core/vars.js';

/** FileBChecksums lives inside RAM_01_CODE (SRAM $6D9C): a label, not a .inc variable. */
function fileBChecksums() {
  return label('FileBChecksums').addr;
}

// ------------------------------------------------------------------ address sets

/**
 * FetchFileAAddressSet (Z_01, runs from WRAM): copy the 14-byte address set of file A for
 * CurSaveSlot to [$00-$0D]; [$0E:0F] = WorldFlags.
 * [00] items, [02] world flags, [04] name, [06] IsSaveSlotActive, [08] ?, [0A] death count,
 * [0C] quest number.
 */
export function FetchFileAAddressSet() {
  // FetchFileAAddressSet (Z_01)
  let a = 0xff;
  let y = ram[CurSaveSlot];
  do {
    a = (a + 0x0e) & 0xff; // CLC / ADC #$0E
    y = (y - 1) & 0xff;
  } while (!(y & 0x80));
  y = a;
  // The table is read where the code runs: in the copy of BANK_01_CODE in SRAM.
  const sets = label('SaveFileAAddressSets').addr;
  for (let x = 0x0d; x >= 0; x--) {
    ram[0x00 + x] = peek(sets + y);
    y = (y - 1) & 0xff;
  }
  ram[0x0e] = WorldFlags & 0xff;
  ram[0x0f] = WorldFlags >> 8;
  return WorldFlags >> 8;
}

/**
 * FetchFileBAddressSet (Z_02): copy the 14-byte address set of file B for CurSaveSlot to
 * [$C0-$CD]. [C0] items, [C2] world flags, [C4] name, [C6] IsSaveSlotActive, [C8] ?,
 * [CA] death count, [CC] quest number.
 */
export function FetchFileBAddressSet() {
  // FetchFileBAddressSet (Z_02)
  let a = 0xff;
  let y = ram[CurSaveSlot];
  do {
    a = (a + 0x0e) & 0xff;
    y = (y - 1) & 0xff;
  } while (!(y & 0x80));
  y = a;
  const sets = table(bus.rom, 'SaveFileBAddressSets');
  let v = 0;
  for (let x = 0x0d; x >= 0; x--) {
    v = sets.byte(y);
    ram[0xc0 + x] = v;
    y = (y - 1) & 0xff;
  }
  return v;
}

// ------------------------------------------------------------------ file A

/** CalculateFileAChecksum (Z_02). Returns the sum in [$0E] (high) : [$0F] (low). */
export function CalculateFileAChecksum() {
  // CalculateFileAChecksum (Z_02)
  ram[0x0e] = 0x00;
  ram[0x0f] = 0x00;
  for (let y = 0x07; y >= 0; y--) AddATo0F0E(peek(word(0x04) + y)); // name
  for (let y = 0x27; y >= 0; y--) AddATo0F0E(peek(word(0x00) + y)); // Items block
  ram[0x01] = 0x80; // will count $180 with [01:00]
  ram[0x00] = 0x01;
  // World flags ($180 bytes) at [$02:03]; Y stays 0.
  do {
    do {
      AddATo0F0E(peek(word(0x02)));
      if ((++ram[0x02] & 0xff) === 0) ram[0x03]++;
    } while ((--ram[0x01] & 0xff) !== 0);
    ram[0x00]--;
  } while (!(ram[0x00] & 0x80));
  AddATo0F0E(peek(word(0x06))); // IsSaveSlotActive
  AddATo0F0E(peek(word(0x08))); // TODO byte
  AddATo0F0E(peek(word(0x0a))); // DeathCount
  return AddATo0F0E(peek(word(0x0c))); // QuestNumber; falls through into AddATo0F0E
}

/** AddATo0F0E (Z_02): [$0F] += A, carry into [$0E]. Returns A = [$0E]. */
export function AddATo0F0E(a) {
  // AddATo0F0E (Z_02)
  cpu.c = 0;
  ram[0x0f] = cpu.adc(a, ram[0x0f]);
  ram[0x0e] = cpu.adc(ram[0x0e], 0x00);
  return ram[0x0e];
}

/** FormatFileA (Z_02): reset file A of CurSaveSlot (pointers from FetchFileAAddressSet). */
export function FormatFileA() {
  // FormatFileA (Z_02)
  for (let y = 0x07; y >= 0; y--) poke(word(0x04) + y, 0x24); // name = 8 spaces
  for (let y = 0x27; y >= 0; y--) poke(word(0x00) + y, 0x00); // Items block
  ram[0x01] = 0x80;
  ram[0x00] = 0x01;
  do {
    do {
      poke(word(0x02), 0x00);
      if ((++ram[0x02] & 0xff) === 0) ram[0x03]++;
    } while ((--ram[0x01] & 0xff) !== 0);
    ram[0x00]--;
  } while (!(ram[0x00] & 0x80));
  poke(word(0x06), 0x00); // IsSaveSlotActive
  poke(word(0x08), 0x00); // TODO byte
  poke(word(0x0a), 0x00); // DeathCount
  poke(word(0x0c), 0x00); // QuestNumber
  FetchFileAAddressSet();
  CalculateFileAChecksum();
  let y = ram[CurSaveSlot];
  // Be proactive and reset these values in save slot info.
  ram[IsSaveSlotActive + y] = 0x00;
  ram[QuestNumbers + y] = 0x00;
  ram[DeathCounts + y] = 0x00;
  // Since file A is in a good state, treat file B as committed.
  poke(IsSaveFileBCommitted + y, 0xff);
  poke(SaveFileOpenMarkers + y, 0x5a);
  poke(SaveFileCloseMarkers + y, 0xa5);
  y = (y << 1) & 0xff;
  poke(FileAChecksums + y, ram[0x0e]);
  y++;
  poke(FileAChecksums + y, ram[0x0f]);
  return ram[0x0f];
}

// ------------------------------------------------------------------ file B

/** CalculateAndStoreFileBChecksumUncommitted (Z_02): file B valid but uncommitted. */
export function CalculateAndStoreFileBChecksumUncommitted() {
  // CalculateAndStoreFileBChecksumUncommitted (Z_02)
  CalculateFileBChecksum();
  let y = ram[CurSaveSlot];
  poke(IsSaveFileBCommitted + y, 0x00);
  y = (y << 1) & 0xff;
  const sums = fileBChecksums();
  poke(sums + y, ram[0xce]);
  y++;
  poke(sums + y, ram[0xcf]);
  return ram[0xcf];
}

/** CalculateFileBChecksum (Z_02). Returns the sum in [$CE] (high) : [$CF] (low). */
export function CalculateFileBChecksum() {
  // CalculateFileBChecksum (Z_02)
  ram[0xce] = 0x00;
  ram[0xcf] = 0x00;
  for (let y = 0x07; y >= 0; y--) AddAToCFCE(peek(word(0xc4) + y)); // name
  for (let y = 0x27; y >= 0; y--) AddAToCFCE(peek(word(0xc0) + y)); // Items block
  ram[0xc1] = 0x80; // will count $180 with [C1:C0]
  ram[0xc0] = 0x01;
  do {
    do {
      AddAToCFCE(peek(word(0xc2)));
      if ((++ram[0xc2] & 0xff) === 0) ram[0xc3]++;
    } while ((--ram[0xc1] & 0xff) !== 0);
    ram[0xc0]--;
  } while (!(ram[0xc0] & 0x80));
  AddAToCFCE(peek(word(0xc6))); // IsSaveSlotActive
  AddAToCFCE(peek(word(0xc8))); // TODO byte
  AddAToCFCE(peek(word(0xca))); // DeathCount
  return AddAToCFCE(peek(word(0xcc))); // QuestNumber; falls through into AddAToCFCE
}

/** AddAToCFCE (Z_02): [$CF] += A, carry into [$CE]. Returns A = [$CE]. */
export function AddAToCFCE(a) {
  // AddAToCFCE (Z_02)
  cpu.c = 0;
  ram[0xcf] = cpu.adc(a, ram[0xcf]);
  ram[0xce] = cpu.adc(ram[0xce], 0x00);
  return ram[0xce];
}

/** FormatFileB (Z_02): clear file B of CurSaveSlot, leave its checksum in [$CF:CE], mark committed. */
export function FormatFileB() {
  // FormatFileB (Z_02)
  for (let y = 0x07; y >= 0; y--) poke(word(0xc4) + y, 0x24);
  for (let y = 0x27; y >= 0; y--) poke(word(0xc0) + y, 0x00);
  ram[0xc1] = 0x80;
  ram[0xc0] = 0x01;
  do {
    do {
      poke(word(0xc2), 0x00);
      if ((++ram[0xc2] & 0xff) === 0) ram[0xc3]++;
    } while ((--ram[0xc1] & 0xff) !== 0);
    ram[0xc0]--;
  } while (!(ram[0xc0] & 0x80));
  poke(word(0xc6), 0x00); // IsSaveSlotActive
  poke(word(0xc8), 0x00); // TODO byte
  poke(word(0xca), 0x00); // DeathCount
  poke(word(0xcc), 0x00); // QuestNumber
  FetchFileBAddressSet();
  CalculateFileBChecksum();
  const y = ram[CurSaveSlot];
  poke(IsSaveFileBCommitted + y, 0xff);
  return 0xff;
}

/** CopyFileBToFileA (Z_02): commit file B of CurSaveSlot into file A and the save slot info. */
export function CopyFileBToFileA() {
  // CopyFileBToFileA (Z_02)
  let y = ram[CurSaveSlot];
  poke(SaveFileOpenMarkers + y, 0x00); // reset the save file markers
  poke(SaveFileCloseMarkers + y, 0x00);
  y = (y << 1) & 0xff; // reset the checksum
  poke(FileAChecksums + y, 0x00);
  y++;
  poke(FileAChecksums + y, 0x00);
  FetchFileBAddressSet();
  FetchFileAAddressSet(); // puts $067F in [$0E:0F]
  for (y = 0x27; y >= 0; y--) poke(word(0x00) + y, peek(word(0xc0) + y)); // Items block
  poke(word(0x06), peek(word(0xc6))); // IsSaveSlotActive
  poke(word(0x08), peek(word(0xc8))); // TODO byte
  poke(word(0x0a), peek(word(0xca))); // DeathCount
  poke(word(0x0c), peek(word(0xcc))); // QuestNumber
  const active = peek(word(0x06)); // PHA x3
  const deaths = peek(word(0x0a));
  const quest = peek(word(0x0c));
  y = ram[CurSaveSlot];
  ram[QuestNumbers + y] = quest;
  ram[DeathCounts + y] = deaths;
  ram[IsSaveSlotActive + y] = active;
  for (y = 0x07; y >= 0; y--) poke(word(0x04) + y, peek(word(0xc4) + y)); // name
  // World flags ($180 bytes): counts [$0E:0F] up from $067F to $07FF.
  do {
    poke(word(0x02), peek(word(0xc2)));
    if ((++ram[0x02] & 0xff) === 0) ram[0x03]++;
    if ((++ram[0xc2] & 0xff) === 0) ram[0xc3]++;
    if ((++ram[0x0e] & 0xff) === 0) ram[0x0f]++;
  } while (ram[0x0e] !== 0xff || ram[0x0f] !== 0x07);
  y = ram[CurSaveSlot];
  poke(SaveFileOpenMarkers + y, 0x5a);
  poke(SaveFileCloseMarkers + y, 0xa5);
  y = (y << 1) & 0xff; // copy the checksum from file B to file A
  const sums = fileBChecksums();
  poke(FileAChecksums + y, peek(sums + y));
  y++;
  poke(FileAChecksums + y, peek(sums + y));
  y = ram[CurSaveSlot];
  poke(IsSaveFileBCommitted + y, 0xff); // file B has been committed
  return 0xff;
}

// ------------------------------------------------------------------ profile

/** FetchProfileNameAddress (Z_02): [$0C:0D] = &Names[CurSaveSlot * 8]. */
export function FetchProfileNameAddress() {
  // FetchProfileNameAddress (Z_02)
  const y = ram[CurSaveSlot];
  ram[0x0c] = table(bus.rom, 'ProfileNameAddrsLo').byte(y);
  ram[0x0d] = table(bus.rom, 'ProfileNameAddrsHi').byte(y);
  return ram[0x0d];
}

/** StoreSaveSlotHearts (Z_02): copy HeartValues/HeartPartial to SaveSlotHearts[CurSaveSlot]. */
export function StoreSaveSlotHearts() {
  // StoreSaveSlotHearts (Z_02)
  const y = ram[CurSaveSlot];
  ram[0x0c] = table(bus.rom, 'SaveSlotHeartsAddrsLo').byte(y);
  ram[0x0d] = table(bus.rom, 'SaveSlotHeartsAddrsHi').byte(y);
  for (let i = 0x01; i >= 0; i--) poke(word(0x0c) + i, ram[HeartValues + i]);
  return ram[HeartValues];
}

/** SwitchProfileToSecondQuest (Z_02): clear world flags and items, 3 hearts, quest 2. */
export function SwitchProfileToSecondQuest() {
  // SwitchProfileToSecondQuest (Z_02)
  const addrs = table(bus.rom, 'WorldFlagBlockAddrs');
  for (let x = 0x04; !(x & 0x80); x = (x - 2) & 0xff) {
    ram[0x00] = addrs.byte(x);
    ram[0x01] = addrs.byte(x + 1);
    for (let y = 0x7f; y >= 0; y--) poke(word(0x00) + y, 0x00);
  }
  for (let y = 0x27; y >= 0; y--) ram[Items + y] = 0x00;
  ram[HeartValues] = 0x22;
  ram[HeartPartial]--;
  ram[MaxBombs] = 0x08;
  const y = ram[CurSaveSlot];
  ram[QuestNumbers + y] = 0x01;
  return 0x01;
}
