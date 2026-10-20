import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRom, loadSymbols } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { runFrame } from '../../src/core/loop.js';
import { createTileViewer, overworldPatternBlocks } from '../../src/tileviewer.js';
import { hasRom, hasDisasm, realRom } from './helpers.mjs';

test('tile viewer fills CHR-RAM from the real ROM and renders it', { skip: !hasRom && 'roms/zelda.nes not present' }, async () => {
  await loadSymbols();
  const m = createMachine(loadRom(realRom()));
  const blocks = overworldPatternBlocks(m.rom);
  // Shapes from TransferCommonPatterns / TransferLevelPatternBlocks: 3 common + 2 OW blocks.
  assert.deepEqual(blocks.map((b) => b.bank), [2, 2, 2, 3, 3]);
  const viewer = createTileViewer();
  viewer.reset();
  // Each block landed in CHR-RAM byte for byte at its VRAM address (compared with the ROM, not stored data).
  for (const b of blocks) {
    const src = m.rom.prgBytes(b.bank, b.src, b.size);
    const dst = m.ppu.chr.subarray(b.vram, b.vram + b.size);
    assert.ok(Buffer.from(dst).equals(Buffer.from(src)), `block $${b.src.toString(16)} -> $${b.vram.toString(16)}`);
  }
  runFrame(m, viewer);
  runFrame(m, viewer);
  const colours = new Set(m.ppu.indexBuffer);
  assert.ok(colours.size >= 4, `picture uses several colours (${[...colours]})`);
});

test('pattern block labels match bins.xml offsets (skipped without the disassembly)', { skip: !hasDisasm && 'no disassembly' }, async () => {
  const { readFileSync } = await import('node:fs');
  const { DISASM } = await import('./helpers.mjs');
  const { label } = await import('../../src/core/rom.js');
  await loadSymbols();
  const xml = readFileSync(`${DISASM}/bins.xml`, 'utf8');
  const off = (name) => Number(xml.match(new RegExp(`Offset='(\\d+)'[^>]*dat/${name}\\.dat`))[1]);
  for (const name of ['CommonSpritePatterns', 'CommonBackgroundPatterns', 'CommonMiscPatterns', 'PatternBlockOWBG', 'PatternBlockOWSP']) {
    const l = label(name);
    assert.equal(l.bank * 0x4000 + (l.load - 0x8000), off(name), name);
  }
});
