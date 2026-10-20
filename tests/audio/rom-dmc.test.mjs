import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { newApu } from './helpers.mjs';

const ROM = fileURLToPath(new URL('../../roms/zelda.nes', import.meta.url));
const hasRom = existsSync(ROM);

// Lector mínimo del banco fijo (PRG banco 7 en $C000-$FFFF) para no depender de src/core.
function fixedBankReader(file) {
  const rom = readFileSync(file);
  const trainer = rom[6] & 0x04 ? 512 : 0;
  const prgSize = rom[4] * 0x4000;
  const base = 16 + trainer + prgSize - 0x4000;
  return (addr) => (addr >= 0xc000 ? rom[base + addr - 0xc000] : 0);
}

test('ROM: el DMC reproduce PcmSamples ($C000, banco fijo) con la secuencia de DriveSample', { skip: !hasRom && 'roms/zelda.nes no existe' }, () => {
  const apu = newApu({ readMemory: fixedBankReader(ROM) });
  apu.writeRegister(0x4011, 0x00);
  apu.writeRegister(0x4010, 0x0f);
  apu.writeRegister(0x4012, 0x00); // $C000 = PcmSamples
  apu.writeRegister(0x4013, 0x10);
  apu.writeRegister(0x4015, 0x0f);
  apu.writeRegister(0x4015, 0x1f);
  // $4013=$10 -> 257 bytes; a la tasa $F (54 ciclos/bit) son 257*8*54 ciclos. Se deja margen de 2 bytes.
  const levels = new Set();
  for (let i = 0; i < 54 * 8 * (257 + 2); i += 54) {
    apu.clock(54);
    levels.add(apu.dmc.level);
  }
  assert.ok(levels.size > 4, 'el nivel del DMC varía con el sample');
  assert.equal(apu.readStatus() & 0x10, 0, 'el sample termina');
});
