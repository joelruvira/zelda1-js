#!/usr/bin/env node
// cycle-diff (docs/TIMING.md §7 Paso 3.1): plays a movie from power-on in the oracle (jsnes) and in the
// port with the cycle tracker on (src/core/timing.js, mode jsnes-compat), and compares, in order,
// every NMI start, every I/O access ($2000-$401F reads/writes, with value for writes) and every RTI on
// its ABSOLUTE CPU cycle. Stops at the first difference and names the routine and the asm line of the
// port's access, plus the first breadcrumb failure of the tracker (missing/misplaced $br, ...).
//
//   node tools/timing/cycle-diff.mjs <movie.zmv|name> [--frames N] [--strict] [--resync] [--json out.json] [--context 6]
//   node tools/timing/cycle-diff.mjs --all [--jobs J] [--resync] [names...]      every movie, in parallel
//
// --strict  breadcrumb errors throw (TimingError with the asm location) instead of degrading.
// --seed F  only the F-th NMI takes its start from the oracle; the comparison starts there and the
//           following NMIs chain on the tracker's own timing.
// --nmi N   (with --resync) details of the N-th NMI: context of its first difference in both.
// --resync  every NMI starts at the oracle's cycle (instead of the tracker's own prediction) and is
//           compared on its own: lists every NMI that differs, grouped by the asm location of its first
//           difference or breadcrumb failure (the annotators' worklist). Without it the comparison
//           stops at the first difference from power-on (what CI requires: 0 differences).
// Exit code: 0 = no difference, 1 = difference. Reports: out/timing/cycle-diff/<movie>.json and summary.json.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { Oracle } from '../oracle/lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { loadMovie } from '../oracle/lib/movie.mjs';
import { parseArgs, runCli } from '../oracle/lib/cli.mjs';
import { sramForMovie } from './measure-movie.mjs';

const MOVIES = join(REPO_ROOT, 'tests/oracle/movies');
const OUT = join(REPO_ROOT, 'out/timing/cycle-diff');
const hex = (n) => '$' + n.toString(16).toUpperCase();

/**
 * Oracle event stream: {k:'begin', c} NMI start (first cycle of the 7-cycle sequence),
 * {k:'w'|'r', a, c, v}, {k:'rti', c} (cycle after the RTI). Absolute CPU cycles (jsnes numbering).
 */
export function attachOracleEvents(oracle, events) {
  const cpu = oracle.nes.cpu;
  const mmap = oracle.nes.mmap;
  const mem = cpu.mem;
  const nmi = cpu.doNonMaskableInterrupt.bind(cpu);
  cpu.doNonMaskableInterrupt = (s) => {
    events.push({ k: 'begin', c: cpu._cpuCycleBase + cpu.instrBusCycles });
    return nmi(s);
  };
  const emulate = cpu.emulate.bind(cpu);
  cpu.emulate = () => {
    if (!cpu.nmiImmediate && !(cpu.irqRequested && cpu.F_INTERRUPT === 0) && cpu.cyclesToHalt === 0
      && mmap.load((cpu.REG_PC + 1) & 0xffff) === 0x40) events.push({ k: 'rti', c: cpu._cpuCycleBase + 6 });
    return emulate();
  };
  const write = mmap.write.bind(mmap);
  mmap.write = (addr, val) => {
    if (addr >= 0x2000 && addr < 0x4020) {
      // PPU registers: the bus cycle is counted before the write; other registers after
      const c = cpu._cpuCycleBase + cpu.instrBusCycles - (addr < 0x4000 ? 1 : 0);
      events.push({ k: 'w', a: addr < 0x4000 ? 0x2000 | (addr & 7) : addr, c, v: val });
    }
    return write(addr, val);
  };
  const load = mmap.load.bind(mmap);
  mmap.load = (addr) => {
    if (addr >= 0x2000 && addr < 0x4020 && addr !== 0x4014) {
      const c = cpu._cpuCycleBase + cpu.instrBusCycles - (addr < 0x4000 ? 1 : 0);
      events.push({ k: 'r', a: addr < 0x4000 ? 0x2000 | (addr & 7) : addr, c });
    }
    return load(addr);
  };
  void mem;
}

function fmt(e, P, describe) {
  if (!e) return '(none)';
  const where = e.id !== undefined && P ? ` ${describe(P, e.id)}` : '';
  if (e.k === 'w') return `w ${hex(e.a)}=${hex(e.v ?? 0)} @${e.c}${where}`;
  if (e.k === 'r') return `r ${hex(e.a)} @${e.c}${where}`;
  return `${e.k} @${e.c}`;
}

