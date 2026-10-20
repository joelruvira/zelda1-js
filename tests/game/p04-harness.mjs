// Routine-level oracle for P04: runs one original routine on jsnes' 6502 (real ROM, RAM_01_CODE
// copied to WRAM like CopyCommonCodeToRam) from a given RAM state and register set, and returns
// the resulting RAM and registers, so a JS port can be diffed against it on random states.
// Needs roms/zelda.nes and tools/oracle/node_modules/jsnes; callers skip without them.

import { readFileSync } from 'node:fs';
import { loadSymbols, label, loadRom } from '../../src/core/rom.js';
import { SEGMENTS } from '../../src/core/symbols.js';
import { createMachine } from '../../src/core/machine.js';
import { ram } from '../../src/core/ram.js';
import { loadJsnes, hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { hasRom, ROM_PATH } from '../core/helpers.mjs';

export const canRunCpuOracle = async () => hasRom && (await hasJsnes());

const TRAP = 0x5ff0; // unmapped: execution stops when the routine returns here

export async function createCpuOracle() {
  const { NES } = await loadJsnes();
  await loadSymbols();
  const romBytes = readFileSync(ROM_PATH);
  const rom = loadRom(romBytes);
  createMachine(rom); // the port's bus/ROM for table()
  const nes = new NES({ onFrame() {}, onAudioSample: null });
  let s = '';
  for (let i = 0; i < romBytes.length; i += 0x8000) s += String.fromCharCode.apply(null, romBytes.subarray(i, i + 0x8000));
  nes.loadROM(s);
  const cpu = nes.cpu;
  cpu.irqRequested = false; // drop the pending power-on RESET: we jump straight into routines
  const mem = cpu.mem;
  const seg = SEGMENTS.BANK_01_CODE;
  const codeBytes = rom.prgBytes(seg.bank, seg.load, seg.size);

  return {
    /**
     * Run `name` on the 6502 from RAM `state` (2 KB). Returns {ram, a, x, y, c}.
     */
    run(name, state, { a = 0, x = 0, y = 0, c = 0 } = {}) {
      const { bank, addr } = label(name);
      mem.set(codeBytes, seg.run);
      if (addr < 0xc000 && addr >= 0x8000) nes.mmap.loadRomBank(bank, 0x8000);
      mem.set(state, 0);
      cpu.REG_ACC = a;
      cpu.REG_X = x;
      cpu.REG_Y = y;
      cpu.F_CARRY = c;
      cpu.REG_SP = 0xfd;
      cpu.push(((TRAP - 1) >> 8) & 0xff);
      cpu.push((TRAP - 1) & 0xff);
      cpu.REG_PC = addr - 1;
      for (let n = 0; ; n++) {
        if (((cpu.REG_PC + 1) & 0xffff) === TRAP) break;
        if (n > 200000) throw new Error(`${name}: did not return`);
        cpu.emulate();
      }
      return { ram: Uint8Array.from(mem.subarray(0, 0x800)), a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y, c: cpu.F_CARRY };
    },
    /** Run the JS port `fn` on the port's RAM from `state`; returns {ram, ret}. */
    runPort(fn, state) {
      ram.set(state);
      const ret = fn();
      return { ram: Uint8Array.from(ram), ret };
    },
  };
}

/** First differing addresses (stack page $0100-$01FF ignored), as "$addr: port!=orig". */
export function ramDiff(port, orig, max = 8) {
  const out = [];
  for (let i = 0; i < 0x800 && out.length < max; i++) {
    if (i >= 0x100 && i < 0x200) continue;
    if (port[i] !== orig[i]) out.push(`$${i.toString(16).padStart(4, '0')}: ${port[i].toString(16)}!=${orig[i].toString(16)}`);
  }
  return out;
}

/** Deterministic PRNG (xorshift32) for reproducible random states. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  return { byte: () => next() & 0xff, int: (n) => next() % n, chance: (p) => next() / 0x100000000 < p };
}
