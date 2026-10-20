import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CPU_HZ, LENGTH_TABLE, NOISE_PERIODS } from '../../src/audio/tables.js';
import { measureFrequency, newApu } from './helpers.mjs';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected}`);

test('pulso: f = CPU / (16 * (t + 1))', () => {
  for (const t of [0x08, 0xfd, 0x1ab, 0x7ff]) {
    for (const [base, ch] of [[0x4000, 'pulse1'], [0x4004, 'pulse2']]) {
      const apu = newApu();
      apu.writeRegister(0x4015, 0x03);
      apu.writeRegister(base, 0xbf); // duty 50 %, halt, volumen constante 15
      apu.writeRegister(base + 1, 0x08); // sweep desactivado, negar (evita mute por objetivo)
      apu.writeRegister(base + 2, t & 0xff);
      apu.writeRegister(base + 3, (t >> 8) | 0x08);
      const hz = measureFrequency(apu, () => apu[ch].output(), 16 * (t + 1) * 20);
      near(hz, CPU_HZ / (16 * (t + 1)), 0.01, `${ch} t=${t}`);
    }
  }
});

test('pulso: duty cycles 12.5/25/50/75 %', () => {
  const expected = [1 / 8, 2 / 8, 4 / 8, 6 / 8];
  for (let d = 0; d < 4; d++) {
    const apu = newApu();
    apu.writeRegister(0x4015, 0x01);
    apu.writeRegister(0x4000, (d << 6) | 0x3f);
    apu.writeRegister(0x4001, 0x08);
    apu.writeRegister(0x4002, 0x40);
    apu.writeRegister(0x4003, 0x08);
    let high = 0;
    const n = 16 * 0x41 * 8;
    for (let i = 0; i < n; i++) {
      apu.clock(1);
      if (apu.pulse1.output() > 0) high++;
    }
    near(high / n, expected[d], 0.01, `duty ${d}`);
  }
});

test('pulso: periodo < 8 silencia; objetivo del sweep > $7FF silencia', () => {
  const apu = newApu();
  apu.writeRegister(0x4015, 0x01);
  apu.writeRegister(0x4000, 0xbf);
  apu.writeRegister(0x4002, 0x07);
  apu.writeRegister(0x4003, 0x08);
  assert.equal(apu.pulse1.muted(), true);
  apu.writeRegister(0x4002, 0xff);
  apu.writeRegister(0x4003, 0x0f); // periodo $7FF
  apu.writeRegister(0x4001, 0x01); // sweep desactivado, shift 1, suma: objetivo > $7FF
  assert.equal(apu.pulse1.muted(), true);
});

test('sweep: negación en complemento a uno (pulso 1) vs a dos (pulso 2)', () => {
  const apu = newApu();
  for (const base of [0x4000, 0x4004]) {
    apu.writeRegister(base + 1, 0x89); // activo, periodo 0, negar, shift 1
    apu.writeRegister(base + 2, 0x00);
    apu.writeRegister(base + 3, 0x01); // periodo $100
  }
  assert.equal(apu.pulse1.sweepTarget(), 0x100 - 0x80 - 1);
  assert.equal(apu.pulse2.sweepTarget(), 0x100 - 0x80);
});

test('sweep: actualiza el periodo en cada half frame', () => {
  const apu = newApu();
  apu.writeRegister(0x4015, 0x01);
  apu.writeRegister(0x4000, 0xbf);
  apu.writeRegister(0x4001, 0x81); // activo, divisor 0, suma, shift 1
  apu.writeRegister(0x4002, 0x40);
  apu.writeRegister(0x4003, 0x08); // periodo $40
  apu.pulse1.clockHalf(); // primer clock: recarga (reload) y aplica
  assert.equal(apu.pulse1.period, 0x60);
  apu.pulse1.clockHalf();
  assert.equal(apu.pulse1.period, 0x90);
});

test('triángulo: f = CPU / (32 * (t + 1)) y linear counter', () => {
  const t = 0x0fd;
  const apu = newApu();
  apu.writeRegister(0x4015, 0x04);
  apu.writeRegister(0x4008, 0xff); // control, linear 127
  apu.writeRegister(0x400a, t & 0xff);
  apu.writeRegister(0x400b, (t >> 8) | 0x08);
  apu.clock(7460); // primer quarter frame carga el linear counter
  const hz = measureFrequency(apu, () => apu.triangle.output(), 32 * (t + 1) * 20);
  near(hz, CPU_HZ / (32 * (t + 1)), 0.01, 'triángulo');

  // Linear counter de 4 quarter frames sin control: se detiene el secuenciador.
  apu.writeRegister(0x4008, 0x04);
  apu.writeRegister(0x400b, 0x08);
  apu.clock(29830 * 2);
  assert.equal(apu.triangle.linear, 0);
  const seq = apu.triangle.sequence;
  apu.clock(5000);
  assert.equal(apu.triangle.sequence, seq);
});

test('ruido: periodos NTSC y modo corto (secuencia de 93 pasos)', () => {
  for (const idx of [0, 4, 15]) {
    const apu = newApu();
    apu.writeRegister(0x400e, idx);
    const before = apu.noise.shift;
    let shifts = 0;
    let prev = apu.noise.shift;
    for (let i = 0; i < NOISE_PERIODS[idx] * 10; i++) {
      apu.clock(1);
      if (apu.noise.shift !== prev) shifts++;
      prev = apu.noise.shift;
    }
    assert.ok(shifts >= 9 && shifts <= 10, `idx ${idx}: ${shifts}`);
    assert.notEqual(before, apu.noise.shift);
  }
  // Modo corto: el LFSR (desde 1) vuelve a su estado cada 93 pasos (o 31 en otro ciclo).
  const apu = newApu();
  apu.writeRegister(0x400e, 0x80);
  const seen = [apu.noise.shift];
  for (let i = 0; i < 93; i++) {
    apu.noise.timer = 0;
    apu.noise.clockTimer();
    seen.push(apu.noise.shift);
  }
  assert.equal(seen[93], seen[0]);
  // Modo largo: periodo 32767.
  const longApu = newApu();
  let s = longApu.noise.shift;
  let steps = 0;
  do {
    longApu.noise.timer = 0;
    longApu.noise.clockTimer();
    steps++;
  } while (longApu.noise.shift !== s && steps < 40000);
  assert.equal(steps, 32767);
});

test('envelope: decae de 15 a 0 con divisor V+1 quarter frames; loop reinicia', () => {
  const apu = newApu();
  apu.writeRegister(0x4015, 0x01);
  apu.writeRegister(0x4000, 0x02); // decay, V=2 (divisor 3), sin loop
  apu.writeRegister(0x4003, 0x08);
  const env = apu.pulse1.envelope;
  env.clock(); // start: decay=15
  assert.equal(env.decay, 15);
  for (let i = 0; i < 3 * 15; i++) env.clock();
  assert.equal(env.decay, 0);
  for (let i = 0; i < 10; i++) env.clock();
  assert.equal(env.decay, 0);
  apu.writeRegister(0x4000, 0x22); // loop
  for (let i = 0; i < 3; i++) env.clock();
  assert.equal(env.decay, 15);
  apu.writeRegister(0x4000, 0x17); // volumen constante 7
  assert.equal(env.output(), 7);
});

test('length counter: tabla, half frames a 120 Hz, halt y $4015', () => {
  const apu = newApu();
  apu.writeRegister(0x4015, 0x0f);
  apu.writeRegister(0x4000, 0x10);
  apu.writeRegister(0x4003, 0x00); // índice 0 -> 10
  assert.equal(apu.pulse1.length, LENGTH_TABLE[0]);
  assert.equal(apu.readStatus() & 1, 1);
  // 4 pasos: 2 half frames por cada 29830 ciclos -> 10 half frames = 5 periodos.
  apu.clock(29830 * 5);
  assert.equal(apu.pulse1.length, 0);
  assert.equal(apu.readStatus() & 1, 0);

  apu.writeRegister(0x4000, 0x30); // halt
  apu.writeRegister(0x4003, 0x18); // índice 3 -> 2
  apu.clock(29830 * 2);
  assert.equal(apu.pulse1.length, 2);

  apu.writeRegister(0x4015, 0x00); // deshabilitar limpia y bloquea la carga
  assert.equal(apu.pulse1.length, 0);
  apu.writeRegister(0x4003, 0x18);
  assert.equal(apu.pulse1.length, 0);
});

test('frame counter: 4 pasos genera IRQ salvo inhibición; 5 pasos a 96 Hz de half frame', () => {
  const apu = newApu();
  apu.writeRegister(0x4017, 0x00);
  apu.clock(29835);
  assert.equal(apu.readStatus() & 0x40, 0x40);
  assert.equal(apu.readStatus() & 0x40, 0); // la lectura borra el flag

  // $4017 = $FF (lo que escribe Zelda cada frame): 5 pasos, clock inmediato quarter+half.
  const b = newApu();
  b.writeRegister(0x4015, 0x01);
  b.writeRegister(0x4000, 0x10);
  b.writeRegister(0x4003, 0x18); // length 2
  b.writeRegister(0x4017, 0xff);
  b.clock(4);
  assert.equal(b.pulse1.length, 1);
  b.clock(37282); // half frames en 14913 y 37281
  assert.equal(b.pulse1.length, 0);
  assert.equal(b.readStatus() & 0x40, 0);
});

test('escribir $4017=$FF una vez por frame: 2 half frames por frame de vídeo', () => {
  const apu = newApu();
  apu.writeRegister(0x4015, 0x01);
  apu.writeRegister(0x4000, 0x10);
  apu.writeRegister(0x4003, 0xf8); // índice 31 -> 30
  for (let f = 0; f < 10; f++) {
    apu.writeRegister(0x4017, 0xff);
    apu.clock(f & 1 ? 29781 : 29780);
  }
  // Por frame: half inmediato (reset) + half en 14913 -> 20 en 10 frames.
  assert.equal(apu.pulse1.length, 10);
});
