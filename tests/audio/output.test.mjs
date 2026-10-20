import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Apu } from '../../src/audio/apu.js';
import { Resampler } from '../../src/audio/resampler.js';
import { ApuStream, packWrite, unpackWrite } from '../../src/audio/stream.js';
import { CPU_HZ, FRAME_CYCLES } from '../../src/audio/tables.js';
import { goertzel, zeroCrossingHz } from './helpers.mjs';

function render(writes, seconds, sampleRate = 48000) {
  const apu = new Apu();
  const rs = new Resampler({ sampleRate, capacity: Math.ceil(seconds * sampleRate) + 16 });
  for (const [a, v] of writes) apu.writeRegister(a, v);
  apu.clock(Math.round(seconds * CPU_HZ), rs);
  return rs.take();
}

test('salida: un La (440 Hz) en el pulso 1 da 440 Hz por cruces por cero', () => {
  const t = Math.round(CPU_HZ / (16 * 440) - 1); // 253 = $0FD
  const samples = render(
    [[0x4015, 0x01], [0x4000, 0xbf], [0x4001, 0x08], [0x4002, t & 0xff], [0x4003, t >> 8]],
    0.5,
  );
  const hz = zeroCrossingHz(samples, 48000, 4800);
  const expected = CPU_HZ / (16 * (t + 1));
  assert.ok(Math.abs(hz - expected) < 0.5, `${hz} vs ${expected}`);
});

test('salida a 44.1 kHz: triángulo, pico espectral en la frecuencia esperada', () => {
  const t = 0x150;
  const samples = render([[0x4015, 0x04], [0x4008, 0xff], [0x400a, t & 0xff], [0x400b, t >> 8]], 0.5, 44100);
  const f = CPU_HZ / (32 * (t + 1));
  const body = samples.subarray(4410);
  const peak = goertzel(body, 44100, f);
  assert.ok(peak > 5 * goertzel(body, 44100, f * 1.5), 'pico en f');
  assert.ok(peak > 5 * goertzel(body, 44100, f * 0.7), 'pico en f');
  assert.ok(Math.abs(zeroCrossingHz(body, 44100) - f) < 1);
});

test('filtros: la salida no tiene DC (paso-alto) y queda acotada', () => {
  const samples = render([[0x4011, 0x7f]], 0.3); // nivel DC del DMC
  assert.ok(Math.abs(samples[samples.length - 1]) < 1e-3);
  for (const s of samples) assert.ok(Math.abs(s) <= 1);
});

test('stream: escrituras por frame con timestamp y número de muestras ~ tiempo real', () => {
  const stream = new ApuStream({ sampleRate: 48000, targetFrames: 2 });
  const t = 0x0fd;
  stream.maxFrames = 1000;
  let frac = 0;
  for (let f = 0; f < 60; f++) {
    const writes = [packWrite(0, 0x4017, 0xff)];
    if (f === 0) {
      writes.push(packWrite(100, 0x4015, 0x01), packWrite(104, 0x4000, 0xbf),
        packWrite(108, 0x4001, 0x08), packWrite(112, 0x4002, t & 0xff), packWrite(116, 0x4003, 0));
    }
    frac += FRAME_CYCLES;
    const cycles = Math.floor(frac);
    frac -= cycles;
    stream.pushFrame(Uint32Array.from(writes), cycles);
  }
  const out = new Float32Array(128);
  const all = [];
  for (let i = 0; i < 300; i++) {
    stream.render(out);
    all.push(...out);
  }
  const hz = zeroCrossingHz(Float32Array.from(all), 48000, 4800);
  assert.ok(Math.abs(hz - CPU_HZ / (16 * (t + 1))) < 3, `${hz}`);
  assert.deepEqual(unpackWrite(packWrite(29780, 0x4013, 0xab)), { cycle: 29780, addr: 0x4013, value: 0xab });
});

test('stream: sin frames se queda en silencio; con exceso de cola descarta latencia', () => {
  const stream = new ApuStream({ sampleRate: 48000, targetFrames: 2, maxFrames: 4 });
  const out = new Float32Array(128);
  stream.render(out);
  assert.ok(out.every((v) => v === 0));
  for (let i = 0; i < 10; i++) stream.pushFrame(new Uint32Array(0), 29780);
  assert.ok(stream.queue.length <= 4);
  assert.ok(stream.bufferedCycles() <= 4 * 29781);
});
