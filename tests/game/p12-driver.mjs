// Closed-loop driver of the oracle (jsnes running the original game), used to generate movies that
// depend on the game state (P12: ow-tour, cave-and-cellar). Inputs are chosen frame by frame from the
// RAM and recorded; the result is a plain .zmv (timing nmi), so replaying it from power-on reproduces
// exactly the same run (jsnes and the game are deterministic). rewind(f) replays the recorded inputs
// of frames 1..f on a fresh emulator (jsnes savestates would drop the oracle's hooks and PPU fixes).
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { formatButtons } from '../../tools/oracle/lib/movie.mjs';

export async function createDriver() {
  const rom = loadRomFile();
  let o, inputs, forced, next, done;
  const comments = new Map(); // frame index -> comment

  async function boot(replay = []) {
    o = await Oracle.create({ rom: rom.bytes });
    inputs = [];
    forced = replay;
    next = 0;
    done = 0;
    // Buttons are latched when NMI n begins (as Oracle.run does); record what NMI n really got.
    o.handlers.nmi = (n) => {
      const v = n - 1 < forced.length ? forced[n - 1] : next;
      o.setButtons(v, 0);
      inputs[n - 1] = v;
    };
    o.handlers.snapshot = (f) => { done = f; };
    while (o.nmiCount === 0) o.nes.frame(); // frame 0: first NMI entry
    while (done < replay.length) advance();
    forced = [];
  }

  function advance() {
    const target = done + 1;
    for (let guard = 0; done < target; guard++) {
      o.nes.frame();
      if (guard > 60) throw new Error('driver: NMI did not complete');
    }
  }

  await boot();
  const d = {
    rom,
    get ram() { return o.ram; },
    get sram() { return o.sram; },
    /** Frames completed (the last snapshot index). */
    get frame() { return done; },
    /** One NMI with buttons p1. */
    step(p1 = 0) {
      next = p1 & 0xff;
      advance();
    },
    run(n, p1 = 0) { for (let i = 0; i < n; i++) d.step(p1); },
    comment(text) { comments.set(done, text); },
    /** Fast savestate (jsnes state copied into the live objects, so the oracle's hooks stay). */
    save() {
      return { nes: structuredClone(o.nes.toJSON()), done, inputs: inputs.slice(0, done + 1),
        counters: [o.nmiCount, o.completedFrames, o.videoFrames, o.prgBank], comments: new Map(comments) };
    },
    load(st) {
      const s = structuredClone(st.nes);
      o.nes.cpu.fromJSON(s.cpu);
      o.nes.mmap.fromJSON(s.mmap);
      o.nes.ppu.fromJSON(s.ppu);
      o.nes.papu.fromJSON(s.papu);
      o.nes.controllers[1].fromJSON(s.controllers[1]);
      o.nes.controllers[2].fromJSON(s.controllers[2]);
      [o.nmiCount, o.completedFrames, o.videoFrames, o.prgBank] = st.counters;
      done = st.done;
      inputs = st.inputs.slice();
      comments.clear();
      for (const [k, v] of st.comments) comments.set(k, v);
    },
    /** Go back to the state of frame f (keeps the inputs of frames 1..f). */
    async rewind(f) {
      const keep = inputs.slice(0, f);
      for (const k of [...comments.keys()]) if (k > f) comments.delete(k);
      await boot(keep);
    },
    /** Serialize the recorded inputs of frames 1..frame as .zmv text (run-length encoded). */
    toZmv(header = []) {
      const list = inputs.slice(0, done);
      const lines = ['zmv 1', ...header.map((h) => `# ${h}`), 'timing nmi'];
      let i = 0;
      while (i < list.length) {
        if (comments.has(i)) lines.push(`# ${comments.get(i)}`);
        let j = i + 1;
        while (j < list.length && list[j] === list[i] && !comments.has(j)) j++;
        lines.push(`${j - i} ${formatButtons(list[i])}`);
        i = j;
      }
      return lines.join('\n') + '\n';
    },
  };
  return d;
}
