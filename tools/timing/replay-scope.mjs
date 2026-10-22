#!/usr/bin/env node
// Replay-based scope and tolerance (no port code needed: uses only the oracle + src/core/ppu.js).
// For every logical frame whose compared picture contains a relevant mid-frame write (from
// out/timing/<movie>.json, made by measure-movie.mjs), plus a validation sample of other frames:
//   valid      replay at true times == oracle picture? (else: rows where jsnes' per-scanline rendering
//              differs from the dot renderer)
//   portModel  picture with the port's current timing model (logic in zero time; only the vblank-end
//              wait and the sprite-0 split are timed) vs replay at true times -> pixels the port gets
//              wrong today because of cycle timing
//   slack      for each relevant write, how many CPU cycles earlier/later it can happen with an
//              identical (dot-accurate) picture, searched by re-rendering (sampled per site)
//
// Usage: node tools/timing/replay-scope.mjs <movie.zmv> [--max-slack-frames N]   |   --all [--jobs N]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { Oracle } from '../oracle/lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { loadMovie } from '../oracle/lib/movie.mjs';
import { getPalette } from '../oracle/lib/palette.mjs';
import { parseArgs, readOptionalSram, runCli } from '../oracle/lib/cli.mjs';
import { sramForMovie } from './measure-movie.mjs';
import { attachRecorder, renderReplay, pictureDiff } from './lib/replay.mjs';
import { symbolize } from './lib/symbolize.mjs';
import { impact, region } from './lib/classify.mjs';

const OUT = join(REPO_ROOT, 'out/timing');
const MOVIES = join(REPO_ROOT, 'tests/oracle/movies');
const VALIDATION_EVERY = 97;
const MAX_SHIFT = 3000; // cycles

const OAM_DMA_DOTS = 513 * 3;

/** Time model of the port today (src/core/ppu.js catch-up + src/game/nmi.js). */
export function portModelTimes(rec) {
  const ev = rec.events;
  const times = new Array(ev.length);
  let anchor = -1;
  for (let i = 0; i < ev.length; i++) {
    const s = ev[i].pc === undefined ? { routine: null, local: null } : symbolize(ev[i].pc, ev[i].bank);
    ev[i].routine = s.routine;
    ev[i].local = s.local;
    if (ev[i].kind === 'r' && ev[i].reg === 0x2002 && s.local === 'IsrNmi@WaitVBlankEnd') anchor = i;
  }
  let clock = 0, dmaDone = false;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    // timed in the port: the vblank-end wait (anchor), WaitAndScrollToSplitBottom and its tail call
    // JMP TurnOffAllVideo (src/game/ppu/sprite0.js counts those cycles by hand)
    const split = e.routine === 'WaitAndScrollToSplitBottom' ||
      (e.routine === 'TurnOffAllVideo' && i > 0 && ev[i - 1].routine === 'WaitAndScrollToSplitBottom');
    if (split) e.routine = 'WaitAndScrollToSplitBottom';
    if (split || i === anchor) clock = Math.max(clock, e.frameDot);
    times[i] = clock;
    if (e.kind === 'w' && e.reg === 0x4014 && !dmaDone && i < anchor) { clock += OAM_DMA_DOTS; dmaDone = true; }
  }
  return times;
}

/**
 * The port today (src/core/ppu.js waitStatus, src/game/nmi.js): the NMI starts at clock 0, OAM DMA
 * adds 513 cycles, everything else is free; @WaitVBlankEnd polls every 9 cycles until the sprite-0
 * flag clears (pre-render dot 1), then WaitAndScrollToSplitBottom polls every 9 cycles until the hit.
 * Returns (port detection dot - original detection dot), or null when the frame has no split.
 */