/** Plays one movie in both; returns the report. */
export async function cycleDiff({ moviePath, frames, strict = false, context = 6, resync = false, seed = 0, showNmi = 0 }) {
  const movie = loadMovie(moviePath);
  const length = Math.min(movie.length, frames ?? movie.length);
  const sramPath = sramForMovie(moviePath);
  const sram = sramPath && existsSync(sramPath) ? new Uint8Array(readFileSync(sramPath)) : null;
  const rom = loadRomFile();

  // ---- oracle: events of every frame
  const oracle = await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 });
  const oev = [];
  attachOracleEvents(oracle, oev);
  oracle.run({ ...movie, length }, { write() {} });

  // ---- port with the tracker
  const { createGame } = await import('../../src/headless.js');
  const { describe } = await import('../../src/core/cfg.js');
  const pev = [];
  const failures = [];
  let game;
  const inputFor = (n) => [movie.p1[n - 1] ?? 0, movie.p2?.[n - 1] ?? 0];
  let timingError = null;
  try {
    game = await createGame({ rom: rom.bytes, sram: sram ? Uint8Array.from(sram) : null, powerOnFill: 0, timing: 'jsnes', strict, inputFor });
  } catch (e) {
    timingError = String(e.message ?? e);
  }
  const T = game?.timing;
  const oStarts = oev.filter((e) => e.k === 'begin').map((e) => e.c);
  const nmiFailure = new Map();
  if (T) {
    T.log = pev;
    T.onFail = (f) => { if (failures.length < 50) failures.push(f); if (!nmiFailure.has(f.nmi)) nmiFailure.set(f.nmi, f); };
    if (resync) T.seedNmi = (k) => oStarts[k - 1] ?? null;
    else if (seed) T.seedNmi = (k) => (k === seed ? oStarts[k - 1] ?? null : null);
    // the reset ran inside createGame: its accesses are lost for the log; re-run is not possible, so
    // compare from the first NMI on (the reset's timing shows in the first NMI start)
  }
  const resetFailure = T?.failure ?? null;
  let stepped = 0;
  if (game) {
    for (let f = 1; f <= length && !timingError; f++) {
      try {
        game.stepFrame(movie.p1[f - 1] ?? 0, movie.p2?.[f - 1] ?? 0);
        stepped = f;
      } catch (e) {
        timingError = `frame ${f}: ${e.message}`;
      }
    }
  }

  // ---- compare (from the first NMI: the port's log starts there)
  const nthBegin = (ev, k) => { let c = 0; return ev.findIndex((e) => e.k === 'begin' && ++c === k); };
  const o = oev.slice(nthBegin(oev, seed || 1));
  // mapper writes ($8000+) are not in the oracle's log (SwitchBank's are opaque in the port too): skip them
  const p0 = pev.map((e) => (e.k === 'begin' ? { k: 'begin', c: e.start, n: e.n } : e)).filter((e) => e.k !== 'nmi' && !(e.k === 'w' && e.a >= 0x8000));
  const p = p0.slice(Math.max(0, nthBegin(p0, seed || 1)));
  if (resync) return perNmi({ movie: basename(moviePath, '.zmv'), length, stepped, o, p, T, describe, nmiFailure, resetFailure, timingError, showNmi });
  let nmi = (seed || 1) - 1, mismatch = null;
  const n = Math.min(o.length, p.length);
  for (let i = 0; i < n; i++) {
    const a = o[i], b = p[i];
    if (a.k === 'begin') nmi++;
    const same = a.k === b.k && a.c === b.c && (a.k !== 'w' && a.k !== 'r' ? true : a.a === b.a && (a.k !== 'w' || a.v === b.v));
    if (!same) {
      mismatch = {
        nmi, index: i,
        oracle: fmt(a), port: fmt(b, T?.P, describe),
        before: p.slice(Math.max(0, i - context), i).map((e) => fmt(e, T?.P, describe)),
        oracleNext: o.slice(i + 1, i + 4).map((e) => fmt(e)),
      };
      break;
    }
  }
  const exactNmis = mismatch ? mismatch.nmi - (seed || 1) : o.filter((e) => e.k === 'begin').length;
  const firstFail = failures[0] ?? resetFailure;
  return {
    movie: basename(moviePath, '.zmv'), frames: length, stepped,
    events: { oracle: o.length, port: p.length },
    exactNmis, mismatch,
    resetFailure: resetFailure ? `${resetFailure.msg} @ ${resetFailure.where}` : null,
    firstFailure: firstFail ? { nmi: firstFail.nmi, msg: firstFail.msg, where: firstFail.where } : null,
    failures: T?.stats.failures ?? null,
    timingError,
  };
}

