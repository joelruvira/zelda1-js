// P25: every ported routine of modes 8, $11, $12 and $13 vs. the original 6502 code (jsnes CPU on the
// port's machine, see p01-hybrid.mjs) from the same random RAM/SRAM/PPU states: RAM (but the stack),
// SRAM, VRAM, palette, PPU registers and MMC1 must be identical, and the returned registers where a
// caller uses them. Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canRunHybrid, runOriginal } from './p01-hybrid.mjs';
import { loadSymbols, loadRom, label } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram, cpu } from '../../src/core/ram.js';
import { bus } from '../../src/core/bus.js';
import { switchBank } from '../../src/core/asm.js';
import { ROM_PATH } from '../core/helpers.mjs';
import {
  CurSaveSlot, GameSubmode, ButtonsPressed, ObjTimer, ObjDir, DeathModeCounter, CurLevel, RoomId,
  World_IsFillingHearts, ObjX, ObjY, Song, TextboxCharIndex, TextboxCharPtr, ItemLiftTimer,
  EndingFlashLongTimer, PeaceCharDelayCounter, PeaceCharIndex, CreditsTileOffset, VScrollAddrHi,
  VScrollAddrLo, CurVScroll, QuestNumbers, CreditsRow, CreditsVramPage, CreditsVramLine, CreditsLineIndex,
  DeathCounts, ObjInvincibilityTimer, CurRow, Item_ObjItemLifetime, ItemTypeToLift, ObjState, ObjType,
  ObjMetastate, CurColumn, DynTileBufLen, FadeCycle, LevelInfo_WorldFlagsAddr,
} from '../../src/core/vars.js';
import * as m8 from '../../src/game/modes/mode8-continue.js';
import * as m11 from '../../src/game/modes/mode11-death.js';
import * as m12 from '../../src/game/modes/mode12-endlevel.js';
import * as m13 from '../../src/game/modes/mode13-ending.js';
import * as credits from '../../src/game/modes/credits.js';

const skip = !canRunHybrid && 'needs roms/zelda.nes and tools/oracle jsnes';
let machine;
if (canRunHybrid) {
  await loadSymbols();
  machine = createMachine(loadRom(readFileSync(ROM_PATH)));
}

// ROUTINES_SEED (battery): shifts every random stream; 0 = the default states.
const SEED_OFFSET = Number(process.env.ROUTINES_SEED ?? 0) >>> 0;
// ROUTINES_SCALE (battery): multiplies the number of random states per routine.
const ROUTINES_SCALE = Math.max(1, Number(process.env.ROUTINES_SCALE ?? 1));
function rng(seed) {
  let s = (seed + Math.imul(SEED_OFFSET, 0x9e3779b1)) >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return { byte: () => next() & 0xff, int: (n) => next() % n, pick: (a) => a[next() % a.length] };
}

/** CopyCommonCodeToRam and CopyCommonDataToRam, as InitializeGameOrMode leaves WRAM. */
function copyCommon() {
  for (let i = 0; i < 0x1270; i++) sram[0x0c90 + i] = bus.rom.prgByte(1, 0xa500 + i);
  const d = label('MenuPalettesTransferBuf');
  for (let i = 0; i < 0x8e; i++) sram[d.addr - 0x6000 + i] = bus.rom.prgByte(6, d.load + i);
}

const PPU_FIELDS = ['ctrl', 'mask', 'status', 'oamAddr', 'v', 't', 'x', 'w', 'readBuffer', 'mirroring'];
function snapshot() {
  const p = machine.ppu;
  const m = machine.mapper;
  return {
    ram: Uint8Array.from(ram), sram: Uint8Array.from(sram),
    vram: Uint8Array.from(p.vram), pal: Uint8Array.from(p.palette),
    regs: PPU_FIELDS.map((f) => p[f]), mapper: [m.shift, m.control, m.chrBank0, m.chrBank1, m.prgBank],
  };
}
function restore(s) {
  const p = machine.ppu;
  const m = machine.mapper;
  ram.set(s.ram); sram.set(s.sram);
  p.vram.set(s.vram); p.palette.set(s.pal);
  PPU_FIELDS.forEach((f, i) => { p[f] = s.regs[i]; });
  [m.shift, m.control, m.chrBank0, m.chrBank1, m.prgBank] = s.mapper;
}
function firstDiff(a, b, base = 0, skipStack = false) {
  for (let i = 0; i < a.length; i++) {
    if (skipStack && i >= 0x100 && i < 0x200) continue;
    if (a[i] !== b[i]) return `$${(base + i).toString(16)}: port ${a[i].toString(16)} != orig ${b[i].toString(16)}`;
  }
  return null;
}
function assertSame(port, orig, what) {
  assert.equal(firstDiff(port.ram, orig.ram, 0, true), null, `${what}: RAM`);
  assert.equal(firstDiff(port.sram, orig.sram, 0x6000), null, `${what}: SRAM`);
  assert.equal(firstDiff(port.vram, orig.vram, 0x2000), null, `${what}: VRAM`);
  assert.equal(firstDiff(port.pal, orig.pal, 0x3f00), null, `${what}: palette`);
  assert.deepEqual(port.regs, orig.regs, `${what}: PPU registers ${PPU_FIELDS}`);
  assert.deepEqual(port.mapper, orig.mapper, `${what}: MMC1`);
}