export function splitPhaseError(rec) {
  const ev = rec.events;
  const hit = ev.find((e) => e.kind === 'h');
  const reads = ev.filter((e) => e.kind === 'r' && e.reg === 0x2002 && symbolize(e.pc, e.bank).routine === 'WaitAndScrollToSplitBottom');
  if (!hit || !reads.length) return null;
  // the original's detecting read: the first loop read at or after the hit
  const orig = reads.find((e) => e.frameDot >= hit.frameDot);
  if (!orig) return null;
  const POLL = 27, CLEAR = 20 * 341; // pre-render line dot 1 = frameDot 6820
  let c = OAM_DMA_DOTS;
  if (c < CLEAR) c += POLL * Math.ceil((CLEAR - c) / POLL);
  const port = c + POLL * Math.max(0, Math.ceil((hit.frameDot - c) / POLL));
  return port - orig.frameDot;
}

function isRelevantWrite(e, rec) {
  if (e.kind !== 'w') return false;
  const why = impact({ ...e, maskBefore: e.maskBefore, ctrlBefore: e.ctrlBefore });
  return why !== null && region(e.frameDot) !== 'vblank' && e.frameDot < 89342 && rec.nmi.endVideo === rec.nmi.video;
}

/** Largest shift (cycles, in direction dir) of event i that leaves the picture identical to `ref`. */
function searchSlack(rec, palette, ref, i, dir) {
  const ev = rec.events;
  const base = ev[i].frameDot;
  // keep the access between its neighbours: crossing them would change the access order
  const limitDots = dir > 0
    ? (i + 1 < ev.length ? ev[i + 1].frameDot - base - 1 : 89341 - base)
    : (i > 0 ? base - ev[i - 1].frameDot - 1 : base);
  const limit = Math.min(MAX_SHIFT, Math.floor(limitDots / 3));
  const same = (k) => {
    const img = renderReplay(rec, palette, (e, j) => (j === i ? base + dir * 3 * k : e.frameDot));
    return pictureDiff(ref, img).count === 0;
  };
  let good = 0, bad = null, k = 1;
  while (k <= limit) {
    if (same(k)) { good = k; k *= 2; } else { bad = k; break; }
  }
  if (bad === null) {
    if (good < limit && same(limit)) return { cycles: limit, bounded: true };
    if (good === limit) return { cycles: limit, bounded: true };
    bad = limit;
    if (same(limit)) return { cycles: limit, bounded: true };
  }
  while (bad - good > 1) {
    const mid = (good + bad) >> 1;
    if (same(mid)) good = mid; else bad = mid;
  }
  return { cycles: good, bounded: false };
}

