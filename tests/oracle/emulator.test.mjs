// Checks that jsnes handles the hardware features Zelda relies on, using a synthetic
// MMC1 + CHR-RAM ROM (no Nintendo data), and that the oracle -> port -> diff pipeline works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { buildTestRom } from '../../tools/oracle/testrom/build-test-rom.mjs';
import { createMovie, idleMovie, BTN } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { compareTraces, loadIgnoreConfig } from '../../tools/oracle/lib/diff-core.mjs';
import { runPort, loadPort, PortMissingError, inputsFromTrace } from '../../tools/oracle/lib/port-adapter.mjs';

const skip = (await hasJsnes()) ? false : 'jsnes not installed (npm install in tools/oracle)';
const { Oracle } = skip ? {} : await import('../../tools/oracle/lib/nes-oracle.mjs');
const FAKE_PORT = join(import.meta.dirname, '../../tools/oracle/testrom/test-rom-port.mjs');
const STUB_PORT = join(import.meta.dirname, '../../tools/oracle/headless-stub.mjs');

async function runOracle(movie, opts = {}) {
  const oracle = await Oracle.create({ rom: buildTestRom(), ...opts });
  const sink = new TraceCollector({});
  oracle.run(movie, sink, { captureFb: opts.captureFb ?? (() => false) });
  return { oracle, frames: sink.frames };
}

test('MMC1 PRG switching, SRAM code execution and frame 0 alignment', { skip }, async () => {
  const { frames } = await runOracle(idleMovie(3));
  assert.deepEqual(frames.map((f) => f.frame), [0, 1, 2, 3]);
  assert.equal(frames[0].ram[0x300], 3, 'bank 3 marker read through MMC1 $E000 writes');
  assert.equal(frames[0].ram[0x301], 1, 'routine copied to $6000 ran');
  assert.equal(frames[0].ram[0x304], 0, 'frame 0 is taken before the first NMI');
  assert.deepEqual([...frames[0].sram.subarray(0, 4)], [0xee, 0x01, 0x03, 0x60]);
});

test('one logical frame per NMI; sprite 0 hit is detected every frame', { skip }, async () => {
  const { frames } = await runOracle(idleMovie(120));
  for (const f of frames.slice(1)) {
    assert.equal(f.ram[0x304], f.frame & 0xff, `NMI count at frame ${f.frame}`);
    assert.equal(f.ram[0x302], f.frame & 0xff, `sprite 0 hits at frame ${f.frame}`);
    assert.equal(f.sram[0x1000], f.frame & 0xff);
  }
});

test('movie input N is what ReadInputs-style code reads in NMI N', { skip }, async () => {
  const p1 = Array.from({ length: 64 }, (_, i) => (i * 73 + 5) & 0xff);
  const { frames } = await runOracle(createMovie(p1, null));
  for (const f of frames.slice(1)) {
    assert.equal(f.ram[0x303], p1[f.frame - 1]);
    assert.equal(f.p1, p1[f.frame - 1]);
  }
});

test('video timing (fm2) applies input per video frame and records what NMIs saw', { skip }, async () => {
  const p1 = new Uint8Array(30).fill(0);
  p1.fill(BTN.START, 10);
  const { frames } = await runOracle(createMovie(p1, null, { timing: 'video' }));
  for (const f of frames.slice(1)) assert.equal(f.ram[0x303], f.p1);
  assert.ok(frames.some((f) => f.p1 === BTN.START));
});

test('CHR-RAM tiles, palettes and sprites reach the framebuffer', { skip }, async () => {
  const { frames } = await runOracle(idleMovie(4), { captureFb: (f) => f === 4 });
  const fb = frames[4].fb;
  assert.ok(fb);
  assert.equal(fb[67 * 256 + 67], 0x16, 'sprite 0 pixel');
  assert.equal(fb[100 * 256 + 10], 0x30, 'background pixel (CHR-RAM tile 0, color 1)');
});

test('emulation is deterministic and power-on fill is configurable', { skip }, async () => {
  const a = await runOracle(idleMovie(30));
  const b = await runOracle(idleMovie(30));
  assert.equal(compareTraces({ frames: a.frames }, { frames: b.frames }).equal, true);
  const c = await runOracle(idleMovie(2), { powerOnFill: 0xff });
  assert.equal(c.frames[0].ram[0x7ff], 0xff);
});

test('oracle and a contract-conforming port produce identical traces', { skip }, async () => {
  const p1 = Array.from({ length: 40 }, (_, i) => (i % 7 === 0 ? BTN.A : 0));
  const oracle = await runOracle(createMovie(p1, null), { captureFb: (f) => f % 10 === 0 });
  const port = new TraceCollector({});
  const ref = { frames: oracle.frames };
  await runPort({
    modulePath: FAKE_PORT, rom: buildTestRom(), inputs: inputsFromTrace(ref), sink: port,
    captureFb: (f) => f % 10 === 0,
  });
  const report = compareTraces(ref, { frames: port.frames }, { ignore: loadIgnoreConfig().ignore });
  assert.equal(report.equal, true, JSON.stringify(report.frames[0]));
  // A deliberate bug in the port is caught at the right frame.
  port.frames[25].ram[0x302] ^= 1;
  assert.equal(compareTraces(ref, { frames: port.frames }, { ignore: loadIgnoreConfig().ignore }).firstDivergence, 25);
});

test('the port stub and a missing port fail with a clear error', async () => {
  await assert.rejects(loadPort('/nonexistent/headless.js'), PortMissingError);
  const sink = new TraceCollector({});
  await assert.rejects(
    runPort({ modulePath: STUB_PORT, rom: new Uint8Array(16), inputs: idleMovie(1), sink }),
    /not ported yet/,
  );
});
