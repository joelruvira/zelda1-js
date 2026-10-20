// Loads the port's headless runner and drives it with the same movie as the oracle.
//
// Contract (docs/ORACLE.md, "Headless runner contract"):
//   export function createGame({ rom, sram, powerOnFill }) -> game
//   game.ram         Uint8Array(0x800)  live NES RAM; right after createGame it must hold frame 0
//                                       (IsrReset + RunGame done, before the first NMI)
//   game.sram        Uint8Array(0x2000) live $6000-$7FFF
//   game.stepFrame(p1, p2)              runs exactly one IsrNmi; p1/p2 are what ReadInputs reads
//                                       (ButtonsPressed layout: A=$80 B=$40 Sel=$20 Start=$10 U D L R)
//   game.framebuffer Uint8Array(256*240) NES color indices of the picture drawn after the last
//                                       stepFrame (optional; or game.renderFrame() returning one)
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './rom-file.mjs';
import { FB_SIZE, canonicalizeIndices, getPalette } from './palette.mjs';
import { RAM_SIZE, SRAM_SIZE } from './trace.mjs';

export const DEFAULT_PORT_MODULE = resolve(REPO_ROOT, 'src/headless.js');

export class PortMissingError extends Error {}

export async function loadPort(modulePath = DEFAULT_PORT_MODULE) {
  if (!existsSync(modulePath)) {
    throw new PortMissingError(
      `Port headless runner not found at ${modulePath}. The port does not implement the oracle ` +
        'contract yet (see docs/ORACLE.md, "Headless runner contract"; template: ' +
        'tools/oracle/headless-stub.mjs). Use --port <module> to point elsewhere.',
    );
  }
  const mod = await import(pathToFileURL(resolve(modulePath)).href);
  if (typeof mod.createGame !== 'function') {
    throw new PortMissingError(`${modulePath} does not export createGame({rom, sram, powerOnFill}).`);
  }
  return mod;
}

export function validateGame(game) {
  const problems = [];
  if (!(game?.ram instanceof Uint8Array) || game.ram.length !== RAM_SIZE) problems.push('game.ram must be Uint8Array(0x800)');
  if (!(game?.sram instanceof Uint8Array) || game.sram.length !== SRAM_SIZE) problems.push('game.sram must be Uint8Array(0x2000)');
  if (typeof game?.stepFrame !== 'function') problems.push('game.stepFrame(p1, p2) is missing');
  if (problems.length) throw new PortMissingError(`Port contract violated: ${problems.join('; ')}`);
}

function readFramebuffer(game) {
  const fb = typeof game.renderFrame === 'function' ? game.renderFrame() : game.framebuffer;
  if (!fb) return null;
  if (fb.length !== FB_SIZE) throw new Error(`port framebuffer must have ${FB_SIZE} entries, got ${fb.length}`);
  return fb;
}

/**
 * Plays inputs through the port. `inputs` is a movie ({length, p1, p2}); for movies with
 * 'video' timing pass the oracle trace's recorded per-frame inputs instead (inputsFromTrace).
 */
export async function runPort({ modulePath, rom, sram = null, powerOnFill = 0x00, inputs, sink, captureFb = () => false }) {
  const mod = await loadPort(modulePath);
  const palette = await getPalette();
  const game = await mod.createGame({ rom, sram: sram ? Uint8Array.from(sram) : null, powerOnFill });
  validateGame(game);
  const record = (frame, p1, p2) => {
    let fb = null;
    if (captureFb(frame)) {
      const raw = readFramebuffer(game);
      fb = raw ? canonicalizeIndices(raw, palette) : null;
    }
    sink.write({ frame, videoFrame: frame, p1, p2, ram: game.ram, sram: game.sram, fb });
  };
  record(0, 0, 0);
  for (let i = 0; i < inputs.length; i++) {
    game.stepFrame(inputs.p1[i], inputs.p2[i]);
    record(i + 1, inputs.p1[i], inputs.p2[i]);
  }
}

/** Builds an nmi-timed input list from a trace (frame N's recorded p1/p2 -> index N-1). */
export function inputsFromTrace(trace) {
  const frames = trace.frames.filter((f) => f.frame > 0).sort((a, b) => a.frame - b.frame);
  return {
    timing: 'nmi',
    length: frames.length,
    p1: Uint8Array.from(frames, (f) => f.p1),
    p2: Uint8Array.from(frames, (f) => f.p2),
  };
}