/** --resync: each NMI compared on its own (both start at the oracle's cycle). */
function perNmi({ movie, length, stepped, o, p, T, describe, nmiFailure, resetFailure, timingError, showNmi }) {
  const chunks = (ev) => {
    const out = [];
    for (const e of ev) {
      if (e.k === 'begin') out.push([]);
      if (out.length) out[out.length - 1].push(e);
    }
    return out;
  };
  const oc = chunks(o), pc = chunks(p);
  const groups = new Map();
  let exact = 0;
  const bad = [];
  for (let n = 1; n <= Math.min(oc.length, pc.length); n++) {
    const a = oc[n - 1], b = pc[n - 1];
    let diff = null;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i], y = b[i];
      const same = x && y && x.k === y.k && (x.k === 'begin' || x.c - a[0].c === y.c - b[0].c) &&
        (x.k !== 'w' && x.k !== 'r' ? true : x.a === y.a && (x.k !== 'w' || x.v === y.v));
      if (!same) { diff = { i, oracle: x ? fmt({ ...x, c: x.c - a[0].c }) : '(end)', port: y ? fmt({ ...y, c: y.c - b[0].c }, T?.P, describe) : '(end)' }; break; }
    }
    if (!diff) { exact++; continue; }
    const f = nmiFailure.get(n);
    // group by the breadcrumb failure location (or the routine of the port's access)
    const key = f ? `${f.msg.replace(/ @cycle \d+/, '')}` : `access ${diff.port.replace(/ @\d+/, '').replace(/=\$[0-9A-F]+/, '')}`;
    const g = groups.get(key) ?? { key, count: 0, firstNmi: n, example: diff };
    g.count++;
    groups.set(key, g);
    if (bad.length < 2000 || n === showNmi) {
      const ctx = (ev, k) => ev.slice(Math.max(0, diff.i - 4), diff.i + 3).map((e) => fmt({ ...e, c: e.c - ev[0].c }, k ? T?.P : null, describe));
      bad.push({ nmi: n, ...diff, failure: f ? `${f.msg} @ ${f.where}` : null, ...(n === showNmi ? { oracleCtx: ctx(a, 0), portCtx: ctx(b, 1) } : {}) });
    }
  }
  return {
    movie, frames: length, stepped, resync: true, nmis: oc.length, exactNmis: exact,
    mismatch: bad.length ? { nmi: bad[0].nmi, oracle: bad[0].oracle, port: bad[0].port, before: [], oracleNext: [] } : null,
    worklist: [...groups.values()].sort((x, y) => y.count - x.count),
    bad, resetFailure: resetFailure ? `${resetFailure.msg} @ ${resetFailure.where}` : null,
    failures: T?.stats.failures ?? null, timingError,
  };
}

function line(r) {
  if (r.resync) {
    return `${r.movie.padEnd(24)} NMIs ${String(r.nmis).padStart(6)}  exact ${String(r.exactNmis).padStart(6)}` +
      (r.worklist?.length ? '\n' + r.worklist.slice(0, 8).map((g) => `${' '.repeat(26)}${String(g.count).padStart(6)} x ${g.key} (first nmi ${g.firstNmi})`).join('\n') : '') +
      (r.timingError ? `\n${' '.repeat(26)}ERROR ${r.timingError}` : '');
  }
  const m = r.mismatch;
  return `${r.movie.padEnd(24)} frames ${String(r.frames).padStart(6)}  exact NMIs ${String(r.exactNmis).padStart(6)}` +
    (m ? `  FIRST DIFF nmi ${m.nmi}: oracle ${m.oracle} | port ${m.port}` : '  no difference') +
    (r.firstFailure ? `\n${' '.repeat(26)}first breadcrumb failure (nmi ${r.firstFailure.nmi}): ${r.firstFailure.msg} @ ${r.firstFailure.where}` : '') +
    (r.timingError ? `\n${' '.repeat(26)}ERROR ${r.timingError}` : '');
}

