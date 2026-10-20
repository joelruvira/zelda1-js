// Template for the port's headless runner (copy to src/headless.js once the port can boot).
// It satisfies the shape of the oracle contract but fails clearly on use, so the
// harness reports "not implemented" instead of producing a misleading trace.
//
// Real implementation outline:
//   createGame: build RAM Uint8Array(0x800) filled with powerOnFill, SRAM Uint8Array(0x2000)
//               (copy of `sram` if given), map the ROM, run IsrReset + RunGame (Z_07) up to
//               LoopForever. Do not run any NMI yet: game.ram is then "frame 0".
//   stepFrame:  latch p1/p2 for ReadInputs and run IsrNmi once (one logical frame).
//   framebuffer: render the PPU state left by that NMI (sprite-0 split included) as
//               256*240 NES color indices.

export class NotImplementedError extends Error {
  name = 'NotImplementedError';
}

/** IsrReset + RunGame (Z_07) — not ported yet. */
export function createGame({ rom, sram = null, powerOnFill = 0x00 } = {}) {
  void rom;
  const ram = new Uint8Array(0x800).fill(powerOnFill);
  const sramBytes = sram ? Uint8Array.from(sram) : new Uint8Array(0x2000);
  return {
    ram,
    sram: sramBytes,
    framebuffer: null,
    // IsrNmi (Z_07) — not ported yet.
    stepFrame() {
      throw new NotImplementedError('port headless runner is a stub: IsrNmi is not ported yet');
    },
  };
}
