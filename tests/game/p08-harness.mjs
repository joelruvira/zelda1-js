// Routine-level oracle for P08: runs one original routine on jsnes' 6502 (real ROM) from a given
// RAM + SRAM state, with the bank the caller would have mapped, and returns RAM/SRAM/registers.
// Unlike p04-harness, the whole SRAM is part of the state (PlayAreaTiles, RAM_01_CODE).
// Needs roms/zelda.nes and tools/oracle/node_modules/jsnes; callers skip without them.

import { readFileSync } from 'node:fs';
import { loadSymbols, label, loadRom } from '../../src/core/rom.js';
import { SEGMENTS } from '../../src/core/symbols.js';
import { createMachine } from '../../src/core/machine.js';
import { loadJsnes, hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { hasRom, ROM_PATH } from '../core/helpers.mjs';

export const canRunP08Oracle = async () => hasRom && (await hasJsnes());

const TRAP = 0x5ff0;

export async function createP08Oracle() {
  const { NES } = await loadJsnes();
  await loadSymbols();
  const romBytes = readFileSync(ROM_PATH);
  const rom = loadRom(romBytes);
  createMachine(rom);
  const nes = new NES({ onFrame() {}, onAudioSample: null });
  let s = '';
  for (let i = 0; i < romBytes.length; i += 0x8000) s += String.fromCharCode.apply(null, romBytes.subarray(i, i + 0x8000));
  nes.loadROM(s);
  const cpu = nes.cpu;
  cpu.irqRequested = false;
  const mem = cpu.mem;
  // Ignore APU/PPU side effects: route them to nowhere (the RAM never depends on them).
  nes.mmap.regWrite = () => {};
  nes.mmap.regLoad = () => 0;
  const seg = SEGMENTS.BANK_01_CODE;
  const codeBytes = rom.prgBytes(seg.bank, seg.load, seg.size);

  return {
    rom,
    /** SRAM image with RAM_01_CODE in place (what CopyCommonCodeToRam leaves). */
    baseSram() {
      const sram = new Uint8Array(0x2000);
      sram.set(codeBytes, seg.run - 0x6000);
      return sram;
    },
    /** Run `name` with `bank` mapped at $8000. Returns {ram, sram, a, x, y, c}. */
    run(name, state, sramState, bank, { a = 0, x = 0, y = 0, c = 0 } = {}) {
      const { addr, bank: own } = label(name);
      mem.set(state, 0);
      mem.set(sramState, 0x6000);
      nes.mmap.regBufferCounter = 0; // an aborted run may have left a serial MMC1 write half done
      nes.mmap.regBuffer = 0;
      nes.mmap.loadRomBank(addr >= 0x8000 && addr < 0xc000 ? own : bank, 0x8000);
      nes.mmap.loadRomBank(7, 0xc000);
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
        if (n > 2e6) throw new Error(`${name}: did not return (PC $${cpu.REG_PC.toString(16)})`);
        cpu.emulate();
      }
      return {
        ram: Uint8Array.from(mem.subarray(0, 0x800)), sram: Uint8Array.from(mem.subarray(0x6000, 0x8000)),
        a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y, c: cpu.F_CARRY,
      };
    },
  };
}

/** First differing addresses (stack page ignored) as "$addr: port!=orig". */
export function memDiff(port, orig, base = 0, max = 8) {
  const out = [];
  for (let i = 0; i < port.length && out.length < max; i++) {
    if (base === 0 && i >= 0x100 && i < 0x200) continue;
    if (port[i] !== orig[i]) out.push(`$${(base + i).toString(16).padStart(4, '0')}: ${port[i].toString(16)}!=${orig[i].toString(16)}`);
  }
  return out;
}
