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
import { $br, $pxa } from '../../core/timing.js';

/** DEY / BPL loop from y0 down to 0: body(y), then one breadcrumb per iteration. */
function downLoop(y0, ref, body) {
  for (let y = y0; ;) {
    body(y);
    y = (y - 1) & 0xff;
    if (!$br(ref, y < 0x80)) break;
  }
}

/**
 * The $180-byte world flag walk of the checksum/format routines: per byte body(), then
 * INC lo / BNE / INC hi, DEC cnt / BNE, DEC cnt2 / BPL (refs: [carry, inner, outer]).
 */
function worldFlagsLoop(lo, cnt, body, refs) {
  ram[cnt + 1] = 0x80; // [cnt+1] counts $80, [cnt] the extra block (= $180 in all)
  ram[cnt] = 0x01;
  for (;;) {
    body();
    ram[lo]++;
    if (!$br(refs[0], ram[lo] !== 0)) ram[lo + 1]++;
    ram[cnt + 1]--;
    if ($br(refs[1], ram[cnt + 1] !== 0)) continue;
    ram[cnt]--;
    if (!$br(refs[2], ram[cnt] < 0x80)) break;
  }
}

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
  for (;;) {
    a = (a + 0x0e) & 0xff; // CLC / ADC #$0E
    y = (y - 1) & 0xff;
    if (!$br('Z_01:3070', y < 0x80)) break;
  }
  y = a;
  // The table is read where the code runs: in the copy of BANK_01_CODE in SRAM.
  const sets = label('SaveFileAAddressSets').addr;
  for (let x = 0x0d; ;) {
    $pxa('Z_01:3077', sets, y);
    ram[0x00 + x] = peek(sets + y);
    y = (y - 1) & 0xff;
    x--;
    if (!$br('Z_01:3081', x >= 0)) break;
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
  for (;;) {
    a = (a + 0x0e) & 0xff;
    y = (y - 1) & 0xff;
    if (!$br('Z_02:1381', y < 0x80)) break;
  }
  y = a;
  const sets = table(bus.rom, 'SaveFileBAddressSets');
  let v = 0;
  for (let x = 0x0d; ;) {
    v = sets.byte(y);
    ram[0xc0 + x] = v;
    y = (y - 1) & 0xff;
    x--;
    if (!$br('Z_02:1393', x >= 0)) break;
  }
  return v;
}

// ------------------------------------------------------------------ file A

/** CalculateFileAChecksum (Z_02). Returns the sum in [$0E] (high) : [$0F] (low). */
export function CalculateFileAChecksum() {
  // CalculateFileAChecksum (Z_02)
  ram[0x0e] = 0x00;
  ram[0x0f] = 0x00;
  downLoop(0x07, 'Z_02:2331', (y) => { $pxa('Z_02:2328', word(0x04), y); AddATo0F0E(peek(word(0x04) + y)); }); // name
  downLoop(0x27, 'Z_02:2338', (y) => { $pxa('Z_02:2335', word(0x00), y); AddATo0F0E(peek(word(0x00) + y)); }); // Items block
  // World flags ($180 bytes) at [$02:03], counted with [01:00]; Y stays 0.
  worldFlagsLoop(0x02, 0x00, () => { $pxa('Z_02:2346', word(0x02), 0); AddATo0F0E(peek(word(0x02))); },
    ['Z_02:2349', 'Z_02:2353', 'Z_02:2356']);
  $pxa('Z_02:2357', word(0x06), 0); AddATo0F0E(peek(word(0x06))); // IsSaveSlotActive
  $pxa('Z_02:2359', word(0x08), 0); AddATo0F0E(peek(word(0x08))); // TODO byte
  $pxa('Z_02:2361', word(0x0a), 0); AddATo0F0E(peek(word(0x0a))); // DeathCount
  $pxa('Z_02:2363', word(0x0c), 0);
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
  downLoop(0x07, 'Z_02:2381', (y) => poke(word(0x04) + y, 0x24)); // name = 8 spaces
  downLoop(0x27, 'Z_02:2388', (y) => poke(word(0x00) + y, 0x00)); // Items block
  worldFlagsLoop(0x02, 0x00, () => poke(word(0x02), 0x00), ['Z_02:2399', 'Z_02:2403', 'Z_02:2406']);
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
  downLoop(0x07, 'Z_02:2468', (y) => { $pxa('Z_02:2465', word(0xc4), y); AddAToCFCE(peek(word(0xc4) + y)); }); // name
  downLoop(0x27, 'Z_02:2475', (y) => { $pxa('Z_02:2472', word(0xc0), y); AddAToCFCE(peek(word(0xc0) + y)); }); // Items block
  // World flags ($180 bytes), counted with [C1:C0].
  worldFlagsLoop(0xc2, 0xc0, () => { $pxa('Z_02:2483', word(0xc2), 0); AddAToCFCE(peek(word(0xc2))); },
    ['Z_02:2486', 'Z_02:2490', 'Z_02:2493']);
  $pxa('Z_02:2494', word(0xc6), 0); AddAToCFCE(peek(word(0xc6))); // IsSaveSlotActive
  $pxa('Z_02:2496', word(0xc8), 0); AddAToCFCE(peek(word(0xc8))); // TODO byte
  $pxa('Z_02:2498', word(0xca), 0); AddAToCFCE(peek(word(0xca))); // DeathCount
  $pxa('Z_02:2500', word(0xcc), 0);
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
  downLoop(0x07, 'Z_02:2518', (y) => poke(word(0xc4) + y, 0x24));
  downLoop(0x27, 'Z_02:2525', (y) => poke(word(0xc0) + y, 0x00));
  worldFlagsLoop(0xc2, 0xc0, () => poke(word(0xc2), 0x00), ['Z_02:2536', 'Z_02:2540', 'Z_02:2543']);
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
  downLoop(0x27, 'Z_02:3068', (i) => { $pxa('Z_02:3065', word(0xc0), i); poke(word(0x00) + i, peek(word(0xc0) + i)); }); // Items block
  $pxa('Z_02:3070', word(0xc6), 0); poke(word(0x06), peek(word(0xc6))); // IsSaveSlotActive
  $pxa('Z_02:3072', word(0xc8), 0); poke(word(0x08), peek(word(0xc8))); // TODO byte
  $pxa('Z_02:3074', word(0xca), 0); poke(word(0x0a), peek(word(0xca))); // DeathCount
  $pxa('Z_02:3076', word(0xcc), 0); poke(word(0x0c), peek(word(0xcc))); // QuestNumber
  $pxa('Z_02:3078', word(0x06), 0); const active = peek(word(0x06)); // PHA x3
  $pxa('Z_02:3080', word(0x0a), 0); const deaths = peek(word(0x0a));
  $pxa('Z_02:3082', word(0x0c), 0); const quest = peek(word(0x0c));
  y = ram[CurSaveSlot];
  ram[QuestNumbers + y] = quest;
  ram[DeathCounts + y] = deaths;
  ram[IsSaveSlotActive + y] = active;
  downLoop(0x07, 'Z_02:3097', (i) => { $pxa('Z_02:3094', word(0xc4), i); poke(word(0x04) + i, peek(word(0xc4) + i)); }); // name
  // World flags ($180 bytes): counts [$0E:0F] up from $067F to $07FF.
  for (;;) {
    $pxa('Z_02:3104', word(0xc2), 0);
    poke(word(0x02), peek(word(0xc2)));
    ram[0x02]++;
    if (!$br('Z_02:3107', ram[0x02] !== 0)) ram[0x03]++;
    ram[0xc2]++;
    if (!$br('Z_02:3111', ram[0xc2] !== 0)) ram[0xc3]++;
    ram[0x0e]++;
    if (!$br('Z_02:3115', ram[0x0e] !== 0)) ram[0x0f]++;
    if ($br('Z_02:3120', ram[0x0e] !== 0xff)) continue;
    if (!$br('Z_02:3123', ram[0x0f] !== 0x07)) break;
  }
  y = ram[CurSaveSlot];
  poke(SaveFileOpenMarkers + y, 0x5a);
  poke(SaveFileCloseMarkers + y, 0xa5);
  y = (y << 1) & 0xff; // copy the checksum from file B to file A
  const sums = fileBChecksums();
  $pxa('Z_02:3132', sums, y); poke(FileAChecksums + y, peek(sums + y));
  y++;
  $pxa('Z_02:3135', sums, y); poke(FileAChecksums + y, peek(sums + y));
  y = ram[CurSaveSlot];
  poke(IsSaveFileBCommitted + y, 0xff); // file B has been committed
  return 0xff;
}

