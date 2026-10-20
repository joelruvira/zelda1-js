// Assembles the machine: ROM + MMC1 + PPU + input + RAM/SRAM on the bus.
// One instance per page; the game code imports `bus`/`ram` directly.

import { Mmc1 } from './mapper.js';
import { Ppu } from './ppu.js';
import { Input } from './input.js';
import { ram, sram, cpu } from './ram.js';
import { bus, connect } from './bus.js';

/** @param {import('./rom.js').Rom|null} rom */
export function createMachine(rom = null, { input = new Input() } = {}) {
  const mapper = new Mmc1();
  const ppu = new Ppu();
  connect({ rom, mapper, ppu, input });
  return { rom, mapper, ppu, input, ram, sram, cpu, bus };
}