export async function replayScope(moviePath, { maxSlackFrames = 60 } = {}) {
  const name = basename(moviePath, '.zmv');
  const movie = loadMovie(moviePath);
  const sram = readOptionalSram(sramForMovie(moviePath));
  const rom = loadRomFile();
  const palette = await getPalette();
  const measured = JSON.parse(readFileSync(join(OUT, `${name}.json`), 'utf8'));
  const relevantFrames = new Set(measured.relevant.filter((w) => w.captured).map((w) => w.frame));
  const wanted = (f) => relevantFrames.has(f) || f % VALIDATION_EVERY === 0;

  const oracle = await Oracle.create({ rom: rom.bytes, sram });
  const { frames } = attachRecorder(oracle, wanted);
  const res = {
    movie: name, frames: movie.length,
    validation: { frames: 0, identical: 0, differing: [] },
    relevant: { frames: 0, replayIdenticalToOracle: 0, jsnesRowDiffs: [], portModelWrong: 0, portModelPixels: 0, portModelExamples: [] },
    slack: {}, // site -> {n, hwBackMin, hwFwdMin, samples: [...]}
    splitPhase: {}, // dots the port's sprite-0 detection is late (+) / early (-) -> frames
  };
  const slackDone = new Map();
  const sink = {
    write(r) {
      const rec = frames.get(r.frame);
      frames.delete(r.frame);
      if (!rec || !r.fb || rec.nmi.endVideo !== rec.nmi.video) return;
      const truth = renderReplay(rec, palette);
      const vsOracle = pictureDiff(r.fb, truth);
      if (!relevantFrames.has(r.frame)) {
        res.validation.frames++;
        if (!vsOracle.count) res.validation.identical++;
        else if (res.validation.differing.length < 50) res.validation.differing.push({ frame: r.frame, ...vsOracle });
        return;
      }
      res.relevant.frames++;
      if (!vsOracle.count) res.relevant.replayIdenticalToOracle++;
      else if (res.relevant.jsnesRowDiffs.length < 400) res.relevant.jsnesRowDiffs.push({ frame: r.frame, ...vsOracle });
      const model = portModelTimes(rec);
      const img = renderReplay(rec, palette, (e, i) => model[i]);
      const dm = pictureDiff(truth, img);
      if (dm.count) {
        res.relevant.portModelWrong++;
        res.relevant.portModelPixels += dm.count;
        if (res.relevant.portModelExamples.length < 40) {
          const ws = rec.events.filter((e) => isRelevantWrite(e, rec) && e.routine !== 'WaitAndScrollToSplitBottom')
            .map((e) => `${e.local ?? e.routine} $${e.reg.toString(16)}=${e.val.toString(16)} L${e.line}:${e.dot}`);
          res.relevant.portModelExamples.push({ frame: r.frame, ...dm, writes: ws });
        }
      }
      // sprite-0 split: where the port's current polling model detects the hit vs the original
      const err = splitPhaseError(rec);
      if (err !== null) res.splitPhase[err] = (res.splitPhase[err] ?? 0) + 1;
      // slack of each relevant write (sampled per site)
      for (let i = 0; i < rec.events.length; i++) {
        const e = rec.events[i];
        if (!isRelevantWrite(e, rec)) continue;
        const site = `${e.local ?? e.routine} $${e.reg.toString(16).toUpperCase()}`;
        const n = slackDone.get(site) ?? 0;
        if (n >= maxSlackFrames) continue;
        slackDone.set(site, n + 1);
        const back = searchSlack(rec, palette, truth, i, -1);
        const fwd = searchSlack(rec, palette, truth, i, +1);
        const s = res.slack[site] ??= { n: 0, backMin: Infinity, fwdMin: Infinity, zeroBoth: 0, hist: {}, samples: [] };
        s.n++;
        s.backMin = Math.min(s.backMin, back.cycles);
        s.fwdMin = Math.min(s.fwdMin, fwd.cycles);
        const tot = Math.min(back.cycles, fwd.cycles);
        if (tot === 0) s.zeroBoth++;
        const b = tot === 0 ? '0' : tot <= 2 ? '1-2' : tot <= 8 ? '3-8' : tot <= 32 ? '9-32' : tot <= 128 ? '33-128' : '>128';
        s.hist[b] = (s.hist[b] ?? 0) + 1;
        if (s.samples.length < 12) s.samples.push(`#${r.frame} L${e.line}:${e.dot} -${back.cycles}${back.bounded ? '+' : ''}/+${fwd.cycles}${fwd.bounded ? '+' : ''}`);
      }
    },
    close() {},
  };
  const t0 = performance.now();
  oracle.run(movie, sink, { captureFb: wanted });
  res.seconds = +((performance.now() - t0) / 1000).toFixed(1);
  return res;
}

