import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceWriter, TraceCollector, readTrace } from '../../tools/oracle/lib/trace.mjs';
import { compareTraces, parseRange, loadIgnoreConfig, diffFramebuffers, formatReport } from '../../tools/oracle/lib/diff-core.mjs';
import { VarNames, parseIncText, loadVarNames } from '../../tools/oracle/lib/var-names.mjs';
import { FB_SIZE } from '../../tools/oracle/lib/palette.mjs';

function makeFrames(n, mutate = () => {}) {
  const c = new TraceCollector({});
  const sram = new Uint8Array(0x2000);
  for (let f = 0; f <= n; f++) {
    const ram = new Uint8Array(0x800);
    ram[0x15] = f;
    mutate(f, ram, sram);
    c.write({ frame: f, videoFrame: f, p1: f & 1 ? 0x10 : 0, p2: 0, ram, sram });
  }
  return c;
}

test('trace writer/reader round-trip, SRAM carried forward', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ztrace-'));
  try {
    const path = join(dir, 't.ztrace');
    const w = new TraceWriter(path, { source: 'test' });
    const sram = new Uint8Array(0x2000);
    const fb = new Uint8Array(FB_SIZE).fill(0x0f);
    for (let f = 0; f < 4; f++) {
      if (f === 2) sram[5] = 9;
      const ram = new Uint8Array(0x800).fill(f);
      w.write({ frame: f, videoFrame: f + 3, p1: f, p2: 0, ram, sram, fb: f === 3 ? fb : null });
    }
    w.close();
    const t = readTrace(path);
    assert.equal(t.meta.source, 'test');
    assert.equal(t.frames.length, 4);
    assert.equal(t.frames[3].ram[100], 3);
    assert.equal(t.frames[1].sram[5], 0);
    assert.equal(t.frames[3].sram[5], 9);
    assert.equal(t.frames[3].videoFrame, 6);
    assert.equal(t.frames[3].fb[0], 0x0f);
    assert.equal(t.frames[2].fb, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compareTraces finds the first divergent frame and honours ignores', () => {
  const a = makeFrames(10);
  const b = makeFrames(10, (f, ram) => {
    if (f >= 6) ram[0x12] = 5;
    ram[0x1f0] = f; // stack noise
  });
  const r = compareTraces(a, b, { ignore: [{ from: 0x110, to: 0x1ff }] });
  assert.equal(r.firstDivergence, 6);
  assert.equal(r.divergentFrames, 5);
  assert.deepEqual(r.frames[0].ram, [{ addr: 0x12, a: 0, b: 5 }]);
  const names = new VarNames([{ name: 'GameMode', addr: 0x12, size: 1 }], 'test');
  assert.match(formatReport(r, names), /\$0012 GameMode +oracle=\$00 port=\$05/);
  const clean = compareTraces(a, makeFrames(10), {});
  assert.equal(clean.equal, true);
});

test('compareTraces reports SRAM differences and input mismatches', () => {
  const a = makeFrames(3);
  const b = makeFrames(3, (f, ram, sram) => { if (f === 2) sram[0x10] = 1; });
  b.frames[1].p1 = 0x80;
  const r = compareTraces(a, b, {});
  assert.equal(r.firstDivergence, 2);
  assert.deepEqual(r.frames[0].sram, [{ addr: 0x6010, a: 0, b: 1 }]);
  assert.equal(r.inputMismatches.length, 1);
  assert.equal(compareTraces(a, b, { compareSram: false }).divergentFrames, 0);
});

test('framebuffer diff counts pixels and skips row 0 by default', () => {
  const fa = new Uint8Array(FB_SIZE);
  const fb = new Uint8Array(FB_SIZE);
  fb[5] = 1; // row 0
  fb[10 * 256 + 20] = 1;
  fb[12 * 256 + 3] = 1;
  assert.deepEqual(diffFramebuffers(fa, fb), { count: 2, bbox: { x0: 3, y0: 10, x1: 20, y1: 12 } });
  assert.equal(diffFramebuffers(fa, fb, { ignoreRow0: false }).count, 3);
  assert.equal(diffFramebuffers(fa, fb, { ignoreLeft8: true }).count, 1);
});

test('ranges parse from hex and variable names; default config loads', () => {
  const names = new VarNames(parseIncText('GameMode := $12\nObjX := $70\nObjY := $84\nK = 5\n'), 'inline');
  assert.deepEqual(parseRange('0x00-0x0F'), { from: 0, to: 15, why: '0x00-0x0F' });
  assert.equal(parseRange('$6000').from, 0x6000);
  assert.deepEqual([parseRange('ObjX:13', names).from, parseRange('ObjX:13', names).to], [0x70, 0x7c]);
  assert.equal(parseRange('ObjX+2', names).from, 0x72);
  assert.throws(() => parseRange('Nope', names));
  const cfg = loadIgnoreConfig();
  assert.ok(cfg.ignore.some((r) => r.from === 0x110 && r.to === 0x1ff));
  assert.ok(cfg.presets.temps.length);
});

test('VarNames names array elements as Name+offset', () => {
  const vars = parseIncText('Random := $18\nStunCycle := $26\n');
  const names = new VarNames([{ ...vars[0], size: 14 }, { ...vars[1], size: 1 }], 'inline');
  assert.equal(names.name(0x18), 'Random');
  assert.equal(names.name(0x1b), 'Random+3');
  assert.equal(names.name(0x26), 'StunCycle');
  assert.equal(names.name(0x500), null);
});

test('loadVarNames finds a source (vars.js or .inc) when present', async (t) => {
  const names = await loadVarNames();
  if (names.source === 'none') return t.skip('neither src/core/vars.js nor the disassembly is available');
  assert.equal(names.name(0x12), 'GameMode');
  assert.equal(names.name(0x15), 'FrameCounter');
});
