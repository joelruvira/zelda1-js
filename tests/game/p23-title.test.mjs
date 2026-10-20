// P23: mode 0 (title, story, item parade) routines vs. the original 6502 code (jsnes CPU on the
// port's machine, tests/game/p01-hybrid.mjs) from the same random RAM/SRAM states.
// Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canRunHybrid, runOriginal } from './p01-hybrid.mjs';
import { loadSymbols, loadRom, label } from '../../src/core/rom.js';
import { SEGMENTS } from '../../src/core/symbols.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram, cpu } from '../../src/core/ram.js';
import { bus } from '../../src/core/bus.js';
import { switchBank } from '../../src/core/asm.js';
import { ROM_PATH } from '../core/helpers.mjs';
import {
  DemoPhase, DemoSubphase, GameSubmode, SkippedDemo, IsUpdatingMode, ObjState, DemoItemIds, ObjY,
  DemoLineTextIndex, DemoLineIndex, ScrolledLineCount, ScrolledScreenCount, CurVScroll, DemoTimer,
  TriforceGlowTimer, TriforceGlowCycle, InitializedWaterfallAnimation, DemoPhase0Subphase1Timer,
  DemoPhase0Subphase1Cycle, ButtonsPressed, DemoItemRow, DemoLineTileVramAddrHi, DemoLineTileVramAddrLo,
  DemoLineAttrVramAddrHi, DemoLineAttrVramAddrLo, FrameCounter, CurSaveSlot,
} from '../../src/core/vars.js';
import * as title from '../../src/game/modes/mode0-title.js';
import * as story from '../../src/game/modes/mode0-story.js';
import { NotImplementedError } from '../../src/game/stub.js';

const skip = !canRunHybrid && 'needs roms/zelda.nes and tools/oracle jsnes';
let machine;
if (canRunHybrid) {
  await loadSymbols();
  machine = createMachine(loadRom(readFileSync(ROM_PATH)));
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return { byte: () => next() & 0xff, int: (n) => next() % n };
}

function copyWramSegments() {
  for (const seg of [SEGMENTS.BANK_01_CODE, SEGMENTS.BANK_06_DATA]) {
    for (let i = 0; i < seg.size; i++) sram[seg.run - 0x6000 + i] = bus.rom.prgByte(seg.bank, seg.load + i);
  }
}

const PPU_FIELDS = ['ctrl', 'mask', 'status', 'oamAddr', 'v', 't', 'x', 'w', 'readBuffer'];
function snapshot() {
  const p = machine.ppu;
  return {
    ram: Uint8Array.from(ram), sram: Uint8Array.from(sram), vram: Uint8Array.from(p.vram),
    pal: Uint8Array.from(p.palette), regs: PPU_FIELDS.map((f) => p[f]),
  };
}
function restore(s) {
  const p = machine.ppu;
  ram.set(s.ram); sram.set(s.sram); p.vram.set(s.vram); p.palette.set(s.pal);
  PPU_FIELDS.forEach((f, i) => { p[f] = s.regs[i]; });
}
function firstDiff(a, b, base = 0, skipStack = false) {
  for (let i = 0; i < a.length; i++) {
    if (skipStack && i >= 0x100 && i < 0x200) continue;
    if (a[i] !== b[i]) return `$${(base + i).toString(16)}: port ${a[i].toString(16)} != orig ${b[i].toString(16)}`;
  }
  return null;
}

