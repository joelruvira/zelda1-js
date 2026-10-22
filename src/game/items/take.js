// P10 items — taking items (Z_01). Most of these run from WRAM (BANK_01_CODE, $6C90-$7EFF):
// their tables ItemIdToSlot / ItemIdToDescriptor / LinkColors_CommonCode are read in SRAM, like the
// original. CheckPowerTriforceFanfare / TakePowerTriforce live in bank 1 proper ($A17C).
//
// Contracts:
//   TryTakeRoomItem():           no parameters (BeginUpdateWorld).
//   TryTakeItem(x):              X = object slot, [$04] = item type.
//   TakeItem(a):                 A = item ID (shops, cave items, TryTakeItem).
//   CompareHeartsToContainers(): returns A = HeartValues >> 4 (containers - 1), [$00] = HeartValues & $0F;
//                                the original's Z flag is A === [$00].
//   CheckPowerTriforceFanfare(): no parameters (bank 1 mapped by the caller).

import { ram, peek, poke } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { switchBank } from '../../core/asm.js';
import {
  ObjState, ObjTimer, ObjX, ObjY, ObjRoomItemId, Item_ObjItemLifetime, TriforceFanfareActive,
  TileBufSelector, World_IsFillingHearts, GameSubmode, SongRequest, LastBossDefeated, Tune1Request,
  Tune0Request, GameMode, ItemLiftTimer, ItemTypeToLift, Items, CurLevel, StatusBarMapTrigger,
  MaxBombs, HeartPartial, HeartValues, CurSaveSlot, InvRing, RupeesToAdd,
} from '../../core/vars.js';
import { Abs } from '../movement/math.js';
import { EndGameMode } from '../modes/dispatch.js';
import { PatchAndCueLevelPalettesTransferAndAdvanceSubmode } from '../modes/mode3-unfurl.js';
import { ReplaceAshesPaletteRow } from '../bosses/ganon.js';
import { GetRoomFlagUWItemState, SetRoomFlagUWItemState } from './roomitem.js';

const wram = (name, i) => peek(label(name).addr + i); // BANK_01_CODE data, read in WRAM

// ------------------------------------------------------------------ power triforce (bank 1)

/** CheckPowerTriforceFanfare (Z_01): flashes the palette while Link holds the Triforce of Power. */
export function CheckPowerTriforceFanfare() {
  // CheckPowerTriforceFanfare (Z_01)
  if (ram[TriforceFanfareActive] === 0) return; // @Exit
  if (ram[ObjTimer] === 0) {
    // @EndFanfare
    ReplaceAshesPaletteRow();
    ram[SongRequest] = 0x20; // level 9 song again
    ram[LastBossDefeated] = 0x01;
    const a = 0x01 >> 1; // LSR
    ram[ObjState] = a; // Link idle, not halted
    ram[TriforceFanfareActive] = a;
    return;
  }
  let y = 0x18;
  // Redundant check of Link's timer that never branches.
  const t = ram[ObjTimer];
  if (t === 0) {
    // @FillHearts (unverified code 6196)
    ram[World_IsFillingHearts] = 0x02;
    ram[GameSubmode]++;
    return;
  }
  if ((t & 0x07) >= 0x04) y = 0x78;
  ram[TileBufSelector] = y;
}

/** TakePowerTriforce (Z_01): halt Link for $C0 frames and start the fanfare. */
export function TakePowerTriforce() {
  // TakePowerTriforce (Z_01)
  ram[TriforceFanfareActive]++;
  ram[ObjTimer] = 0xc0;
  ram[ObjState] = 0x40;
}

// ------------------------------------------------------------------ taking items (WRAM)

/** TryTakeRoomItem (Z_01): Link tries to take the room item (object slot $13). */
export function TryTakeRoomItem() {
  // TryTakeRoomItem (Z_01)
  if ((ram[ObjState] & 0xc0) === 0x40) return; // Link halted
  if (GetRoomFlagUWItemState() !== 0) return; // already taken
  const x = 0x13;
  if (ram[ObjState + x] & 0x80) return; // room item not active
  ram[0x04] = ram[ObjRoomItemId + x]; // [04] item type
  return TryTakeItem(x); // falls through
}

