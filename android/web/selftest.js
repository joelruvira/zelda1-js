// Pixel-perfect self test of the Android build (debug APK only; also runs in Node for the reference).
// Plays an input movie of tests/oracle/movies in 'hardware' timing two ways and hashes everything:
//   nmi track   : src/headless.js (the oracle's runner): per logical frame (IsrNmi) the NES colour indices
//                 of the picture, the RAM and the SRAM.
//   video track : src/session.js + core/loop.js runVideoFrame (exactly what the app shows): per 60.0988 Hz
//                 video frame, the RGBA picture handed to the canvas.
// scripts/android/device-test.mjs runs it in the phone's WebView and compares with the same code in Node.

import { createGame } from '../../src/headless.js';
import { bootGame } from '../../src/session.js';
import { runVideoFrame } from '../../src/core/loop.js';
import { timing } from '../../src/core/timing.js';
import { loadRom } from '../../src/core/rom.js';

const LETTERS = { R: 0x01, L: 0x02, D: 0x04, U: 0x08, T: 0x10, S: 0x20, B: 0x40, A: 0x80 };

function parseButtons(token = '.') {
  if (token === '.' || token === '-' || token === '0') return 0;
  if (/^0x[0-9a-f]{1,2}$/i.test(token)) return parseInt(token, 16);
  let mask = 0;
  for (const c of token) {
    if (c === '.') continue;
    if (!(c in LETTERS)) throw new Error(`zmv: unknown button "${c}"`);
    mask |= LETTERS[c];
  }
  return mask;
}

/** .zmv text -> {timing, length, p1, p2} (same format as tools/oracle/lib/movie.mjs parseZmv). */
export function parseZmv(text) {
  const p1 = [];
  const p2 = [];
  let timingMode = 'nmi';
  let header = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'zmv') { header = parts[1] === '1'; continue; }
    if (parts[0] === 'timing') { timingMode = parts[1]; continue; }
    const count = Number(parts[0]);
    if (!Number.isInteger(count) || count < 0) throw new Error(`zmv: bad count "${parts[0]}"`);
    const a = parseButtons(parts[1]);
    const b = parseButtons(parts[2]);
    for (let i = 0; i < count; i++) { p1.push(a); p2.push(b); }
  }
  if (!header) throw new Error('zmv: missing "zmv 1" header');
  return { timing: timingMode, length: p1.length, p1: Uint8Array.from(p1), p2: Uint8Array.from(p2) };
}

/** FNV-1a 32 of a byte/index array, as 8 hex digits. */
export function fnv(a) {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Digest of a list of hashes (to print one line). */
export const digest = (list) => fnv(new TextEncoder().encode(list.join(',')));

const now = () => globalThis.performance.now();

/** @param {{rom: Uint8Array, movie: ReturnType<typeof parseZmv>, sram?: Uint8Array|null}} o */
export async function runNmiTrack({ rom, movie, sram = null }) {
  const game = await createGame({ rom, sram, timing: 'hardware' });
  const fb = [fnv(game.framebuffer)];
  const ram = [fnv(game.ram)];
  const srm = [fnv(game.sram)];
  const t0 = now();
  for (let i = 0; i < movie.length; i++) {
    game.stepFrame(movie.p1[i], movie.p2[i]);
    fb.push(fnv(game.framebuffer));
    ram.push(fnv(game.ram));
    srm.push(fnv(game.sram));
  }
  const ms = now() - t0;
  return { frames: movie.length, fb, ram, sram: srm, ms, msPerFrame: ms / Math.max(1, movie.length), failures: timing.stats.failures };
}

/** @param {{rom: Uint8Array, movie: ReturnType<typeof parseZmv>, sram?: Uint8Array|null}} o */
export async function runVideoTrack({ rom, movie, sram = null }) {
  const session = await bootGame(loadRom(rom), {
    timingMode: 'hardware',
    prepare: (m) => {
      m.ram.fill(0); // power-on RAM of the oracle (headless powerOnFill 0)
      m.sram.fill(0);
      if (sram) m.sram.set(sram.subarray(0, 0x2000));
    },
  });
  const { machine } = session;
  // the input of the logical frame being run (nested NMIs read it too, like src/headless.js)
  const game = {
    ...session.game,
    nmi: () => {
      const i = timing.frames;
      machine.input.setOverride(0, movie.p1[i] ?? 0);
      machine.input.setOverride(1, movie.p2[i] ?? 0);
      return session.game.nmi();
    },
  };
  const pics = [];
  const t0 = now();
  let guard = movie.length * 4 + 64;
  while (timing.frames < movie.length && guard-- > 0) pics.push(fnv(runVideoFrame(machine, game)));
  const ms = now() - t0;
  return {
    nmis: timing.frames, videoFrames: pics.length, pics, ram: fnv(machine.ram), sram: fnv(machine.sram),
    ms, msPerFrame: ms / Math.max(1, pics.length), failures: timing.stats.failures,
  };
}

/**
 * Runs both tracks of one movie.
 * @param {{rom: Uint8Array, name: string, zmv: string, sram?: Uint8Array|null}} o
 */
export async function selfTest({ rom, name, zmv, sram = null }) {
  const movie = parseZmv(zmv);
  const nmi = await runNmiTrack({ rom, movie, sram });
  const video = await runVideoTrack({ rom, movie, sram });
  return {
    name,
    frames: movie.length,
    nmi,
    video,
    digest: { fb: digest(nmi.fb), ram: digest(nmi.ram), sram: digest(nmi.sram), video: digest(video.pics) },
  };
}
