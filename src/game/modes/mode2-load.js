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
import { $br, $pxa } from '../../core/timing.js';
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
  $pxa('Z_06:68', QuestNumbers, y);
  const q2 = $br('Z_06:69', ram[QuestNumbers + y] !== 0);
  const t = table(bus.rom, q2 ? 'LevelBlockAddrsQ2' : 'LevelBlockAddrsQ1');
  if (q2) $pxa('Z_06:80', t.addr, x);
  ram[0x00] = t.byte(x);
  x = (x + 1) & 0xff;
  if (q2) $pxa('Z_06:83', t.addr, x);
  ram[0x01] = t.byte(x); // @Copy
  FetchLevelBlockDestInfo();
  CopyBlock();
}

export function InitMode2_Sub1() {
  // InitMode2_Sub1 (Z_06): copy the level info to $6B7E, then begin updating the mode
  const t = table(bus.rom, 'LevelInfoAddrs');
  let x = (ram[CurLevel] << 1) & 0xff;
  $pxa('Z_06:96', t.addr, x); ram[0x00] = t.byte(x);
  x = (x + 1) & 0xff;
  $pxa('Z_06:99', t.addr, x); ram[0x01] = t.byte(x);
  FetchLevelInfoDestInfo();
  CopyBlock();
  ram[GameSubmode] = 0x00;
  ram[IsUpdatingMode]++;
}

export function UpdateMode2Load_Full() {
  // UpdateMode2Load_Full (Z_06): make replacements for the second quest
  let y = ram[CurSaveSlot];
  $pxa('Z_06:206', QuestNumbers, y);
  if ($br('Z_06:207', ram[QuestNumbers + y] === 0)) return; // @Exit: not second quest
  let x = ram[CurLevel];
  if ($br('Z_06:209', x === 0)) return PatchQ2Rooms();
  y = (x << 1) & 0xff;
  // The address array skips the OW element (0): index -2 (it overlaps LevelInfoUWQ2Replacements9).
  const addrs = table(bus.rom, 'LevelInfoUWQ2ReplacementAddrs');
  $pxa('Z_06:219', addrs.addr - 2, y); ram[0x00] = addrs.byte(y - 2);
  $pxa('Z_06:221', addrs.addr - 1, y); ram[0x01] = addrs.byte(y - 1);
  const sizes = table(bus.rom, 'LevelInfoUWQ2ReplacementSizes');
  $pxa('Z_06:226', sizes.addr - 1, x);
  y = sizes.byte(x - 1);
  // @ReplaceInfoBytes: copy to the level info starting at the shortcut position array (offset $29).
  const src = ram[0x00] | (ram[0x01] << 8);
  for (;;) {
    $pxa('Z_06:231', src, y);
    sram[LevelInfo_ShortcutOrItemPosArray - S + y] = read((src + y) & 0xffff);
    y = (y - 1) & 0xff;
    if (!$br('Z_06:234', y < 0x80)) break; // BPL
  }
}

function PatchQ2Rooms() {
  // UpdateMode2Load_Full@PatchQ2Rooms (Z_06): replace attributes of several OW rooms in the second quest
  const offs = table(bus.rom, 'LevelBlockAttrsBQ2ReplacementOffsets');
  const vals = table(bus.rom, 'LevelBlockAttrsBQ2ReplacementValues');
  for (let y = 0x07; ;) {
    $pxa('Z_06:244', offs.addr, y);
    const x = offs.byte(y);
    $pxa('Z_06:245', vals.addr, y);
    sram[LevelBlockAttrsB - S + x] = vals.byte(y);
    y = (y - 1) & 0xff;
    if (!$br('Z_06:248', y < 0x80)) break; // BPL
  }
  sram[LevelBlockAttrsD - S + 11] = 0x7b;
  sram[LevelBlockAttrsD - S + 60] = 0x7b;
  sram[LevelBlockAttrsD - S + 116] = 0x5a;
  sram[LevelBlockAttrsA - S + 60] = 0x72;
  sram[LevelBlockAttrsA - S + 116] = 0x72;
  sram[LevelBlockAttrsF - S + 60] = 0x01;
  sram[LevelBlockAttrsF - S + 116] = 0x00;
}
