#!/usr/bin/env node
// Measures mid-frame PPU writes over every movie in tests/oracle/movies (each with its .sav from
// <movie>.expect.json) and prints/saves aggregate statistics.
//
// Usage: node tools/timing/measure.mjs [--jobs N] [--only a,b] [--aggregate-only]
// Output: out/timing/<movie>.json (per movie) and out/timing/summary.json; a text summary on stdout.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { parseArgs, runCli } from '../oracle/lib/cli.mjs';

const MOVIES = join(REPO_ROOT, 'tests/oracle/movies');
const OUT = join(REPO_ROOT, 'out/timing');
const hex = (n, w = 2) => '$' + n.toString(16).toUpperCase().padStart(w, '0');

function runOne(movie) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--no-warnings', join(import.meta.dirname, 'measure-movie.mjs'), join(MOVIES, movie)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => (code === 0 ? res(out.trim()) : rej(new Error(`${movie}: exit ${code}`))));
  });
}

async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) console.log(await fn(queue.shift()));
  });
  await Promise.all(workers);
}

export function aggregate(reports) {
  const bySite = new Map();
  const byMode = new Map();
  const totals = { movies: reports.length, frames: 0, nmis: 0, overrun: 0, lagVideoFrames: 0, relevantWrites: 0,
    relevantFrames: 0, capturedFrames: 0, dmcFrames: 0, irqs: 0, endInPicture: 0, oamDma513: 0, oamDma514: 0,
    maxNmiCycles: 0, minVblankMargin: Infinity };
  const slackHist = { hw: {}, js: {} };
  const bucket = (v) => (v === 0 ? '0' : v <= 2 ? '1-2' : v <= 8 ? '3-8' : v <= 32 ? '9-32' : v <= 128 ? '33-128' : '>128');
  for (const r of reports) {
    totals.frames += r.frames;
    totals.nmis += r.nmi.count;
    totals.overrun += r.nmi.overrun;
    totals.lagVideoFrames += r.nmi.lagVideoFrames ?? 0;
    totals.dmcFrames += r.nmi.dmcFrames;
    totals.irqs += r.nmi.irqs;
    totals.endInPicture += r.nmi.endInPicture;
    totals.oamDma513 += r.nmi.oamDma[513] ?? 0;
    totals.oamDma514 += r.nmi.oamDma[514] ?? 0;
    totals.maxNmiCycles = Math.max(totals.maxNmiCycles, r.nmi.cycles.max);
    if (r.nmi.vblankMargin.min !== null) totals.minVblankMargin = Math.min(totals.minVblankMargin, r.nmi.vblankMargin.min);
    const frames = new Set(), captured = new Set();
    for (const w of r.relevant) {
      totals.relevantWrites++;
      frames.add(w.frame);
      if (w.captured) captured.add(w.frame);
      const key = `${w.site} ${hex(w.reg, 4)} ${w.impact}`;
      let s = bySite.get(key);
      if (!s) bySite.set(key, (s = { site: w.site, reg: hex(w.reg, 4), impact: w.impact, writes: 0, captured: 0, frames: 0,
        regions: {}, callers: {}, modes: {}, lines: [Infinity, -Infinity], onPixels: 0, hwMin: Infinity, jsMin: Infinity,
        movies: {}, examples: [] }));
      s.writes++;
      if (w.captured) s.captured++;
      s.regions[w.region] = (s.regions[w.region] ?? 0) + 1;
      const caller = w.chain.slice(1, 3).join('<');
      s.callers[caller] = (s.callers[caller] ?? 0) + 1;
      const mode = `${hex(w.mode)}/${hex(w.submode)}`;
      s.modes[mode] = (s.modes[mode] ?? 0) + 1;
      if (w.region === 'visible') { s.lines[0] = Math.min(s.lines[0], w.line); s.lines[1] = Math.max(s.lines[1], w.line); }
      const hwS = Math.min(w.hw.back, w.hw.fwd), jsS = Math.min(w.js.back, w.js.fwd);
      if (hwS === 0) s.onPixels++;
      s.hwMin = Math.min(s.hwMin, hwS);
      s.jsMin = Math.min(s.jsMin, jsS);
      s.movies[r.movie] = (s.movies[r.movie] ?? 0) + 1;
      if (s.examples.length < 3) s.examples.push(`${r.movie}#${w.frame} L${w.line}:${w.dot} cyc ${w.cyc}${w.captured ? '' : ' (lag picture)'}`);
      if (w.captured) {
        slackHist.hw[bucket(hwS)] = (slackHist.hw[bucket(hwS)] ?? 0) + 1;
        slackHist.js[bucket(jsS)] = (slackHist.js[bucket(jsS)] ?? 0) + 1;
      }
      const m = byMode.get(mode) ?? { writes: 0, sites: new Set() };
      m.writes++;
      m.sites.add(w.site);
      byMode.set(mode, m);
    }
    totals.relevantFrames += frames.size;
    totals.capturedFrames += captured.size;
  }
  for (const s of bySite.values()) s.frames = s.writes; // writes are per frame for these sites (1/frame)
  return {
    totals,
    slackHist,
    sites: [...bySite.values()].sort((a, b) => b.writes - a.writes),
    modes: Object.fromEntries([...byMode].map(([k, v]) => [k, { writes: v.writes, sites: [...v.sites] }])),
  };
}

