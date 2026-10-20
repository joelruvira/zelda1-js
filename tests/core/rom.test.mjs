import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRom, setSymbols, label, table } from '../../src/core/rom.js';
import { syntheticRom, hasRom, realRom } from './helpers.mjs';

test('parses a valid MMC1 128KB PRG / CHR-RAM image', () => {
  const rom = loadRom(syntheticRom().buffer);
  assert.equal(rom.info.mapper, 1);
  assert.equal(rom.info.prgBanks, 8);
  assert.equal(rom.info.battery, true);
  assert.equal(rom.prg.length, 0x20000);
});

test('rejects bad magic, wrong mapper, wrong PRG size, CHR-ROM and truncation', () => {
  const bad = syntheticRom(); bad[0] = 0;
  assert.throws(() => loadRom(bad), /iNES/);
  assert.throws(() => loadRom(syntheticRom({ mapper: 4 })), /mapper 4/);
  assert.throws(() => loadRom(syntheticRom({ prgBanks: 4 })), /8 PRG/);
  assert.throws(() => loadRom(syntheticRom({ chrBanks: 1 })), /CHR-RAM/);
  assert.throws(() => loadRom(syntheticRom().subarray(0, 0x8000)), /Truncated/);
});

test('skips a 512-byte trainer', () => {
  const rom = loadRom(syntheticRom({ trainer: true }));
  assert.equal(rom.prgByte(0, 0x8000), 0);
  assert.equal(rom.prgByte(1, 0x8001), 17);
});

test('prgByte maps $8000-$BFFF to the given bank and $C000-$FFFF to bank 7', () => {
  const rom = loadRom(syntheticRom({ fill: (b, o) => (b << 4) | (o >> 12) }));
  assert.equal(rom.prgByte(3, 0x8000), 0x30);
  assert.equal(rom.prgByte(3, 0xbfff), 0x33);
  assert.equal(rom.prgByte(3, 0xc000), 0x70);
  assert.equal(rom.prgByte(0, 0xffff), 0x73);
  assert.equal(rom.prgOffset(2, 0x8d60), 2 * 0x4000 + 0xd60);
  assert.deepEqual([...rom.prgBytes(5, 0x9000, 2)], [0x51, 0x51]);
  assert.throws(() => rom.prgByte(0, 0x6000), RangeError);
});

test('label() and table() resolve data by name (including SRAM-run segments)', () => {
  const rom = loadRom(syntheticRom({ fill: (b, o) => (b + o) & 0xff }));
  setSymbols({ Tbl: [2, 0x8010, 4, 'd'], RamTbl: [1, 0x6c90, 2, 'd', 0xa500] });
  const t = table(rom, 'Tbl');
  assert.equal(t.byte(1), (2 + 0x11) & 0xff);
  assert.equal(t.word(0), ((2 + 0x10) & 0xff) | (((2 + 0x11) & 0xff) << 8));
  assert.equal(t.bytes().length, 4);
  const r = label('RamTbl');
  assert.equal(r.addr, 0x6c90);
  assert.equal(r.load, 0xa500);
  assert.equal(table(rom, 'RamTbl').byte(0), (1 + 0x2500) & 0xff);
  assert.throws(() => label('Nope'), /Unknown label/);
});

test('real ROM loads (skipped without roms/zelda.nes)', { skip: !hasRom && 'roms/zelda.nes not present' }, () => {
  const rom = loadRom(realRom());
  assert.equal(rom.info.mapper, 1);
  // Reset vector points at IsrReset ($FF50) in the fixed bank.
  assert.equal(rom.prgWord(7, 0xfffc), 0xff50);
});
