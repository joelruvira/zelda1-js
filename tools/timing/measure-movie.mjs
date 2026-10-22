#!/usr/bin/env node
// Runs one movie in the oracle with the PPU-write probe and writes a JSON report:
// every PPU/OAM-DMA write that can change the picture and does not happen in vblank, with its
// cycle since the NMI, raster position, writing routine, call chain, game mode and slack, plus
// per-site counters for all writes and per-NMI statistics.
//
// Usage: node tools/timing/measure-movie.mjs <movie.zmv> [--sram f.sav] [--out file.json]
//        (--sram defaults to the "sram" field of <movie>.expect.json)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Oracle } from '../oracle/lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { loadMovie } from '../oracle/lib/movie.mjs';
import { parseArgs, readOptionalSram, runCli } from '../oracle/lib/cli.mjs';
import { attachProbe, describeCallChain, writeSite } from './lib/ppu-probe.mjs';
import { classify, FRAME_DOTS, PRE_COPY_DOT, VIS0_DOT } from './lib/classify.mjs';

export function sramForMovie(moviePath) {
  const expect = moviePath.replace(/\.zmv$/, '.expect.json');
  if (!existsSync(expect)) return null;
  const name = JSON.parse(readFileSync(expect, 'utf8')).sram;
  if (!name) return null;
  // either next to the movie ("p16-items.sav") or relative to the repo ("out/sram/p08-items.sav")
  const candidates = [join(dirname(moviePath), name), join(REPO_ROOT, name), join(dirname(moviePath), basename(name))];
  return candidates.find(existsSync) ?? candidates[0];
}

const hex = (n, w = 2) => '$' + n.toString(16).toUpperCase().padStart(w, '0');

export async function measureMovie(moviePath, { sramPath } = {}) {
  const movie = loadMovie(moviePath);
  sramPath ??= sramForMovie(moviePath);
  const sram = readOptionalSram(sramPath);
  const rom = loadRomFile();
  const oracle = await Oracle.create({ rom: rom.bytes, sram });

  const relevant = [];
  const sites = new Map(); // "site reg" -> {count, regionCounts}
  const nmis = { count: 0, cycles: [], overrun: 0, lagVideoFrames: 0, overrunFrames: [], endInPicture: 0, dmcFrames: 0,
    dmcCycles: 0, irqs: 0, oamDma: { 513: 0, 514: 0 }, lastSafeMargin: [] };
  let lastSafeWrite = null;
  const pending = []; // relevant writes of the NMI in progress // frameDot of the last vblank write in the current NMI

  attachProbe(oracle, {
    onWrite(ev) {
      if (ev.frame === null) return; // reset code before the first NMI
      const c = classify(ev);
      const site = writeSite(ev);
      const key = `${site} ${hex(ev.reg, 4)}`;
      let s = sites.get(key);
      if (!s) sites.set(key, (s = { site, reg: ev.reg, count: 0, regions: {}, relevant: 0 }));
      s.count++;
      s.regions[c.region] = (s.regions[c.region] ?? 0) + 1;
      if (c.region === 'vblank') lastSafeWrite = ev.frameDot;
      if (!c.relevant) return;
      s.relevant++;
      pending.push({
        frame: ev.frame, cyc: ev.cyc, line: ev.line, dot: ev.dot, frameDot: ev.frameDot,
        region: c.region, reg: ev.reg, val: ev.val, before: ev.reg === 0x2001 ? ev.maskBefore : ev.reg === 0x2000 ? ev.ctrlBefore : null,
        impact: c.impact, site, chain: describeCallChain(ev, 6), mode: ev.mode, submode: ev.submode,
        hw: c.hw, js: c.js, video: ev.video,
      });
    },
    onNmiEnd(n) {
      // the oracle captures the picture drawn during video frame n.endVideo (the one the RTI is in);
      // writes in earlier video frames of an overrunning NMI land in lag pictures nobody compares
      for (const w of pending) {
        w.captured = w.video === n.endVideo;
        w.lagPicture = !w.captured;
        delete w.video;
        relevant.push(w);
      }
      pending.length = 0;
      nmis.count++;
      nmis.cycles.push(n.cycles);
      const endFrameDot = (n.endVideo - n.video) * FRAME_DOTS + (n.endLine >= 241 ? (n.endLine - 241) * 341 : (n.endLine + 21) * 341) + n.endDot - 1;
      if (n.endVideo > n.video) {
        nmis.overrun++;
        nmis.lagVideoFrames += n.endVideo - n.video; // pictures drawn while this NMI was still running
        if (nmis.overrunFrames.length < 400) nmis.overrunFrames.push(n.frame);
      }
      else if (endFrameDot >= VIS0_DOT) nmis.endInPicture++;
      if (n.dmcHalts) { nmis.dmcFrames++; nmis.dmcCycles += n.dmcHalt; }
      nmis.irqs += n.irqs;
      if (n.oamDma) nmis.oamDma[n.oamDma] = (nmis.oamDma[n.oamDma] ?? 0) + 1;
      if (lastSafeWrite !== null) nmis.lastSafeMargin.push(Math.floor((PRE_COPY_DOT - lastSafeWrite) / 3));
      lastSafeWrite = null;
    },
  });
  const t0 = performance.now();
  oracle.run(movie, { write() {} });
  const ms = performance.now() - t0;

  const cyc = nmis.cycles.sort((a, b) => a - b);
  const margins = nmis.lastSafeMargin.sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
  return {
    movie: basename(moviePath, '.zmv'),
    sram: sramPath ? basename(sramPath) : null,
    frames: movie.length,
    seconds: +(ms / 1000).toFixed(2),
    nmi: {
      count: nmis.count,
      cycles: { min: cyc[0], p50: pct(cyc, 0.5), p99: pct(cyc, 0.99), max: cyc[cyc.length - 1] },
      overrun: nmis.overrun, lagVideoFrames: nmis.lagVideoFrames, overrunFrames: nmis.overrunFrames,
      endInPicture: nmis.endInPicture,
      dmcFrames: nmis.dmcFrames, dmcCycles: nmis.dmcCycles, irqs: nmis.irqs, oamDma: nmis.oamDma,
      vblankMargin: { min: margins[0] ?? null, p01: pct(margins, 0.01), p50: pct(margins, 0.5) },
    },
    sites: [...sites.values()].sort((a, b) => b.relevant - a.relevant || b.count - a.count),
    relevant,
  };
}

export async function main(argv) {
  const args = parseArgs(argv);
  const moviePath = args._[0] && resolve(args._[0]);
  if (!moviePath) {
    console.error('usage: measure-movie.mjs <movie.zmv> [--sram f.sav] [--out file.json]');
    return 2;
  }
  const report = await measureMovie(moviePath, { sramPath: args.sram && resolve(args.sram) });
  const out = resolve(args.out ?? join(REPO_ROOT, 'out/timing', `${report.movie}.json`));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report));
  console.log(`${report.movie}: ${report.frames} frames, ${report.relevant.length} relevant writes, ` +
    `${report.nmi.overrun} overrun NMIs, ${report.seconds}s -> ${out}`);
  return 0;
}

if (import.meta.main) runCli(main);
