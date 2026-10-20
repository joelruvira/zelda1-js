// P02 driver tests with the real ROM (tables are read from it); skipped without roms/zelda.nes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { hasRom, realRom } from '../core/helpers.mjs';
import { ram } from '../../src/core/ram.js';
import { bus } from '../../src/core/bus.js';
import { loadRom, loadSymbols, table } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { switchBank } from '../../src/core/asm.js';
import {
  Paused, SongRequest, Song, Tune0, Tune0Request, TunePtr0, EffectRequest, Effect, EffectCounter,
  SampleRequest, Sample, BackgroundSample, SampleCounter, Tune1, Tune1Request,
} from '../../src/core/vars.js';
import {
  DriveAudio, DriveTune0, EmitSquareNote0, EmitSquareNote1, EmitTriangleNote,
} from '../../src/game/audio/driver.js';
import { DriveEffect } from '../../src/game/audio/effects.js';
import { DriveSample } from '../../src/game/audio/samples.js';

const skip = !hasRom && 'needs roms/zelda.nes';
let writes = [];
const w = (a, v) => (a << 8) | v;

before(async () => {
  if (!hasRom) return;
  await loadSymbols();
  createMachine(loadRom(realRom()));
  bus.apuWrite = (a, v) => writes.push(w(a, v));
  switchBank(0);
});

function reset() {
  ram.fill(0);
  writes = [];
  switchBank(0);
}

test('DriveAudio while paused: $4015 off/on, only tune 0, clears all requests', { skip }, () => {
  reset();
  ram[Paused] = 1;
  ram[SongRequest] = 0x80;
  ram[EffectRequest] = 0x01;
  ram[SampleRequest] = 0x01;
  DriveAudio();
  assert.deepEqual(writes, [w(0x4015, 0), w(0x4015, 0x0f)]);
  assert.equal(ram[Song], 0);
  for (let a = SongRequest; a < SongRequest + 5; a++) assert.equal(ram[a], 0);
});

test('DriveAudio not paused starts with $4017=$FF and plays the title song', { skip }, () => {
  reset();
  ram[SongRequest] = 0x80;
  DriveAudio();
  assert.equal(writes[0], w(0x4017, 0xff));
  assert.equal(ram[Song], 0x80);
  assert.ok(writes.some((x) => x >> 8 === 0x4006 || x >> 8 === 0x4002), 'square notes emitted');
});

test('Emit*Note: a rest (period low byte 0) returns 0 and writes nothing', { skip }, () => {
  reset();
  const periods = table(bus.rom, 'NotePeriodTable');
  let rest = -1;
  for (let i = 0; i < 0x70; i += 2) if (periods.byte(i + 1) === 0) { rest = i; break; }
  assert.ok(rest >= 0);
  assert.equal(EmitSquareNote0(rest), 0);
  assert.equal(EmitSquareNote1(rest), 0);
  assert.equal(EmitTriangleNote(rest), 0);
  assert.deepEqual(writes, []);
  assert.equal(EmitSquareNote1(0x02) !== 0, true);
  assert.equal(writes.length, 2);
});

test('DriveTune0: heart warning ($40) does not interrupt a playing tune', { skip }, () => {
  reset();
  ram[Tune0Request] = 0x01;
  DriveTune0();
  assert.equal(ram[Tune0], 0x01);
  const ptr = ram[TunePtr0];
  ram[Tune0Request] = 0x40;
  DriveTune0();
  assert.equal(ram[Tune0], 0x01);
  assert.ok(ram[TunePtr0] > ptr);
});

test('DriveEffect: $80 silences samples/tune 1; sword sfx counts down from $0A', { skip }, () => {
  reset();
  ram[Sample] = 3; ram[Tune1] = 4; ram[BackgroundSample] = 0x10; ram[0x61a] = 9;
  ram[EffectRequest] = 0x80;
  assert.equal(DriveEffect(0x25), 0x25);
  assert.deepEqual(writes, [w(0x4015, 0x0f)]);
  assert.equal(ram[Sample] | ram[Tune1] | ram[BackgroundSample] | ram[0x61a], 0);
  writes = [];
  ram[EffectRequest] = 0x01;
  const x = DriveEffect(0x25);
  assert.equal(ram[Effect], 0x01);
  assert.equal(ram[EffectCounter], 0x09);
  assert.equal(x, table(bus.rom, 'SwordSfxNotes').byte(9)); // X = note (TAX)
  assert.deepEqual(writes.map((v) => v >> 8), [0x400e, 0x400c, 0x400f]);
});

test('DriveSample: a background sample restarts with the incoming X on $4011', { skip }, () => {
  reset();
  ram[BackgroundSample] = 0x10;
  const x = DriveSample(0x5a);
  assert.equal(writes[0], w(0x4011, 0x5a));
  assert.equal(ram[Sample], 0x10);
  assert.equal(ram[SampleCounter], 0xa0);
  assert.equal(x, 0x10);
  assert.deepEqual(writes.slice(-2), [w(0x4015, 0x0f), w(0x4015, 0x1f)]);
});

test('DriveTune1 $80 request: SilenceSong then plays tune bit 8', { skip }, () => {
  reset();
  ram[Song] = 0x01;
  ram[Tune1Request] = 0x80;
  DriveAudio();
  assert.equal(ram[Tune1], 0x80);
  assert.equal(ram[Song], 0);
});

test('Title song through the emulated APU is audible', { skip }, async () => {
  const { Apu, FRAME_CYCLES } = await import('../../src/audio/apu.js');
  reset();
  const apu = new Apu();
  bus.apuWrite = (a, v) => apu.writeRegister(a, v);
  try {
    apu.writeRegister(0x4015, 0x0f); // as ClearAllAudioAndVideo leaves it at reset
    ram[SongRequest] = 0x80;
    let sum = 0, n = 0, min = Infinity, max = -Infinity;
    for (let f = 0; f < 240; f++) {
      DriveAudio();
      for (let c = 0; c < Math.floor(FRAME_CYCLES); c += 37) {
        apu.clock(37);
        const v = apu.mix();
        sum += v; n++; min = Math.min(min, v); max = Math.max(max, v);
      }
    }
    assert.ok(max - min > 0.05, `signal swings (${min}..${max})`);
  } finally {
    bus.apuWrite = (a, v) => writes.push(w(a, v));
  }
});
