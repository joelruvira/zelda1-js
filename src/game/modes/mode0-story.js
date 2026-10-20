// Mode 0, demo phase 1: the story scroll and the parade of items (Z_02). Package P23.
//   AnimateDemo_Phase1_JumpTable: Subphase0 (scroll to the text) -> 1 (wait) -> 2 (scroll text and
//   items, ProcessDemoLine*) -> 3/4 (wait with the final items) -> back to phase 0 (title).
// Line attributes, item lists, text fields and sprite tables are read from the ROM by label.

import { ram, cpu, word } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  FrameCounter, CurVScroll, ScrolledScreenCount, SwitchNameTablesReq, DemoSubphase, DemoTimer,
  DemoLineTileVramAddrHi, DemoLineTileVramAddrLo, DemoLineAttrVramAddrHi, DemoLineAttrVramAddrLo,
  ObjY, ObjX, ObjState, ScrolledLineCount, DynTileBuf, DemoLineIndex, DemoLineTextIndex, DemoItemRow,
  DemoItemIds, Sprites, IsUpdatingMode, DemoPhase,
} from '../../core/vars.js';
import { HideAllSprites } from '../boot.js';
import { Anim_FetchObjPosForSpriteDescriptor } from '../draw/anim.js';
import { Anim_SetSpriteDescriptorRedPaletteRow } from '../draw/sprites.js';
import { Anim_WriteItemSprites } from '../draw/items.js';
import { AnimateItemObject } from '../items/roomitem.js';

const rom = () => bus.rom;

export function AnimateDemoPhase1Subphase0() {
  // AnimateDemoPhase1Subphase0 (Z_02): scroll down to the text, one line every odd frame.
  if (ram[FrameCounter] & 0x01) {
    ram[CurVScroll]++;
    if (ram[CurVScroll] === 0xf0) { // bottom of nametable 2 = top of nametable 0
      ram[ScrolledScreenCount]++;
      ram[CurVScroll] = 0x00;
      ram[SwitchNameTablesReq]++;
    }
  }
  // @CheckVScroll: done after the bottom, the wrap and 8 more lines.
  if (ram[CurVScroll] !== 0x08) return;
  if (ram[ScrolledScreenCount] === 0) return;
  ram[ScrolledScreenCount] = 0;
  ram[DemoSubphase]++;
}

export function AnimateDemoPhase1Subphase1() {
  // AnimateDemoPhase1Subphase1 (Z_02)
  ram[DemoTimer]++;
  if (ram[DemoTimer] === 0) ram[DemoSubphase]++;
  ram[DemoLineTileVramAddrHi] = 0x29;
  ram[DemoLineTileVramAddrLo] = 0x00;
  ram[DemoLineAttrVramAddrHi] = 0x2b;
  ram[DemoLineAttrVramAddrLo] = 0xe0;
}

