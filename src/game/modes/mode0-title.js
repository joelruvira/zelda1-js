// Mode 0: title screen and demo driver (Z_02). Package P23.
//   InitMode0 -> InitDemo_RunTasks (one task per frame, by DemoPhase/DemoSubphase)
//   UpdateMode -> UpdateMode0Demo -> AnimateDemo (title: phase 0; story: phase 1, mode0-story.js)
//   Start -> UpdateMode0Demo_Sub0 -> _Sub1 (P24) -> _Sub2 -> mode 1 (file select menu)
// Every table (sprites, palettes, transfer records, delays) is read from the ROM by label.

import { ram, cpu, word } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  DemoPhase, DemoSubphase, GameSubmode, SkippedDemo, IsUpdatingMode, ButtonsPressed,
  TransferredDemoPatterns, SongRequest, GameMode, TileBufSelector, CurSaveSlot, IsSaveSlotActive,
  DeathCounts, QuestNumbers, SaveSlotHearts, Names, DynTileBuf, DynTileBufLen, DemoLineTextIndex,
  DemoItemRow, TriforceGlowTimer, InitializedWaterfallAnimation, DemoPhase0Subphase1Cycle, ObjState,
  SwitchNameTablesReq, CurVScroll, FrameCounter, DemoTimer, Sprites, TriforceGlowCycle, TitleWaveYs,
  DemoPhase0Subphase1Timer, DemoItemIds,
} from '../../core/vars.js';
import { TurnOffAllVideo, TurnOffVideoAndClearArtifacts, HideAllSprites } from '../boot.js';
import { SilenceAllSound } from '../audio/requests.js';
import { FetchFileAAddressSet, FormatFileA } from '../save/files.js';
import { UpdateMode0Demo_Sub1 } from './mode1-fileselect.js';
import {
  AnimateDemoPhase1Subphase0, AnimateDemoPhase1Subphase1, AnimateDemoPhase1Subphase2,
  AnimateDemoPhase1Subphase3, AnimateDemoPhase1Subphase4,
} from './mode0-story.js';
import { $br, $pxa } from '../../core/timing.js';

const rom = () => bus.rom;

// ------------------------------------------------------------------ init tasks

let initPhase0Handlers;
let initPhase1Handlers;

export function InitDemo_RunTasks() {
  // InitDemo_RunTasks (Z_02)
  TurnOffAllVideo();
  if ($br('Z_02:183', ram[DemoPhase] !== 0)) return InitDemo_Phase1(); // BNE InitDemo_Phase1
  initPhase0Handlers ??= [InitDemoSubphaseClearArtifacts, InitDemoSubphaseTransferTitlePalette,
    InitDemoSubphasePlayTitleSong];
  return tableJump(label('InitDemo_RunTasks_Phase0_JumpTable').addr, ram[DemoSubphase], initPhase0Handlers);
}

export function InitDemo_Phase1() {
  // InitDemo_Phase1 (Z_02): internal label of InitDemo_RunTasks
  initPhase1Handlers ??= [InitDemoSubphaseClearArtifacts, InitDemoSubphaseTransferStoryPalette,
    InitDemoSubphaseTransferStoryTiles];
  return tableJump(label('InitDemo_RunTasks_Phase1_JumpTable').addr, ram[DemoSubphase], initPhase1Handlers);
}

export function InitDemoSubphaseClearArtifacts() {
  // InitDemoSubphaseClearArtifacts (Z_02)
  TurnOffVideoAndClearArtifacts();
  return IncSubphase(); // falls through
}

export function IncSubphase() {
  // IncSubphase (Z_02)
  ram[DemoSubphase]++;
}