function child(args) {
  return new Promise((res) => {
    const pr = spawn(process.execPath, ['--no-warnings', '--max-old-space-size=6144', import.meta.filename, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    pr.stdout.on('data', (d) => { out += d; });
    pr.stderr.on('data', (d) => { err += d; });
    pr.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }));
  });
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['all', 'strict', 'quiet', 'resync'] });
  if (args.all) {
    let movies = args._.length ? args._.map((m) => (m.endsWith('.zmv') ? basename(m) : `${m}.zmv`))
      : readdirSync(MOVIES).filter((f) => f.endsWith('.zmv'));
    const sizes = Object.fromEntries(movies.map((m) => [m, loadMovie(join(MOVIES, m)).length]));
    movies.sort((a, b) => sizes[b] - sizes[a]);
    mkdirSync(OUT, { recursive: true });
    const jobs = Number(args.jobs ?? Math.max(1, availableParallelism() - 1));
    const queue = [...movies];
    const reports = [];
    await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      while (queue.length) {
        const m = queue.shift();
        const json = join(OUT, m.replace(/\.zmv$/, '.json'));
        const extra = [];
        if (args.frames) extra.push('--frames', String(args.frames));
        if (args.strict) extra.push('--strict');
        if (args.resync) extra.push('--resync');
        const r = await child([join(MOVIES, m), '--json', json, ...extra]);
        if (!existsSync(json)) { console.log(`${m}: CRASH ${r.err.slice(-800)}`); reports.push({ movie: m, crash: r.err.slice(-800) }); continue; }
        const rep = JSON.parse(readFileSync(json, 'utf8'));
        reports.push(rep);
        console.log(line(rep));
      }
    }));
    reports.sort((a, b) => a.movie.localeCompare(b.movie));
    const exact = reports.filter((r) => !r.mismatch && !r.crash && !r.timingError).length;
    if (args.resync) {
      // worklist over all movies
      const all = new Map();
      for (const r of reports) for (const g of r.worklist ?? []) {
        const a = all.get(g.key) ?? { key: g.key, count: 0, movies: [] };
        a.count += g.count; a.movies.push(r.movie);
        all.set(g.key, a);
      }
      const wl = [...all.values()].sort((x, y) => y.count - x.count);
      writeFileSync(join(OUT, 'worklist.json'), JSON.stringify(wl, null, 1));
      console.log('\n== worklist (first difference per NMI, all movies):');
      for (const g of wl.slice(0, 40)) console.log(`${String(g.count).padStart(8)} x ${g.key}  [${g.movies.slice(0, 4).join(', ')}${g.movies.length > 4 ? ', ...' : ''}]`);
    }
    const summary = { movies: reports.length, exact, nmis: reports.reduce((n, r) => n + (r.exactNmis ?? 0), 0), reports };
    writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
    console.log(`\n== ${exact}/${reports.length} movies without a difference; ${summary.nmis} NMIs exact before the first difference`);
    return exact === reports.length ? 0 : 1;
  }
  const spec = args._[0];
  if (!spec) { console.error('usage: cycle-diff.mjs <movie.zmv|name> [--frames N] [--strict] | --all'); return 2; }
  const moviePath = existsSync(spec) ? resolve(spec) : join(MOVIES, spec.endsWith('.zmv') ? spec : `${spec}.zmv`);
  const rep = await cycleDiff({ moviePath, frames: args.frames ? Number(args.frames) : undefined, strict: !!args.strict, context: Number(args.context ?? 6), resync: !!args.resync, seed: Number(args.seed ?? 0), showNmi: Number(args.nmi ?? 0) });
  if (args.nmi && rep.resync) {
    const b = rep.bad.find((x) => x.nmi === Number(args.nmi));
    console.log(b ? JSON.stringify(b, null, 1) : `NMI ${args.nmi}: exact`);
  }
  if (args.json) writeFileSync(resolve(args.json), JSON.stringify(rep, null, 1));
  else {
    console.log(line(rep));
    if (rep.mismatch && !args.quiet) {
      console.log('  port, last events before the difference:');
      for (const b of rep.mismatch.before) console.log(`    ${b}`);
      console.log(`  oracle next: ${rep.mismatch.oracleNext.join(' | ')}`);
    }
  }
  return rep.mismatch || rep.timingError ? 1 : 0;
}

if (import.meta.main) runCli(main);