/** TryTakeItem (Z_01): X = object slot, [04] = item type. Takes it if Link is close enough. */
export function TryTakeItem(x) {
  // TryTakeItem (Z_01)
  if (ram[Item_ObjItemLifetime + x] >= 0xf0) return; // L6C28_Exit: can't take it right away
  let a = Abs((((ram[ObjY] + 0x03) & 0xff) - ram[ObjY + x]) & 0xff);
  if (a >= 0x09) return;
  a = Abs((ram[ObjX] - ram[ObjX + x]) & 0xff);
  if (a >= 0x09) return;
  // Deactivate the item (in case it is the room item).
  ram[ObjState + x] = 0xff;
  ram[ObjY + x] = 0xff;
  if (x === 0x13) SetRoomFlagUWItemState();
  return TakeItem(ram[0x04]); // falls through
}

/** TakeItem (Z_01): A = item ID. Updates the inventory, plays tunes, lifts the item in caves. */
export function TakeItem(a) {
  // TakeItem (Z_01)
  ram[Tune1Request] = 0x08; // "item taken"
  if (a === 0x0e) ram[Tune1Request] = 0x02; // Triforce of Power: "item appears"
  if (ram[GameMode] !== 0x05) {
    // In a cave or cellar: lift the item.
    ram[ItemLiftTimer] = 0x80;
    ram[SongRequest] = 0x08; // "item" song
    ram[ItemTypeToLift] = a;
  }
  // @SkipLift
  const x = a;
  const y = wram('ItemIdToSlot', x);
  a = wram('ItemIdToDescriptor', x);
  ram[0x0a] = a & 0x0f; // [0A] item value
  a &= 0xf0; // item class
  if (a !== 0) return CheckClass1(a, x, y);
  // Class 0: unique or complex.
  if (y === 0x11 || y === 0x10 || y === 0x1a || y === 0x1b) return TakeClass0Complex(a, x, y);
  return SetItemValue(ram[0x0a], y);
}

/** SetItemValue (Z_01): Items[Y] = A. L6C28_Exit is its RTS. */
export function SetItemValue(a, y) {
  // SetItemValue (Z_01)
  ram[Items + y] = a;
}

/** Take5Rupees (Z_01, part of TakeItem): TakeOneRupee five times. */
export function Take5Rupees() {
  // Take5Rupees (Z_01)
  for (let y = 0x04; y >= 0; y--) TakeOneRupee();
}

/** CheckClass1 (Z_01, part of TakeItem): A = item class, X = item type, Y = item slot. */
export function CheckClass1(a, x, y) {
  // CheckClass1 (Z_01)
  if (a !== 0x10) {
    // @CheckClass2
    if (a === 0x20) return HandleClass2(a, x, y);
    return capAndSet(0xff, y); // @SetItemValueFF: class $30
  }
  // Class 1: amounts.
  if (y === 0x18) {
    // @TakeHeartContainer: add a container and a heart, up to $10 containers.
    a = ram[Items + y];
    if (a >= 0xf0) return; // L6C28_Exit
    return SetItemValue((a + 0x11) & 0xff, y); // C = 0 here
  }
  if (y === 0x1c) return Take5Rupees();
  if (y === 0x16) return TakeOneRupee(); // @TakeRupee
  if (y === 0x19) return TakeHearts();
  if (y === 0x17) PlayKeyTakenTune();
  if (y === 0x14) return TakeHeartsNoSound(); // fairy
  // Keys and other amounts.
  a = ram[0x0a] + ram[Items + y];
  if (a > 0xff) a = 0xff; // @SetItemValueFF
  return capAndSet(a, y);
}

