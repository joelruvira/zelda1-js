// MMC1 (SxROM) register model. In the port the PRG bank does not select code (every
// routine is JS), but it decides what bus.read() returns for $8000-$BFFF, and the
// control register drives nametable mirroring and CHR banking of the 8KB CHR-RAM.

export const MIRROR_SINGLE_LOW = 0;
export const MIRROR_SINGLE_HIGH = 1;
export const MIRROR_VERTICAL = 2;
export const MIRROR_HORIZONTAL = 3;

export class Mmc1 {
  constructor() {
    this.onMirroringChange = null; // (mode) => void, wired to the PPU
    this.powerOn();
  }

  powerOn() {
    this.shift = 0x10;
    this.control = 0x0c; // PRG mode 3 (fix last bank at $C000)
    this.chrBank0 = 0;
    this.chrBank1 = 0;
    this.prgBank = 0;
  }

  /** CPU write to $8000-$FFFF (serial port, 1 bit per write, bit 7 resets). */
  write(addr, value) {
    if (value & 0x80) {
      this.shift = 0x10;
      this.setControl(this.control | 0x0c);
      return;
    }
    const done = this.shift & 1;
    this.shift = (this.shift >> 1) | ((value & 1) << 4);
    if (!done) return;
    const data = this.shift;
    this.shift = 0x10;
    switch ((addr >> 13) & 3) {
      case 0: this.setControl(data); break;
      case 1: this.chrBank0 = data; break;
      case 2: this.chrBank1 = data; break;
      case 3: this.prgBank = data & 0x0f; break;
    }
  }

  /** Same as five serial writes to $8000 (used by ports of SetMMC1Control). */
  setControl(value) {
    const old = this.control & 3;
    this.control = value & 0x1f;
    if ((this.control & 3) !== old && this.onMirroringChange) this.onMirroringChange(this.control & 3);
  }

  /** Same as five serial writes to $E000 (used by ports of SwitchBank). */
  setPrgBank(bank) { this.prgBank = bank & 0x0f; }

  get mirroring() { return this.control & 3; }

  /** PRG bank mapped at `cpuAddr` ($8000-$FFFF), for an 8-bank (128KB) cartridge. */
  prgBankAt(cpuAddr) {
    const mode = (this.control >> 2) & 3;
    const bank = this.prgBank & 7;
    if (mode < 2) return (bank & ~1) + (cpuAddr >= 0xc000 ? 1 : 0); // 32KB mode
    if (mode === 2) return cpuAddr >= 0xc000 ? bank : 0; // fix first bank at $8000
    return cpuAddr >= 0xc000 ? 7 : bank; // fix last bank at $C000 (Zelda)
  }

  /** Offset into the 8KB CHR-RAM for PPU address $0000-$1FFF. */
  chrOffset(ppuAddr) {
    if (this.control & 0x10) { // 4KB mode
      const bank = ppuAddr < 0x1000 ? this.chrBank0 : this.chrBank1;
      return ((bank & 1) * 0x1000) + (ppuAddr & 0x0fff);
    }
    return ppuAddr & 0x1fff; // 8KB mode: with 8KB of CHR-RAM only one 8KB bank exists
  }
}
