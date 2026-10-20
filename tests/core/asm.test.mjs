import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram } from '../../src/core/ram.js';
import { read } from '../../src/core/bus.js';
import { switchBank, tableJump } from '../../src/core/asm.js';
import { syntheticRom } from './helpers.mjs';

test('switchBank maps the bank at $8000 and returns A >> 4', () => {
  const m = createMachine(loadRom(syntheticRom({ fill: (b) => b })));
  assert.equal(switchBank(5), 0);
  assert.equal(m.mapper.prgBankAt(0x8000), 5);
  assert.equal(read(0x9000), 5);
});

test('tableJump leaves $00-$03 like the original and dispatches', () => {
  // Fixed bank: a jump table at $E000 = [$1234, $ABCD].
  const entries = [0x34, 0x12, 0xcd, 0xab];
  createMachine(loadRom(syntheticRom({ fill: (b, o) => (b === 7 && o >= 0x2000 && o < 0x2004 ? entries[o - 0x2000] : 0) })));
  const calls = [];
  const r = tableJump(0xe000, 1, [() => calls.push(0), () => { calls.push(1); return 'ok'; }]);
  assert.equal(r, 'ok');
  assert.deepEqual(calls, [1]);
  assert.deepEqual([...ram.subarray(0, 4)], [0xff, 0xdf, 0xcd, 0xab]);
  assert.throws(() => tableJump(0xe000, 7, []), RangeError);
});
