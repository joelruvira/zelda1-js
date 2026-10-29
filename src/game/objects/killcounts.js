// P05 objects — room history and kill counts (Z_07, Z_05): which rooms were visited recently,
// and how many foes of a room stay defeated (room flags of the world, LevelKillCounts).

import { ram, cpu, word } from '../../core/ram.js';
// (ptr),Y accesses go through the bus like the original's LDA/STA ($00),Y (the pointer is SRAM in play).
import { read, write } from '../../core/bus.js';
import {
  ForceSwordShot, RoomHistory, RoomId, RoomKillCount, RoomObjCount, RoomObjTemplateType,
  LevelKillCounts,
} from '../../core/vars.js';
import { GetRoomFlags } from '../world/roomflags.js';

/** ClearRoomHistory (Z_07): also resets ForceSwordShot. @returns A = 0 */
export function ClearRoomHistory() {
  // ClearRoomHistory (Z_07)
  const a = 0x00;
  ram[ForceSwordShot] = a;
  for (let y = 0x05; y >= 0; y--) ram[RoomHistory + y] = a;
  return a;
}

// GetRoomFlags leaves [$00:01] = world flags address and Y = RoomId: ($00),Y is the room's flags byte.
const flagsAddr = () => word(0x00) + ram[RoomId];

function inRoomHistory() {
  const a = ram[RoomId];
  for (let y = 0x05; y >= 0; y--) if (ram[RoomHistory + y] === a) return true;
  return false;
}

/**
 * ModifyObjCountByHistoryOW (Z_05). [02] = object list ID, [03] = object count: subtract the
 * room's kill count (room flags bits 0-2) from the count, or reset it (count and list = 0).
 */
export function ModifyObjCountByHistoryOW() {
  // ModifyObjCountByHistoryOW (Z_05)
  if (!inRoomHistory()) {
    // Not found: if all foes were defeated, reset the kill count in the room flags.
    if ((GetRoomFlags() & 0x07) === 0x07) {
      const addr = flagsAddr();
      write(addr, read(addr) & 0xf8);
      return;
    }
  }
  let a = GetRoomFlags() & 0x07;
  if (a === 0) return; // @Exit
  if (a !== 0x07) {
    ram[0x04] = a;
    a = (ram[0x03] - ram[0x04]) & 0xff; // SEC / SBC
    if (!(a & 0x80)) {
      ram[0x03] = a;
      return;
    }
  }
  // @ResetObjList
  a = 0x00;
  ram[0x02] = a;
  ram[0x03] = a;
}

/** SaveKillCountOW (Z_05): add RoomKillCount to the room's kill count (max 7) in its flags. */
export function SaveKillCountOW() {
  // SaveKillCountOW (Z_05)
  ram[0x02] = GetRoomFlags() & 0x07;
  const addr = flagsAddr();
  write(addr, read(addr) & 0xf8);
  let a = ram[RoomKillCount];
  if (a < ram[RoomObjCount]) {
    a = ((a & 0x07) + ram[0x02]) & 0xff; // CLC / ADC
    if (a >= 0x07) a = 0x07;
  } else {
    a = 0x07; // @LimitCount
  }
  write(addr, a | read(addr));
}

/** True if the object list ID refers to non-recurring foes ($32-$48 except $3A, $3B). */
function isNonRecurring(id) {
  return id >= 0x32 && id !== 0x3a && id !== 0x3b && id < 0x49;
}

/**
 * ModifyObjCountByHistoryUW (Z_05). [02] = object list ID, [03] = object count: subtract
 * LevelKillCounts[RoomId] from the count, or reset it.
 */
export function ModifyObjCountByHistoryUW() {
  // ModifyObjCountByHistoryUW (Z_05)
  if (!inRoomHistory()) {
    if ((GetRoomFlags() & 0xc0) === 0xc0) {
      // Not in history and all foes defeated.
      if (isNonRecurring(ram[0x02])) return resetObjCount();
      // Recurring foes: reset the kill count in the room flags and the level block.
      const addr = flagsAddr();
      write(addr, read(addr) & 0x3f);
      ram[LevelKillCounts + ram[RoomId]] = 0x00;
      return;
    }
  }
  // @CalcObjCount
  const y = ram[RoomId];
  const a = (ram[0x03] - ram[LevelKillCounts + y]) & 0xff; // SEC / SBC
  if (a & 0x80) return resetObjCount();
  ram[0x03] = a;
}

function resetObjCount() {
  // ModifyObjCountByHistoryUW@ResetObjCount
  ram[0x02] = 0x00;
  ram[0x03] = 0x00;
}

/** SaveKillCountUW (Z_05): kill count of the room in its flags (bits 6-7) and LevelKillCounts. */
export function SaveKillCountUW() {
  // SaveKillCountUW (Z_05)
  const flags = GetRoomFlags() & 0x3f;
  const addr = flagsAddr();
  write(addr, flags);
  let a = ram[RoomObjCount];
  let max = a === 0;
  if (!max) {
    a = ram[RoomKillCount];
    if (a !== 0 && isNonRecurring(ram[RoomObjTemplateType])) max = true;
    else if (a >= ram[RoomObjCount]) max = true;
  }
  const y = ram[RoomId];
  if (max) {
    // @StoreMax
    ram[LevelKillCounts + y] = 0x0f;
    a = 0xc0;
  } else {
    a = (a + ram[LevelKillCounts + y]) & 0xff; // CLC / ADC
    ram[LevelKillCounts + y] = a;
    if (a >= 0x03) a = 0x02;
    cpu.c = 0;
    a = cpu.ror(a);
    a = cpu.ror(a);
    a = cpu.ror(a);
  }
  // @CombineWithFlags
  write(addr, a | read(addr));
}
