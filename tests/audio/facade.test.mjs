import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NesAudio } from '../../src/audio/audio.js';
import { ApuStream, unpackWrite } from '../../src/audio/stream.js';

test('fachada: lotes por frame, cursor de ciclos y duración 29780/29781 alternada', () => {
  const audio = new NesAudio();
  const sent = [];
  audio.stream = new ApuStream({ maxFrames: 1000 }); // modo sin AudioContext (como el fallback)
  audio.node = {}; // sin port: post() entrega al stream local
  const push = audio.stream.pushFrame.bind(audio.stream);
  audio.stream.pushFrame = (w, c) => (sent.push({ w: Array.from(w, unpackWrite), c }), push(w, c));
  for (let f = 0; f < 4; f++) {
    audio.writeRegister(0x4017, 0xff);
    audio.writeRegister(0x4000, 0x30);
    audio.writeRegister(0x4002, 0x10, 500);
    audio.writeRegister(0x4016, 0x01); // no es APU: se ignora
    audio.endFrame();
  }
  assert.equal(sent.length, 4);
  assert.deepEqual(sent[0].w.map((w) => w.cycle), [0, 4, 500]);
  assert.deepEqual(sent.map((s) => s.c), [29780, 29781, 29780, 29781]);
});