/** Random state -> run original and port from it (bank 2 mapped, WRAM code copied) -> compare. */
function check(name, fn, { seeds = 40, prepare = () => {}, regs = () => ({}), cmpRet } = {}) {
  for (let seed = 1; seed <= seeds; seed++) {
    const r = rng(seed * 7919 + name.length * 31);
    for (let i = 0; i < 0x800; i++) ram[i] = r.byte();
    for (let i = 0; i < 0x2000; i++) sram[i] = r.byte();
    machine.ppu.reset();
    machine.mapper.powerOn();
    copyWramSegments();
    switchBank(2);
    const reg = regs(r);
    prepare(r, reg);
    const start = snapshot();
    const o = runOriginal(name, reg);
    const orig = snapshot();
    restore(start);
    switchBank(2);
    cpu.c = reg.c ?? 0;
    const ret = fn(reg);
    const port = snapshot();
    const what = `${name} seed ${seed}`;
    assert.equal(firstDiff(port.ram, orig.ram, 0, true), null, `${what}: RAM`);
    assert.equal(firstDiff(port.sram, orig.sram, 0x6000), null, `${what}: SRAM`);
    assert.equal(firstDiff(port.vram, orig.vram, 0x2000), null, `${what}: VRAM`);
    assert.equal(firstDiff(port.pal, orig.pal, 0x3f00), null, `${what}: palette`);
    assert.deepEqual(port.regs, orig.regs, `${what}: PPU registers`);
    if (cmpRet) cmpRet(ret, o, what);
  }
}

// Story objects drawn without AnimateItemObject (P10): disabled, the fairy ($23) or final items (>= $30).
function noPlainItems(r) {
  for (let x = 1; x <= 10; x++) {
    ram[ObjState + x] = r.int(2) ? 0 : 0xff;
    if (ram[ObjState + x] !== 0) continue;
    const k = r.int(3);
    ram[DemoItemIds + x] = k === 0 ? 0x23 : k === 1 ? 0x30 + r.int(4) : ram[DemoItemIds + x] | 0x30;
  }
}

test('init tasks: InitDemo_RunTasks (both phases, every subphase) and its handlers', { skip }, () => {
  check('InitDemo_RunTasks', () => title.InitDemo_RunTasks(), {
    seeds: 30, prepare: (r) => { ram[DemoPhase] = r.int(2) ? 0 : r.byte() | 1; ram[DemoSubphase] = r.int(3); },
  });
  for (const n of ['InitDemoSubphaseClearArtifacts', 'InitDemoSubphaseTransferTitlePalette',
    'InitDemoSubphasePlayTitleSong', 'InitDemoSubphaseTransferStoryPalette',
    'InitDemoSubphaseTransferStoryTiles', 'IncSubphase']) {
    check(n, () => title[n](), { seeds: 5 });
  }
  check('EndInitDemo', (g) => title.EndInitDemo(g.a), { seeds: 5, regs: (r) => ({ a: r.byte() }) });
});

test('title animation: phase 0 subphases, triforce glow, waterfall', { skip }, () => {
  check('AnimateDemoPhase0Subphase0', () => title.AnimateDemoPhase0Subphase0(), {
    seeds: 60,
    prepare: (r) => {
      if (r.int(2)) ram[DemoTimer] = 0xff;
      if (r.int(2)) ram[TriforceGlowTimer] = r.int(2);
      ram[TriforceGlowCycle] = r.int(8);
      if (r.int(2)) ram[InitializedWaterfallAnimation] = 0;
    },
  });
  check('AnimateDemoPhase0Subphase0Artifacts', () => title.AnimateDemoPhase0Subphase0Artifacts(), {
    seeds: 30, prepare: (r) => { ram[TriforceGlowTimer] = r.int(3); ram[TriforceGlowCycle] = r.int(8); },
  });
  check('UpdateWaterfallAnimation', () => title.UpdateWaterfallAnimation(), {
    seeds: 30, prepare: (r) => { if (r.int(2)) ram[InitializedWaterfallAnimation] = 0; },
  });
  check('UpdateSpritesForWaterfallWave', (g) => title.UpdateSpritesForWaterfallWave(g.x), {
    seeds: 40, regs: (r) => ({ x: r.int(3) }), cmpRet: (ret, o, w) => assert.equal(ret, o.x, `${w}: X`),
  });
  check('UpdateSpritesForWaterfallCrest', () => title.UpdateSpritesForWaterfallCrest(), {
    seeds: 20, regs: (r) => ({ c: r.int(2) }), cmpRet: (ret, o, w) => assert.equal(cpu.c, o.c, `${w}: C`),
  });
  check('AnimateDemoPhase0Subphase1', () => title.AnimateDemoPhase0Subphase1(), {
    seeds: 60,
    prepare: (r) => {
      ram[DemoPhase0Subphase1Timer] = r.int(2) ? 0 : r.byte();
      ram[DemoPhase0Subphase1Cycle] = r.int(14);
    },
  });
  check('AnimateDemo', () => title.AnimateDemo(), {
    seeds: 30, prepare: (r) => { ram[DemoPhase] = 0; ram[DemoSubphase] = r.int(2); },
  });
});

