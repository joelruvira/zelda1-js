#!/usr/bin/env node
// Prototype: the port with exact cycle accounting (tracker + breadcrumbs) on title-start frame 121.
//
//   node --import ./tools/timing/proto/register.mjs tools/timing/proto/frame121.mjs
//        [--frame N] [--from F] [--movie m.zmv] [--jsnes-compat] [--no-tracker]
//
// 1. Oracle: plays the movie and records frames F..N (NMI start, every PPU access with its raster
//    position, picture); renders frame N with the dot-accurate replay (lib/replay.mjs).
// 2. Port (src/ instrumented on load by proto/hooks.mjs): frames 1..F-1 as usual; frames F..N with
//    the tracker on. Frame F is seeded with its NMI start (absolute cycle + dot) from the oracle;
//    every later frame is seeded by the model (nmi-model.mjs predictStart) from the tracker's own
//    end-of-NMI cycle: no oracle input after frame F.
// 3. Compares, per tracked frame, the cycle of every PPU access with the oracle, and the pictures.
import { join } from 'node:path';
import { Oracle } from '../../oracle/lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from '../../oracle/lib/rom-file.mjs';
import { loadMovie } from '../../oracle/lib/movie.mjs';
import { getPalette, canonicalizeIndices } from '../../oracle/lib/palette.mjs';
import { parseArgs } from '../../oracle/lib/cli.mjs';
import { attachRecorder, renderReplay, pictureDiff } from '../lib/replay.mjs';
import { buildCfg } from '../lib/cfg.mjs';
import { Tracker, TimingError } from '../lib/tracker.mjs';
import { predictStart } from '../nmi-model.mjs';
import { loadRom } from '../../../src/core/rom.js';

const args = parseArgs(process.argv.slice(2), { flags: ['no-tracker', 'quiet', 'jsnes-compat'] });
const target = Number(args.frame ?? 121);
const from = Number(args.from ?? target);
const moviePath = args.movie ?? join(REPO_ROOT, 'tests/oracle/movies/title-start.zmv');
const movie = loadMovie(moviePath);
const romFile = loadRomFile();
const palette = await getPalette();
const FRAME_DOTS = 341 * 262; // jsnes never drops the odd-frame dot (see docs/TIMING.md)

// ---------------------------------------------------------------- oracle
const oracle = await Oracle.create({ rom: romFile.bytes });
const { frames } = attachRecorder(oracle, (f) => f >= from && f <= target);
let oracleFb = null;
oracle.run({ ...movie, length: target }, { write(r) { if (r.frame === target) oracleFb = r.fb; } }, { captureFb: (f) => f === target });
const rec = frames.get(target) ?? null;
if (!rec || !oracleFb) throw new Error('oracle: frame not recorded');
const truth = renderReplay(rec, palette);
const ioOf = (r) => r.events.filter((e) => e.kind === 'w' || (e.kind === 'r' && e.reg === 0x2002)).map((e) => ({
  kind: e.kind, addr: e.reg, cycle: (e.frameDot - r.nmi.startPortDot) / 3,
}));

// ---------------------------------------------------------------- port + tracker
const cfg = buildCfg(loadRom(romFile.bytes));
if (cfg.errors.length) throw new Error(`cfg: ${cfg.errors[0]}`);
const tracker = new Tracker(cfg);
const { createGame } = await import('../../../src/headless.js');
const game = await createGame({ rom: romFile.bytes });
const ppu = game.machine.ppu;
const setClock = (dot) => { if (dot !== null && dot > ppu.clock) ppu.clock = dot; };
// --jsnes-compat: jsnes draws each scanline at its end, so a mid-line PPUMASK write only affects
// the next line. Deferring such writes to the end of the line reproduces the oracle exactly.
const VIS0 = 21 * 341 - 1;
const snapLine = (dot) => {
  if (dot === null || !args['jsnes-compat'] || dot < VIS0 || dot >= VIS0 + 240 * 341) return dot;
  return VIS0 + Math.ceil((dot - VIS0) / 341) * 341;
};
Object.defineProperty(globalThis.__cy, 'on', { get: () => tracker.on, configurable: true });
Object.assign(globalThis.__cy, {
  enter: (n, b) => tracker.enter(n, b),
  leave: (t) => tracker.leave(t),
  br: (r, c) => tracker.br(r, c),
  px: (r, c) => tracker.px(r, c),
  pxAddr: (r, b, i) => tracker.pxAddr(r, b, i),
  ioRead: (a) => setClock(tracker.io(a, false)),
  ioWrite: (a) => { const d = tracker.io(a, true); setClock(a === 0x2001 ? snapLine(d) : d); },
  tableJump: (t, i, x) => tracker.tableJump(t, i, x),
  switchBank: (b) => tracker.switchBank(b),
});
// timed waits and fixed delays now come from the tracker
const cpuCycles = ppu.cpuCycles.bind(ppu);
ppu.cpuCycles = (n) => { if (!tracker.on) cpuCycles(n); };
const waitStatus = ppu.waitStatus.bind(ppu);
ppu.waitStatus = (mask, wantSet, per) => {
  if (!tracker.on) return waitStatus(mask, wantSet, per);
  tracker.pollStatus(mask, (dot) => { setClock(dot); return ppu.readStatus(); });
  return true;
};

