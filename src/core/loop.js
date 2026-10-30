// Fixed-timestep main loop at the NTSC NES frame rate, decoupled from the display rate.
// requestAnimationFrame (or setTimeout) only wakes the loop up; an accumulator decides how
// many emulated frames to run, so a 144 Hz monitor still gets exactly 60.0988 frames/s.

import { timing } from './timing.js';

export const NES_FPS = 60.0988;
export const FRAME_MS = 1000 / NES_FPS;
const MAX_CATCHUP_FRAMES = 4;

/**
 * Run one logical frame of the game (one RTI of IsrNmi, docs/ORACLE.md): the NMI drives everything in
 * Zelda (RunGame just loops forever after enabling NMI).
 *  * cycle tracker off: begin vblank, run the ported IsrNmi in "zero time", render the rest.
 *  * tracker on (core/timing.js): the CPU runs from where it was (idle loop, NMI latency, DMC halts) to
 *    the next RTI with every PPU access on its exact cycle; the PPU crosses frame boundaries by itself
 *    (lag frames) and stops at the picture shown after that RTI.
 * @param {{ppu: import('./ppu.js').Ppu}} machine
 * @param {{nmi: () => void}} game
 */
export function runFrame(machine, game) {
  if (timing.enabled && machine.ppu.continuous) {
    timing.stepFrame(game.nmi);
    return;
  }
  machine.ppu.beginFrame();
  game.nmi();
  machine.ppu.endFrame();
}

/**
 * One VIDEO frame (60.0988 Hz): returns the RGBA picture to show. With the tracker on, the pictures are
 * the ones the PPU completes (core/ppu.js onFrame): a long NMI (loading a mode with the video off)
 * completes several, which are shown one per video frame without running a new NMI meanwhile, exactly
 * like the original's lag frames. Without the tracker: one NMI per video frame.
 */
export function runVideoFrame(machine, game) {
  const ppu = machine.ppu;
  if (!(timing.enabled && ppu.continuous)) {
    runFrame(machine, game);
    return ppu.frameBuffer;
  }
  if (ppu.onFrame !== pictures.capture) ppu.onFrame = pictures.capture;
  for (let guard = 0; !pictures.queue.length && guard < 64; guard++) timing.stepFrame(game.nmi);
  pictures.release(pictures.shown);
  pictures.shown = pictures.queue.shift() ?? null;
  return pictures.shown ?? ppu.frameBuffer;
}

/** Completed pictures waiting to be shown (copies of ppu.frameBuffer, pooled). */
const pictures = {
  queue: [],
  pool: [],
  shown: null,
  capture(ppu) {
    const buf = pictures.pool.pop() ?? new Uint8ClampedArray(ppu.frameBuffer.length);
    buf.set(ppu.frameBuffer);
    pictures.queue.push(buf);
    if (pictures.queue.length > 32) pictures.release(pictures.queue.shift()); // never grow unbounded
  },
  release(buf) { if (buf && pictures.pool.length < 8) pictures.pool.push(buf); },
};

/** Power-on + IsrReset/RunGame (with the tracker when it is on: the reset's long loops are timed too). */
export function runReset(machine, game) {
  if (timing.enabled) {
    timing.attach(machine);
    timing.runReset(game.reset);
    return;
  }
  game.reset();
}

/**
 * @param {object} o
 * @param {() => void} o.frame     run one emulated frame (logic + PPU)
 * @param {() => void} [o.present] draw the latest framebuffer (called at most once per wakeup)
 * @param {() => number} [o.now]
 * @param {(cb: () => void) => any} [o.schedule]
 */
export function createLoop({ frame, present = () => {}, now = () => performance.now(), schedule } = {}) {
  const sched = schedule ?? ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, FRAME_MS / 2)));
  let running = false;
  let last = 0;
  let acc = 0;
  let frames = 0;

  /** Advance by elapsed real time; returns the number of frames run. */
  function tick() {
    const t = now();
    acc += Math.min(t - last, FRAME_MS * MAX_CATCHUP_FRAMES);
    last = t;
    let n = 0;
    while (acc >= FRAME_MS) {
      frame();
      acc -= FRAME_MS;
      n++;
    }
    frames += n;
    if (n) present();
    return n;
  }

  function wake() {
    if (!running) return;
    tick();
    sched(wake);
  }

  return {
    start() { if (running) return; running = true; last = now(); acc = 0; sched(wake); },
    stop() { running = false; },
    /** Run exactly one frame (debugging / frame advance). */
    step() { frame(); frames++; present(); },
    tick,
    get running() { return running; },
    get frameCount() { return frames; },
  };
}