export function AnimateDemoPhase1Subphase2() {
  // AnimateDemoPhase1Subphase2 (Z_02)
  HideAllSprites();
  DisableFallenObjects();
  Demo_AnimateObjects();
  if ((ram[FrameCounter] & 0x01) === 0) return; // every even frame, just return
  let x;
  for (x = 0x0a; x !== 0; x--) ram[ObjY + x]--; // move every object up
  ram[ScrolledLineCount]++;
  if (ram[ScrolledLineCount] === 0) ram[ScrolledScreenCount]++;
  if (ram[ScrolledScreenCount] === 0x05 && ram[ScrolledLineCount] === 0x80) {
    ram[DemoSubphase]++; // 5.5 screens scrolled
    return;
  }
  // @Scroll
  ram[CurVScroll]++;
  if (ram[CurVScroll] === 0xf0) {
    ram[SwitchNameTablesReq]++;
    ram[CurVScroll] = 0x00;
  }
  // @CheckLine: every 8 lines, check for new text and objects.
  if (ram[ScrolledLineCount] & 0x07) return;
  ProcessDemoLineItems();

  // Append a request to transfer a line, blank by default.
  x = 0x20;
  ram[DynTileBuf + 3 + x] = 0xff;
  for (x--; x >= 0; x--) ram[DynTileBuf + 3 + x] = 0x24;
  ram[DynTileBuf + 2] = 0x20;
  ram[DynTileBuf] = ram[DemoLineTileVramAddrHi];
  let a = ram[DemoLineTileVramAddrLo];
  ram[DynTileBuf + 1] = a;
  a = (a + 0x20) & 0xff; // CLC / ADC #$20: the next line is 32 bytes farther
  ram[DemoLineTileVramAddrLo] = a;
  if (a === 0) {
    ram[DemoLineTileVramAddrHi]++; // crossed a page
  } else if (a === 0xc0) {
    // @CheckNTEnd: $2BC0 -> $2000, $23C0 -> $2800
    a = ram[DemoLineTileVramAddrHi];
    let reset = false;
    if (a === 0x2b) {
      ram[DemoLineTileVramAddrHi] = 0x20;
      reset = true;
    } else if (a === 0x23) {
      ram[DemoLineTileVramAddrHi] = 0x28;
      reset = true;
    }
    if (reset) ram[DemoLineTileVramAddrLo] = 0x00; // @ResetVramLo
  }

  // @CheckText
  x = ram[DemoLineIndex];
  if (table(rom(), 'DemoLineAttrs').byte(x) & 0x80) {
    x = (ram[DemoLineTextIndex] << 1) & 0xff;
    let y = 0x00;
    const addrs = table(rom(), 'DemoLineTextAddrs');
    ram[0x00] = addrs.byte(x);
    ram[0x01] = addrs.byte(x + 1);
    const src = word(0x00);
    x = read(src); // first byte: offset into the line
    for (;;) {
      // @CopyLine
      y = (y + 1) & 0xff;
      a = read((src + y) & 0xffff);
      if (a === 0xff) break;
      ram[DynTileBuf + 3 + x] = a;
      x = (x + 1) & 0xff;
    }
    ram[DemoLineTextIndex]++; // @EndLine
  }
  // @ProcessAttrs
  ProcessDemoLineAttrs();
  ram[DemoLineIndex]++;
}

export function ProcessDemoLineAttrs() {
  // ProcessDemoLineAttrs (Z_02)
  const x = ram[DemoLineIndex];
  if ((table(rom(), 'DemoLineAttrs').byte(x) & 0x40) === 0) return;
  // Append a second transfer record, for nametable attributes (8 zeroes).
  ram[DynTileBuf + 35] = ram[DemoLineAttrVramAddrHi];
  ram[DynTileBuf + 36] = ram[DemoLineAttrVramAddrLo];
  ram[DynTileBuf + 37] = 0x48;
  ram[DynTileBuf + 38] = 0x00;
  ram[DynTileBuf + 39] = 0xff;
  ram[0x0416]++; // UNKNOWN: doesn't seem to be used
  const a = (ram[DemoLineAttrVramAddrLo] + 0x08) & 0xff;
  ram[DemoLineAttrVramAddrLo] = a;
  if (a !== 0) return;
  // End of the attributes: $2C00 -> $23C0, $2400 -> $2BC0.
  ram[DemoLineAttrVramAddrHi] = ram[DemoLineAttrVramAddrHi] === 0x23 ? 0x2b : 0x23;
  ram[DemoLineAttrVramAddrLo] = 0xc0; // @SetVramLo
}

export function DisableFallenObjects() {
  // DisableFallenObjects (Z_02): objects 1..10 that fell off the top ($F0) are disabled.
  for (let x = 0x0a; x !== 0; x--) {
    if (ram[ObjY + x] === 0xf0) ram[ObjState + x] = 0xff;
  }
}

export function ProcessDemoLineItems() {
  // ProcessDemoLineItems (Z_02): attribute $20 instantiates new objects.
  let y = ram[DemoLineIndex];
  if ((table(rom(), 'DemoLineAttrs').byte(y) & 0x20) === 0) return;
  // @MakeObject: look for the first disabled object (no bound, like the original).
  let x = 0x0a;
  while (ram[ObjState + x] === 0) x = (x - 1) & 0xff;
  // @SetUpObject
  const left = table(rom(), 'DemoLeftItemIds');
  y = ram[DemoItemRow];
  ram[DemoItemIds + x] = left.byte(y); // item on the left
  ram[ObjY + x] = 0xef; // bottom of the screen
  ram[ObjX + x] = table(rom(), 'DemoItemColumnX1').byte(0);
  ram[ObjState + x] = 0x00;
  if (ram[DemoItemIds + x] >= 0x30) {
    ram[ObjX + x] = 0x68; // @CenterLink: Link's special item is centered
  } else {
    x = (x - 1) & 0xff; // another object for the item on the right
    ram[DemoItemIds + x] = table(rom(), 'DemoRightItemIds').byte(y);
    ram[ObjY + x] = 0xef;
    ram[ObjX + x] = table(rom(), 'DemoItemColumnX2').byte(0);
    ram[ObjState + x] = 0x00;
    if (left.byte(y) === 0x1b) {
      // The triforce is in both columns: center both (overlapping) objects.
      ram[ObjX + x] = 0x78;
      ram[ObjX + 1 + x] = 0x78;
      ram[0x0430] = 0x00; // UNKNOWN: doesn't seem to be used
    }
  }
  // @IncRow
  ram[DemoItemRow]++;
}

