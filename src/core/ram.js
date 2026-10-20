// Game state: the NES RAM ($0000-$07FF) and battery SRAM ($6000-$7FFF) at their real
// addresses, so the port's memory can be diffed against an emulator frame by frame.
// Also a tiny "CPU-lite" with the flag semantics needed for literal asm translations.

export const RAM_SIZE = 0x800;
export const SRAM_BASE = 0x6000;
export const SRAM_SIZE = 0x2000;

export const ram = new Uint8Array(RAM_SIZE);
export const sram = new Uint8Array(SRAM_SIZE);

/** Read a byte of RAM ($0000-$1FFF, mirrored) or SRAM ($6000-$7FFF). */
export function peek(addr) {
  if (addr < 0x2000) return ram[addr & 0x7ff];
  if (addr >= SRAM_BASE && addr < SRAM_BASE + SRAM_SIZE) return sram[addr - SRAM_BASE];
  throw new RangeError(`peek: $${addr.toString(16)} is not RAM/SRAM (use bus.read)`);
}

/** Write a byte of RAM or SRAM (value is masked to 8 bits). */
export function poke(addr, value) {
  if (addr < 0x2000) ram[addr & 0x7ff] = value;
  else if (addr >= SRAM_BASE && addr < SRAM_BASE + SRAM_SIZE) sram[addr - SRAM_BASE] = value;
  else throw new RangeError(`poke: $${addr.toString(16)} is not RAM/SRAM (use bus.write)`);
}

/** Little-endian 16-bit pointer at a zero-page/RAM address (wraps within zero page like ($zp),Y). */
export function word(addr) {
  if (addr < 0x100) return ram[addr] | (ram[(addr + 1) & 0xff] << 8);
  return peek(addr) | (peek(addr + 1) << 8);
}

/** Store a little-endian 16-bit value. */
export function setWord(addr, value) {
  poke(addr, value & 0xff);
  poke(addr + 1, (value >> 8) & 0xff);
}

/** Zero RAM and (optionally) SRAM. */
export function clearAll({ keepSram = true } = {}) {
  ram.fill(0);
  if (!keepSram) sram.fill(0);
}

// -------------------------------------------------------------- CPU-lite
// Not an emulator. Registers A/X/Y are plain JS locals in ported code; this object holds
// the flags (C, Z, N, V) and the hardware stack only where a literal translation needs them
// (ADC/SBC chains, ROL/ROR through carry, PHA/PLA, flags tested after a JSR...).

export const cpu = {
  c: 0, // carry 0/1
  z: 0, // zero 0/1
  n: 0, // negative 0/1
  v: 0, // overflow 0/1
  s: 0xff, // stack pointer (stack lives in ram[$100-$1FF], same as the NES)

  /** Set Z and N from an 8-bit result; returns it. */
  nz(r) { r &= 0xff; this.z = r === 0 ? 1 : 0; this.n = r >> 7; return r; },

  /** ADC: a + m + C. */
  adc(a, m) {
    const r = a + m + this.c;
    this.v = (~(a ^ m) & (a ^ r) & 0x80) ? 1 : 0;
    this.c = r > 0xff ? 1 : 0;
    return this.nz(r);
  },
  /** SBC: a - m - (1 - C). */
  sbc(a, m) {
    const r = a - m - (1 - this.c);
    this.v = ((a ^ m) & (a ^ r) & 0x80) ? 1 : 0;
    this.c = r >= 0 ? 1 : 0;
    return this.nz(r);
  },
  /** CMP/CPX/CPY: sets C, Z, N. */
  cmp(reg, m) { this.c = reg >= m ? 1 : 0; this.nz(reg - m); },
  /** BIT: Z from a&m, N/V from m. */
  bit(a, m) { this.z = (a & m) === 0 ? 1 : 0; this.n = (m >> 7) & 1; this.v = (m >> 6) & 1; },
  asl(m) { this.c = (m >> 7) & 1; return this.nz(m << 1); },
  lsr(m) { this.c = m & 1; return this.nz(m >> 1); },
  rol(m) { const c = this.c; this.c = (m >> 7) & 1; return this.nz((m << 1) | c); },
  ror(m) { const c = this.c; this.c = m & 1; return this.nz((m >> 1) | (c << 7)); },

  /** ASL/LSR/ROL/ROR/INC/DEC on memory (read-modify-write in RAM). */
  aslMem(addr) { poke(addr, this.asl(peek(addr))); },
  lsrMem(addr) { poke(addr, this.lsr(peek(addr))); },
  rolMem(addr) { poke(addr, this.rol(peek(addr))); },
  rorMem(addr) { poke(addr, this.ror(peek(addr))); },
  incMem(addr) { poke(addr, this.nz(peek(addr) + 1)); },
  decMem(addr) { poke(addr, this.nz(peek(addr) - 1)); },

  push(v) { ram[0x100 | this.s] = v; this.s = (this.s - 1) & 0xff; },
  pull() { this.s = (this.s + 1) & 0xff; return ram[0x100 | this.s]; },
  /** PHP/PLP with the NES status layout (NV1BDIZC). */
  php() { this.push((this.n << 7) | (this.v << 6) | 0x30 | (this.z << 1) | this.c); },
  plp() { const p = this.pull(); this.n = p >> 7; this.v = (p >> 6) & 1; this.z = (p >> 1) & 1; this.c = p & 1; },

  reset() { this.c = this.z = this.n = this.v = 0; this.s = 0xff; },
};
