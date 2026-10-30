// Mode $13, submode 3: the credits scroll (Z_02). Package P25.
// The credits are drawn one tile row at a time into the nametables just below the visible area while
// the screen scrolls up by half a pixel per frame. Text lines are read from the ROM (CreditsTextLines).
import { ram } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  CreditsTileOffset, VScrollAddrHi, VScrollAddrLo, CurVScroll, SwitchNameTablesReq, CurSaveSlot,
  QuestNumbers, GameSubmode, ObjTimer, DynTileBuf, CreditsRow, CreditsVramPage, CreditsVramLine,
  CreditsLineIndex, Names, DeathCounts,
} from '../../core/vars.js';
import { FormatDecimalByte } from '../text/format.js';
import { $br, $pxa } from '../../core/timing.js';

/** UpdateMode13WinGame_Sub3 (Z_02): scroll the credits; stop at the last screen of the quest. */
export function UpdateMode13WinGame_Sub3() {
  // UpdateMode13WinGame_Sub3 (Z_02)
  // After scrolling 8 pixels, draw another tile row (CMP #$08 / BMI: signed).
  if (!$br('Z_02:3682', ((ram[CreditsTileOffset] - 0x08) & 0x80) !== 0)) {
    ram[CreditsTileOffset] = ram[CreditsTileOffset] - 0x08; // SBC with C = 1 from the CMP
    DrawCredits();
  }
  // Add $80 to the scroll speed fraction; carry to the tile offset and the V-scroll.
  let sum = ram[VScrollAddrHi] + 0x80;
  ram[VScrollAddrHi] = sum;
  let c = sum >> 8;
  if (!$br('Z_02:3695', c === 0)) ram[CreditsTileOffset]++;
  sum = ram[CurVScroll] + c;
  let a = sum & 0xff;
  ram[CurVScroll] = a;
  // At the bottom of a nametable, roll the V-scroll over and switch nametables.
  c = a >= 0xf0 ? 1 : 0;
  if (!$br('Z_02:3707', c === 0)) {
    ram[CurVScroll] = 0x00;
    ram[VScrollAddrLo]++;
  }
  ram[SwitchNameTablesReq] = c; // LDA #0 / ROL
  let y = 0;
  $pxa('Z_02:3719', QuestNumbers, ram[CurSaveSlot]);
  if (!$br('Z_02:3720', ram[QuestNumbers + ram[CurSaveSlot]] === 0)) y++;
  // Not the last screen, or not the last amount in it: return.
  const screens = table(bus.rom, 'CreditsLastScreenList');
  $pxa('Z_02:3725', screens.addr, y);
  if ($br('Z_02:3726', ram[VScrollAddrLo] < screens.byte(y))) return;
  const vscrolls = table(bus.rom, 'CreditsLastVscrollList');
  $pxa('Z_02:3731', vscrolls.addr, y);
  if ($br('Z_02:3732', ram[CurVScroll] < vscrolls.byte(y))) return;
  ram[GameSubmode]++;
  ram[ObjTimer] = 0x40;
}

/**
 * DrawCredits (Z_02): DynTileBuf = a record of a full tile row (walls and maybe a text line) and,
 * every 4 rows, a record of NT attributes. Advances CreditsRow/CreditsVramLine/CreditsVramPage and
 * CreditsLineIndex.
 */