// ------------------------------------------------------------------ profile

/** FetchProfileNameAddress (Z_02): [$0C:0D] = &Names[CurSaveSlot * 8]. */
export function FetchProfileNameAddress() {
  // FetchProfileNameAddress (Z_02)
  const y = ram[CurSaveSlot];
  const lo = table(bus.rom, 'ProfileNameAddrsLo');
  const hi = table(bus.rom, 'ProfileNameAddrsHi');
  $pxa('Z_02:3154', lo.addr, y); ram[0x0c] = lo.byte(y);
  $pxa('Z_02:3156', hi.addr, y); ram[0x0d] = hi.byte(y);
  return ram[0x0d];
}

/** StoreSaveSlotHearts (Z_02): copy HeartValues/HeartPartial to SaveSlotHearts[CurSaveSlot]. */
export function StoreSaveSlotHearts() {
  // StoreSaveSlotHearts (Z_02)
  const y = ram[CurSaveSlot];
  const lo = table(bus.rom, 'SaveSlotHeartsAddrsLo');
  const hi = table(bus.rom, 'SaveSlotHeartsAddrsHi');
  $pxa('Z_02:3162', lo.addr, y); ram[0x0c] = lo.byte(y);
  $pxa('Z_02:3164', hi.addr, y); ram[0x0d] = hi.byte(y);
  downLoop(0x01, 'Z_02:3172', (i) => { $pxa('Z_02:3169', HeartValues, i); poke(word(0x0c) + i, ram[HeartValues + i]); });
  return ram[HeartValues];
}

/** SwitchProfileToSecondQuest (Z_02): clear world flags and items, 3 hearts, quest 2. */
export function SwitchProfileToSecondQuest() {
  // SwitchProfileToSecondQuest (Z_02)
  const addrs = table(bus.rom, 'WorldFlagBlockAddrs');
  for (let x = 0x04; ;) {
    $pxa('Z_02:4042', addrs.addr, x); ram[0x00] = addrs.byte(x);
    $pxa('Z_02:4044', addrs.addr + 1, x); ram[0x01] = addrs.byte(x + 1);
    downLoop(0x7f, 'Z_02:4051', (y) => poke(word(0x00) + y, 0x00));
    x = (x - 2) & 0xff;
    if (!$br('Z_02:4054', x < 0x80)) break;
  }
  downLoop(0x27, 'Z_02:4061', (y) => { ram[Items + y] = 0x00; });
  ram[HeartValues] = 0x22;
  ram[HeartPartial]--;
  ram[MaxBombs] = 0x08;
  const y = ram[CurSaveSlot];
  ram[QuestNumbers + y] = 0x01;
  return 0x01;
}
