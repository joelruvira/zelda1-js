// P03: ported loaders vs. the original 6502 code (jsnes CPU on the port's machine, see p01-hybrid.mjs)
// from random RAM/SRAM/PPU states. Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canRunHybrid, runOriginal } from './p01-hybrid.mjs';
import { loadSymbols, loadRom, label } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram, cpu } from '../../src/core/ram.js';
import { ROM_PATH } from '../core/helpers.mjs';
import { switchBank } from '../../src/core/asm.js';
import * as pat from '../../src/game/loaders/patterns.js';
import * as lb from '../../src/game/loaders/levelblocks.js';
import * as m2 from '../../src/game/modes/mode2-load.js';
import * as boot from '../../src/game/boot.js';
import {
  CurLevel, CurSaveSlot, QuestNumbers, GameSubmode, PatternBlockIndex,
} from '../../src/core/vars.js';

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
  return { byte: () => next() & 0xff, int: (n) => next() % n };
}

const PPU_FIELDS = ['ctrl', 'mask', 'status', 'oamAddr', 'v', 't', 'x', 'w', 'readBuffer', 'mirroring'];
function snapshot() {
  const p = machine.ppu;
  const m = machine.mapper;
  return {
    ram: Uint8Array.from(ram), sram: Uint8Array.from(sram),
    chr: Uint8Array.from(p.chr), vram: Uint8Array.from(p.vram), pal: Uint8Array.from(p.palette),
    regs: PPU_FIELDS.map((f) => p[f]), mapper: [m.shift, m.control, m.chrBank0, m.chrBank1, m.prgBank],
  };
}
function restore(s) {
  const p = machine.ppu;
  const m = machine.mapper;
  ram.set(s.ram); sram.set(s.sram);
  p.chr.set(s.chr); p.vram.set(s.vram); p.palette.set(s.pal);
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
  assert.equal(firstDiff(port.chr, orig.chr), null, `${what}: CHR`);
  assert.deepEqual(port.regs, orig.regs, `${what}: PPU registers ${PPU_FIELDS}`);
  assert.deepEqual(port.mapper, orig.mapper, `${what}: MMC1`);
}

/** Random state -> prepare -> run original and port from it -> compare everything. */
function check(name, fn, { seeds = 4, prepare = () => {}, regs = () => ({}) } = {}) {
  for (let seed = 1; seed <= seeds * ROUTINES_SCALE; seed++) {
    const r = rng(seed * 7919 + name.length);
    for (let i = 0; i < 0x800; i++) ram[i] = r.byte();
    for (let i = 0; i < 0x2000; i++) sram[i] = r.byte();
    machine.ppu.reset();
    machine.mapper.powerOn();
    const reg = regs(r);
    const { bank } = label(name);
    switchBank(bank);
    prepare(r, reg, seed);
    const start = snapshot();
    runOriginal(name, reg);
    const orig = snapshot();
    restore(start);
    cpu.c = reg.c ?? 0;
    fn(reg);
    assertSame(snapshot(), orig, `${name} seed ${seed}`);
  }
}

test('TransferCommonPatterns / TransferDemoPatterns', { skip }, () => {
  check('TransferCommonPatterns', () => pat.TransferCommonPatterns(), { seeds: 2, prepare: () => { ram[PatternBlockIndex] = 0; } });
  check('TransferDemoPatterns', () => pat.TransferDemoPatterns(), { seeds: 2, prepare: () => { ram[PatternBlockIndex] = 0; } });
  // Resuming from block 1 / 2 (PatternBlockIndex is persistent RAM).
  check('TransferCommonPatterns', () => pat.TransferCommonPatterns(), { seeds: 2, prepare: (r) => { ram[PatternBlockIndex] = 1 + r.int(2); } });
});

