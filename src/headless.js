// Headless runner of the port for the oracle (contract: docs/ORACLE.md, "Headless runner contract").
// No DOM: Node or a worker. Wires the same machine as the page and runs one IsrNmi per stepFrame().
// The core keeps RAM/SRAM/bus as module singletons, so there is one live game per process:
// every createGame() call re-initialises it.

import { loadRom, loadSymbols } from './core/rom.js';
import { createMachine } from './core/machine.js';
import { runFrame, runReset } from './core/loop.js';
import { setupTiming, timing } from './core/timing.js';
import { cpu } from './core/ram.js';
import { createGameLogic } from './game/index.js';

/**
 * @param {{rom: Uint8Array|ArrayBuffer, sram?: Uint8Array|null, powerOnFill?: number,
 *   timing?: 'off'|'jsnes'|'hardware', strict?: boolean, inputFor?: (nmi: number) => [number, number]}} o
 *   rom: the whole .nes file (iNES header included).
 *   timing: cycle tracker (core/timing.js, docs/TIMING.md). 'jsnes' (default, or env ZELDA_TIMING)
 *     reproduces the CI oracle; 'off' = the old zero-time model. strict: a misplaced/missing breadcrumb throws TimingError.
 *   inputFor: input of the n-th NMI (1-based) when an NMI starts inside another one (nested NMI);
 *     without it that NMI reads the stepFrame() input.
 */
export async function createGame({ rom, sram = null, powerOnFill = 0x00, timing: mode, strict, inputFor = null } = {}) {
  await loadSymbols();
  const machine = createMachine(loadRom(rom));
  const env = typeof process !== 'undefined' ? process.env : {};
  mode ??= env.ZELDA_TIMING || 'jsnes';
  strict ??= env.ZELDA_TIMING_STRICT === '1';
  await setupTiming({ rom: machine.rom, mode, strict });
  machine.ram.fill(powerOnFill & 0xff);
  machine.sram.fill(0);
  if (sram) machine.sram.set(sram.subarray(0, 0x2000));
  cpu.reset();
  const logic = createGameLogic();
  runReset(machine, logic); // IsrReset + RunGame: game.ram is now "frame 0"
  let stepInput = [0, 0];
  const timedLogic = {
    ...logic,
    nmi: (n) => {
      // the n-th NMI reads its own input: stepFrame's, or inputFor(n) for an extra (nested) NMI
      const inp = n !== undefined && n !== timing.frames + 1 && inputFor ? inputFor(n) : stepInput;
      machine.input.setOverride(0, inp[0] & 0xff);
      machine.input.setOverride(1, inp[1] & 0xff);
      return logic.nmi();
    },
  };
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
      stepInput = [p1, p2];
      runFrame(machine, timedLogic);
    },
    /** The cycle tracker (core/timing.js) when timing is on. */
    timing: mode !== 'off' ? timing : null,
  };
}