/** Random state -> run the original and the port from it -> compare everything. */
function check(name, fn, { seeds = 24, prepare = () => {}, regs = () => ({}), cmpRet, bank } = {}) {
  for (let seed = 1; seed <= seeds * ROUTINES_SCALE; seed++) {
    const r = rng(seed * 7919 + name.length * 31);
    for (let i = 0; i < 0x800; i++) ram[i] = r.byte();
    for (let i = 0; i < 0x2000; i++) sram[i] = r.byte();
    machine.ppu.reset();
    machine.mapper.powerOn();
    copyCommon();
    ram[CurSaveSlot] = r.int(3);
    const reg = regs(r);
    const { bank: b, addr } = label(name);
    switchBank(bank ?? (addr >= 0x8000 && addr < 0xc000 ? b : 5));
    prepare(r, reg);
    const start = snapshot();
    const o = runOriginal(name, reg);
    const orig = snapshot();
    restore(start);
    cpu.c = reg.c ?? 0;
    const ret = fn(reg);
    const port = snapshot();
    assertSame(port, orig, `${name} seed ${seed}`);
    if (cmpRet) cmpRet(ret, o, `${name} seed ${seed}`);
  }
}
const retA = (ret, o, what) => assert.equal(ret & 0xff, o.a, `${what}: A`);

/** A plausible play state: Link on the grid in a valid room, a level 0-9, short timers. */
function playState(r) {
  ram[CurLevel] = r.int(10);
  ram[RoomId] = r.int(0x80);
  ram[ObjX] = 0x10 * r.int(15);
  ram[ObjY] = 0x3d + 8 * r.int(20);
  ram[ObjDir] = r.pick([1, 2, 4, 8]);
  ram[ObjState] = r.pick([0x00, 0x00, 0x40, r.byte()]);
  ram[ObjInvincibilityTimer] = r.pick([0, 0, 1, 0x10, r.byte()]);
  for (let i = 0; i < 0x13; i++) if (r.int(3)) ram[ObjTimer + i] = r.pick([0, 1, 2, r.int(0x40)]);
  ram[Item_ObjItemLifetime + 0x13] = r.pick([0, 0xf0, 0xf1, r.byte()]);
  ram[Item_ObjItemLifetime + 0x02] = r.pick([0, 0xf0, 0xf1, r.byte()]);
  ram[DynTileBufLen] = r.int(0x20);
  ram[CurColumn] = r.pick([0xff, r.int(0x20)]);
  // The world flags pointer is one of the three blocks of the game (WorldFlagBlockAddrs): a random one
  // would make GetRoomFlags read open bus ($4020-$5FFF), which the port and jsnes model differently.
  const flags = r.pick([0x067f, 0x06ff, 0x077f]);
  sram[LevelInfo_WorldFlagsAddr - 0x6000] = flags & 0xff;
  sram[LevelInfo_WorldFlagsAddr - 0x6000 + 1] = flags >> 8;
}

test('P25 mode 8: continue question', { skip }, () => {
  check('InitMode8', () => m8.InitMode8(), {
    seeds: 30, prepare: (r) => { playState(r); ram[GameSubmode] = r.pick([0, 0, 1, r.byte()]); }, cmpRet: retA,
  });
  check('UpdateMode8ContinueQuestion_Full', () => m8.UpdateMode8ContinueQuestion_Full(), {
    seeds: 80,
    prepare: (r) => {
      ram[GameSubmode] = r.pick([0, 1, 2, 0x80, 0x81, 0x82, r.byte()]);
      ram[ButtonsPressed] = r.pick([0, 0x10, 0x20, 0x30, r.byte()]);
      ram[ObjTimer + 1] = r.pick([0, 0, 1, 4, 0x40, r.byte()]);
    },
  });
});

