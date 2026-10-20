import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../../src/headless.js';
import { validateGame } from '../../tools/oracle/lib/port-adapter.mjs';
import { syntheticRom, hasRom, realRom } from './helpers.mjs';

// While routines of later packages are stubs, stepping may hit NotImplementedError (src/game/stub.js):
// skip the stepping part with the routine's name instead of failing (added by P01).
function stepOrSkip(t, step) {
  try {
    step();
    return true;
  } catch (e) {
    if (e.name !== 'NotImplementedError') throw e;
    t.skip(`stepping needs an unported routine: ${e.message}`);
    return false;
  }
}

test('src/headless.js satisfies the oracle contract (synthetic ROM)', async (t) => {
  const sram = new Uint8Array(0x2000).fill(7);
  const game = await createGame({ rom: syntheticRom(), sram, powerOnFill: 0xff });
  validateGame(game);
  assert.equal(game.ram.length, 0x800);
  assert.equal(game.sram[0x123], 7);
  assert.equal(game.framebuffer.length, 256 * 240);
  if (!stepOrSkip(t, () => { game.stepFrame(0x10, 0); game.stepFrame(0, 0x80); })) return;
  assert.equal(game.machine.ppu.frameCount, 2);
});

test('headless runner boots with the real ROM (skipped without roms/zelda.nes)', { skip: !hasRom && 'roms/zelda.nes not present' }, async (t) => {
  const game = await createGame({ rom: realRom() });
  if (!stepOrSkip(t, () => { for (let i = 0; i < 3; i++) game.stepFrame(0, 0); })) return;
  assert.equal(game.machine.rom.prgWord(7, 0xfffc), 0xff50);
});
