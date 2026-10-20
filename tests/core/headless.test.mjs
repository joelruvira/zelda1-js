import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../../src/headless.js';
import { validateGame } from '../../tools/oracle/lib/port-adapter.mjs';
import { syntheticRom, hasRom, realRom } from './helpers.mjs';

test('src/headless.js satisfies the oracle contract (synthetic ROM)', async () => {
  const sram = new Uint8Array(0x2000).fill(7);
  const game = await createGame({ rom: syntheticRom(), sram, powerOnFill: 0xff });
  validateGame(game);
  assert.equal(game.ram.length, 0x800);
  assert.equal(game.sram[0x123], 7);
  assert.equal(game.framebuffer.length, 256 * 240);
  game.stepFrame(0x10, 0);
  game.stepFrame(0, 0x80);
  assert.equal(game.machine.ppu.frameCount, 2);
});

test('headless runner boots with the real ROM (skipped without roms/zelda.nes)', { skip: !hasRom && 'roms/zelda.nes not present' }, async () => {
  const game = await createGame({ rom: realRom() });
  for (let i = 0; i < 3; i++) game.stepFrame(0, 0);
  assert.equal(game.machine.rom.prgWord(7, 0xfffc), 0xff50);
});