test('P25 mode $11: death', { skip }, () => {
  check('InitMode11', () => m11.InitMode11(), {
    seeds: 40,
    prepare: (r) => { playState(r); ram[GameSubmode] = r.pick([0, 1, 1, r.byte()]); ram[ObjTimer] = r.pick([0, 0, 1, 0x21]); },
  });
  check('SilenceSound', () => m11.SilenceSound(), { seeds: 3, cmpRet: retA });
  const sub = (r) => {
    playState(r);
    ram[DeathModeCounter] = r.pick([0, 1, 4, 5, 6, 0x0f, r.byte()]);
    ram[ObjTimer + 11] = r.pick([0, 0, 1, 5, r.byte()]);
    ram[CurRow] = r.pick([0, 0x15, r.int(0x16)]);
    ram[FadeCycle] = r.pick([0x60, 0x61, 0x63, r.byte()]);
    ram[CurSaveSlot] = r.int(3);
    ram[DeathCounts + ram[CurSaveSlot]] = r.pick([0, 0xfe, 0xff, r.byte()]);
  };
  check('UpdateMode11Death_Full', () => m11.UpdateMode11Death_Full(), {
    seeds: 13 * 6, prepare: (r) => { sub(r); ram[GameSubmode] = r.int(13); },
  });
  const subs = ['UpdateMode11Death_Sub0', 'UpdateMode11Death_Sub1', 'UpdateMode11Death_Sub2', 'UpdateMode11Death_Sub3',
    'UpdateMode11Death_Sub4', 'UpdateMode11Death_Sub5', 'UpdateMode11Death_Sub6', 'UpdateMode11Death_Sub7',
    'UpdateMode11Death_Sub8_AnimateFade', 'UpdateMode11Death_Sub9', 'UpdateMode11Death_SubA',
    'UpdateMode11Death_SubB', 'UpdateMode11Death_SubC'];
  for (const n of subs) check(n, () => m11[n](), { seeds: 20, prepare: (r) => { sub(r); ram[GameSubmode] = r.int(3); } });
  check('CueTransferPlayAreaAttrsHalfAndAdvanceSubmode', (g) => m11.CueTransferPlayAreaAttrsHalfAndAdvanceSubmode(g.a, g.x, g.y), {
    regs: (r) => ({ a: r.pick([0xd0, 0xe8]), x: r.pick([0x23, 0x2b]), y: r.pick([0x17, 0x2f]) }),
  });
  check('CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2', (g) => m11.CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2(g.a, g.x, g.y), {
    regs: (r) => ({ a: r.pick([0xd0, 0xe8]), x: r.byte(), y: r.pick([0x17, 0x2f]) }),
  });
  check('SelectTransferBufAndAdvanceSubmode', (g) => m11.SelectTransferBufAndAdvanceSubmode(g.a), {
    regs: (r) => ({ a: r.byte() }),
  });
});

test('P25 mode $12: end of level', { skip }, () => {
  const st = (r) => {
    playState(r);
    ram[ObjTimer] = r.pick([0, 0, 1, 4, 5, 0x30, r.byte()]);
    ram[World_IsFillingHearts] = r.pick([0, 0, 2]);
    ram[ObjX + 12] = r.pick([0x20, 0x12, 0x11, 0x10, r.int(0x21)]);
    ram[ObjX + 13] = (0x21 - ram[ObjX + 12]) & 0xff;
    ram[ItemTypeToLift] = 0x1b;
  };
  check('InitMode12', () => m12.InitMode12(), { seeds: 12, prepare: st });
  check('UpdateMode12EndLevel_Full', () => m12.UpdateMode12EndLevel_Full(), {
    seeds: 50, prepare: (r) => { st(r); ram[GameSubmode] = r.int(5); },
  });
  for (const n of ['UpdateMode12EndLevel_Sub0', 'UpdateMode12EndLevel_Sub1', 'UpdateMode12EndLevel_Sub2',
    'UpdateMode12EndLevel_Sub3', 'UpdateMode12EndLevel_Sub4']) {
    check(n, () => m12[n](), { seeds: 20, prepare: st });
  }
  check('EndGameMode12', () => m12.EndGameMode12(), { seeds: 6, cmpRet: retA });
});