export function InitDemoSubphaseTransferTitlePalette() {
  // InitDemoSubphaseTransferTitlePalette (Z_02)
  let x = 0x23; // write a tile buf record for the title palette
  ram[0x0300] = x; // STX $0300
  ram[DynTileBufLen] = x;
  const rec = table(rom(), 'TitlePaletteTransferRecord');
  for (;;) { $pxa('Z_02:462', rec.addr, x); ram[DynTileBuf + x] = rec.byte(x); x--; if (!$br('Z_02:465', x >= 0)) break; }
  // Reset variables used in this phase.
  ram[DemoLineTextIndex] = 0;
  ram[DemoItemRow] = 0;
  for (x = 0x0a; ;) {
    ram[TriforceGlowTimer + x] = 0;
    ram[InitializedWaterfallAnimation + x] = 0;
    ram[DemoPhase0Subphase1Cycle + x] = 0;
    x--; if (!$br('Z_02:476', x >= 0)) break;
  }
  for (x = 0x0a; ;) { ram[ObjState + x] = 0xff; x--; if (!$br('Z_02:483', x !== 0)) break; } // mark objects 1 to 10 disabled
  return IncSubphase(); // JMP IncSubphase
}

export function InitDemoSubphasePlayTitleSong() {
  // InitDemoSubphasePlayTitleSong (Z_02)
  ram[SongRequest] = 0x80; // title song
  // Transfer buffer 8 (offset $10 in TransferBufAddrs): title nametables and attributes.
  return EndInitDemo(0x10);
}

export function InitDemoSubphaseTransferStoryPalette() {
  // InitDemoSubphaseTransferStoryPalette (Z_02)
  let x = 0x23;
  ram[0x0300] = x; // STX $0300
  ram[DynTileBufLen] = x;
  const rec = table(rom(), 'StoryPaletteTransferRecord');
  for (;;) { $pxa('Z_02:508', rec.addr, x); ram[DynTileBuf + x] = rec.byte(x); x--; if (!$br('Z_02:511', x >= 0)) break; }
  // Reset variables used in this phase ($0412, $041F, $0437, $0444 + 0..$0A).
  for (x = 0x0a; ;) {
    ram[TriforceGlowTimer + x] = 0; // $0412
    ram[InitializedWaterfallAnimation + x] = 0; // $041F
    ram[DemoPhase0Subphase1Cycle + x] = 0; // $0437
    ram[DemoItemIds + x] = 0; // $0444
    x--; if (!$br('Z_02:521', x >= 0)) break;
  }
  return IncSubphase(); // JMP IncSubphase
}

export function InitDemoSubphaseTransferStoryTiles() {
  // InitDemoSubphaseTransferStoryTiles (Z_02)
  ram[SwitchNameTablesReq]++;
  ram[CurVScroll] = 0x10;
  // Transfer buffer 1 (offset 2): story nametables and attributes.
  return EndInitDemo(0x02); // falls through
}

/** A = TileBufSelector value. */
export function EndInitDemo(a) {
  // EndInitDemo (Z_02)
  ram[TileBufSelector] = a;
  ram[DemoSubphase] = 0;
  ram[IsUpdatingMode]++;
}

// ------------------------------------------------------------------ update

let updateHandlers;

export function UpdateMode0Demo() {
  // UpdateMode0Demo (Z_02): only animate if submode = 0 and SkippedDemo = 0.
  if (!$br('Z_02:203', ram[GameSubmode] !== 0) && !$br('Z_02:205', ram[SkippedDemo] !== 0)) {
    AnimateDemo();
    if ($br('Z_02:208', ram[IsUpdatingMode] === 0)) return; // BEQ Exit
  }
  // @HandleSubmodes
  updateHandlers ??= [UpdateMode0Demo_Sub0, UpdateMode0Demo_Sub1, UpdateMode0Demo_Sub2];
  return tableJump(label('UpdateMode0Demo_JumpTable').addr, ram[GameSubmode], updateHandlers);
}

export function UpdateMode0Demo_Sub0() {
  // UpdateMode0Demo_Sub0 (Z_02)
  const a = ram[ButtonsPressed] & 0x10;
  if ($br('Z_02:222', a === 0)) return; // Start not pressed: Exit
  ram[TransferredDemoPatterns] = a; // $10: convenient and not $A5
  ram[SongRequest] = 0;
  SilenceAllSound();
  ram[SkippedDemo] = 0x5a;
  ram[GameSubmode]++;
  TurnOffAllVideo();
  HideAllSprites();
  ram[TileBufSelector] = 0x12; // transfer record for menu palettes
}

