// Fixed-timestep main loop at the NTSC NES frame rate, decoupled from the display rate.
// requestAnimationFrame (or setTimeout) only wakes the loop up; an accumulator decides how
// many emulated frames to run, so a 144 Hz monitor still gets exactly 60.0988 frames/s.

export const NES_FPS = 60.0988;
export const FRAME_MS = 1000 / NES_FPS;
const MAX_CATCHUP_FRAMES = 4;

/**
 * Run one NES frame of the game: the NMI drives everything in Zelda (RunGame just loops
 * forever after enabling NMI), so a frame = begin vblank, run the ported IsrNmi, render.
 * @param {{ppu: import('./ppu.js').Ppu}} machine
 * @param {{nmi: () => void}} game
 */
export function runFrame(machine, game) {
  machine.ppu.beginFrame();
  game.nmi();
  machine.ppu.endFrame();
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
