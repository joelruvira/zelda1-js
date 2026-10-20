import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYMBOLS, SEGMENTS } from '../../src/core/symbols.js';
import { DISASM, hasDisasm, hasRom, realRom } from './helpers.mjs';

test('well-known routines are at their documented addresses', () => {
  assert.deepEqual(SYMBOLS.IsrNmi.slice(0, 2), [7, 0xe484]);
  assert.deepEqual(SYMBOLS.IsrReset.slice(0, 2), [7, 0xff50]);
  assert.deepEqual(SYMBOLS.PcmSamples.slice(0, 2), [7, 0xc000]);
  assert.equal(SYMBOLS.PatternBlockOWBG[3], 'd');
  assert.equal(SYMBOLS.IsrNmi[3], 'c');
  assert.ok(SYMBOLS['IsrNmi@SetScroll']);
});

test('SRAM-run segments carry both run and load addresses', () => {
  assert.equal(SEGMENTS.BANK_01_CODE.run, 0x6c90);
  assert.equal(SEGMENTS.BANK_06_DATA.run, 0x67f0);
  const ramSym = Object.values(SYMBOLS).find((s) => s[0] === 1 && s[1] >= 0x6c90 && s[1] < 0x8000);
  assert.ok(ramSym && ramSym[4] >= 0x8000, 'has a load address in bank 1');
});

test('symbols.js matches a fresh assembly and bins.xml', { skip: !hasDisasm && 'disassembly not present' }, async () => {
  const { assemble } = await import('../../scripts/lib/asm65.mjs');
  const { symbols, problems } = assemble(DISASM);
  assert.deepEqual(problems, []);
  assert.equal(symbols.size, Object.keys(SYMBOLS).length);
  for (const [k, s] of symbols) assert.deepEqual(SYMBOLS[k].slice(0, 2), [s.bank, s.addr], k);
});

test('assembled bytes equal the ROM everywhere they are known', { skip: (!hasDisasm || !hasRom) && 'needs disassembly and roms/zelda.nes' }, async () => {
  const { assemble } = await import('../../scripts/lib/asm65.mjs');
  const { loadRom } = await import('../../src/core/rom.js');
  const rom = loadRom(realRom());
  const { banks } = assemble(DISASM, { emit: true });
  let checked = 0;
  for (let b = 0; b < 8; b++) {
    for (let i = 0; i < 0x4000; i++) {
      if (banks[b][i] < 0) continue;
      assert.equal(banks[b][i], rom.prg[b * 0x4000 + i], `bank ${b} offset $${i.toString(16)}`);
      checked++;
    }
  }
  assert.ok(checked > 60000);
});

test('checkRevision accepts the expected ROM revision (US PRG0)', { skip: !hasRom && 'roms/zelda.nes not present' }, async () => {
  const { loadRom, checkRevision } = await import('../../src/core/rom.js');
  const { PRG_FINGERPRINT, INCBIN_RANGES } = await import('../../src/core/symbols.js');
  const rom = loadRom(realRom());
  assert.deepEqual(checkRevision(rom, PRG_FINGERPRINT, INCBIN_RANGES), { ok: true, mismatchedBanks: [] });
  rom.prg[5 * 0x4000 + 0x10] ^= 0xff; // corrupt a code byte of bank 5
  assert.deepEqual(checkRevision(rom, PRG_FINGERPRINT, INCBIN_RANGES).mismatchedBanks, [5]);
});
