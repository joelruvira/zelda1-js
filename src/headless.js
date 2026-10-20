// Headless runner of the port for the oracle (contract: docs/ORACLE.md, "Headless runner contract").
// No DOM: Node or a worker. Wires the same machine as the page and runs one IsrNmi per stepFrame().
// The core keeps RAM/SRAM/bus as module singletons, so there is one live game per process:
// every createGame() call re-initialises it.

import { loadRom, loadSymbols } from './core/rom.js';
import { createMachine } from './core/machine.js';
import { runFrame } from './core/loop.js';
import { cpu } from './core/ram.js';
import { createGameLogic } from './game/index.js';

/**
 * @param {{rom: Uint8Array|ArrayBuffer, sram?: Uint8Array|null, powerOnFill?: number}} o
 *   rom: the whole .nes file (iNES header included).
 */
export async function createGame({ rom, sram = null, powerOnFill = 0x00 } = {}) {
  await loadSymbols();
  const machine = createMachine(loadRom(rom));
  machine.ram.fill(powerOnFill & 0xff);
  machine.sram.fill(0);
  if (sram) machine.sram.set(sram.subarray(0, 0x2000));
  cpu.reset();
  const logic = createGameLogic();
  logic.reset(); // IsrReset + RunGame: game.ram is now "frame 0"
  return {
    ram: machine.ram,
    sram: machine.sram,
    machine,
    ported: logic.ported,
    /** Picture drawn after the last stepFrame, as NES colour indices (256*240). */
    framebuffer: machine.ppu.indexBuffer,
    /** One IsrNmi; p1/p2 are the bytes ReadInputs will read (A=$80 B=$40 Sel=$20 St=$10 U D L R). */
    stepFrame(p1 = 0, p2 = 0) {
      machine.input.setOverride(0, p1 & 0xff);
      machine.input.setOverride(1, p2 & 0xff);
      runFrame(machine, logic);
    },
  };
}