function printSummary(sum, reports) {
  const t = sum.totals;
  console.log('\n== totals');
  console.log(JSON.stringify({ ...t, minVblankMargin: t.minVblankMargin }, null, 1));
  console.log('\n== slack (captured pictures, min(back,fwd) CPU cycles): hardware', JSON.stringify(sum.slackHist.hw), ' jsnes', JSON.stringify(sum.slackHist.js));
  console.log('\n== sites');
  for (const s of sum.sites) {
    console.log(`${s.site} ${s.reg} ${s.impact}: ${s.writes} writes (${s.captured} in compared pictures, ${s.onPixels} on pixel dots), ` +
      `lines ${s.lines[0]}-${s.lines[1]}, hw slack min ${s.hwMin}, jsnes slack min ${s.jsMin}`);
    console.log(`   regions ${JSON.stringify(s.regions)} callers ${JSON.stringify(s.callers)}`);
    console.log(`   modes ${JSON.stringify(s.modes)}`);
    console.log(`   e.g. ${s.examples.join('; ')}`);
  }
  console.log('\n== per movie');
  for (const r of reports) {
    const cap = new Set(r.relevant.filter((w) => w.captured).map((w) => w.frame));
    console.log(`${r.movie.padEnd(22)} ${String(r.frames).padStart(6)} fr  relevant ${String(r.relevant.length).padStart(4)}  ` +
      `captured-frames ${String(cap.size).padStart(3)}  overrun ${String(r.nmi.overrun).padStart(3)}  nmi cyc p50 ${r.nmi.cycles.p50} max ${r.nmi.cycles.max}  ` +
      `dmc ${r.nmi.dmcFrames}  vblank margin min ${r.nmi.vblankMargin.min}`);
  }
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['aggregate-only'] });
  let movies = readdirSync(MOVIES).filter((f) => f.endsWith('.zmv')).sort();
  if (args.only) movies = movies.filter((m) => String(args.only).split(',').some((o) => m.startsWith(o)));
  mkdirSync(OUT, { recursive: true });
  if (!args['aggregate-only']) {
    const jobs = Number(args.jobs ?? Math.max(1, availableParallelism() - 1));
    // longest first
    const size = (m) => readFileSync(join(MOVIES, m), 'utf8').length;
    await pool(movies.sort((a, b) => size(b) - size(a)), jobs, runOne);
  }
  const reports = movies.map((m) => join(OUT, m.replace(/\.zmv$/, '.json'))).filter(existsSync)
    .map((f) => JSON.parse(readFileSync(f, 'utf8'))).sort((a, b) => a.movie.localeCompare(b.movie));
  const sum = aggregate(reports);
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(sum, null, 1));
  printSummary(sum, reports);
  return 0;
}

if (import.meta.main) runCli(main);