export function Demo_AnimateObjects() {
  // Demo_AnimateObjects (Z_02): objects 1..10
  for (let x = 0x0a; x !== 0; x--) {
    if (ram[ObjState + x] !== 0) continue; // disabled
    const saved = x; // TXA / PHA
    const a = ram[DemoItemIds + x];
    if (a === 0x23) AnimateStationaryFairy(x);
    else if (a < 0x30) AnimateItemObject(a, x);
    else AnimateDemoStoryFinalItems(x); // Link's special items and the sheet of paper
    x = saved; // PLA / TAX
  }
}

/** Unreferenced, unverified code at $97C5 (A = input). */
export function Unused_97C5(a) {
  // Unused_97C5 (Z_02)
  let x = 0x04;
  if (a === 0x14) x = 0x0c;
  do {
    ram[Sprites + 80 + x]--;
    x = a; // TAX
    cpu.c = 1; // SEC
    a = cpu.sbc(a, 0x04);
    x = a; // TAX
  } while (!(a & 0x80));
}

/** X = object index. */
export function AnimateStationaryFairy(x) {
  // AnimateStationaryFairy (Z_02)
  Anim_FetchObjPosForSpriteDescriptor(x);
  let a = Anim_SetSpriteDescriptorRedPaletteRow(); // A = 2 (palette 6)
  a = (a << 1) & ram[FrameCounter]; // every 4 frames, switch between 2 frames
  ram[0x0c] = a >> 2;
  return Anim_WriteItemSprites(x, 0x14);
}

/** X = object index. */
export function AnimateDemoStoryFinalItems(x) {
  // AnimateDemoStoryFinalItems (Z_02): low nibble of the item id = row of 6 sprites.
  let a = (ram[DemoItemIds + x] & 0x0f) << 1;
  ram[0x00] = a;
  a = (a << 1) + ram[0x00];
  let y = a & 0xff; // (id & $0F) * 6
  ram[0x00] = ram[ObjY + x];
  ram[0x01] = ram[ObjX + x];
  ram[0x02] = 0x05; // 6 sprites
  x = (y << 2) & 0xff; // sprite offset (index * 4)
  const tiles = table(rom(), 'DemoStoryFinalSpriteTiles');
  const attrs = table(rom(), 'DemoStoryFinalSpriteAttrs');
  do {
    a = tiles.byte(y);
    if (a !== 0) {
      ram[Sprites + 1 + x] = a;
      ram[Sprites + x] = ram[0x00];
      ram[Sprites + 2 + x] = attrs.byte(y);
      ram[Sprites + 3 + x] = ram[0x01];
      x = (x + 4) & 0xff;
    }
    // @SkipSprite
    ram[0x01] = ram[0x01] + 0x08;
    y = (y + 1) & 0xff;
    ram[0x02]--;
  } while (!(ram[0x02] & 0x80));
}

export function AnimateDemoPhase1Subphase3() {
  // AnimateDemoPhase1Subphase3 (Z_02): delay about 256 frames.
  ram[DemoTimer]++;
  if (ram[DemoTimer] !== 0) return AnimateDemoPhase1End_AnimateObjects();
  ram[DemoSubphase]++;
}

export function AnimateDemoPhase1Subphase4() {
  // AnimateDemoPhase1Subphase4 (Z_02): delay 56 frames, then back to phase 0 (initialized again).
  ram[DemoTimer]++;
  if (ram[DemoTimer] !== 0x39) return AnimateDemoPhase1End_AnimateObjects();
  ram[IsUpdatingMode] = 0;
  ram[DemoTimer] = 0;
  ram[DemoPhase] = 0;
  ram[DemoSubphase] = 0;
}

export function AnimateDemoPhase1End_AnimateObjects() {
  // AnimateDemoPhase1End_AnimateObjects (Z_02): shared tail of Subphase3/4
  HideAllSprites();
  Demo_AnimateObjects();
}
