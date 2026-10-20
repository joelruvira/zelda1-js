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
    patchJsnesPpu(this.nes.ppu);
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
      // jsnes keeps irqRequested set (APU frame/DMC IRQ) while I=1: the instruction still runs.
      if (!cpu.nmiImmediate && !(cpu.irqRequested && cpu.F_INTERRUPT === 0) && cpu.cyclesToHalt === 0) {
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

/**
 * Fixes three jsnes 2.1.0 PPU rendering bugs so that the oracle's picture follows the hardware
 * (the port's PPU, src/core/ppu.js, already does). None of them affects CPU-visible state, so RAM,
 * SRAM and timing are unchanged; only the framebuffer is.
 *  1. 8x16 sprites with an odd tile number: jsnes takes `topTileNum - 1 + 256` as the top tile; the
 *     hardware uses `(tile & $FE)` from $1000, i.e. `topTileNum + 256` (Zelda's heart cursor $F3,
 *     the register cursor $25, the story heart).
 *  2. Background rows above `fineY` are not drawn: renderBgScanline skips a scanline when
 *     `scan - cntFV < 0`, so with a vertical scroll whose fine Y is not 0 the first partial tile row
 *     stays blank (story scroll in title-idle). The hardware draws every scanline.
 *  3. Backdrop colour: jsnes fills the whole frame with $3F00 in startFrame(), i.e. at the start of
 *     vblank, before the NMI writes the palette, so a backdrop change shows one frame late. Here each
 *     rendered band is refilled with the current $3F00 colour right before jsnes draws it.
 *  4. $2007 access during rendering: jsnes does the hardware coarse-X/fine-Y increment of v, but then
 *     cntsFromAddress() keeps only 2 bits of fine Y (`& 3`), so fine Y 4-7 is lost. Zelda's vertical
 *     scroll split (WaitAndScrollToSplitBottom: $2006 x2 then two $2007 reads) showed the playfield
 *     up to 4 pixels off. v has 3 fine-Y bits (`& 7`).
 *  5. Fine X scroll: jsnes draws 32 tiles per scanline starting at -fineX, so the rightmost fineX
 *     pixels stay unpainted (mode 7 horizontal scroll showed a black strip at x=252-255). The
 *     hardware fetches a 33rd tile; it is drawn here, clipped at x=255.
 *  6. Sprites on buffer row 1: jsnes' background row r is hardware scanline r (the pre-render line
 *     draws row 0), and a sprite with OAM Y shows on rows Y+1..Y+8, but row 1 is filled with the stale
 *     secondary OAM of the previous frame instead of the evaluation made on scanline 0, so sprites
 *     with Y=0 lose their top line (title-idle item parade). Row 1 is evaluated from OAM here, after
 *     OAMADDR is reset as on hardware. (Row 0 is masked by the diff.)
 *  7. Left 8-pixel column: when PPUMASK hides the left column jsnes paints it black (RGB 0) for the
 *     whole frame in endFrame(); the hardware shows the backdrop there (and with rendering off the
 *     whole screen is backdrop). Here the column is cleared per rendered band with the backdrop
 *     colour, using the PPUMASK of that band. Only the "both hidden" case is modelled (Zelda writes
 *     PPUMASK $1E or $00); "background hidden, sprites shown" is left as jsnes draws it.
 * The patched methods are rebuilt from jsnes' own source; if a jsnes upgrade changes the text, the
 * patch throws instead of silently doing nothing.
 */
export function patchJsnesPpu(ppu) {
  const proto = Object.getPrototypeOf(ppu);
  const rebuild = (name, edits) => {
    let src = proto[name].toString();
    for (const [from, to, count = 1] of edits) {
      if (src.split(from).length !== count + 1) {
        throw new Error(`patchJsnesPpu: '${from}' not found ${count} time(s) in ${name}`);
      }
      src = src.split(from).join(to);
    }
    // Method source "name(args) { ... }" -> function; the bodies only use `this`.
    ppu[name] = new Function(`return ({ ${src} }).${name};`)();
  };
  rebuild('renderSpritesPartially', [
    ['topTileNum - 1 + 256', 'topTileNum + 256'],
  ]);
  rebuild('endScanline', [
    ['this.sramAddress = 0;', 'this.sramAddress = 0;\n          this.evaluateSprites(1);'],
  ]);
  rebuild('cntsFromAddress', [
    ['this.cntFV = (address >> 4) & 3;', 'this.cntFV = (address >> 4) & 7;'],
  ]);
  rebuild('renderBgScanline', [
    ['scan < 240 && scan - this.cntFV >= 0', 'scan < 240'],
    ['for (let tile = 0; tile < 32; tile++)', 'for (let tile = 0; tile < 33; tile++)'],
    ['let x = (tile << 3) - this.regFH;', 'let x = (tile << 3) - this.regFH;\n          let sxEnd = x > 248 ? 256 - x : 8;'],
    ['if (x > -8) {', 'if (x > -8 && x < 256) {'],
    ['for (; sx < 8; sx++)', 'for (; sx < sxEnd; sx++)', 2],
  ]);
  ppu.attrib = new Uint8Array(33); // per-tile cache, now 33 tiles per scanline
  rebuild('endFrame', [
    ['this.clipToTvSize ||\n      this.f_bgClipping === 0 ||\n      this.f_spClipping === 0', 'this.clipToTvSize'],
  ]);
  const render = ppu.renderFramePartially.bind(ppu);
  ppu.renderFramePartially = (startScan, scanCount) => {
    const first = Math.max(0, startScan);
    const end = Math.min(240, startScan + scanCount);
    // Monochrome (greyscale) backdrops keep jsnes' own startFrame() fill.
    if (ppu.f_dispType === 0 && end > first) ppu.buffer.fill(ppu.imgPalette[0], first << 8, end << 8);
    const result = render(startScan, scanCount);
    if (ppu.f_dispType === 0 && ppu.f_bgClipping === 0 && ppu.f_spClipping === 0) {
      const c = ppu.imgPalette[0];
      for (let y = first; y < end; y++) ppu.buffer.fill(c, y << 8, (y << 8) + 8);
    }
    return result;
  };
}

function romToBinaryString(bytes) {
  // jsnes accepts typed arrays too, but a binary string works with every jsnes version.
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return s;
}