test('story: phase 1 subphases, lines, attributes and objects', { skip }, () => {
  check('AnimateDemoPhase1Subphase0', () => story.AnimateDemoPhase1Subphase0(), {
    seeds: 60,
    prepare: (r) => {
      ram[CurVScroll] = [0xef, 0x07, 0x08, r.byte()][r.int(4)];
      if (r.int(2)) ram[ScrolledScreenCount] = 0;
    },
  });
  check('AnimateDemoPhase1Subphase1', () => story.AnimateDemoPhase1Subphase1(), {
    seeds: 10, prepare: (r) => { if (r.int(2)) ram[DemoTimer] = 0xff; },
  });
  check('AnimateDemoPhase1Subphase2', () => story.AnimateDemoPhase1Subphase2(), {
    seeds: 200,
    prepare: (r) => {
      ram[DemoLineIndex] = r.int(0xaf);
      ram[DemoLineTextIndex] = r.int(29);
      ram[DemoItemRow] = r.int(18);
      ram[ScrolledLineCount] = r.int(2) ? (r.byte() & 0xf8) - 1 : r.byte();
      ram[ScrolledScreenCount] = r.int(2) ? 5 : r.byte();
      ram[CurVScroll] = r.int(3) ? 0xef : r.byte();
      ram[DemoLineTileVramAddrHi] = [0x2b, 0x23, 0x29, r.byte()][r.int(4)];
      ram[DemoLineTileVramAddrLo] = [0xa0, 0xe0, r.byte() & 0xe0][r.int(3)];
      ram[DemoLineAttrVramAddrHi] = [0x2b, 0x23][r.int(2)];
      ram[DemoLineAttrVramAddrLo] = r.int(2) ? 0xf8 : r.byte();
      ram[ObjState + 1 + r.int(10)] = 0xff; // ProcessDemoLineItems needs a disabled slot
      if (r.int(2)) ram[ObjY + 1 + r.int(10)] = 0xf1;
      noPlainItems(r);
    },
  });
  check('ProcessDemoLineAttrs', () => story.ProcessDemoLineAttrs(), {
    seeds: 40,
    prepare: (r) => {
      ram[DemoLineIndex] = r.int(0xaf);
      ram[DemoLineAttrVramAddrHi] = [0x2b, 0x23][r.int(2)];
      ram[DemoLineAttrVramAddrLo] = r.int(2) ? 0xf8 : r.byte();
    },
  });
  check('DisableFallenObjects', () => story.DisableFallenObjects(), {
    seeds: 10, prepare: (r) => { for (let x = 1; x <= 10; x++) if (r.int(2)) ram[ObjY + x] = 0xf0; },
  });
  check('ProcessDemoLineItems', () => story.ProcessDemoLineItems(), {
    seeds: 80,
    prepare: (r) => {
      ram[DemoLineIndex] = r.int(0xaf);
      ram[DemoItemRow] = r.int(18);
      for (let x = 1; x <= 10; x++) ram[ObjState + x] = r.int(3) ? 0 : 0xff;
      ram[ObjState + 1 + r.int(10)] = 0xff;
    },
  });
  check('Demo_AnimateObjects', () => story.Demo_AnimateObjects(), { seeds: 40, prepare: noPlainItems });
  check('AnimateStationaryFairy', (g) => story.AnimateStationaryFairy(g.x), {
    seeds: 20, regs: (r) => ({ x: 1 + r.int(10) }),
  });
  check('AnimateDemoStoryFinalItems', (g) => story.AnimateDemoStoryFinalItems(g.x), {
    seeds: 40, regs: (r) => ({ x: 1 + r.int(10) }),
  });
  check('AnimateDemoPhase1Subphase3', () => story.AnimateDemoPhase1Subphase3(), {
    seeds: 20, prepare: (r) => { if (r.int(2)) ram[DemoTimer] = 0xff; noPlainItems(r); },
  });
  check('AnimateDemoPhase1Subphase4', () => story.AnimateDemoPhase1Subphase4(), {
    seeds: 20, prepare: (r) => { if (r.int(2)) ram[DemoTimer] = 0x38; noPlainItems(r); },
  });
  check('AnimateDemo', () => title.AnimateDemo(), {
    seeds: 50,
    prepare: (r) => {
      ram[DemoPhase] = 1 + r.int(5);
      ram[DemoSubphase] = r.int(5);
      ram[DemoLineTextIndex] = r.int(29);
      ram[ObjState + 1 + r.int(10)] = 0xff;
      noPlainItems(r);
    },
  });
  check('Unused_97C5', (g) => story.Unused_97C5(g.a), { seeds: 20, regs: (r) => ({ a: r.int(3) ? 0x14 : r.byte() }) });
});

