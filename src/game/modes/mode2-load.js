// Mode 2: load the level (Z_06). Package P03.
//   InitMode2 (Z_07, P01) -> InitMode2_Submodes: Sub0 copies the level block, Sub1 the level info and
//   starts the update phase; UpdateMode2Load (Z_07) -> UpdateMode2Load_Full applies the 2nd quest patches.

import { ram, sram } from '../../core/ram.js';
import { read, bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { label, table } from '../../core/rom.js';
import {
  GameSubmode, IsUpdatingMode, CurLevel, CurSaveSlot, QuestNumbers, LevelInfo_ShortcutOrItemPosArray,
  LevelBlockAttrsA, LevelBlockAttrsB, LevelBlockAttrsD, LevelBlockAttrsF,
} from '../../core/vars.js';
import { CopyBlock, FetchLevelBlockDestInfo, FetchLevelInfoDestInfo } from '../loaders/levelblocks.js';

const S = 0x6000; // SRAM base

export function InitMode2_Submodes() {
  // InitMode2_Submodes (Z_06)
  return tableJump(label('InitMode2_Submodes_JumpTable').addr, ram[GameSubmode], [InitMode2_Sub0, InitMode2_Sub1]);
}

export function InitMode2_Sub0() {
  // InitMode2_Sub0 (Z_06): copy the level block for the level (quest 1 or 2) to $687E
  let x = (ram[CurLevel] << 1) & 0xff;
  const y = ram[CurSaveSlot];
  const t = table(bus.rom, ram[QuestNumbers + y] !== 0 ? 'LevelBlockAddrsQ2' : 'LevelBlockAddrsQ1');
  ram[0x00] = t.byte(x);
  x = (x + 1) & 0xff;
  ram[0x01] = t.byte(x); // @Copy
  FetchLevelBlockDestInfo();
  CopyBlock();
}

export function InitMode2_Sub1() {
  // InitMode2_Sub1 (Z_06): copy the level info to $6B7E, then begin updating the mode
  const t = table(bus.rom, 'LevelInfoAddrs');
  let x = (ram[CurLevel] << 1) & 0xff;
  ram[0x00] = t.byte(x);
  x = (x + 1) & 0xff;
  ram[0x01] = t.byte(x);
  FetchLevelInfoDestInfo();
  CopyBlock();
  ram[GameSubmode] = 0x00;
  ram[IsUpdatingMode]++;
}

export function UpdateMode2Load_Full() {
  // UpdateMode2Load_Full (Z_06): make replacements for the second quest
  let y = ram[CurSaveSlot];
  if (ram[QuestNumbers + y] === 0) return; // @Exit: not second quest
  let x = ram[CurLevel];
  if (x === 0) return PatchQ2Rooms();
  y = (x << 1) & 0xff;
  // The address array skips the OW element (0): index -2 (it overlaps LevelInfoUWQ2Replacements9).
  const addrs = table(bus.rom, 'LevelInfoUWQ2ReplacementAddrs');
  ram[0x00] = addrs.byte(y - 2);
  ram[0x01] = addrs.byte(y - 1);
  y = table(bus.rom, 'LevelInfoUWQ2ReplacementSizes').byte(x - 1);
  // @ReplaceInfoBytes: copy to the level info starting at the shortcut position array (offset $29).
  const src = ram[0x00] | (ram[0x01] << 8);
  do {
    sram[LevelInfo_ShortcutOrItemPosArray - S + y] = read((src + y) & 0xffff);
    y = (y - 1) & 0xff;
  } while (y < 0x80); // BPL
}

function PatchQ2Rooms() {
  // UpdateMode2Load_Full@PatchQ2Rooms (Z_06): replace attributes of several OW rooms in the second quest
  const offs = table(bus.rom, 'LevelBlockAttrsBQ2ReplacementOffsets');
  const vals = table(bus.rom, 'LevelBlockAttrsBQ2ReplacementValues');
  for (let y = 0x07; y >= 0; y--) {
    const x = offs.byte(y);
    sram[LevelBlockAttrsB - S + x] = vals.byte(y);
  }
  sram[LevelBlockAttrsD - S + 11] = 0x7b;
  sram[LevelBlockAttrsD - S + 60] = 0x7b;
  sram[LevelBlockAttrsD - S + 116] = 0x5a;
  sram[LevelBlockAttrsA - S + 60] = 0x72;
  sram[LevelBlockAttrsA - S + 116] = 0x72;
  sram[LevelBlockAttrsF - S + 60] = 0x01;
  sram[LevelBlockAttrsF - S + 116] = 0x00;
}
