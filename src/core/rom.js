// iNES loader and PRG access by bank + CPU address or by disassembly label.
// The repo ships no ROM data: every table is read from the user's ROM at run time.

export const PRG_BANK_SIZE = 0x4000;
export const HEADER_SIZE = 16;
export const FIXED_BANK = 7;

/**
 * Parse and validate an iNES image of The Legend of Zelda (MMC1, 8x16KB PRG, CHR-RAM).
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Rom}
 */
export function loadRom(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < HEADER_SIZE || bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) {
    throw new Error('Not an iNES file (missing "NES\\x1A" header)');
  }
  const prgBanks = bytes[4];
  const chrBanks = bytes[5];
  const flags6 = bytes[6];
  const flags7 = bytes[7];
  const isNes2 = (flags7 & 0x0c) === 0x08;
  const mapper = (flags6 >> 4) | (flags7 & 0xf0);
  const hasTrainer = (flags6 & 0x04) !== 0;
  if (mapper !== 1) throw new Error(`Unsupported mapper ${mapper} (Zelda uses MMC1 = mapper 1)`);
  if (prgBanks !== 8) throw new Error(`Expected 8 PRG banks of 16KB, found ${prgBanks}`);
  if (chrBanks !== 0) throw new Error(`Expected CHR-RAM (0 CHR banks), found ${chrBanks}`);
  const prgStart = HEADER_SIZE + (hasTrainer ? 512 : 0);
  const prgSize = prgBanks * PRG_BANK_SIZE;
  if (bytes.length < prgStart + prgSize) throw new Error('Truncated ROM: PRG data is incomplete');
  return new Rom(bytes.slice(prgStart, prgStart + prgSize), {
    mapper, prgBanks, chrBanks, battery: (flags6 & 0x02) !== 0, isNes2, hasTrainer,
  });
}

export class Rom {
  /** @param {Uint8Array} prg 128KB PRG image (no header). */
  constructor(prg, info = {}) {
    this.prg = prg;
    this.info = info;
  }

  /** Offset into PRG (same as bins.xml offsets) of bank:cpuAddr. $C000-$FFFF always maps bank 7. */
  prgOffset(bank, cpuAddr) {
    if (cpuAddr >= 0xc000) return FIXED_BANK * PRG_BANK_SIZE + (cpuAddr - 0xc000);
    if (cpuAddr >= 0x8000) return bank * PRG_BANK_SIZE + (cpuAddr - 0x8000);
    throw new RangeError(`CPU address $${cpuAddr.toString(16)} is not in PRG ROM`);
  }

  /** One PRG byte as the CPU sees it with `bank` mapped at $8000. */
  prgByte(bank, cpuAddr) {
    return this.prg[this.prgOffset(bank, cpuAddr)];
  }

  /** `len` PRG bytes (a view, do not modify) starting at bank:cpuAddr. */
  prgBytes(bank, cpuAddr, len) {
    const off = this.prgOffset(bank, cpuAddr);
    if (off + len > this.prg.length) throw new RangeError('prgBytes past end of PRG');
    return this.prg.subarray(off, off + len);
  }

  /** Little-endian 16-bit word at bank:cpuAddr. */
  prgWord(bank, cpuAddr) {
    return this.prgByte(bank, cpuAddr) | (this.prgByte(bank, cpuAddr + 1) << 8);
  }
}

// ------------------------------------------------------------------ labels

let symbolTable = null;

/** Install the generated symbol table (src/core/symbols.js SYMBOLS). Done by loadSymbols(). */
export function setSymbols(symbols) {
  symbolTable = symbols;
}

/** Lazily import the generated symbol table (kept out of the startup path). */
export async function loadSymbols() {
  if (!symbolTable) symbolTable = (await import('./symbols.js')).SYMBOLS;
  return symbolTable;
}

/**
 * Resolve a disassembly label to where its bytes live in the ROM.
 * @param {string} name label ("PatternBlockOWBG", "Exit#7", "IsrNmi@SetScroll")
 * @returns {{bank:number, addr:number, load:number, size:number, kind:string}}
 *   addr: CPU address used by the code at run time; load: CPU address of the bytes in the
 *   bank (differs only for code/data copied to SRAM: BANK_01_CODE, BANK_06_DATA).
 */
export function label(name) {
  if (!symbolTable) throw new Error('Symbols not loaded: call loadSymbols() or setSymbols() first');
  const s = symbolTable[name];
  if (!s) throw new Error(`Unknown label ${name}`);
  const [bank, addr, size, kind, load = addr] = s;
  return { bank, addr, load, size, kind: { c: 'code', d: 'data', e: 'end' }[kind] };
}

/**
 * A typed view of a data table in the ROM, found by label.
 *   const t = table(rom, 'PlayAreaColumnAddrs');  t.byte(3); t.word(1); t.bytes(16)
 * Index arithmetic is in bytes, exactly like `LDA Label, X`.
 */
export function table(rom, name) {
  const { bank, load, size } = label(name);
  return {
    bank, addr: load, size,
    byte: (i = 0) => rom.prgByte(bank, load + i),
    word: (i = 0) => rom.prgWord(bank, load + i * 2),
    bytes: (len = size, i = 0) => rom.prgBytes(bank, load + i, len),
  };
}

// ------------------------------------------------------------------ revision check

/** CRC32 (IEEE). */
export function crc32(bytes, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/**
 * Compare the ROM with the revision the disassembly describes (US PRG0) using the
 * per-bank fingerprints generated in symbols.js. Labels/addresses are only valid for
 * banks that match.
 * @returns {{ok: boolean, mismatchedBanks: number[]}}
 */
export function checkRevision(rom, fingerprint, incbinRanges) {
  const skip = new Uint8Array(rom.prg.length);
  for (const [off, len] of incbinRanges) skip.fill(1, off, off + len);
  const mismatchedBanks = [];
  for (let b = 0; b < 8; b++) {
    const kept = [];
    for (let i = b * PRG_BANK_SIZE; i < (b + 1) * PRG_BANK_SIZE; i++) if (!skip[i]) kept.push(rom.prg[i]);
    if (crc32(kept) !== fingerprint[b]) mismatchedBanks.push(b);
  }
  return { ok: mismatchedBanks.length === 0, mismatchedBanks };
}
