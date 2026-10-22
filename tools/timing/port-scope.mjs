#!/usr/bin/env node
// Empirical scope: plays a movie in the oracle and in the port (src/headless.js, read-only), compares
// RAM and the picture of EVERY logical frame (hashes; full pixel diff only where they differ) and
// attributes each picture-only difference (RAM equal) to the mid-frame PPU writes found by
// measure-movie.mjs (out/timing/<movie>.json, run it first).
//
// Usage: node tools/timing/port-scope.mjs <movie.zmv> [--out file.json] [--port module]
// Batch: node tools/timing/port-scope.mjs --all [--jobs N]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { Oracle } from '../oracle/lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { loadMovie } from '../oracle/lib/movie.mjs';
import { parseArgs, readOptionalSram, runCli } from '../oracle/lib/cli.mjs';
import { runPort, DEFAULT_PORT_MODULE } from '../oracle/lib/port-adapter.mjs';
import { diffFramebuffers } from '../oracle/lib/diff-core.mjs';
import { sramForMovie } from './measure-movie.mjs';

const OUT = join(REPO_ROOT, 'out/timing');
const MOVIES = join(REPO_ROOT, 'tests/oracle/movies');

function fnv(bytes, from, to, h = 0x811c9dc5) {
  for (let i = from; i < to; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}
// compared state as in tools/oracle/ignore.default.json: no stack page $0110-$01FF, no RAM_01_CODE
const ramHash = (ram) => fnv(ram, 0x200, 0x800, fnv(ram, 0, 0x110));
const sramHash = (sram) => fnv(sram, 0x1f00, 0x2000, fnv(sram, 0, 0x0c90));
const fbHash = (fb) => fnv(fb, 256, fb.length); // row 0 is masked by the diff (jsnes never draws it)

function collector(keepFb) {
  const recs = [];
  return {
    recs,
    write(r) {
      recs[r.frame] = {
        ram: ramHash(r.ram) ^ sramHash(r.sram),
        fb: r.fb ? fbHash(r.fb) : null,
        full: r.fb && keepFb(r.frame) ? Uint8Array.from(r.fb) : null,
      };
    },
    close() {},
  };
}

export async function portScope(moviePath, { modulePath = DEFAULT_PORT_MODULE } = {}) {
  const name = basename(moviePath, '.zmv');
  const movie = loadMovie(moviePath);
  const sram = readOptionalSram(sramForMovie(moviePath));
  const rom = loadRomFile();
  const measured = JSON.parse(readFileSync(join(OUT, `${name}.json`), 'utf8'));
  const flagged = new Map(); // frame -> captured relevant writes
  for (const w of measured.relevant) if (w.captured) {
    if (!flagged.has(w.frame)) flagged.set(w.frame, []);
    flagged.get(w.frame).push(w);
  }
  // keep full pictures for flagged frames; others are hashed (and re-run below when they differ)
  const keep = (f) => flagged.has(f);
  const all = () => true;

  const oracle = await Oracle.create({ rom: rom.bytes, sram });
  const o = collector(keep);
  oracle.run(movie, o, { captureFb: all });
  const p = collector(keep);
  let portError = null;
  try {
    await runPort({ modulePath, rom: rom.bytes, sram, inputs: movie, sink: p, captureFb: all });
  } catch (e) {
    portError = String(e.message ?? e).split('\n')[0];
  }

  const res = { movie: name, frames: movie.length, portError, portFrames: p.recs.length - 1,
    ramDivergent: 0, firstRamDivergence: null, pictureOnly: 0, pictureOnlyFlagged: 0, pictureOnlyUnflagged: [],
    flaggedFrames: flagged.size, flaggedIdentical: 0, details: [] };
  for (let f = 1; f <= movie.length && f < p.recs.length; f++) {
    const a = o.recs[f], b = p.recs[f];
    if (!a || !b) continue;
    if (a.ram !== b.ram) {
      res.ramDivergent++;
      res.firstRamDivergence ??= f;
      continue;
    }
    const isFlagged = flagged.has(f);
    if (a.fb === b.fb) { if (isFlagged) res.flaggedIdentical++; continue; }
    res.pictureOnly++;
    if (!isFlagged) { if (res.pictureOnlyUnflagged.length < 200) res.pictureOnlyUnflagged.push(f); continue; }
    res.pictureOnlyFlagged++;
    const d = diffFramebuffers(a.full, b.full);
    const ws = flagged.get(f);
    res.details.push({ frame: f, pixels: d.count, bbox: d.bbox,
      writes: ws.map((w) => `${w.site} $${w.reg.toString(16)}=${w.val.toString(16)} L${w.line}:${w.dot} (${w.impact})`) });
  }
  return res;
}

function spawnOne(movie, extra) {
  return new Promise((res, rej) => {
    const pr = spawn(process.execPath, ['--no-warnings', import.meta.filename, join(MOVIES, movie), ...extra],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    pr.stdout.on('data', (d) => { out += d; });
    pr.on('close', (code) => (code === 0 ? res(out.trim()) : rej(new Error(`${movie}: exit ${code}`))));
  });
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['all'] });
  if (args.all) {
    const movies = readdirSync(MOVIES).filter((f) => f.endsWith('.zmv'));
    const size = (m) => readFileSync(join(MOVIES, m), 'utf8').length;
    const queue = [...movies].sort((a, b) => size(b) - size(a));
    const jobs = Number(args.jobs ?? Math.max(1, availableParallelism() - 1));
    const extra = args.port ? ['--port', args.port] : [];
    await Promise.all(Array.from({ length: jobs }, async () => {
      while (queue.length) {
        const m = queue.shift();
        try { console.log(await spawnOne(m, extra)); } catch (e) { console.log(String(e.message)); }
      }
    }));
    const reports = movies.map((m) => join(OUT, `${m.replace(/\.zmv$/, '')}.scope.json`)).filter(existsSync)
      .map((f) => JSON.parse(readFileSync(f, 'utf8'))).sort((a, b) => a.movie.localeCompare(b.movie));
    const t = { frames: 0, portFrames: 0, ramDivergent: 0, pictureOnly: 0, pictureOnlyFlagged: 0, flaggedFrames: 0, flaggedIdentical: 0 };
    for (const r of reports) for (const k of Object.keys(t)) t[k] += r[k];
    console.log('\n== port scope totals', JSON.stringify(t));
    for (const r of reports) {
      console.log(`${r.movie.padEnd(22)} ram-div ${String(r.ramDivergent).padStart(5)} (first ${r.firstRamDivergence})  picture-only ${String(r.pictureOnly).padStart(4)} ` +
        `(flagged ${r.pictureOnlyFlagged}, unflagged ${r.pictureOnly - r.pictureOnlyFlagged})  flagged-identical ${r.flaggedIdentical}/${r.flaggedFrames}` +
        (r.portError ? `  PORT ERROR at frame ${r.portFrames + 1}: ${r.portError}` : ''));
    }
    writeFileSync(join(OUT, 'scope-summary.json'), JSON.stringify({ totals: t, reports }, null, 1));
    return 0;
  }
  const moviePath = args._[0] && resolve(args._[0]);
  if (!moviePath) { console.error('usage: port-scope.mjs <movie.zmv> | --all'); return 2; }
  const res = await portScope(moviePath, { modulePath: args.port ? resolve(args.port) : DEFAULT_PORT_MODULE });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(args.out ?? join(OUT, `${res.movie}.scope.json`)), JSON.stringify(res, null, 1));
  console.log(`${res.movie}: ram-divergent ${res.ramDivergent}, picture-only ${res.pictureOnly} ` +
    `(flagged ${res.pictureOnlyFlagged}), flagged identical ${res.flaggedIdentical}/${res.flaggedFrames}` +
    (res.portError ? `, port error: ${res.portError}` : ''));
  return 0;
}

if (import.meta.main) runCli(main);