const timings = [];
const perFrame = [];
let timingError = null;
let seed = null; // {absStart, dot0, vbl (absolute dot of this frame's vblank)}
for (let f = 1; f <= target; f++) {
  const i = f - 1;
  const track = f >= from && !args['no-tracker'] && !timingError;
  if (track) {
    if (f === from) {
      const n = frames.get(f).nmi; // the only values taken from the oracle
      seed = { absStart: n.startCycle, dot0: n.startPortDot, vbl: 3 * n.startCycle - n.startPortDot };
    }
    tracker.log = [];
    tracker.beginNmi({ absStart: seed.absStart, dot0: seed.dot0, bank: 0 });
  }
  const t0 = performance.now();
  try {
    game.stepFrame(movie.p1[i], movie.p2[i]);
  } catch (e) {
    if (!(e instanceof TimingError)) throw e;
    console.log(`TIMING ERROR (frame ${f}): ${process.env.CY_STACK ? e.stack : e.message}`);
    timingError = e;
  } finally {
    timings.push(performance.now() - t0);
    tracker.endNmi();
  }
  if (track && !timingError) {
    const orc = ioOf(frames.get(f));
    const mine = tracker.log.filter((e) => (e.addr >= 0x2000 && e.addr < 0x4000) || e.addr === 0x4014);
    let bad = null;
    for (let k = 0; k < Math.max(mine.length, orc.length); k++) {
      const a = orc[k], b = mine[k];
      if (!a || !b || a.addr !== b.addr || a.cycle !== b.cycle) { bad = { k, oracle: a, port: b }; break; }
    }
    const n = frames.get(f).nmi;
    perFrame.push({ f, accesses: orc.length, bad, end: tracker.cycles, oracleEnd: n.cycles,
      seedOk: seed.absStart === n.startCycle && seed.dot0 === n.startPortDot, stats: { ...tracker.stats } });
    // next frame's NMI from the model: idle loop (JMP, 3 cycles) after the RTI until the next vblank
    const end = seed.absStart + tracker.cycles;
    const vbl = seed.vbl + FRAME_DOTS;
    const s = predictStart(end, vbl, []);
    seed = { absStart: s, dot0: 3 * s - vbl, vbl };
  }
}
const portFb = canonicalizeIndices(game.framebuffer, palette);

// ---------------------------------------------------------------- report
const vsOracle = pictureDiff(oracleFb, portFb);
const vsTruth = pictureDiff(truth, portFb);
const truthVsOracle = pictureDiff(oracleFb, truth);
console.log(`frame ${target}: port vs oracle ${vsOracle.count} px ${JSON.stringify(vsOracle.rows)}; ` +
  `port vs dot-accurate replay ${vsTruth.count} px ${JSON.stringify(vsTruth.rows)}; ` +
  `(replay vs oracle ${truthVsOracle.count} px ${JSON.stringify(truthVsOracle.rows)}: jsnes per-scanline rendering)`);
if (!args['no-tracker'] && perFrame.length) {
  const badFrames = perFrame.filter((p) => p.bad || !p.seedOk || p.end !== p.oracleEnd);
  if (perFrame.length > 1) {
    console.log(`tracked frames ${from}-${perFrame.at(-1).f}: ${perFrame.length}; NMI start predicted ${perFrame.filter((p) => p.seedOk).length}/${perFrame.length}; ` +
      `frames with a PPU access off-cycle or a wrong NMI length: ${badFrames.length}` +
      (badFrames.length ? ` (first: ${JSON.stringify(badFrames[0])})` : ''));
  }
  const last = perFrame.at(-1);
  if (last.f === target) {
    console.log(`PPU accesses: oracle ${last.accesses}; ` +
      (last.bad ? `first mismatch #${last.bad.k}: oracle ${JSON.stringify(last.bad.oracle)} port ${JSON.stringify(last.bad.port)}` : 'all at the same cycle'));
    console.log(`tracker: ${last.stats.events} breadcrumbs, ${last.stats.walked} instructions walked, NMI ends at cycle ${last.end}` +
      ` (oracle ${last.oracleEnd}); unhinted page-cross candidates: ${[...tracker.unhintedPx.keys()].map((k) => `${cfg.instrs[k].file}:${cfg.instrs[k].line}`).join(' ') || 'none'}`);
  }
}
const others = timings.slice(0, -1);
console.log(`time: frame ${target} ${timings.at(-1).toFixed(3)} ms; other frames avg ${(others.reduce((a, b) => a + b, 0) / others.length).toFixed(3)} ms`);
