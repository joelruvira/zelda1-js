#!/usr/bin/env node
// Performance of the cycle tracker. Three runs (each in its own process):
//   node tools/timing/proto/bench.mjs                                            plain port (no hooks)
//   node --import ./tools/timing/proto/register.mjs tools/timing/proto/bench.mjs   instrumented, tracker off
//   node --import ./tools/timing/proto/register.mjs tools/timing/proto/bench.mjs --tracker   tracker on (frame 121)
// Measures (a) frames 1..300 of title-start end to end, (b) frame 121 re-run N times from a snapshot
// (logic + rendering), reporting the median.
import { join } from 'node:path';
import { loadRomFile, REPO_ROOT } from '../../oracle/lib/rom-file.mjs';
import { loadMovie } from '../../oracle/lib/movie.mjs';
import { parseArgs } from '../../oracle/lib/cli.mjs';
import { buildCfg } from '../lib/cfg.mjs';
import { Tracker } from '../lib/tracker.mjs';
import { loadRom } from '../../../src/core/rom.js';

const args = parseArgs(process.argv.slice(2), { flags: ['tracker', 'logic-only'] });
const N = Number(args.n ?? 400);
const hooked = typeof globalThis.__cy === 'object';
const movie = loadMovie(join(REPO_ROOT, 'tests/oracle/movies/title-start.zmv'));
const romFile = loadRomFile();
const { createGame } = await import('../../../src/headless.js');

function snapshotObject(o) {
  const s = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'function') continue;
    s[k] = ArrayBuffer.isView(v) ? v.slice() : Array.isArray(v) ? v.slice() : v;
  }
  return s;
}
function restoreObject(o, s) {
  for (const [k, v] of Object.entries(s)) {
    if (ArrayBuffer.isView(v)) o[k].set(v);
    else o[k] = Array.isArray(v) ? v.slice() : v;
  }
}
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

// (a) whole movie
let game = await createGame({ rom: romFile.bytes });
let t0 = performance.now();
for (let i = 0; i < movie.length; i++) game.stepFrame(movie.p1[i], movie.p2[i]);
const whole = performance.now() - t0;

// (b) frame 121 from a snapshot
game = await createGame({ rom: romFile.bytes });
for (let i = 0; i < 120; i++) game.stepFrame(movie.p1[i], movie.p2[i]);
const m = game.machine;
const snap = { ram: m.ram.slice(), sram: m.sram.slice(), ppu: snapshotObject(m.ppu), mapper: snapshotObject(m.mapper), cpu: snapshotObject(m.cpu) };
let tracker = null;
if (args.tracker) {
  if (!hooked) throw new Error('--tracker needs --import ./tools/timing/proto/register.mjs');
  tracker = new Tracker(buildCfg(loadRom(romFile.bytes)));
  const ppu = m.ppu;
  const setClock = (dot) => { if (dot !== null && dot > ppu.clock) ppu.clock = dot; };
  Object.defineProperty(globalThis.__cy, 'on', { get: () => tracker.on, configurable: true });
  Object.assign(globalThis.__cy, {
    enter: (n, b) => tracker.enter(n, b), leave: (t) => tracker.leave(t), br: (r, c) => tracker.br(r, c),
    px: (r, c) => tracker.px(r, c), pxAddr: (r, b, i) => tracker.pxAddr(r, b, i),
    ioRead: (a) => setClock(tracker.io(a, false)), ioWrite: (a) => setClock(tracker.io(a, true)),
    tableJump: (t, i, x) => tracker.tableJump(t, i, x), switchBank: (b) => tracker.switchBank(b),
  });
  const cpuCycles = ppu.cpuCycles.bind(ppu);
  ppu.cpuCycles = (n) => { if (!tracker.on) cpuCycles(n); };
  const waitStatus = ppu.waitStatus.bind(ppu);
  ppu.waitStatus = (mask, wantSet, per) => {
    if (!tracker.on) return waitStatus(mask, wantSet, per);
    tracker.pollStatus(mask, (dot) => { setClock(dot); return ppu.readStatus(); });
    return true;
  };
}
// no rendering: logic (+ tracker) cost only; status flags still clear at the pre-render line
if (args['logic-only']) m.ppu.sync = function () { if (this.clock >= 20 * 341) this.status &= ~0xe0; };
// seed of frame 121 (title-start, from the oracle: NMI start dot 7, absolute cycle 4526669)
const seed = { absStart: 4526669, dot0: 7, bank: 0 };
const times = [];
let check = null;
for (let r = 0; r < N; r++) {
  m.ram.set(snap.ram); m.sram.set(snap.sram);
  restoreObject(m.ppu, snap.ppu); restoreObject(m.mapper, snap.mapper); restoreObject(m.cpu, snap.cpu);
  if (tracker) tracker.beginNmi(seed);
  t0 = performance.now();
  game.stepFrame(movie.p1[120], movie.p2[120]);
  times.push(performance.now() - t0);
  if (tracker) tracker.endNmi();
  let h = 0;
  for (let i = 0; i < m.ppu.indexBuffer.length; i++) h = (Math.imul(h, 31) + m.ppu.indexBuffer[i]) | 0;
  if (check === null) check = h; else if (check !== h) throw new Error('non-deterministic re-run');
}
const mode = (tracker ? 'tracker on' : hooked ? 'instrumented, tracker off' : 'plain port') + (args['logic-only'] ? ' [logic only]' : '');
console.log(`${mode}: title-start 300 frames ${whole.toFixed(1)} ms (${(whole / movie.length).toFixed(3)} ms/frame); ` +
  `frame 121 median ${median(times).toFixed(3)} ms over ${N} runs` +
  (tracker ? `, ${tracker.stats.events} breadcrumbs + ${tracker.stats.walked} walked instructions per NMI` : ''));