function spawnOne(movie, extra) {
  return new Promise((res, rej) => {
    const pr = spawn(process.execPath, ['--no-warnings', import.meta.filename, join(MOVIES, movie), ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    pr.stdout.on('data', (d) => { out += d; });
    pr.on('close', (code) => (code === 0 ? res(out.trim()) : rej(new Error(`${movie}: exit ${code}`))));
  });
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['all'] });
  const extra = args['max-slack-frames'] ? ['--max-slack-frames', String(args['max-slack-frames'])] : [];
  if (args.all) {
    const movies = readdirSync(MOVIES).filter((f) => f.endsWith('.zmv'));
    const size = (m) => readFileSync(join(MOVIES, m), 'utf8').length;
    const queue = [...movies].sort((a, b) => size(b) - size(a));
    const jobs = Number(args.jobs ?? Math.max(1, availableParallelism() - 1));
    await Promise.all(Array.from({ length: jobs }, async () => {
      while (queue.length) {
        const m = queue.shift();
        try { console.log(await spawnOne(m, extra)); } catch (e) { console.log(String(e.message)); }
      }
    }));
    const reports = movies.map((m) => join(OUT, `${m.replace(/\.zmv$/, '')}.replay.json`)).filter(existsSync)
      .map((f) => JSON.parse(readFileSync(f, 'utf8')));
    const t = { validationFrames: 0, validationIdentical: 0, relevantFrames: 0, replayIdenticalToOracle: 0, portModelWrong: 0, portModelPixels: 0 };
    const slack = {};
    const splitPhase = {};
    for (const r of reports) {
      t.validationFrames += r.validation.frames; t.validationIdentical += r.validation.identical;
      t.relevantFrames += r.relevant.frames; t.replayIdenticalToOracle += r.relevant.replayIdenticalToOracle;
      t.portModelWrong += r.relevant.portModelWrong; t.portModelPixels += r.relevant.portModelPixels;
      for (const [k, v] of Object.entries(r.splitPhase ?? {})) splitPhase[k] = (splitPhase[k] ?? 0) + v;
      for (const [site, s] of Object.entries(r.slack)) {
        const a = slack[site] ??= { n: 0, backMin: Infinity, fwdMin: Infinity, zeroBoth: 0, hist: {}, samples: [] };
        a.n += s.n; a.backMin = Math.min(a.backMin, s.backMin); a.fwdMin = Math.min(a.fwdMin, s.fwdMin); a.zeroBoth += s.zeroBoth;
        for (const [k, v] of Object.entries(s.hist)) a.hist[k] = (a.hist[k] ?? 0) + v;
        for (const x of s.samples) if (a.samples.length < 8) a.samples.push(`${r.movie}${x}`);
      }
    }
    console.log('\n== replay scope totals', JSON.stringify(t));
    console.log('== sprite-0 split: port detection - original (dots) -> frames', JSON.stringify(splitPhase));
    console.log('== slack per site (cycles; min over sampled writes)');
    for (const [site, s] of Object.entries(slack).sort((a, b) => b[1].n - a[1].n)) {
      console.log(`${site}: n=${s.n} back>=${s.backMin} fwd>=${s.fwdMin} both-zero ${s.zeroBoth} hist(min(back,fwd)) ${JSON.stringify(s.hist)}`);
      console.log(`   ${s.samples.join('  ')}`);
    }
    for (const r of reports.sort((a, b) => a.movie.localeCompare(b.movie))) {
      console.log(`${r.movie.padEnd(22)} valid ${r.validation.identical}/${r.validation.frames}  relevant ${r.relevant.frames} ` +
        `(replay==oracle ${r.relevant.replayIdenticalToOracle})  port-model wrong ${r.relevant.portModelWrong} (${r.relevant.portModelPixels} px)`);
    }
    writeFileSync(join(OUT, 'replay-summary.json'), JSON.stringify({ totals: t, slack, splitPhase, reports }, null, 1));
    return 0;
  }
  const moviePath = args._[0] && resolve(args._[0]);
  if (!moviePath) { console.error('usage: replay-scope.mjs <movie.zmv> | --all'); return 2; }
  const res = await replayScope(moviePath, { maxSlackFrames: Number(args['max-slack-frames'] ?? 60) });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${res.movie}.replay.json`), JSON.stringify(res, null, 1));
  console.log(`${res.movie}: valid ${res.validation.identical}/${res.validation.frames}, relevant ${res.relevant.frames} ` +
    `(replay==oracle ${res.relevant.replayIdenticalToOracle}), port-model wrong ${res.relevant.portModelWrong}, ${res.seconds}s`);
  return 0;
}

if (import.meta.main) runCli(main);
