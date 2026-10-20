import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PULSE_TABLE, TND_TABLE, DMC_PERIODS } from '../../src/audio/tables.js';
import { newApu } from './helpers.mjs';

test('mezclador: valores de las tablas oficiales', () => {
  assert.equal(PULSE_TABLE[0], 0);
  assert.ok(Math.abs(PULSE_TABLE[30] - 0.2575) < 1e-3);
  assert.equal(TND_TABLE[0], 0);
  assert.ok(Math.abs(TND_TABLE[202] - 0.7425) < 1e-3);
  // No lineal: dos pulsos a 15 suenan menos que el doble de uno.
  assert.ok(PULSE_TABLE[30] < 2 * PULSE_TABLE[15]);
  const apu = newApu();
  apu.writeRegister(0x4011, 0x40);
  // El triángulo arranca en el paso 0 de su secuencia (nivel 15).
  assert.ok(Math.abs(apu.mix() - TND_TABLE[3 * 15 + 0x40]) < 1e-7);
});

test('DMC: $4011 fija el nivel; reproducción de bytes con deltas ±2 y fin con IRQ', () => {
  const mem = new Uint8Array(0x10000);
  mem.fill(0xff, 0xc000, 0xc011); // 17 bytes de unos: sube +2 por bit
  const reads = [];
  const apu = newApu({ readMemory: (a) => (reads.push(a), mem[a]) });
  apu.writeRegister(0x4011, 0x10);
  apu.writeRegister(0x4010, 0x8f); // IRQ, sin loop, rate 15 (54 ciclos)
  apu.writeRegister(0x4012, 0x00); // $C000
  apu.writeRegister(0x4013, 0x01); // 17 bytes
  apu.writeRegister(0x4015, 0x10);
  assert.equal(apu.readStatus() & 0x10, 0x10);
  assert.equal(reads[0], 0xc000);
  apu.clock(DMC_PERIODS[15] * 8 * 20);
  assert.equal(apu.dmc.level, 126); // 16 + 2k, no sube si > 125
  assert.equal(reads.length, 17);
  assert.equal(reads[16], 0xc010);
  const s = apu.readStatus();
  assert.equal(s & 0x10, 0);
  assert.equal(s & 0x80, 0x80);
  apu.writeRegister(0x4015, 0x00); // escribir $4015 borra el IRQ del DMC
  assert.equal(apu.readStatus() & 0x80, 0);
});

test('DMC: secuencia de Zelda (DriveSample): $4015=$0F y luego $1F reinicia el sample', () => {
  const mem = new Uint8Array(0x10000);
  mem.fill(0x00, 0xc000, 0x10000); // ceros: baja -2 por bit
  const apu = newApu({ readMemory: (a) => mem[a] });
  apu.writeRegister(0x4011, 0x7f);
  apu.writeRegister(0x4010, 0x0f);
  apu.writeRegister(0x4012, 0x4c);
  apu.writeRegister(0x4013, 0x10);
  apu.writeRegister(0x4015, 0x0f);
  apu.writeRegister(0x4015, 0x1f);
  assert.equal(apu.dmc.address, 0xc000 + 0x4c * 64 + 1);
  assert.equal(apu.dmc.bytesRemaining, 0x10 * 16);
  apu.clock(54 * 8 * 4);
  assert.ok(apu.dmc.level < 0x7f);
});

test('DMC: frecuencia de bits según tabla de periodos', () => {
  const mem = new Uint8Array(0x10000).fill(0x55); // 1,0,1,0... alterna +2/-2
  const apu = newApu({ readMemory: (a) => mem[a] });
  apu.writeRegister(0x4011, 0x40);
  apu.writeRegister(0x4010, 0x4f); // loop, rate 15
  apu.writeRegister(0x4015, 0x10);
  let changes = 0;
  let prev = apu.dmc.level;
  const cycles = 54 * 800;
  for (let i = 0; i < cycles; i++) {
    apu.clock(1);
    if (apu.dmc.level !== prev) changes++;
    prev = apu.dmc.level;
  }
  // Primer byte de silencio (sin buffer al empezar la unidad de salida), luego 1 cambio por bit.
  assert.ok(changes >= 780 && changes <= 800, `${changes}`);
});
