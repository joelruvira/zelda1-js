// Audio-driver oracle (package P02): instruments jsnes to capture, for every call to
// DriveAudio (Z_00) made by IsrNmi, the RAM before/after the call, X on entry and the exact
// sequence of APU register writes ($4000-$4013, $4015, $4017) made inside it. Also records the
// APU writes of each whole logical frame (NMI) for the end-to-end comparison.
//
// It can inject sound requests (pokes into the original's RAM at DriveAudio entry) so every
// song, tune, effect and sample of the ROM is exercised from a plain title-screen movie.
import { Oracle } from './nes-oracle.mjs';

const OP_RTS = 0x60;

/** Frames each song is left playing in the sweep: long enough for the looping songs to wrap. */
export const SWEEP_SONG_FRAMES = { 0x80: 5000, 0x01: 2500, 0x40: 1300, 0x10: 4000 };

/**
 * Builds the built-in injection schedule that requests every sound in the ROM.
 * Best run on top of a movie that ends standing still in the game (register-name): the title
 * screen keeps requesting its own song and silencing everything when the demo restarts.
 * @param {object} [o]
 * @param {number} [o.start=200] first DriveAudio call (= NMI number) of the schedule
 * @param {number} [o.songFrames] frames per song (default: SWEEP_SONG_FRAMES, else 600)
 * @returns {{frames:number, pokes: Map<number, Array<{addr:number, value:number, restore?:boolean}>>}}
 */
export function fullSweepSchedule({ start = 200, songFrames } = {}) {
  const pokes = new Map();
  const add = (frame, addr, value, restore = false) => {
    if (!pokes.has(frame)) pokes.set(frame, []);
    pokes.get(frame).push({ addr, value, restore });
  };
  const SONG = 0x600, SAMPLE = 0x601, TUNE1 = 0x602, EFFECT = 0x603, TUNE0 = 0x604, PAUSED = 0xe0;
  let f = start;
  // Songs: every single bit and $06 (single phrase song with Y=$24).
  const songs = [0x80, 0x01, 0x40, 0x10, 0x02, 0x04, 0x08, 0x20, 0x06];
  for (const s of songs) { add(f, SONG, s); f += songFrames ?? SWEEP_SONG_FRAMES[s] ?? 600; }
  // Tune requests with bit 7 silence the song: test them at the end over a fresh song.
  add(f, SONG, 0x01); add(f + 100, TUNE0, 0x80);
  add(f + 200, SONG, 0x40); add(f + 300, TUNE1, 0x80); add(f + 330, SONG, 0x80);
  f += 600;
  const end = f;
  // Over the songs: effects, tunes and samples on a staggered cycle.
  const effects = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x80, 0x03, 0x21];
  const tune0 = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];
  const tune1 = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];
  const samples = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x11, 0x82];
  let i = 0;
  for (let g = start + 37; g < end; g += 97, i++) add(g, EFFECT, effects[i % effects.length]);
  i = 0;
  for (let g = start + 61; g < end; g += 151, i++) add(g, TUNE0, tune0[i % tune0.length]);
  i = 0;
  for (let g = start + 113; g < end; g += 389, i++) {
    // "Game Over" ($40) loops forever: stop it with the $80 request a little later.
    add(g, TUNE1, tune1[i % tune1.length]);
    if (tune1[i % tune1.length] === 0x40) add(g + 300, EFFECT, 0x80);
  }
  i = 0;
  for (let g = start + 89; g < end; g += 211, i++) add(g, SAMPLE, samples[i % samples.length]);
  // Pause for a few frames now and then (restored after the call so the game logic is untouched).
  for (let g = start + 500; g < end; g += 1700) for (let k = 0; k < 4; k++) add(g + k, PAUSED, 1, true);
  return { frames: end + 300, pokes };
}

/**
 * Runs the original and collects DriveAudio calls and per-frame APU writes.
 * @param {object} o
 * @param {Uint8Array} o.rom
 * @param {object} o.movie parsed movie
 * @param {number} o.driveAudioAddr CPU address of DriveAudio (bank 0)
 * @param {Map} [o.pokes] call index (1-based, = NMI number) -> pokes applied at DriveAudio entry
 */
export async function runAudioOracle({ rom, movie, driveAudioAddr, pokes = new Map(), sram = null, powerOnFill = 0 }) {
  const oracle = await Oracle.create({ rom, sram, powerOnFill });
  const nes = oracle.nes;
  const cpu = nes.cpu;
  const mem = cpu.mem;
  const calls = [];
  const frameWrites = [[]]; // index = logical frame (0 = reset)
  let cur = null;
  let callIndex = 0;
  let restore = [];

  const writeReg = nes.papu.writeReg.bind(nes.papu);
  nes.papu.writeReg = (addr, value) => {
    cur?.writes.push((addr << 8) | (value & 0xff));
    frameWrites[frameWrites.length - 1].push((addr << 8) | (value & 0xff));
    return writeReg(addr, value);
  };
  const emulate = cpu.emulate.bind(cpu);
  cpu.emulate = () => {
    // An instruction executes in this emulate() call unless an NMI or an unmasked IRQ is taken
    // first. jsnes keeps irqRequested set (APU frame/DMC IRQ) while I=1: the instruction runs.
    if (!cpu.nmiImmediate && !(cpu.irqRequested && cpu.F_INTERRUPT === 0) && cpu.cyclesToHalt === 0) {
      const pc = (cpu.REG_PC + 1) & 0xffff;
      if (!cur && pc === driveAudioAddr && oracle.prgBank === 0) {
        callIndex++;
        restore = [];
        for (const p of pokes.get(callIndex) ?? []) {
          if (p.restore) restore.push({ addr: p.addr, value: mem[p.addr] });
          mem[p.addr] = p.value;
        }
        cur = { index: callIndex, frame: oracle.nmiCount, x: cpu.REG_X & 0xff, sp: cpu.REG_SP & 0xff,
          pre: Uint8Array.from(mem.subarray(0, 0x800)), writes: [] };
      } else if (cur && mem[pc] === OP_RTS && (cpu.REG_SP & 0xff) === cur.sp) {
        cur.post = Uint8Array.from(mem.subarray(0, 0x800));
        calls.push(cur);
        cur = null;
        for (const r of restore) mem[r.addr] = r.value;
        restore = [];
      }
    }
    return emulate();
  };
  const frameSink = { write() { frameWrites.push([]); }, close() {} };
  // Each snapshot (frame N) opens the list of frame N+1: the writes of NMI N+1 land in
  // frameWrites[N+1], those of IsrReset/RunGame in frameWrites[0].
  oracle.run(movie, frameSink);
  frameWrites.pop(); // the list opened after the last frame
  return { calls, frameWrites };
}

/** Formats a packed write (addr << 8 | value). */
export function fmtWrite(w) {
  return `$${(w >> 8).toString(16).toUpperCase()}=${(w & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}