// CheckClass1 tail from @SetItemValueFF: potion cap 2, bomb cap MaxBombs, then SetItemValue.
function capAndSet(a, y) {
  if (y === 0x07 && a >= 0x03) a = 0x02;
  if (y === 0x01 && a >= ram[MaxBombs]) a = ram[MaxBombs];
  return SetItemValue(a, y);
}

/** TakeClass0Complex (Z_01, part of TakeItem): map, compass, triforce pieces and Triforce of Power. */
export function TakeClass0Complex(a, x, y) {
  // TakeClass0Complex (Z_01)
  a = ram[CurLevel];
  if (a === 0) return; // OW
  if (y === 0x1b) return L_TakePowerTriforce();
  if (y === 0x11) ram[StatusBarMapTrigger] = 0x01; // draw the status bar map
  a = (a - 0x01) & 0xff;
  if (a >= 0x08) y += 2; // level 9: map9 / compass9 slots
  x = a & 0x07;
  ram[Items + y] = ram[Items + y] | table(bus.rom, 'LevelMasks').byte(x);
  if (y !== 0x1a) return;
  // Triforce piece: go to mode $12.
  EndGameMode();
  ram[GameMode] = 0x12;
}

/** TakeHearts (Z_01, part of TakeItem): key tune, then TakeHeartsNoSound. */
export function TakeHearts() {
  // TakeHearts (Z_01)
  PlayKeyTakenTune();
  return TakeHeartsNoSound(); // falls through
}

/** TakeHeartsNoSound (Z_01, part of TakeItem): [0A] = hearts to add - 1. */
export function TakeHeartsNoSound() {
  // TakeHeartsNoSound (Z_01)
  ram[0x01] = ram[0x0a];
  for (;;) {
    // @CompareHearts
    if (CompareHeartsToContainers() === ram[0x00]) {
      // Full containers: fill the partial heart.
      if (ram[HeartPartial] !== 0xff) ram[HeartPartial] = 0xff; // @FillHeartPartial
      return;
    }
    // @AddWholeHeart
    ram[HeartValues]++;
    ram[0x01]--;
    if (ram[0x01] & 0x80) return; // BPL
  }
}

/** CompareHeartsToContainers (Z_01). @returns A = HeartValues >> 4; [00] = HeartValues & $0F (Z: A === [00]) */
export function CompareHeartsToContainers() {
  // CompareHeartsToContainers (Z_01)
  const a = ram[HeartValues];
  ram[0x00] = a & 0x0f;
  return a >> 4;
}

/** L_TakePowerTriforce (Z_01, part of TakeItem): switch to bank 1 and take the Triforce of Power. */
export function L_TakePowerTriforce() {
  // L_TakePowerTriforce (Z_01): LDA #$01 / JSR SwitchBank_Local5
  switchBank(0x01);
  return TakePowerTriforce();
}

/** HandleClass2 (Z_01, part of TakeItem): graded items; a new ring changes Link's color. */
export function HandleClass2(a, x, y) {
  // HandleClass2 (Z_01)
  a = ram[0x0a];
  if (a < ram[Items + y]) return; // L6D1B_Exit: we have a higher grade
  ram[Items + y] = a;
  if (y !== 0x0b) return; // not a ring
  x = ram[CurSaveSlot];
  y = ram[InvRing];
  a = wram('LinkColors_CommonCode', y);
  y = table(bus.rom, 'SaveSlotToPaletteRowOffset').byte(x);
  poke(label('MenuPalettesTransferBuf').addr + 20 + y, a); // BANK_06_DATA in WRAM
  return PatchAndCueLevelPalettesTransferAndAdvanceSubmode();
}

/** TakeOneRupee (Z_01): rupee tune, RupeesToAdd++. */
export function TakeOneRupee() {
  // TakeOneRupee (Z_01)
  ram[Tune1Request] = 0x01;
  ram[RupeesToAdd]++;
}

/** PlayKeyTakenTune (Z_01) */
export function PlayKeyTakenTune() {
  // PlayKeyTakenTune (Z_01)
  ram[Tune1Request] = 0x00;
  ram[Tune0Request] = 0x08;
}
