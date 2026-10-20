// Runs the original ROM in jsnes and produces one snapshot per logical frame.
//
// Frame definition (see docs/ORACLE.md): Zelda does all of its work inside IsrNmi (Z_07);
// the main program idles in LoopForever. Logical frame N (N >= 1) is the state right when
// the N-th NMI handler executes its final RTI. Frame 0 is the state at the entry of the first
// NMI (power-on + IsrReset + RunGame done). The RTI only reads the stack, so the snapshot is
// taken just before it executes.
import { loadJsnes } from './jsnes-loader.mjs';
import { getPalette, jsnesBufferToIndices } from './palette.mjs';
import { RAM_SIZE, SRAM_SIZE } from './trace.mjs';

const OP_RTI = 0x40;

/** Sets jsnes controller state from a ButtonsPressed-layout byte (A=$80 ... Right=$01). */
function applyButtons(controller, mask) {
  for (let i = 0; i < 8; i++) controller.state[i] = mask & (0x80 >> i) ? 0x41 : 0x40;
}

export class Oracle {
  static async create({ rom, sram = null, powerOnFill = 0x00 } = {}) {
    const { NES } = await loadJsnes();
    const palette = await getPalette();
    return new Oracle(NES, palette, rom, sram, powerOnFill);
  }

  constructor(NES, palette, rom, sram, powerOnFill) {
    this.palette = palette;
    this.videoFrames = 0;
    this.nmiCount = 0;
    this.completedFrames = 0;
    this.prgBank = null;
    this.handlers = { snapshot: null, video: null, nmi: null };
    this.nes = new NES({ onFrame: (buf) => this.#onVideoFrame(buf), onAudioSample: null });
    this.nes.loadROM(romToBinaryString(rom));
    this.nes.ppu.clipToTvSize = false;
    const mem = this.nes.cpu.mem;
    if (powerOnFill !== 'jsnes') mem.fill(powerOnFill, 0, 0x2000);
    if (sram) mem.set(sram.subarray(0, SRAM_SIZE), 0x6000);
    this.#installHooks();
  }

  get ram() {
    return this.nes.cpu.mem.subarray(0, RAM_SIZE);
  }

  get sram() {
    return this.nes.cpu.mem.subarray(0x6000, 0x6000 + SRAM_SIZE);
  }

  #installHooks() {
    const cpu = this.nes.cpu;
    const mem = cpu.mem;
    const emulate = cpu.emulate.bind(cpu);
    cpu.emulate = () => {
      if (!cpu.nmiImmediate && !cpu.irqRequested && cpu.cyclesToHalt === 0) {
        if (mem[(cpu.REG_PC + 1) & 0xffff] === OP_RTI) {
          this.completedFrames++;
          this.handlers.snapshot?.(this.completedFrames);
        }
      }
      return emulate();
    };
    const nmi = cpu.doNonMaskableInterrupt.bind(cpu);
    cpu.doNonMaskableInterrupt = (status) => {
      if (this.nmiCount === 0) this.handlers.snapshot?.(0);
      this.nmiCount++;
      this.handlers.nmi?.(this.nmiCount);
      return nmi(status);
    };
    const mmap = this.nes.mmap;
    const setReg = mmap.setReg?.bind(mmap);
    if (setReg) {
      mmap.setReg = (reg, value) => {
        if (reg === 3) this.prgBank = value & 0x0f;
        return setReg(reg, value);
      };
    }
  }

  #onVideoFrame(buffer) {
    this.videoFrames++;
    this.handlers.video?.(buffer);
  }

  setButtons(p1, p2 = 0) {
    applyButtons(this.nes.controllers[1], p1);
    applyButtons(this.nes.controllers[2], p2);
    this.p1 = p1;
    this.p2 = p2;
  }

  framebufferIndices(buffer = this.nes.ppu.buffer) {
    return jsnesBufferToIndices(buffer, this.palette);
  }

  pcInfo() {
    const pc = (this.nes.cpu.REG_PC + 1) & 0xffff;
    return `PC=$${pc.toString(16).padStart(4, '0')} bank=${this.prgBank ?? '?'}`;
  }

  /**
   * Plays `movie` from power-on, calling sink.write(record) for frames 0..movie.length.
   * captureFb(frame) -> bool selects frames whose framebuffer is recorded: the picture
   * the PPU renders right after that frame's NMI (the next completed video frame).
   */
  run(movie, sink, { captureFb = () => false, maxVideoFrames } = {}) {
    if (this.nmiCount !== 0) throw new Error('Oracle.run must start from power-on (create a new Oracle)');
    const target = movie.length;
    const limit = maxVideoFrames ?? target * 3 + 600;
    let pending = null;
    const flush = () => {
      if (pending) sink.write(pending);
      pending = null;
    };
    this.setButtons(0, 0);
    this.handlers.nmi = (n) => {
      if (movie.timing === 'nmi') {
        const i = n - 1;
        this.setButtons(i < target ? movie.p1[i] : 0, i < target ? movie.p2[i] : 0);
      }
      this.nmiVideoFrame = this.videoFrames;
      this.nmiButtons = [this.p1, this.p2];
    };
    this.handlers.snapshot = (frame) => {
      if (frame > target) return;
      flush();
      const [p1, p2] = frame === 0 ? [0, 0] : this.nmiButtons;
      pending = {
        frame,
        videoFrame: frame === 0 ? this.videoFrames : this.nmiVideoFrame,
        p1,
        p2,
        ram: Uint8Array.from(this.ram),
        sram: Uint8Array.from(this.sram),
        wantsFb: captureFb(frame),
        fb: null,
      };
      if (!pending.wantsFb) flush();
    };
    this.handlers.video = (buffer) => {
      if (pending?.wantsFb) {
        pending.fb = this.framebufferIndices(buffer);
        flush();
      }
    };
    try {
      while (this.completedFrames < target || pending) {
        if (movie.timing === 'video') {
          const i = this.videoFrames;
          this.setButtons(i < target ? movie.p1[i] : 0, i < target ? movie.p2[i] : 0);
        }
        this.nes.frame();
        if (this.videoFrames > limit) {
          throw new Error(
            `oracle: no progress after ${this.videoFrames} video frames ` +
              `(${this.completedFrames}/${target} logical frames; ${this.pcInfo()}). ` +
              'The NMI handler may be stuck (e.g. waiting for sprite 0 hit).',
          );
        }
      }
      flush();
    } finally {
      this.handlers = { snapshot: null, video: null, nmi: null };
    }
  }
}

function romToBinaryString(bytes) {
  // jsnes accepts typed arrays too, but a binary string works with every jsnes version.
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return s;
}
