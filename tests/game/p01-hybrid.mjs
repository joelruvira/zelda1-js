// P01 test tool: run ORIGINAL 6502 routines (jsnes CPU, real ROM) directly on the port's machine:
// the port's RAM/SRAM are copied in and back, and every PPU/APU/input/mapper access of the 6502 code
// goes to the port's bus (core/bus.js). Used two ways:
//   1. unit tests: runOriginal('Name', regs) vs. the JS port on the same state;
//   2. hybrid oracle runs: `node --import ./tests/game/p01-hybrid-register.mjs tools/oracle/run-port.mjs ...`
//      replaces src/game/stub.js so every routine not ported yet executes as original 6502 code.
//      That lets a package be checked frame-by-frame before its dependencies are ported.
// Needs roms/zelda.nes and tools/oracle/node_modules/jsnes (callers skip without them).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { label } from '../../src/core/rom.js';
import { ram, sram, cpu as portCpu } from '../../src/core/ram.js';
import { bus, read, write } from '../../src/core/bus.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ROM = join(ROOT, 'roms/zelda.nes');
const JSNES = join(ROOT, 'tools/oracle/node_modules/jsnes/src/index.js');
export const canRunHybrid = existsSync(ROM) && existsSync(JSNES);

export class NotImplementedError extends Error { name = 'NotImplementedError'; }

const TRAP = 0x5ff0; // unmapped: execution stops when the routine returns here
let nes = null;

async function init() {
  const { NES } = await import(pathToFileURL(JSNES).href);
  const romBytes = readFileSync(ROM);
  nes = new NES({ onFrame() {}, onAudioSample: null });
  let s = '';
  for (let i = 0; i < romBytes.length; i += 0x8000) s += String.fromCharCode.apply(null, romBytes.subarray(i, i + 0x8000));
  nes.loadROM(s);
  nes.cpu.irqRequested = false;
  const m = nes.mmap;
  m.regWrite = (a, v) => write(a, v);
  m.regLoad = (a) => read(a);
  const w = m.write.bind(m);
  m.write = (a, v) => { if (a >= 0x8000) write(a, v); w(a, v); };
}
if (canRunHybrid) await init();

export const calls = {};

/** Run original routine `name` on the port's machine. Returns {a, x, y, c}; also sets port cpu.c. */
export function runOriginal(name, { a = 0, x = 0, y = 0, c = 0 } = {}) {
  if (!nes) throw new NotImplementedError(`${name}: hybrid needs roms/zelda.nes and jsnes`);
  calls[name] = (calls[name] ?? 0) + 1;
  const cpu = nes.cpu;
  const mem = cpu.mem;
  mem.set(ram, 0);
  mem.set(sram, 0x6000);
  nes.mmap.loadRomBank(bus.mapper.prgBank & 7, 0x8000);
  nes.mmap.loadRomBank(7, 0xc000); // Zelda keeps bank 7 fixed at $C000
  // MMC1 serial register: aligned, as SwitchBank always finds it (an aborted run may leave it mid-way).
  nes.mmap.regBuffer = 0;
  nes.mmap.regBufferCounter = 0;
  bus.mapper.shift = 0x10; // the port's MMC1 (it gets the same writes)
  const { addr } = label(name);
  cpu.REG_ACC = a & 0xff;
  cpu.REG_X = x & 0xff;
  cpu.REG_Y = y & 0xff;
  cpu.F_CARRY = c;
  cpu.REG_SP = 0xfd;
  cpu.push(((TRAP - 1) >> 8) & 0xff);
  cpu.push((TRAP - 1) & 0xff);
  cpu.REG_PC = addr - 1;
  for (let n = 0; ; n++) {
    if (((cpu.REG_PC + 1) & 0xffff) === TRAP) break;
    if (n > 5e6) throw new Error(`${name}: did not return`);
    cpu.emulate();
  }
  ram.set(mem.subarray(0, 0x800));
  sram.set(mem.subarray(0x6000, 0x8000));
  portCpu.c = cpu.F_CARRY;
  return { a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y, c: cpu.F_CARRY };
}

/** Replacement for src/game/stub.js: the stubbed routine runs as original code. Returns A. */
export function stub(name) {
  return (a = 0, x = 0, y = 0) => runOriginal(name, { a, x, y }).a;
}

/** Replacement for stubRegs() of src/game/stub.js: returns {a, x, y, c} of the original code. */
export function stubRegs(name) {
  return (a = 0, x = 0, y = 0) => runOriginal(name, { a, x, y });
}

/**
 * Replacement for stubX() of src/game/stub.js: fn(x) runs the original with X = slot and A/Y as
 * TableJump leaves them when the object jump tables dispatch ObjType[X] (A = [$03], Y = type*2+2).
 */
export function stubX(name) {
  return (x = 0) => runOriginal(name, { a: ram[0x03], x, y: (ram[0x34f + x] * 2 + 2) & 0xff }).a;
}
