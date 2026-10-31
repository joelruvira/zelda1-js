// Boot of a game session on a ROM and its real-time loop, shared by the web page (src/main.js) and the
// Android shell (android/web/app.js). Platform code (DOM, storage, audio unlock, touch) stays in those
// pages; this module only wires the core exactly as the page always did:
//   checkRevision -> createMachine -> prepare (input, SRAM) -> game logic -> cycle tracker -> IsrReset.

import { loadSymbols, checkRevision } from './core/rom.js';
import { createMachine } from './core/machine.js';
import { createLoop, runReset, runVideoFrame } from './core/loop.js';
import { setupTiming } from './core/timing.js';
import { cpu } from './core/ram.js';
import { createGameLogic } from './game/index.js';

/**
 * @param {import('./core/rom.js').Rom} rom
 * @param {object} [o]
 * @param {'hardware'|'jsnes'|'off'} [o.timingMode] cycle tracker mode (docs/TIMING.md §11)
 * @param {(machine: object) => void} [o.prepare] called on the new machine before IsrReset (attach input,
 *   restore the battery SRAM)
 * @param {() => {reset: () => void, nmi: () => void}} [o.fallback] logic to run while the game is not ported
 * @returns {Promise<{machine: object, game: object, ported: boolean, revision: {ok: boolean, mismatchedBanks: number[]}}>}
 */
export async function bootGame(rom, { timingMode = 'hardware', prepare = () => {}, fallback = null } = {}) {
  await loadSymbols();
  const { PRG_FINGERPRINT, INCBIN_RANGES } = await import('./core/symbols.js');
  const revision = checkRevision(rom, PRG_FINGERPRINT, INCBIN_RANGES);
  const machine = createMachine(rom);
  prepare(machine);
  const logic = createGameLogic();
  const game = logic.ported || !fallback ? logic : fallback(); // tile viewer until P01 ports IsrReset/IsrNmi
  try {
    await setupTiming({ rom, mode: logic.ported ? timingMode : 'off' });
  } catch (err) {
    console.warn('timing off:', err);
    await setupTiming({ rom, mode: 'off' });
  }
  cpu.reset(); // same power-on flags/stack as src/headless.js
  runReset(machine, game);
  return { machine, game, ported: logic.ported, revision };
}

/**
 * Real-time loop of a booted session (60.0988 video frames per second of real time, core/loop.js).
 * @param {object} o
 * @param {object} o.machine
 * @param {object} o.game
 * @param {(picture: Uint8ClampedArray) => void} o.present draw the RGBA picture of the last video frame
 * @param {() => ({endFrame: () => void}|null)} [o.audio] audio sink, closed once per video frame
 * @param {(err: Error) => void} [o.onHalt] a frame threw (the loop is stopped)
 * @param {() => number} [o.now] clock (default performance.now)
 * @param {(cb: () => void) => any} [o.schedule] wake-up source (default requestAnimationFrame)
 */
export function createGameLoop({ machine, game, present, audio = () => null, onHalt = () => {}, now, schedule }) {
  let halted = false;
  let picture = null;
  const loop = createLoop({
    frame: () => {
      if (halted) return;
      try {
        picture = runVideoFrame(machine, game);
      } catch (err) {
        // A routine of a later package is still a stub (NotImplementedError): stop on this frame.
        halted = true;
        loop.stop();
        onHalt(err);
        return;
      }
      audio()?.endFrame();
    },
    present: () => present(picture ?? machine.ppu.frameBuffer),
    ...(now ? { now } : {}),
    ...(schedule ? { schedule } : {}),
  });
  return loop;
}
