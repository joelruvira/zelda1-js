// P01: ported routines vs. the original 6502 code (jsnes CPU on the port's machine, see p01-hybrid.mjs)
// from the same random RAM/SRAM/PPU states. Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canRunHybrid, runOriginal } from './p01-hybrid.mjs';
import { loadSymbols, loadRom, label } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram, cpu } from '../../src/core/ram.js';
import { bus } from '../../src/core/bus.js';
import { ROM_PATH } from '../core/helpers.mjs';
import * as int16 from '../../src/game/util/int16.js';
import * as boot from '../../src/game/boot.js';
import * as nmi from '../../src/game/nmi.js';
import * as dispatch from '../../src/game/modes/dispatch.js';
import { TransferTileBuf, TransferCurTileBuf } from '../../src/game/ppu/tilebuf.js';
import { NotImplementedError } from '../../src/game/stub.js';

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

function copyCommonCode() {
  for (let i = 0; i < 0x1270; i++) sram[0x0c90 + i] = bus.rom.prgByte(1, 0xa500 + i);
}

const PPU_FIELDS = ['ctrl', 'mask', 'status', 'oamAddr', 'v', 't', 'x', 'w', 'readBuffer', 'mirroring'];
function snapshot() {
  const p = machine.ppu;
  const m = machine.mapper;
  return {
    ram: Uint8Array.from(ram), sram: Uint8Array.from(sram),
    chr: Uint8Array.from(p.chr), vram: Uint8Array.from(p.vram), pal: Uint8Array.from(p.palette),
    oam: Uint8Array.from(p.oam), regs: PPU_FIELDS.map((f) => p[f]),
    mapper: [m.shift, m.control, m.chrBank0, m.chrBank1, m.prgBank],
  };
}
function restore(s) {
  const p = machine.ppu;
  const m = machine.mapper;
  ram.set(s.ram); sram.set(s.sram);
  p.chr.set(s.chr); p.vram.set(s.vram); p.palette.set(s.pal); p.oam.set(s.oam);
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
  assert.equal(firstDiff(port.chr, orig.chr), null, `${what}: CHR`);
  assert.deepEqual(port.regs, orig.regs, `${what}: PPU registers ${PPU_FIELDS}`);
  assert.deepEqual(port.mapper, orig.mapper, `${what}: MMC1`);
}

