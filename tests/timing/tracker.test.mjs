// Cycle tracker in src/ (src/core/timing.js, cfg.js, apu-timing.js; docs/TIMING.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { hasRom, hasDisasm, realRom, ROOT } from '../core/helpers.mjs';
import { CFG_FILES } from '../../src/core/cfg.gen.js';
import { JsnesApuTiming } from '../../src/core/apu-timing.js';

const jsnes = await hasJsnes();

test('cfg.gen.js is up to date with the disassembly (node scripts/gen-cfg.mjs)', { skip: !hasDisasm && 'no disassembly' }, async () => {
  const { collectInstructions, encode } = await import('../../scripts/gen-cfg.mjs');
  assert.deepEqual(encode(collectInstructions()), CFG_FILES.map((f) => ({ ...f })));
});

test('decoded program: every instruction matches the asm mnemonic, no errors', { skip: (!hasDisasm || !hasRom) && 'needs disassembly and ROM' }, async () => {
  const { collectInstructions } = await import('../../scripts/gen-cfg.mjs');
  const { buildProgram } = await import('../../src/core/cfg.js');
  const { SYMBOLS } = await import('../../src/core/symbols.js');
  const { loadRom } = await import('../../src/core/rom.js');
  const { OPCODES } = await import('../../src/core/opcodes.js');
  const P = buildProgram(loadRom(realRom()), CFG_FILES, SYMBOLS);
  assert.deepEqual(P.errors, []);
  const asm = collectInstructions().flat();
  assert.equal(P.n, asm.length);
  for (let i = 0; i < P.n; i++) assert.equal(OPCODES[P.op[i]].mn, asm[i].mn, `Z_0${P.bank[i]}:${P.line[i]}`);
});

test('APU timing model == jsnes papu (DMC fetches per APU call)', { skip: !jsnes && 'jsnes not installed' }, async () => {
  const { loadJsnes } = await import('../../tools/oracle/lib/jsnes-loader.mjs');
  const { NES } = await loadJsnes();
  const nes = new NES({ onFrame() {}, onAudioSample: null });
  let halts = 0;
  nes.cpu.haltCycles = (n) => { if (n === 4) halts++; };
  nes.mmap = { load: () => 0, clockIrqCounter() {} };
  const m = new JsnesApuTiming();
  const bulkModel = new JsnesApuTiming();
  let s = 12345;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
  let fetches = 0;
  for (let k = 0; k < 100000; k++) {
    const r = rnd();
    const w = (a, v) => { nes.papu.writeReg(a, v); m.write(a, v); bulkModel.write(a, v); };
    if (r < 0.002) w(0x4010, ((rnd() * 16) | 0) | (rnd() < 0.2 ? 0x40 : 0));
    else if (r < 0.004) w(0x4013, (rnd() * 8) | 0);
    else if (r < 0.008) w(0x4015, rnd() < 0.7 ? 0x1f : 0x0f);
    const n = rnd() < 0.05 ? 8 : 2 + ((rnd() * 6) | 0);
    nes.papu.clockFrameCounter(n, 0);
    assert.equal(m.call(n), halts, `call ${k}`);
    if (bulkModel.safeCycles() > n + 8) bulkModel.bulk(n, n); else bulkModel.call(n);
    fetches += halts;
    halts = 0;
  }
  assert.equal(bulkModel.sampleTimer, m.sampleTimer);
  assert.ok(fetches > 100, 'the sequence exercised DMC fetches');
});

test('reset fully annotated: strict tracker, first NMI at the oracle cycle 327595', { skip: !hasRom && 'no ROM' }, async () => {
  const { createGame } = await import('../../src/headless.js');
  const g = await createGame({ rom: realRom(), timing: 'jsnes', strict: true });
  assert.equal(g.timing.synced, true);
  assert.equal(g.timing.runUntil().nmiStart, 327595);
  g.timing.strict = false;
});

test('title-start: NMIs 7-121 chained from one seed exact on every access and RTI', { skip: (!hasRom || !jsnes) && 'needs ROM and jsnes' }, async () => {
  const { cycleDiff } = await import('../../tools/timing/cycle-diff.mjs');
  const r = await cycleDiff({ moviePath: `${ROOT}/tests/oracle/movies/title-start.zmv`, frames: 121, seed: 7 });
  assert.equal(r.mismatch, null, JSON.stringify(r.mismatch));
  assert.equal(r.exactNmis, 115);
});

test('title-start: picture identical to the oracle in all 300 frames (jsnes-compat)', { skip: (!hasRom || !jsnes) && 'needs ROM and jsnes' }, async () => {
  const { lockstep } = await import('../../tools/oracle/battery.mjs');
  const { loadMovie } = await import('../../tools/oracle/lib/movie.mjs');
  const res = await lockstep({ movie: loadMovie(`${ROOT}/tests/oracle/movies/title-start.zmv`), timing: 'jsnes' });
  assert.equal(res.defects, 0);
  assert.equal(res.px, 0);
});
