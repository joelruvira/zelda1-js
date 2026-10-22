// Room flags (Z_07, Z_05). Package P14.
// These shared routines are called on every room of the overworld/underworld (layout, kill counts,
// map, next room, doors, secrets), see docs/PORT_MAP.md "rutinas compartidas".
// Contracts (from the asm):
//   GetRoomFlags():    returns A = flags of RoomId in the level block world flags;
//                      Y = RoomId; [$00:01] = LevelInfo_WorldFlagsAddr (callers re-read Y as RoomId).
//   GetUniqueRoomId(): returns A = LevelBlockAttrsD[RoomId] & $3F; Y = RoomId.
//   MarkRoomVisited(): flags of RoomId |= $20 (UW visited).
//   SaveKillCount():   no parameters.
import { ram, peek } from '../../core/ram.js';
import { read, write } from '../../core/bus.js';
import { RoomId, CurLevel, LevelInfo_WorldFlagsAddr, LevelBlockAttrsD } from '../../core/vars.js';
import { SaveKillCountOW, SaveKillCountUW } from '../objects/killcounts.js';

/** GetRoomFlags (Z_07). @returns A = ([$00:01]),Y with [$00:01] = LevelInfo_WorldFlagsAddr, Y = RoomId */
export function GetRoomFlags() {
  // GetRoomFlags (Z_07)
  ram[0x00] = peek(LevelInfo_WorldFlagsAddr);
  ram[0x01] = peek(LevelInfo_WorldFlagsAddr + 1);
  const y = ram[RoomId];
  return read((((ram[0x01] << 8) | ram[0x00]) + y) & 0xffff);
}

/** MarkRoomVisited (Z_07): sets the UW visit state ($20) in the room's flags. */
export function MarkRoomVisited() {
  // MarkRoomVisited (Z_07); its RTS is the label Exit
  const a = GetRoomFlags() | 0x20;
  write((((ram[0x01] << 8) | ram[0x00]) + ram[RoomId]) & 0xffff, a);
}

/** GetUniqueRoomId (Z_07). @returns A = LevelBlockAttrsD[RoomId] & $3F (Y = RoomId) */
export function GetUniqueRoomId() {
  // GetUniqueRoomId (Z_07)
  return peek(LevelBlockAttrsD + ram[RoomId]) & 0x3f;
}

/** SaveKillCount (Z_05): SaveKillCountOW in the OW (CurLevel = 0), else SaveKillCountUW. */
export function SaveKillCount() {
  // SaveKillCount (Z_05); L1746E_Exit is its RTS
  if (ram[CurLevel] === 0) return SaveKillCountOW();
  SaveKillCountUW();
}