export function DrawCredits() {
  // DrawCredits (Z_02)
  // A transfer record of a full row of blank tiles.
  for (let y = 0x1f; ;) { ram[DynTileBuf + 3 + y] = 0x24; y--; if (!$br('Z_02:3775', y >= 0)) break; }
  const row = ram[CreditsRow];
  // Row 0: no walls. Rows 1 and $2E: horizontal walls. Rows 2 to $2D: side walls.
  if (!$br('Z_02:3779', row === 0)) {
    let horizontal = true;
    let side = true;
    if (!$br('Z_02:3784', row === 0x01)) {
      if ($br('Z_02:3786', row < 0x2e)) horizontal = false;
      else if ($br('Z_02:3787', row !== 0x2e)) horizontal = side = false;
    }
    if (horizontal) {
      // @WriteHorizontalWalls
      for (let y = 0x19; ;) { ram[DynTileBuf + 6 + y] = 0xfa; y--; if (!$br('Z_02:3795', y >= 0)) break; }
    }
    if (side) {
      // @WriteSideWalls
      ram[DynTileBuf + 6] = 0xfa;
      ram[DynTileBuf + 31] = 0xfa;
    }
  }
  // @TerminateRecords
  ram[DynTileBuf + 35] = 0xff; // end of the tiles record
  ram[DynTileBuf + 46] = 0xff; // end of the attributes record
  ram[DynTileBuf + 2] = 0x20;
  let x = ram[CreditsVramPage];
  const hi = table(bus.rom, 'CreditLineVramAddrsHi');
  $pxa('Z_02:3815', hi.addr, x);
  ram[DynTileBuf] = hi.byte(x);
  let a = ram[CreditsVramLine];
  let y = a;
  ram[DynTileBuf + 1] = (a << 5) & 0xff;
  // Shift the page mask (line + 1) times: the bit that says whether this line has text.
  const masks = table(bus.rom, 'CreditsPagesTextMasks');
  $pxa('Z_02:3831', masks.addr, x);
  a = masks.byte(x);
  let c;
  for (;;) {
    c = a >> 7;
    a = (a << 1) & 0xff;
    y = (y - 1) & 0xff;
    if (!$br('Z_02:3837', !(y & 0x80))) break;
  }
  if (!$br('Z_02:3838', c === 0)) DrawCreditsTextLine();
  // @IncVramLine
  ram[CreditsVramLine]++;
  // 8 lines per VRAM page, except 6 in pages $23xx and $2Bxx ((page MOD 4) = 3).
  a = $br('Z_02:3940', (ram[CreditsVramPage] & 0x03) < 0x03) ? 0x08 : 0x06;
  if (!$br('Z_02:3946', a !== ram[CreditsVramLine])) {
    ram[CreditsVramLine] = 0x00;
    y = (ram[CreditsVramPage] + 1) & 0xff;
    if (!$br('Z_02:3958', y < 0x0c)) y = 0x00; // TAY with A = 0
    ram[CreditsVramPage] = y;
  }
  // @WriteAttributes: every 4 rows, a record of NT attributes.
  a = ram[CreditsRow];
  if (!$br('Z_02:3968', (a & 0x01) !== 0) && !$br('Z_02:3970', (a & 0x02) !== 0)) {
    a >>= 2;
    x = 0x00;
    ram[DynTileBuf + 38] = x; // left and right blocks
    ram[DynTileBuf + 45] = x;
    y = a;
    const attrs = table(bus.rom, 'CreditsAttrs');
    $pxa('Z_02:3981', attrs.addr, y);
    a = attrs.byte(y);
    for (y = 5; ;) { ram[DynTileBuf + 39 + y] = a; y--; if (!$br('Z_02:3989', y >= 0)) break; }
    y = !$br('Z_02:3997', (ram[DynTileBuf] & 0x08) === 0) ? 0x2b : 0x23; // NT 1 or NT 0 attribute space
    ram[DynTileBuf + 35] = y;
    a = (ram[CreditsRow] & 0x1f) << 1; // carry clear: bit 7 was 0
    ram[DynTileBuf + 36] = (a + 0xc0) & 0xff;
    ram[DynTileBuf + 37] = 0x08;
  }
  // @IncRow: skip the last two rows of each $20 (240 pixels, not 256).
  y = (ram[CreditsRow] + 1) & 0xff;
  if (!$br('Z_02:4027', (y & 0x1f) < 0x1e)) y = (y + 2) & 0xff;
  ram[CreditsRow] = y;
}

// The part of DrawCredits between the mask test and @IncLine / @IncVramLine.
function DrawCreditsTextLine() {
  let y = ram[CreditsLineIndex];
  if ($br('Z_02:3844', y >= 0x17)) return; // @IncVramLine
  // First quest: no lines >= $10. Second quest: skip lines $C to $F.
  $pxa('Z_02:3848', QuestNumbers, ram[CurSaveSlot]);
  if (!$br('Z_02:3849', ram[QuestNumbers + ram[CurSaveSlot]] !== 0)) {
    if ($br('Z_02:3851', y >= 0x10)) return IncLine();
  }
  $pxa('Z_02:3854', QuestNumbers, ram[CurSaveSlot]);
  if (!$br('Z_02:3857', ram[QuestNumbers + ram[CurSaveSlot]] === 0) && !$br('Z_02:3859', y < 0x0c)) {
    if ($br('Z_02:3861', y < 0x10)) return IncLine();
  }
  const lo = table(bus.rom, 'CreditsTextAddrsLo');
  const hi = table(bus.rom, 'CreditsTextAddrsHi');
  $pxa('Z_02:3863', lo.addr, y); ram[0x00] = lo.byte(y);
  $pxa('Z_02:3865', hi.addr, y); ram[0x01] = hi.byte(y);
  const ptr = ram[0x00] | (ram[0x01] << 8);
  y = 0;
  $pxa('Z_02:3870', ptr, y);
  ram[0x02] = read(ptr + y); // length of the string
  y++;
  $pxa('Z_02:3876', ptr, y);
  let x = read(ptr + y); // offset of the first character in the line
  y++;
  for (;;) {
    $pxa('Z_02:3882', ptr, y);
    ram[DynTileBuf + 3 + x] = read(ptr + y);
    y = (y + 1) & 0xff;
    x = (x + 1) & 0xff;
    ram[0x02]--;
    if (!$br('Z_02:3887', ram[0x02] !== 0)) break;
  }
  y = ram[CreditsLineIndex];
  if (!$br('Z_02:3892', y < 0x0c) && !$br('Z_02:3894', y !== 0x11)) {
    // Line $11: the player's name at offset 9 and the death count at offset 19.
    y = (ram[CurSaveSlot] << 3) & 0xff;
    x = 0;
    for (;;) {
      $pxa('Z_02:3906', Names, y);
      ram[DynTileBuf + 12 + x] = ram[Names + y];
      y = (y + 1) & 0xff;
      x++;
      if (!$br('Z_02:3911', x < 0x08)) break;
    }
    $pxa('Z_02:3915', DeathCounts, ram[CurSaveSlot]);
    FormatDecimalByte(ram[DeathCounts + ram[CurSaveSlot]]);
    for (x = 2; ;) { ram[DynTileBuf + 22 + x] = ram[0x01 + x]; x--; if (!$br('Z_02:3924', x >= 0)) break; }
  }
  return IncLine();
}

// @IncLine of DrawCredits.
function IncLine() {
  ram[CreditsLineIndex]++;
}
