// P02 unit tests that need neither the ROM nor jsnes: request helpers and pure routines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ram } from '../../src/core/ram.js';
import {
  SongRequest, SampleRequest, EffectRequest, Tune0Request, Tune0, Tune1, ObjTimer,
} from '../../src/core/vars.js';
import { PlaySample, PlayEffect, PlayBoomerangSfx, SilenceAllSound } from '../../src/game/audio/requests.js';
import { VibratePitch } from '../../src/game/audio/driver.js';
import { PrepareCustomSongEnvelope } from '../../src/game/audio/song.js';

test('PlaySample / PlayEffect OR the request into SampleRequest / EffectRequest', () => {
  ram.fill(0, SongRequest, SongRequest + 5);
  ram[SampleRequest] = 0x02;
  assert.equal(PlaySample(0x10), 0x12);
  assert.equal(ram[SampleRequest], 0x12);
  ram[EffectRequest] = 0x01;
  assert.equal(PlayEffect(0x08), 0x09);
  assert.equal(ram[EffectRequest], 0x09);
  assert.equal(ram[SongRequest], 0);
});

test('PlayBoomerangSfx only requests when ObjTimer+19 is 0 and rearms it to $0A', () => {
  ram[EffectRequest] = 0;
  ram[ObjTimer + 19] = 3;
  PlayBoomerangSfx(2);
  assert.equal(ram[EffectRequest], 0);
  ram[ObjTimer + 19] = 0;
  PlayBoomerangSfx(2);
  assert.equal(ram[EffectRequest], 2);
  assert.equal(ram[ObjTimer + 19], 0x0a);
});

test('SilenceAllSound requests $80 on tune 0 / effects and clears Tune0/Tune1', () => {
  ram[Tune0] = 4;
  ram[Tune1] = 8;
  assert.equal(SilenceAllSound(), 0);
  assert.equal(ram[Tune0Request], 0x80);
  assert.equal(ram[EffectRequest], 0x80);
  assert.equal(ram[Tune0], 0);
  assert.equal(ram[Tune1], 0);
});

test('VibratePitch: no change below $10, +1 / -1 by bit 2, $FF quirk falls into -1', () => {
  assert.equal(VibratePitch(0x0f, 0x40), 0x40);
  assert.equal(VibratePitch(0x10, 0x40), 0x41); // bit 2 clear: +1
  assert.equal(VibratePitch(0x14, 0x40), 0x3f); // bit 2 set: -1
  assert.equal(VibratePitch(0x10, 0xff), 0xfe); // ADC gives 0 -> BNE not taken -> @GoDown
  assert.equal(VibratePitch(0x14, 0x00), 0xff);
});

test('PrepareCustomSongEnvelope returns A=$20 X=$82 Y=$7F', () => {
  assert.deepEqual(PrepareCustomSongEnvelope(), { a: 0x20, x: 0x82, y: 0x7f });
});
