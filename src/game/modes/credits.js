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

/** UpdateMode13WinGame_Sub3 (Z_02): scroll the credits; stop at the last screen of the quest. */
export function UpdateMode13WinGame_Sub3() {
  // UpdateMode13WinGame_Sub3 (Z_02)
  // After scrolling 8 pixels, draw another tile row (CMP #$08 / BMI: signed).
  if (((ram[CreditsTileOffset] - 0x08) & 0x80) === 0) {
    ram[CreditsTileOffset] = ram[CreditsTileOffset] - 0x08; // SBC with C = 1 from the CMP
    DrawCredits();
  }
  // Add $80 to the scroll speed fraction; carry to the tile offset and the V-scroll.
  let sum = ram[VScrollAddrHi] + 0x80;
  ram[VScrollAddrHi] = sum;
  let c = sum >> 8;
  if (c) ram[CreditsTileOffset]++;
  sum = ram[CurVScroll] + c;
  let a = sum & 0xff;
  ram[CurVScroll] = a;
  // At the bottom of a nametable, roll the V-scroll over and switch nametables.
  c = a >= 0xf0 ? 1 : 0;
  if (c) {
    ram[CurVScroll] = 0x00;
    ram[VScrollAddrLo]++;
  }
  ram[SwitchNameTablesReq] = c; // LDA #0 / ROL
  let y = 0;
  if (ram[QuestNumbers + ram[CurSaveSlot]] !== 0) y++;
  // Not the last screen, or not the last amount in it: return.
  if (ram[VScrollAddrLo] < table(bus.rom, 'CreditsLastScreenList').byte(y)) return;
  if (ram[CurVScroll] < table(bus.rom, 'CreditsLastVscrollList').byte(y)) return;
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
  for (let y = 0x1f; y >= 0; y--) ram[DynTileBuf + 3 + y] = 0x24;
  const row = ram[CreditsRow];
  // Row 0: no walls. Rows 1 and $2E: horizontal walls. Rows 2 to $2D: side walls.
  if (row !== 0) {
    if (row === 0x01 || row === 0x2e) {
      // @WriteHorizontalWalls
      for (let y = 0x19; y >= 0; y--) ram[DynTileBuf + 6 + y] = 0xfa;
    }
    if (row <= 0x2e) {
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
  ram[DynTileBuf] = table(bus.rom, 'CreditLineVramAddrsHi').byte(x);
  let a = ram[CreditsVramLine];
  let y = a;
  ram[DynTileBuf + 1] = (a << 5) & 0xff;
  // Shift the page mask (line + 1) times: the bit that says whether this line has text.
  a = table(bus.rom, 'CreditsPagesTextMasks').byte(x);
  let c;
  do {
    c = a >> 7;
    a = (a << 1) & 0xff;
    y = (y - 1) & 0xff;
  } while (!(y & 0x80));
  if (c) DrawCreditsTextLine();
  // @IncVramLine
  ram[CreditsVramLine]++;
  // 8 lines per VRAM page, except 6 in pages $23xx and $2Bxx ((page MOD 4) = 3).
  a = (ram[CreditsVramPage] & 0x03) >= 0x03 ? 0x06 : 0x08;
  if (a === ram[CreditsVramLine]) {
    ram[CreditsVramLine] = 0x00;
    y = (ram[CreditsVramPage] + 1) & 0xff;
    if (y >= 0x0c) y = 0x00; // TAY with A = 0
    ram[CreditsVramPage] = y;
  }
  // @WriteAttributes: every 4 rows, a record of NT attributes.
  a = ram[CreditsRow];
  if ((a & 0x03) === 0) {
    a >>= 2;
    x = 0x00;
    ram[DynTileBuf + 38] = x; // left and right blocks
    ram[DynTileBuf + 45] = x;
    y = a;
    a = table(bus.rom, 'CreditsAttrs').byte(y);
    for (y = 5; y >= 0; y--) ram[DynTileBuf + 39 + y] = a;
    y = (ram[DynTileBuf] & 0x08) ? 0x2b : 0x23; // NT 1 or NT 0 attribute space
    ram[DynTileBuf + 35] = y;
    a = (ram[CreditsRow] & 0x1f) << 1; // carry clear: bit 7 was 0
    ram[DynTileBuf + 36] = (a + 0xc0) & 0xff;
    ram[DynTileBuf + 37] = 0x08;
  }
  // @IncRow: skip the last two rows of each $20 (240 pixels, not 256).
  y = (ram[CreditsRow] + 1) & 0xff;
  if ((y & 0x1f) >= 0x1e) y = (y + 2) & 0xff;
  ram[CreditsRow] = y;
}

// The part of DrawCredits between the mask test and @IncLine / @IncVramLine.
function DrawCreditsTextLine() {
  let y = ram[CreditsLineIndex];
  if (y >= 0x17) return; // @IncVramLine
  // First quest: no lines >= $10. Second quest: skip lines $C to $F.
  if (ram[QuestNumbers + ram[CurSaveSlot]] === 0) {
    if (y >= 0x10) return IncLine();
  } else if (y >= 0x0c && y < 0x10) {
    return IncLine();
  }
  ram[0x00] = table(bus.rom, 'CreditsTextAddrsLo').byte(y);
  ram[0x01] = table(bus.rom, 'CreditsTextAddrsHi').byte(y);
  const ptr = ram[0x00] | (ram[0x01] << 8);
  y = 0;
  ram[0x02] = read(ptr + y); // length of the string
  y++;
  let x = read(ptr + y); // offset of the first character in the line
  y++;
  do {
    ram[DynTileBuf + 3 + x] = read(ptr + y);
    y = (y + 1) & 0xff;
    x = (x + 1) & 0xff;
    ram[0x02]--;
  } while (ram[0x02] !== 0);
  y = ram[CreditsLineIndex];
  if (y >= 0x0c && y === 0x11) {
    // Line $11: the player's name at offset 9 and the death count at offset 19.
    y = (ram[CurSaveSlot] << 3) & 0xff;
    x = 0;
    do {
      ram[DynTileBuf + 12 + x] = ram[Names + y];
      y = (y + 1) & 0xff;
      x++;
    } while (x < 0x08);
    FormatDecimalByte(ram[DeathCounts + ram[CurSaveSlot]]);
    for (x = 2; x >= 0; x--) ram[DynTileBuf + 22 + x] = ram[0x01 + x];
  }
  return IncLine();
}

// @IncLine of DrawCredits.
function IncLine() {
  ram[CreditsLineIndex]++;
}
