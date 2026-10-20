// Tile viewer shown until the game is ported: exercises ROM -> CHR-RAM -> PPU -> framebuffer
// with the common and overworld pattern blocks. DOM-free, so tests can run it on the real ROM.
// Every source address, size and VRAM address is read from the ROM by label (no ROM data here).

import { table } from './core/rom.js';
import { read, write, bus } from './core/bus.js';
import { ram } from './core/ram.js';
import { switchBank } from './core/asm.js';

/** `.DBYT` entry `i` of a table (big-endian word, as the asm stores sizes and VRAM addresses). */
const dbyt = (t, i) => (t.byte(i * 2) << 8) | t.byte(i * 2 + 1);

/** TransferPatternBlock_Bank2/3, simplified: copy `size` bytes from bank:src to PPU `vram` via $2006/$2007. */
function transferBlock(src, bank, size, vram) {
  write(0x2006, vram >> 8);
  write(0x2006, vram & 0xff);
  switchBank(bank); // ($00),Y reads see this bank at $8000
  for (let i = 0; i < size; i++) write(0x2007, read(src + i));
}

/**
 * The blocks TransferCommonPatterns (Z_02) and the overworld branch of
 * TransferLevelPatternBlocks (Z_03) copy, as {src, bank, size, vram}.
 */
export function overworldPatternBlocks(rom = bus.rom) {
  const blocks = [];
  const addrs = table(rom, 'CommonPatternBlockAddrs');
  const sizes = table(rom, 'CommonPatternBlockSizes');
  const vrams = table(rom, 'CommonPatternVramAddrs');
  for (let i = 0; i < 3; i++) blocks.push({ src: addrs.word(i), bank: addrs.bank, size: dbyt(sizes, i), vram: dbyt(vrams, i) });
  const src = table(rom, 'PatternBlockSrcAddrsOW');
  const len = table(rom, 'PatternBlockSizesOW');
  const ppu = table(rom, 'PatternBlockPpuAddrs');
  for (let i = 0; i < 2; i++) blocks.push({ src: src.word(i), bank: src.bank, size: dbyt(len, i), vram: dbyt(ppu, i) });
  return blocks;
}

/** A stand-in "game" with the same reset()/nmi() shape the ported game will have. */
export function createTileViewer() {
  let bgTable = 0;
  return {
    reset() {
      write(0x2001, 0); // rendering off while filling VRAM
      for (const b of overworldPatternBlocks()) transferBlock(b.src, b.bank, b.size, b.vram);
      // Nametable 0: tiles $00-$FF in a 16x16 grid at tile (1,2); everything else blank ($24 in Zelda's font).
      write(0x2006, 0x20); write(0x2006, 0x00);
      for (let i = 0; i < 0x3c0; i++) {
        const col = i & 31, row = i >> 5;
        const inGrid = col >= 1 && col < 17 && row >= 2 && row < 18;
        write(0x2007, inGrid ? ((row - 2) << 4) | (col - 1) : 0x24);
      }
      for (let i = 0; i < 0x40; i++) write(0x2007, 0); // attributes: palette 0
      // Palettes: BG grey ramp, sprites Link-like (viewer colours, not game data).
      write(0x2006, 0x3f); write(0x2006, 0x00);
      const pal = [0x0f, 0x00, 0x10, 0x30, 0x0f, 0x00, 0x10, 0x30, 0x0f, 0x00, 0x10, 0x30, 0x0f, 0x00, 0x10, 0x30,
        0x0f, 0x29, 0x27, 0x17, 0x0f, 0x16, 0x27, 0x36, 0x0f, 0x02, 0x22, 0x30, 0x0f, 0x16, 0x2a, 0x30];
      for (const c of pal) write(0x2007, c);
      // OAM via DMA from page $200 (like IsrNmi): 64 sprites 8x16 from the $1000 table in an 8x8 grid.
      for (let n = 0; n < 64; n++) {
        ram[0x200 + n * 4] = 15 + (n >> 3) * 18; // Y (top - 1)
        ram[0x201 + n * 4] = (n * 2) | 1; // tile pair, bit 0 = pattern table $1000
        ram[0x202 + n * 4] = (n >> 4) & 3; // palette
        ram[0x203 + n * 4] = 152 + (n & 7) * 12; // X
      }
    },
    nmi() {
      write(0x2003, 0);
      write(0x4014, 0x02);
      write(0x2005, 0); write(0x2005, 0);
      write(0x2000, 0x20 | (bgTable << 4)); // 8x16 sprites, BG table selectable
      write(0x2001, 0x1e);
    },
    toggleTable() { bgTable ^= 1; return bgTable; },
  };
}