export function UpdateMode0Demo_Sub2() {
  // UpdateMode0Demo_Sub2 (Z_02)
  // Copy data from each save file A to save slot info; format each inactive file A.
  TurnOffAllVideo();
  ram[CurSaveSlot] = 0;
  FetchFileAAddressSet();
  let y = 0x02;
  for (;;) {
    // @LoopFormatSlot
    $pxa('Z_02:249', word(0x06), y);
    const a = read((word(0x06) + y) & 0xffff);
    ram[IsSaveSlotActive + y] = a;
    if (!$br('Z_02:251', a !== 0)) {
      const saved = y; // TYA / PHA
      ram[CurSaveSlot] = y;
      FetchFileAAddressSet();
      FormatFileA();
      ram[CurSaveSlot] = 0;
      // Fetch slot 0's address set again to keep using IsSaveSlotActive as a table base.
      FetchFileAAddressSet();
      y = saved; // PLA / TAY
    }
    // @NextFormatSlot
    $pxa('Z_02:271', word(0x0a), y);
    ram[DeathCounts + y] = read((word(0x0a) + y) & 0xffff);
    $pxa('Z_02:273', word(0x0c), y);
    ram[QuestNumbers + y] = read((word(0x0c) + y) & 0xffff);
    y = (y - 1) & 0xff;
    if (!$br('Z_02:276', !(y & 0x80))) break;
  }

  y = 0x18; // hearts value in the Items block
  let x = 0; // even: hearts value; odd: heart partial
  for (;;) {
    // @LoopHeart
    $pxa('Z_02:281', word(0x00), y);
    let a = read((word(0x00) + y) & 0xffff);
    if (!$br('Z_02:288', (x & 1) !== 0)) {
      // Hearts value: make the hearts equal the heart containers.
      a &= 0xf0;
      ram[0x0c] = a;
      a = (a >> 4) | ram[0x0c];
    }
    // @StoreValue
    ram[SaveSlotHearts + x] = a;
    y = (y + 1) & 0xff;
    x++;
    if ($br('Z_02:314', x === 0x06)) break; // @CopyNames
    if ($br('Z_02:317', (x & 1) !== 0)) continue; // odd: go process the heart partial
    y = (y + 0x26) & 0xff; // C = 0 (LSR of an even X): the next slot's hearts value
  }

  // @CopyNames
  for (y = 0x17; ;) {
    $pxa('Z_02:330', word(0x04), y);
    ram[Names + y] = read((word(0x04) + y) & 0xffff);
    y = (y - 1) & 0xff;
    if (!$br('Z_02:333', y < 0x80)) break;
  }
  ram[GameMode]++; // go to the next game mode (menu)
  ram[IsUpdatingMode] = 0;
  ram[GameSubmode] = 0;
}

// ------------------------------------------------------------------ animation

let animPhase0Handlers;
let animPhase1Handlers;

export function AnimateDemo() {
  // AnimateDemo (Z_02)
  if ($br('Z_02:342', ram[DemoPhase] !== 0)) return AnimateDemo_Phase1();
  animPhase0Handlers ??= [AnimateDemoPhase0Subphase0, AnimateDemoPhase0Subphase1];
  return tableJump(label('AnimateDemo_Phase0_JumpTable').addr, ram[DemoSubphase], animPhase0Handlers);
}

export function AnimateDemo_Phase1() {
  // AnimateDemo_Phase1 (Z_02): internal label of AnimateDemo
  animPhase1Handlers ??= [AnimateDemoPhase1Subphase0, AnimateDemoPhase1Subphase1,
    AnimateDemoPhase1Subphase2, AnimateDemoPhase1Subphase3, AnimateDemoPhase1Subphase4];
  return tableJump(label('AnimateDemo_Phase1_JumpTable').addr, ram[DemoSubphase], animPhase1Handlers);
}

export function AnimateDemoPhase0Subphase0() {
  // AnimateDemoPhase0Subphase0 (Z_02): animate while waiting about 512 frames.
  if (!$br('Z_02:544', (ram[FrameCounter] & 0x01) === 0)) { // the timer is incremented every other frame
    ram[DemoTimer]++;
    if (!$br('Z_02:547', ram[DemoTimer] !== 0)) return IncSubphase();
  }
  // @SkipTimer
  AnimateDemoPhase0Subphase0Artifacts();
}