const endingState = (r) => {
  playState(r);
  // Mode $13 (as in the game). Another mode sends Link_EndMoveAndDraw through SwitchBank 5 and the
  // original then returns into bank 5 instead of bank 2 (the port's JS does not depend on the mapped
  // bank). Battery: UpdateZeldaTextbox seed 1828 (ROUTINES_SEED 3), InitMode13_Sub0 seed 1933 (5).
  ram[0x12] = 0x13; // GameMode
  ram[GameSubmode] = r.int(5);
  ram[ObjTimer] = r.pick([0, 0, 1, 5, r.byte()]);
  ram[ObjTimer + 1] = r.pick([0, 0, 1, 6, r.byte()]);
  ram[Song] = r.pick([0, 0, r.byte()]);
  ram[ObjX + 12] = r.pick([0x20, 0x12, 0x11, 0x10, r.int(0x21)]);
  ram[ObjX + 13] = (0x21 - ram[ObjX + 12]) & 0xff;
  ram[ObjX + 1] = 0x78;
  ram[ObjY + 1] = 0x88;
  ram[ObjType + 1] = 0x37; // Zelda
  ram[ObjMetastate + 1] = 0;
  ram[TextboxCharIndex] = r.int(0x26);
  ram[TextboxCharPtr] = r.pick([0xa4, 0xc4, 0xe4, r.byte()]);
  ram[ObjState + 1] = r.pick([0, 0, 1]);
  ram[ItemLiftTimer] = r.pick([0, 0x3f, 0x40, 0x41, 0xbf, 0xc0, r.byte()]);
  ram[EndingFlashLongTimer] = r.pick([0, 1, 3, 4, 5, 0x10, 0x40, r.byte()]);
  ram[PeaceCharDelayCounter] = r.pick([3, 4, r.byte()]);
  ram[PeaceCharIndex] = r.int(0x35);
  ram[ButtonsPressed] = r.pick([0, 0x10, r.byte()]);
  ram[QuestNumbers + ram[CurSaveSlot]] = r.pick([0, 1, r.byte()]);
};

test('P25 mode $13: ending', { skip }, () => {
  check('InitMode13_Full', () => m13.InitMode13_Full(), { seeds: 50, prepare: endingState });
  for (const n of ['InitMode13_Sub0', 'UpdateEndGameCurtainEffect', 'InitMode13_Sub1', 'InitMode13_Sub2',
    'UpdateZeldaTextbox', 'InitMode13_Sub3', 'InitMode13_Sub4', 'UpdateMode13WinGame_Sub0_Flash',
    'DrawLinkZeldaTriforces', 'UpdateMode13WinGame_Sub1', 'UpdatePeaceTextbox', 'UpdateMode13WinGame_Sub4']) {
    check(n, () => m13[n](), { seeds: 30, prepare: endingState });
  }
  check('UpdateMode13WinGame', () => m13.UpdateMode13WinGame(), { seeds: 60, prepare: endingState });
  check('DrawAshPile', (g) => m13.DrawAshPile(g.x), {
    regs: () => ({ x: 2 }), prepare: (r) => { endingState(r); ram[ObjType + 2] = 0x3e; },
  });
});

const creditsState = (r) => {
  endingState(r);
  ram[CreditsTileOffset] = r.pick([0, 7, 8, 9, 0x87, 0x88, 0x90, r.byte()]);
  ram[VScrollAddrHi] = r.pick([0, 0x7f, 0x80, 0xff, r.byte()]);
  ram[CurVScroll] = r.pick([0, 0x77, 0x78, 0xef, 0xf0, 0xff, r.byte()]);
  ram[VScrollAddrLo] = r.pick([0, 1, 2, 3, r.byte()]);
  ram[CreditsRow] = r.pick([0, 1, 2, 0x2d, 0x2e, 0x2f, 0x1d, 0x1e, 0x20, 0x24, r.byte()]);
  ram[CreditsVramPage] = r.pick([r.int(12), r.int(12), 3, 11, r.byte()]);
  ram[CreditsVramLine] = r.pick([r.int(8), r.int(8), 5, 7, r.byte()]);
  ram[CreditsLineIndex] = r.pick([r.int(0x17), r.int(0x17), 0x0b, 0x0c, 0x0f, 0x10, 0x11, 0x16, 0x17, r.byte()]);
  ram[DeathCounts + ram[CurSaveSlot]] = r.pick([0, 9, 10, 99, 100, 255, r.byte()]);
};

test('P25 credits', { skip }, () => {
  check('DrawCredits', () => credits.DrawCredits(), { seeds: 300, prepare: creditsState });
  check('UpdateMode13WinGame_Sub3', () => credits.UpdateMode13WinGame_Sub3(), { seeds: 200, prepare: creditsState });
});

