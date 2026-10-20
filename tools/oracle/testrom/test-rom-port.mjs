// Hand-written "port" of the synthetic test ROM (build-test-rom.mjs) that implements the
// headless runner contract. Used to prove the oracle -> port -> diff pipeline end to end.
import { FB_SIZE } from '../lib/palette.mjs';

/** reset (test ROM) */
export function createGame({ sram = null, powerOnFill = 0x00 } = {}) {
  const ram = new Uint8Array(0x800).fill(powerOnFill);
  const sramBytes = sram ? Uint8Array.from(sram) : new Uint8Array(0x2000);
  ram[0x300] = 3; // bank marker read from bank 3
  sramBytes.set([0xee, 0x01, 0x03, 0x60], 0); // INC $0301 / RTS copied to SRAM
  ram[0x301] = (ram[0x301] + 1) & 0xff; // ...and executed
  ram.set([0x3f, 0x00, 0x00, 0x40], 0x200);
  ram.fill(0xf8, 0x204, 0x300);
  const framebuffer = new Uint8Array(FB_SIZE).fill(0x30);
  for (let y = 64; y < 72; y++) framebuffer.fill(0x16, y * 256 + 64, y * 256 + 72);
  return {
    ram,
    sram: sramBytes,
    framebuffer,
    /** nmi (test ROM) */
    stepFrame(p1) {
      ram[0x302] = (ram[0x302] + 1) & 0xff;
      ram[0x303] = p1;
      ram[0x304] = (ram[0x304] + 1) & 0xff;
      sramBytes[0x1000] = ram[0x304];
    },
  };
}