test('TransferPatternBlock_Bank1/2/3 with arbitrary source/size', { skip }, () => {
  const prep = (r) => {
    ram[0x00] = r.byte(); ram[0x01] = 0x80 + r.int(0x40);
    ram[0x02] = r.int(3); ram[0x03] = r.int(4) ? r.byte() : 0;
    if (!ram[0x02] && !ram[0x03]) ram[0x03] = 1;
    ram[PatternBlockIndex] = r.int(4);
    boot.TurnOffAllVideo();
  };
  check('TransferPatternBlock_Bank1', (g) => pat.TransferPatternBlock_Bank1(g.a), { regs: (r) => ({ a: r.byte() }), prepare: prep });
  check('TransferPatternBlock_Bank2', (g) => pat.TransferPatternBlock_Bank2(g.a), { regs: (r) => ({ a: r.byte() }), prepare: prep });
  check('TransferPatternBlock_Bank3', () => pat.TransferPatternBlock_Bank3(), { prepare: prep });
});

test('TransferLevelPatternBlocks for every level (OW and UW 1-9)', { skip }, () => {
  for (let level = 0; level <= 9; level++) {
    check('TransferLevelPatternBlocks', () => pat.TransferLevelPatternBlocks(), {
      seeds: 1, prepare: () => { ram[CurLevel] = level; ram[PatternBlockIndex] = 0; },
    });
  }
});

test('FetchPatternBlock* helpers', { skip }, () => {
  const prep = (r) => { ram[PatternBlockIndex] = r.int(4); ram[CurLevel] = r.int(10); };
  check('FetchPatternBlockAddrUW', () => pat.FetchPatternBlockAddrUW(), { prepare: prep });
  check('FetchPatternBlockInfoOW', () => pat.FetchPatternBlockInfoOW(), { prepare: prep });
  check('FetchPatternBlockAddrUWSpecial', () => pat.FetchPatternBlockAddrUWSpecial(), { prepare: prep });
  check('FetchPatternBlockUWBoss', () => pat.FetchPatternBlockUWBoss(), { prepare: prep });
  check('ResetPatternBlockIndex', () => pat.ResetPatternBlockIndex(), { prepare: prep });
});

test('CopyBlock and the destination helpers', { skip }, () => {
  check('FetchLevelBlockDestInfo', () => lb.FetchLevelBlockDestInfo(), { seeds: 1 });
  check('FetchLevelInfoDestInfo', () => lb.FetchLevelInfoDestInfo(), { seeds: 1 });
  check('CopyBlock', () => lb.CopyBlock(), {
    prepare: (r) => {
      ram[0x00] = r.byte(); ram[0x01] = 0x80 + r.int(0x3f);
      ram[0x02] = r.byte(); ram[0x03] = 0x60 + r.int(0x10);
      const end = ram[0x02] + (ram[0x03] << 8) + r.int(0x300);
      ram[0x04] = end & 0xff; ram[0x05] = end >> 8;
    },
  });
  // P01's CopyCommonDataToRam now runs on the real CopyBlock.
  check('CopyCommonDataToRam', () => boot.CopyCommonDataToRam(), { seeds: 1 });
});

test('InitMode2 submodes (every level, both quests)', { skip }, () => {
  for (let level = 0; level <= 9; level++) {
    for (const quest of [0, 1]) {
      const prepare = (r) => { ram[CurLevel] = level; ram[CurSaveSlot] = r.int(3); ram[QuestNumbers + ram[CurSaveSlot]] = quest; };
      check('InitMode2_Sub0', () => m2.InitMode2_Sub0(), { seeds: 1, prepare });
      check('InitMode2_Sub1', () => m2.InitMode2_Sub1(), { seeds: 1, prepare });
      for (const sub of [0, 1]) {
        check('InitMode2_Submodes', () => m2.InitMode2_Submodes(), {
          seeds: 1, prepare: (r) => { prepare(r); ram[GameSubmode] = sub; },
        });
      }
    }
  }
});

test('UpdateMode2Load_Full (every level, both quests)', { skip }, () => {
  for (let level = 0; level <= 9; level++) {
    for (const quest of [0, 1, 2]) {
      check('UpdateMode2Load_Full', () => m2.UpdateMode2Load_Full(), {
        seeds: 1,
        prepare: (r) => { ram[CurLevel] = level; ram[CurSaveSlot] = r.int(3); ram[QuestNumbers + ram[CurSaveSlot]] = quest; },
      });
    }
  }
});