export function AnimateDemoPhase0Subphase0Artifacts() {
  // AnimateDemoPhase0Subphase0Artifacts (Z_02)
  // Copy the initial title sprites to the Sprites area.
  const spr = table(rom(), 'InitialTitleSprites');
  for (let y = 0x70; ;) { $pxa('Z_02:1015', spr.addr - 1, y); ram[Sprites - 1 + y] = spr.byte(y - 1); y--; if (!$br('Z_02:1018', y !== 0)) break; }
  UpdateWaterfallAnimation();

  // At the end of the glow cycle, append a transfer record for the triforce palette.
  if (!$br('Z_02:1024', ram[TriforceGlowTimer] !== 0)) {
    const rec = table(rom(), 'TriforcePaletteTransferRecord');
    for (let y = 0x07; ;) { $pxa('Z_02:1028', rec.addr, y); ram[DynTileBuf + y] = rec.byte(y); y--; if (!$br('Z_02:1031', y >= 0)) break; }
    $pxa('Z_02:1036', table(rom(), 'TriforceGlowingColors').addr, ram[TriforceGlowCycle]);
    // Patch the record with the color for the current point in the cycle.
    ram[DynTileBuf + 5] = table(rom(), 'TriforceGlowingColors').byte(ram[TriforceGlowCycle]);
    ram[TriforceGlowTimer] = 0x06;
    ram[TriforceGlowCycle]++;
    if (!$br('Z_02:1043', ram[TriforceGlowCycle] !== 0x08)) {
      ram[TriforceGlowTimer] = 0x10; // delay twice as long for one step
      ram[TriforceGlowCycle] = 0x00;
    }
  }
  // @DecGlowTimer
  ram[TriforceGlowTimer]--;
}

export function UpdateWaterfallAnimation() {
  // UpdateWaterfallAnimation (Z_02)
  if (!$br('Z_02:1070', ram[InitializedWaterfallAnimation] !== 0)) {
    ram[TitleWaveYs + 0] = 0xb6;
    ram[TitleWaveYs + 1] = 0xc8;
    ram[TitleWaveYs + 2] = 0xd8;
    // Unused by the demo (maybe the waterfall used to be bigger).
    ram[TitleWaveYs + 3] = 0xc0;
    ram[TitleWaveYs + 4] = 0xd0;
    ram[TitleWaveYs + 5] = 0xdd;
    ram[InitializedWaterfallAnimation]++;
  }
  // @UpdateSprites
  for (let x = 0x02; ;) { UpdateSpritesForWaterfallWave(x); x--; if (!$br('Z_02:1094', x >= 0)) break; }
  UpdateSpritesForWaterfallCrest();
}

/** X = wave index (kept). Leaves cpu.c as the original (UpdateSpritesForWaterfallCrest's ADC uses it). */
export function UpdateSpritesForWaterfallWave(x) {
  // UpdateSpritesForWaterfallWave (Z_02): add 2 to the wave Y, keeping it in $B2..$E2.
  ram[TitleWaveYs + x] += 2;
  $pxa('Z_02:1103', TitleWaveYs, x);
  let a = ram[TitleWaveYs + x];
  cpu.cmp(a, 0xe3);
  if (!$br('Z_02:1105', !cpu.c)) {
    a = 0xb2;
    ram[TitleWaveYs + x] = a;
  }
  ram[0x05] = a;
  // Tile offset by wave Y: < $B9 -> 0, < $C2 -> 8, else $10.
  let y = a;
  a = 0x10;
  cpu.cmp(y, 0xc2);
  if (!$br('Z_02:1120', !!cpu.c)) {
    a = cpu.lsr(a);
    cpu.cmp(y, 0xb9);
    if (!$br('Z_02:1123', !!cpu.c)) a = 0x00;
  }
  // @SetOffset
  ram[0x00] = a;
  ram[0x02] = x;
  const tiles = table(rom(), 'WaterfallWaveTiles');
  const xs = table(rom(), 'WaterfallSpriteXs');
  $pxa('Z_02:1129', table(rom(), 'WaterfallWaveSpriteOffsets').addr, x);
  y = table(rom(), 'WaterfallWaveSpriteOffsets').byte(x);
  for (x = 0x03; ;) {
    $pxa('Z_02:1133', tiles.addr, x); $pxa('Z_02:1137', xs.addr, x);
    cpu.c = 0; // CLC
    ram[Sprites + 1 + y] = cpu.adc(tiles.byte(x), ram[0x00]);
    ram[Sprites + 3 + y] = xs.byte(x);
    ram[Sprites + y] = ram[0x05];
    ram[Sprites + 2 + y] = 0x00; // normal, palette 4
    y = (y + 4) & 0xff;
    x--; if (!$br('Z_02:1148', x >= 0)) break;
  }
  return ram[0x02]; // LDX $02
}

