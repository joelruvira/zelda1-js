// The jsnes oracle (tools/oracle/lib/nes-oracle.mjs) driven one logical frame at a time, so it can run in
// lockstep with the Mesen2 stream. Same frame/input/picture definition as Oracle.run (copied logic), plus
// read-only instrumentation used to classify differences: PPU register writes landing on a visible row and
// the video frames each NMI spans (the same evidence as tools/oracle/battery.mjs).
import { Oracle } from '../../oracle/lib/nes-oracle.mjs';

export class JsnesStepper {
  static async create({ rom, sram = null, powerOnFill = 0, movie }) {
    const s = new JsnesStepper();
    s.oracle = await Oracle.create({ rom, sram, powerOnFill });
    s.movie = movie;
    s.#install();
    return s;
  }

  #install() {
    const o = this.oracle, nes = o.nes, cpu = nes.cpu, ppu = nes.ppu, mem = cpu.mem, movie = this.movie;
    const target = movie.length;
    this.queue = [];
    let pending = null;
    let writes = [];
    let nmiStartVideo = 0;
    let nmisSinceRti = 0;
    const flush = () => { if (pending) this.queue.push(pending); pending = null; };
    o.setButtons(0, 0);
    // instrumentation wrappers (installed on top of the Oracle's own hooks; they never change emulation)
    const nmi = cpu.doNonMaskableInterrupt.bind(cpu);
    cpu.doNonMaskableInterrupt = (st) => {
      nmiStartVideo = o.videoFrames;
      nmisSinceRti++;
      writes = [];
      return nmi(st);
    };
    const emulate = cpu.emulate.bind(cpu);
    cpu.emulate = () => {
      if (!cpu.nmiImmediate && !(cpu.irqRequested && cpu.F_INTERRUPT === 0) && cpu.cyclesToHalt === 0
        && mem[(cpu.REG_PC + 1) & 0xffff] === 0x40) {
        this.info = { startVideo: nmiStartVideo, endVideo: o.videoFrames, endScan: ppu.scanline - 21, writes, nmis: nmisSinceRti };
        writes = [];
        nmisSinceRti = 0;
      }
      return emulate();
    };
    const mmap = nes.mmap;
    const mwrite = mmap.write.bind(mmap);
    mmap.write = (addr, val) => {
      if ((addr >= 0x2000 && addr < 0x4000) || addr === 0x4014) {
        const row = ppu.scanline - 20; // jsnes: scanline 20 = pre-render, buffer row = scanline - 20
        writes.push({ reg: addr === 0x4014 ? 0x4014 : 0x2000 | (addr & 7), val, row, dot: ppu.curX });
      }
      return mwrite(addr, val);
    };
    o.handlers.nmi = (n) => {
      if (movie.timing === 'nmi') {
        const i = n - 1;
        o.setButtons(i < target ? movie.p1[i] : 0, i < target ? movie.p2[i] : 0);
      }
      o.nmiVideoFrame = o.videoFrames;
      o.nmiButtons = [o.p1, o.p2];
    };
    o.handlers.snapshot = (frame) => {
      if (frame > target) return;
      flush();
      const [p1, p2] = frame === 0 ? [0, 0] : o.nmiButtons;
      pending = {
        frame, videoFrame: frame === 0 ? o.videoFrames : o.nmiVideoFrame, p1, p2,
        ram: Uint8Array.from(o.ram), sram: Uint8Array.from(o.sram), fb: null,
        info: frame === 0 ? null : this.info,
      };
    };
    o.handlers.video = (buffer) => {
      if (pending) { pending.fb = o.framebufferIndices(buffer); flush(); }
    };
    this.flushLast = flush;
    this.limit = target * 3 + 600;
  }

  /** Next logical frame record (frame 0 first), or null after the last one. */
  next() {
    const o = this.oracle, movie = this.movie;
    while (!this.queue.length) {
      if (this.ended) return null;
      if (o.completedFrames >= movie.length && !this.queue.length) {
        // wait for the picture of the last frame, then stop
        o.nes.frame();
        this.flushLast();
        this.ended = true;
        continue;
      }
      if (movie.timing === 'video') {
        const i = o.videoFrames;
        o.setButtons(i < movie.length ? movie.p1[i] : 0, i < movie.length ? movie.p2[i] : 0);
      }
      o.nes.frame();
      if (o.videoFrames > this.limit) throw new Error(`jsnes: no progress after ${o.videoFrames} video frames (${o.pcInfo()})`);
    }
    return this.queue.shift();
  }
}