test('P25 credits: a whole credits roll from the start, first and second quest', { skip }, () => {
  // Chain the routine on its own state (as UpdateMode13WinGame submode 3 does) until the end.
  for (const quest of [0, 1]) {
    for (let i = 0; i < 0x800; i++) ram[i] = 0;
    machine.ppu.reset();
    machine.mapper.powerOn();
    copyCommon();
    switchBank(2);
    ram[CurSaveSlot] = 1;
    ram[QuestNumbers + 1] = quest;
    ram[DeathCounts + 1] = 123;
    for (let i = 0; i < 8; i++) ram[0x0638 + 8 + i] = 0x0a + i;
    ram[GameSubmode] = 3;
    ram[CreditsTileOffset] = 8;
    let frames = 0;
    while (ram[GameSubmode] === 3 && frames < 4000) {
      const start = snapshot();
      runOriginal('UpdateMode13WinGame_Sub3');
      const orig = snapshot();
      restore(start);
      credits.UpdateMode13WinGame_Sub3();
      assertSame(snapshot(), orig, `credits quest ${quest + 1} frame ${frames}`);
      ram[0x0301] = 0; // TransferCurTileBuf empties DynTileBuf each NMI
      frames++;
    }
    assert.equal(ram[GameSubmode], 4, `quest ${quest + 1}: credits end`);
  }
});

test('P25 mode $13: the whole ending (init and update submodes 0-4) chained frame by frame', { skip }, () => {
  // Timers are decremented as IsrNmi does (ObjTimer every frame, EndingFlashLongTimer every 10th),
  // TransferCurTileBuf empties DynTileBuf. Each frame runs the original and the port from the same
  // state and compares everything.
  for (const quest of [0, 1]) {
    const r = rng(77 + quest);
    for (let i = 0; i < 0x800; i++) ram[i] = 0;
    for (let i = 0; i < 0x2000; i++) sram[i] = r.byte();
    machine.ppu.reset();
    machine.mapper.powerOn();
    copyCommon();
    const flags = 0x067f;
    sram[LevelInfo_WorldFlagsAddr - 0x6000] = flags & 0xff;
    sram[LevelInfo_WorldFlagsAddr - 0x6000 + 1] = flags >> 8;
    ram[CurSaveSlot] = 0;
    ram[QuestNumbers] = quest;
    ram[CurLevel] = 9;
    ram[RoomId] = 0x0e;
    ram[ObjX] = 0x70; ram[ObjY] = 0x8d; ram[ObjDir] = 8;
    ram[ObjX + 1] = 0x80; ram[ObjY + 1] = 0x8d; ram[ObjType + 1] = 0x37;
    ram[ObjX + 12] = 0x20; ram[ObjX + 13] = 0x01;
    ram[0x11] = 0; // IsUpdatingMode
    ram[GameSubmode] = 0;
    const seen = new Set();
    let frames = 0;
    for (; frames < 6000; frames++) {
      const updating = ram[0x11] !== 0;
      seen.add(`${updating ? 'U' : 'I'}${ram[GameSubmode]}`);
      if (updating && ram[GameSubmode] === 4 && ram[ObjTimer] === 0) ram[ButtonsPressed] = 0x10; // Start
      const name = updating ? 'UpdateMode13WinGame' : 'InitMode13_Full';
      switchBank(2);
      const start = snapshot();
      runOriginal(name);
      const orig = snapshot();
      restore(start);
      (updating ? m13.UpdateMode13WinGame : m13.InitMode13_Full)();
      assertSame(snapshot(), orig, `ending quest ${quest + 1} frame ${frames} ${name} submode ${start.ram[GameSubmode]}`);
      if (ram[0x12] === 0x0d) break; // GameMode: mode $D (save)
      ram[ButtonsPressed] = 0;
      ram[0x0301] = 0; // DynTileBufLen
      ram[0x0302] = 0xff;
      for (let i = 0; i < 0x14; i++) if (ram[ObjTimer + i]) ram[ObjTimer + i]--;
      if (frames % 10 === 9 && ram[EndingFlashLongTimer]) ram[EndingFlashLongTimer]--;
      if (ram[Song]) ram[Song] = 0; // the song request is handled by DriveAudio
    }
    assert.equal(ram[0x12], 0x0d, `quest ${quest + 1}: reaches mode $D after ${frames} frames (${[...seen]})`);
    for (const s of ['I0', 'I1', 'I2', 'I3', 'I4', 'U0', 'U1', 'U2', 'U3', 'U4']) assert.ok(seen.has(s), `quest ${quest + 1}: ${s}`);
  }
});