export function UpdateSpritesForWaterfallCrest() {
  // UpdateSpritesForWaterfallCrest (Z_02): switch between two frames every 16 frames.
  // ADC without CLC: the carry comes from the last wave's ADC (as in the original).
  const tiles = table(rom(), 'WaterfallCrestTiles');
  const xs = table(rom(), 'WaterfallSpriteXs');
  let y = 0xf0;
  for (let x = 0x03; ;) {
    $pxa('Z_02:1161', tiles.addr, x); $pxa('Z_02:1165', xs.addr, x);
    ram[Sprites + 1 + y] = cpu.adc(ram[FrameCounter] & 0x08, tiles.byte(x));
    ram[Sprites + y] = 0xa8; // fixed Y
    ram[Sprites + 3 + y] = xs.byte(x);
    ram[Sprites + 2 + y] = 0x00; // normal, palette 4
    y = (y + 4) & 0xff;
    x--; if (!$br('Z_02:1174', x >= 0)) break;
  }
}

export function AnimateDemoPhase0Subphase1() {
  // AnimateDemoPhase0Subphase1 (Z_02): palette cycle, then go to the story (phase 1).
  if (!$br('Z_02:1254', ram[DemoPhase0Subphase1Timer] !== 0)) {
    // Addr = DemoPhase0Subphase1Palettes + DemoPhase0Subphase1Cycle * $20
    ram[0x01] = 0;
    let a = ram[DemoPhase0Subphase1Cycle];
    a = cpu.asl(a);
    a = cpu.asl(a);
    a = cpu.asl(a);
    a = cpu.asl(a);
    cpu.rolMem(0x01);
    a = cpu.asl(a);
    cpu.rolMem(0x01);
    const base = label('DemoPhase0Subphase1Palettes').addr;
    ram[0x00] = cpu.adc(a, base & 0xff);
    ram[0x01] = cpu.adc(ram[0x01], base >> 8);
    ram[DynTileBuf] = 0x3f; // record header
    ram[DynTileBuf + 1] = 0x00;
    ram[DynTileBuf + 2] = 0x20;
    let y = 0x1f;
    ram[DynTileBuf + 4 + y] = 0xff; // end marker
    const src = word(0x00);
    for (;;) {
      $pxa('Z_02:1284', src, y);
      ram[DynTileBuf + 3 + y] = read((src + y) & 0xffff);
      y--; if (!$br('Z_02:1287', y >= 0)) break;
    }
    ram[DemoPhase0Subphase1Cycle]++;
    y = ram[DemoPhase0Subphase1Cycle];
    const delays = table(rom(), 'DemoPhase0Subphase1Delays');
    $pxa('Z_02:1294', delays.addr - 1, y);
    ram[DemoPhase0Subphase1Timer] = delays.byte(y - 1);
    cpu.cmp(y, 0x0e);
    if (!$br('Z_02:1297', !cpu.c)) {
      // End of the cycle: advance to the next demo phase, to be initialized.
      ram[DemoPhase]++;
      ram[DemoSubphase] = 0;
      ram[IsUpdatingMode] = 0;
    }
  }
  // @UpdateAnimation
  ram[DemoPhase0Subphase1Timer]--;
  UpdateWaterfallAnimation();
}