/** Random state -> run original and port from it -> compare everything. */
function check(name, fn, { seeds = 20, prepare = () => {}, regs = () => ({}), cmpRet } = {}) {
  for (let seed = 1; seed <= seeds * ROUTINES_SCALE; seed++) {
    const r = rng(seed * 7919 + name.length);
    for (let i = 0; i < 0x800; i++) ram[i] = r.byte();
    for (let i = 0; i < 0x2000; i++) sram[i] = r.byte();
    machine.ppu.reset();
    machine.mapper.powerOn();
    const reg = regs(r);
    const { bank, addr, load } = label(name);
    if (addr >= 0x8000 && addr < 0xc000) boot.SwitchBank(bank); // banked routine: map its bank
    if (addr !== load) copyCommonCode(); // runs from WRAM (BANK_01_CODE)
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
const retC = (ret, o, what) => { assert.equal(cpu.c, o.c, `${what}: C`); };

test('int16 helpers', { skip }, () => {
  const both = (ret, o, w) => { retA(ret, o, w); retC(ret, o, w); };
  check('Add1ToInt16At0', () => int16.Add1ToInt16At0(), { cmpRet: both, prepare: (r) => { ram[0] = r.int(3) ? r.byte() : 0xff; } });
  check('AddToInt16At0', (g) => int16.AddToInt16At0(g.a), { regs: (r) => ({ a: r.byte() }), cmpRet: both });
  check('Add1ToInt16At2', () => int16.Add1ToInt16At2(), { cmpRet: both, prepare: (r) => { ram[2] = r.int(3) ? r.byte() : 0xff; } });
  check('AddToInt16At2', (g) => int16.AddToInt16At2(g.a), { regs: (r) => ({ a: r.byte() }), cmpRet: both });
  check('Add1ToInt16At4', () => int16.Add1ToInt16At4(), { cmpRet: both, prepare: (r) => { ram[4] = r.int(3) ? r.byte() : 0xff; } });
  check('AddToInt16At4', (g) => int16.AddToInt16At4(g.a), { regs: (r) => ({ a: r.byte() }), cmpRet: both });
  check('Sub1FromInt16At4', () => int16.Sub1FromInt16At4(), { cmpRet: both, prepare: (r) => { ram[4] = r.int(3) ? r.byte() : 0; } });
});

test('RAM/SRAM initialisation: ClearRam, ClearRam0300UpTo, InitSaveRam, HideAllSprites', { skip }, () => {
  check('ClearRam', () => boot.ClearRam(), { seeds: 5 });
  check('ClearRam0300UpTo', (g) => boot.ClearRam0300UpTo(g.a, g.y), {
    seeds: 10, regs: (r) => ({ a: 3 + r.int(5), y: r.byte() }),
  });
  // Both branches: already initialised (5A/A5 markers) or not.
  check('InitSaveRam', () => boot.InitSaveRam(), {
    seeds: 10, cmpRet: retC,
    prepare: (r) => { if (r.int(2)) { sram[0x0001] = 0x5a; sram[0x1fff] = r.int(4) ? 0xa5 : 0; } },
  });
  check('HideAllSprites', () => boot.HideAllSprites(), { seeds: 3, cmpRet: retA });
  check('SplitRoomId', () => boot.SplitRoomId().a, { seeds: 5, cmpRet: retA });
});

test('CopyCommonCodeToRam copies BANK_01_CODE to WRAM', { skip }, () => {
  check('CopyCommonCodeToRam', () => { boot.CopyCommonCodeToRam(); }, { seeds: 2, prepare: () => boot.SwitchBank(1) });
});

test('CopyCommonDataToRam (needs P03 CopyBlock)', { skip }, (t) => {
  try {
    check('CopyCommonDataToRam', () => boot.CopyCommonDataToRam(), { seeds: 2, prepare: () => boot.SwitchBank(6) });
  } catch (e) {
    if (e instanceof NotImplementedError) return t.skip('CopyBlock (P03) not ported yet');
    throw e;
  }
});

test('mode helpers: EndGameMode, GoToNextMode, BeginUpdateMode', { skip }, () => {
  check('EndGameMode', () => dispatch.EndGameMode(), { seeds: 3, cmpRet: retA });
  check('GoToNextMode', () => dispatch.GoToNextMode(), { seeds: 3, cmpRet: retA });
  // BeginUpdateMode runs from WRAM: copy the common code first (as InitializeGameOrMode does).
  check('BeginUpdateMode', () => dispatch.BeginUpdateMode(), {
    seeds: 3, cmpRet: retA, prepare: () => { boot.SwitchBank(1); boot.CopyCommonCodeToRam(); },
  });
});

test('MMC1 and video helpers', { skip }, () => {
  check('SetMMC1Control', (g) => boot.SetMMC1Control(g.a), { seeds: 8, regs: (r) => ({ a: r.byte() & 0x1f }), cmpRet: retA });
  check('SetMMC1Control_Local5', (g) => boot.SetMMC1Control_Local5(g.a), {
    seeds: 4, regs: (r) => ({ a: r.byte() & 0x1f }), prepare: () => boot.SwitchBank(5), cmpRet: retA,
  });
  check('SwitchBank', (g) => boot.SwitchBank(g.a), { seeds: 8, regs: (r) => ({ a: r.int(8) }), cmpRet: retA });
  check('SwitchBank_Local2', (g) => boot.SwitchBank_Local2(g.a), {
    seeds: 4, regs: (r) => ({ a: r.int(8) }), prepare: () => boot.SwitchBank(2), cmpRet: retA,
  });
  check('SwitchBank_Local5', (g) => boot.SwitchBank_Local5(g.a), {
    seeds: 4, regs: (r) => ({ a: r.int(8) }), prepare: () => boot.SwitchBank(5), cmpRet: retA,
  });
  check('ResetPpuRegisters', () => boot.ResetPpuRegisters(), { seeds: 3, cmpRet: retA });
  check('TurnOffAllVideo', () => boot.TurnOffAllVideo(), { seeds: 3, cmpRet: retA });
  check('ClearNameTable', (g) => boot.ClearNameTable(g.a, g.x, g.y).a, {
    seeds: 8, regs: (r) => ({ a: [0x20, 0x24, 0x28, 0x2c][r.int(4)], x: r.byte(), y: r.byte() }), cmpRet: retA,
  });
  check('ClearAllAudioAndVideo', () => boot.ClearAllAudioAndVideo(), { seeds: 3 });
});

/** Writes a random well-formed transfer buffer at RAM `addr`. */
function randomTileBuf(r, addr) {
  let p = addr;
  const n = 1 + r.int(5);
  for (let rec = 0; rec < n; rec++) {
    const pal = r.int(4) === 0;
    ram[p++] = pal ? 0x3f : 0x20 + r.int(0x1f);
    ram[p++] = pal ? r.int(0x20) : r.byte();
    const count = r.int(4) === 0 ? 0 : 1 + r.int(0x10);
    const ctl = (r.int(2) << 7) | (r.int(3) === 0 ? 0x40 : 0) | count;
    ram[p++] = ctl;
    const len = ctl & 0x40 ? 1 : (count || 64);
    for (let i = 0; i < len; i++) ram[p++] = r.byte();
  }
  ram[p] = 0x80 | r.byte();
}

test('TransferTileBuf / TransferCurTileBuf write VRAM like the original', { skip }, () => {
  check('TransferTileBuf', () => TransferTileBuf(), {
    seeds: 40,
    prepare: (r) => { randomTileBuf(r, 0x0400); ram[0] = 0x00; ram[1] = 0x04; },
  });
  check('TransferCurTileBuf', () => TransferCurTileBuf(), {
    seeds: 20,
    prepare: (r) => {
      boot.SwitchBank(6);
      randomTileBuf(r, 0x0302);
      // DynTileBuf ($00) or a static buffer of bank 6 / WRAM (BANK_06_DATA copied first).
      ram[0x14] = r.int(2) ? 0 : 2 * r.int(0x40);
      for (let i = 0; i < 0x8e; i++) sram[0x07f0 + i] = bus.rom.prgByte(6, 0x9cd8 + i);
    },
  });
});

test('ReadInputs / ReadOneController', { skip }, () => {
  check('ReadInputs', () => nmi.ReadInputs(), {
    seeds: 20, cmpRet: retA,
    prepare: (r) => { machine.input.setOverride(0, r.byte()); machine.input.setOverride(1, r.byte()); },
  });
});