test('story items drawn with AnimateItemObject (P10)', { skip }, (t) => {
  try {
    check('Demo_AnimateObjects', () => story.Demo_AnimateObjects(), {
      seeds: 20,
      prepare: (r) => {
        for (let x = 1; x <= 10; x++) { ram[ObjState + x] = r.int(2) ? 0 : 0xff; ram[DemoItemIds + x] = r.int(0x34); }
      },
    });
  } catch (e) {
    if (e instanceof NotImplementedError) return t.skip('AnimateItemObject (P10) not ported yet');
    throw e;
  }
});

test('UpdateMode0Demo: animate, Start (Sub0), Sub2 copies the save slots and enters mode 1', { skip }, () => {
  check('UpdateMode0Demo', () => title.UpdateMode0Demo(), {
    seeds: 80,
    prepare: (r) => {
      ram[GameSubmode] = [0, 0, 2][r.int(3)];
      ram[SkippedDemo] = r.int(2) ? 0 : r.byte();
      ram[DemoPhase] = 0;
      ram[DemoSubphase] = r.int(2);
      ram[IsUpdatingMode] = r.byte();
      ram[ButtonsPressed] = r.byte();
      if (r.int(2)) ram[DemoPhase0Subphase1Cycle] = 13;
      ram[FrameCounter] = r.byte();
    },
  });
  check('UpdateMode0Demo_Sub0', () => title.UpdateMode0Demo_Sub0(), {
    seeds: 20, prepare: (r) => { ram[ButtonsPressed] = r.byte(); },
  });
  // Sub2 with every combination of active/inactive slots (inactive ones are formatted by FormatFileA).
  check('UpdateMode0Demo_Sub2', () => title.UpdateMode0Demo_Sub2(), {
    seeds: 40,
    prepare: (r) => {
      ram[CurSaveSlot] = r.byte();
      // [06:07] of slot 0's address set (SaveFileAAddressSets in WRAM) = file A IsSaveSlotActive.
      const set = label('SaveFileAAddressSets').addr - 0x6000;
      const active = (sram[set + 6] | (sram[set + 7] << 8)) - 0x6000;
      for (let s = 0; s < 3; s++) sram[active + s] = r.int(2) ? 0 : r.byte();
    },
  });
});

test('UpdateMode0Demo_Sub1 (P24) via the jump table', { skip }, (t) => {
  try {
    check('UpdateMode0Demo', () => title.UpdateMode0Demo(), {
      seeds: 10, prepare: () => { ram[GameSubmode] = 1; },
    });
  } catch (e) {
    if (e instanceof NotImplementedError) return t.skip('UpdateMode0Demo_Sub1 (P24) not ported yet');
    throw e;
  }
});

test('labels used by P23 exist', { skip }, () => {
  for (const n of ['InitDemo_RunTasks_Phase0_JumpTable', 'InitDemo_RunTasks_Phase1_JumpTable',
    'UpdateMode0Demo_JumpTable', 'AnimateDemo_Phase0_JumpTable', 'AnimateDemo_Phase1_JumpTable',
    'DemoPhase0Subphase1Palettes', 'DemoLineTextAddrs']) {
    assert.ok(label(n).addr >= 0x8000, n);
  }
});
