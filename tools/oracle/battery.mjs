#!/usr/bin/env node
// Test battery of the whole port (docs/ORACLE.md, "Batería").
//
//   node tools/oracle/battery.mjs movies [names...] [--dir d] [--jobs J] [--timing jsnes|hardware|off] [--require-zero]
//       Lockstep of every movie (default: every tests/oracle/movies/*.zmv) in the PURE port against the
//       oracle: RAM, SRAM and the WHOLE picture compared on EVERY frame (no PNGs, nothing sampled).
//       The port runs with the cycle tracker (src/core/timing.js) in jsnes-compat mode by default
//       (--timing off = the old zero-time model). The goal is 0 differing pixels in every frame: the
//       report counts differing frames and pixels; each difference is still classified (classify()) as a
//       hint. RAM/SRAM differences and pictures outside the classes without the tracker are DEFECTs (exit 1);
//       with --require-zero any differing pixel fails. Besides the picture after each NMI, every VIDEO
//       frame is compared (hash of rows 1-239, lag frames inside long NMIs included, and the count of
//       video frames must match): report field `video`; --require-zero fails on it too.
//       Movies run in parallel (one process each).
//       Reports: out/battery/movies/<movie>.json and out/battery/movies-summary.json.
//   node tools/oracle/battery.mjs movie <file.zmv> [--sram f.sav] [--json out.json]
//       One movie (what `movies` runs in each child process).
//   node tools/oracle/battery.mjs routines [--n 5000] [--scale 150] [--seeds 0,1,2] [--jobs J] [--only p22,p25]
//       Every routine-vs-6502 test file of tests/game (not the movie tests) with every Pxx_N / W3_N /
//       WAVE4_N set to N, ROUTINES_SCALE (multiplier of the seed-count tests: P01, P03, P11, P23-P25) and
//       ROUTINES_SEED = each seed; the files with a hybrid register (Pxx_REAL) run a second time in
//       integrated mode (Pxx_REAL=1). Logs: out/battery/routines/*.log.
//   node tools/oracle/battery.mjs fuzz-gen [--frames 24000] [--only name]
//       (Re)generates the fuzz movies tests/oracle/movies/fuzz-*.zmv (see FUZZ below).
//   node tools/oracle/battery.mjs boot
//       Boot from empty SRAM and from SRAM with a bad checksum / garbage, port vs oracle (lockstep).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { Oracle } from './lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from './lib/rom-file.mjs';
import { loadMovie, createMovie, serializeZmv } from './lib/movie.mjs';
import { parseArgs, runCli } from './lib/cli.mjs';
import { loadPort, validateGame } from './lib/port-adapter.mjs';
import { canonicalizeIndices, getPalette, FB_SIZE } from './lib/palette.mjs';

const OUT = join(REPO_ROOT, 'out/battery');
const MOVIES = join(REPO_ROOT, 'tests/oracle/movies');
const GameMode = 0x12, FrameCounter = 0x15;

// ---------------------------------------------------------------------------------------------------
// Lockstep of one movie

/** Compared state as in tools/oracle/ignore.default.json: no stack $0110-$01FF, no RAM_01_CODE. */
function ramDiffs(a, b, out) {
  for (let i = 0; i < 0x800; i++) if (a[i] !== b[i] && (i < 0x110 || i >= 0x200)) out.push(i);
  return out;
}
function sramDiffs(a, b, out) {
  for (let i = 0; i < 0x2000; i++) if (a[i] !== b[i] && (i < 0xc90 || i >= 0x1f00)) out.push(0x6000 + i);
  return out;
}
/** FNV-1a of rows 1-239 (the compared rows) of a canonical index picture. */
function fbHash(a) {
  let h = 2166136261;
  for (let i = 256; i < 240 * 256; i++) h = Math.imul(h ^ a[i], 16777619);
  return h >>> 0;
}
/** Rows (1-239; row 0 is never drawn by jsnes) that differ, and the pixel count. */
function fbDiff(a, b) {
  let count = 0;
  const rows = [];
  for (let y = 1; y < 240; y++) {
    let n = 0;
    for (let i = y << 8, e = i + 256; i < e; i++) if (a[i] !== b[i]) n++;
    if (n) { rows.push(y); count += n; }
  }
  return { count, rows };
}

function sramFor(moviePath) {
  const exp = moviePath.replace(/\.zmv$/, '.expect.json');
  if (!existsSync(exp)) return null;
  const e = JSON.parse(readFileSync(exp, 'utf8'));
  return e.sram ? join(MOVIES, basename(e.sram)) : null;
}

/**
 * Plays `movie` in the oracle and, in lockstep, in the port. Per oracle NMI it records the PPU
 * register writes ($2000-$2007, $4014) that land on a visible scanline and the video frames the NMI
 * spans, so picture differences can be classified on evidence, not by assumption.
 */
export async function lockstep({ movie, sram = null, name = movie.name, modulePath, onFrame, timing = 'jsnes' } = {}) {
  const rom = loadRomFile();
  const palette = await getPalette();
  const oracle = await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 });
  const nes = oracle.nes;
  const ppu = nes.ppu;
  const cpu = nes.cpu;
  // every VIDEO frame (also the lag frames inside a long NMI, which the per-NMI comparison never sees):
  // a hash of rows 1-239 per completed picture, in the oracle and in the port (ppu.onFrame, tracker on)
  const videoO = [];
  let videoFn = null;
  Object.defineProperty(oracle.handlers, 'video', { configurable: true,
    get: () => (buf) => { videoO.push(fbHash(oracle.framebufferIndices(buf))); videoFn?.(buf); },
    set: (f) => { videoFn = f; } });
  // --- oracle instrumentation (read-only: wraps, never changes emulation)
  let nmiStartVideo = 0;
  let writes = [];
  const info = []; // frame -> { startVideo, endVideo, endScan, writes }
  const nmi = cpu.doNonMaskableInterrupt.bind(cpu);
  cpu.doNonMaskableInterrupt = (s) => {
    nmiStartVideo = oracle.videoFrames;
    writes = [];
    return nmi(s);
  };
  const emulate = cpu.emulate.bind(cpu);
  const mem = cpu.mem;
  cpu.emulate = () => {
    // same RTI test as Oracle#installHooks (this wrapper runs first: frame = completedFrames + 1)
    if (!cpu.nmiImmediate && !(cpu.irqRequested && cpu.F_INTERRUPT === 0) && cpu.cyclesToHalt === 0
      && mem[(cpu.REG_PC + 1) & 0xffff] === 0x40) {
      info[oracle.completedFrames + 1] = { startVideo: nmiStartVideo, endVideo: oracle.videoFrames, endScan: ppu.scanline, writes };
      writes = [];
    }
    return emulate();
  };
  const mmap = nes.mmap;
  const mwrite = mmap.write.bind(mmap);
  mmap.write = (addr, val) => {
    if ((addr >= 0x2000 && addr < 0x4000) || addr === 0x4014) {
      const row = ppu.scanline - 20; // jsnes: scanline 20 = pre-render, buffer row = scanline - 20
      if (row >= 0 && row < 240) writes.push({ reg: addr === 0x4014 ? 0x4014 : 0x2000 | (addr & 7), val, row, dot: ppu.curX });
    }
    return mwrite(addr, val);
  };

  // --- port
  const mod = await loadPort(modulePath);
  // nested NMIs: the n-th NMI reads movie[n-1] (core/timing.js runs the extra NMI inside the frame)
  const inputFor = (n) => [movie.p1[n - 1] ?? 0, movie.p2?.[n - 1] ?? 0];
  const game = await mod.createGame({ rom: rom.bytes, sram: sram ? Uint8Array.from(sram) : null, powerOnFill: 0, timing, inputFor });
  const tracker = game.timing ?? null;
  const videoP = [];
  const vppu = tracker && game.machine?.ppu?.continuous ? game.machine.ppu : null;
  const video0 = vppu ? vppu.frameCount : 0; // pictures completed during the reset (before the first NMI)
  if (vppu) {
    const vbuf = new Uint8Array(FB_SIZE);
    vppu.onFrame = (q) => { videoP.push(fbHash(canonicalizeIndices(q.indexBuffer, palette, vbuf))); };
  }
  const failures = new Map(); // first breadcrumb failure per location (tracker non-strict)
  if (tracker) tracker.onFail = (f) => { const k = f.msg.replace(/ @cycle \d+/, ''); failures.set(k, (failures.get(k) ?? 0) + 1); };
  validateGame(game);
  const pfb = new Uint8Array(FB_SIZE);
  const portFb = () => {
    const raw = typeof game.renderFrame === 'function' ? game.renderFrame() : game.framebuffer;
    return raw ? canonicalizeIndices(raw, palette, pfb) : null;
  };

  const res = { movie: name, frames: movie.length, compared: 0, fbCompared: 0, divergent: [], fc: [], mode: [], noFb: [], timing, px: 0, pxFrames: 0 };
  let stepped = 0;
  let portError = null;
  const sink = {
    write(rec) {
      const f = rec.frame;
      res.fc[f] = rec.ram[FrameCounter];
      res.mode[f] = rec.ram[GameMode];
      if (portError) return;
      if (f > 0) {
        try {
          // NMI-timed movie: NMI n reads movie[n-1]. Not rec.p1/p2: after a nested NMI of the original
          // (two NMIs before one RTI) the record holds the inner NMI's input for both frames k and k+1.
          if (movie.timing === 'nmi') game.stepFrame(movie.p1[f - 1] ?? 0, movie.p2?.[f - 1] ?? 0);
          else game.stepFrame(rec.p1, rec.p2);
        } catch (e) {
          portError = { frame: f, error: String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ') };
          return;
        }
        stepped = f;
      }
      const r = ramDiffs(rec.ram, game.ram, []);
      const s = sramDiffs(rec.sram, game.sram, []);
      let fb = null;
      if (f > 0 && !rec.fb && res.noFb.length < 50) res.noFb.push(f);
      if (f > 0 && rec.fb) {
        const p = portFb();
        if (p) {
          fb = fbDiff(rec.fb, p);
          res.fbCompared++;
          if (fb.count) { res.px += fb.count; res.pxFrames++; }
        }
      }
      res.compared++;
      if (r.length || s.length || fb?.count) {
        res.divergent.push({ frame: f, ram: r.slice(0, 24), ramCount: r.length, sram: s.slice(0, 24), sramCount: s.length,
          fbCount: fb?.count ?? 0, rows: fb?.rows ?? [], portRam: r.slice(0, 8).map((a) => game.ram[a]), oracleRam: r.slice(0, 8).map((a) => rec.ram[a]) });
      }
      onFrame?.(f, rec, game);
    },
    close() {},
  };
  oracle.run(movie, sink, { captureFb: (f) => f > 0 });
  res.portError = portError;
  res.portFrames = stepped;
  if (vppu) {
    // the port's k-th picture after the reset is the oracle's (video0 + k)-th video frame
    const v = { oracle: videoO.length, port: video0 + videoP.length, compared: 0, differing: 0, first: [] };
    for (let k = 0; k < videoP.length; k++) {
      const o = videoO[video0 + k];
      if (o === undefined) continue;
      v.compared++;
      if (o !== videoP[k]) { v.differing++; if (v.first.length < 20) v.first.push(video0 + k); }
    }
    if (!portError && v.oracle !== v.port) v.differing++; // a missing or extra picture is a difference too
    res.video = v;
  }
  if (tracker) {
    res.tracker = { nmis: tracker.stats.nmis, failures: tracker.stats.failures, crumbs: tracker.stats.crumbs,
      failureSites: [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `${n} x ${k}`) };
  }
  classify(res, info);
  delete res.fc;
  delete res.mode;
  return res;
}

/**
 * Classes of picture/RAM differences (docs/ORACLE.md, docs/TIMING.md §1). A class is only granted with
 * evidence from the oracle's own run:
 *  - nested-nmi:  the original ran two NMIs before the first RTI (FrameCounter +2 then +0): frame k may
 *                 differ in RAM and picture, frame k+1 in picture only.
 *  - lag:         RAM equal; the original NMI of this frame ended in a later video frame than it began
 *                 (longer than a video frame), so the picture shown after it is not the one the port draws.
 *  - split-63:    RAM equal; only row 63 differs (the playfield split line); mode 7 with the split writes
 *                 recorded on row 62-63 in this NMI, or mode 4 right after mode 7.
 *  - late-write:  RAM equal; the original NMI wrote a PPU register on a visible scanline (after rendering
 *                 began) and every differing row is above its first PPUMASK write there (or, without one,
 *                 at or above the last such write).
 *  - DEFECT:      anything else.
 */
function classify(res, info) {
  const fc = res.fc;
  const nested = new Set();
  for (let k = 1; k + 1 < fc.length; k++) {
    if (((fc[k] - fc[k - 1]) & 0xff) === 2 && fc[k + 1] === fc[k]) nested.add(k);
  }
  res.nestedFrames = [...nested];
  res.classes = { 'nested-nmi': 0, lag: 0, 'split-63': 0, 'late-write': 0, timing: 0, DEFECT: 0 };
  res.byClass = { 'nested-nmi': [], lag: [], 'split-63': [], 'late-write': [], timing: [], DEFECT: [] };
  for (const d of res.divergent) {
    const f = d.frame;
    const inf = info[f];
    const ramEq = d.ramCount === 0 && d.sramCount === 0;
    let cls = 'DEFECT';
    let why = '';
    if (nested.has(f) || (nested.has(f - 1) && ramEq)) {
      cls = 'nested-nmi';
      why = `FrameCounter ${fc[f - 1]}->${fc[f]}->${fc[f + 1]}`;
    } else if (ramEq && inf && inf.endVideo > inf.startVideo) {
      cls = 'lag';
      why = `NMI spans video frames ${inf.startVideo}-${inf.endVideo} (ends on scanline ${inf.endScan})`;
    } else if (ramEq && d.rows.length === 1 && d.rows[0] === 63
      && ((res.mode[f] === 7 && inf?.writes.some((w) => w.row >= 62 && w.row <= 63))
        || (res.mode[f] === 4 && res.mode[f - 1] === 7))) {
      cls = 'split-63';
      why = `mode ${res.mode[f]}` + (res.mode[f] === 4 ? ' after mode 7' : `, split writes ${inf.writes.filter((w) => w.row >= 62).map((w) => `$${w.reg.toString(16)}@${w.row}:${w.dot}`).join(' ')}`);
    } else if (ramEq && inf?.writes.length) {
      // with a visible PPUMASK write, every differing row must be above it (drawn before the write)
      const mask = inf.writes.filter((w) => w.reg === 0x2001);
      const last = mask.length ? mask[0].row : Math.max(...inf.writes.map((w) => w.row)) + 1;
      if (d.rows[d.rows.length - 1] <= last) {
        cls = 'late-write';
        why = `mode ${res.mode[f]}: rows ${d.rows[0]}-${d.rows[d.rows.length - 1]} <= ${mask.length ? 'PPUMASK write' : 'last visible write'} row ${last} ` +
          `(${inf.writes.filter((w) => w.reg === 0x2001 || w.reg === 0x2000).map((w) => `$${w.reg.toString(16)}=${w.val.toString(16)}@${w.row}`).slice(0, 6).join(' ')})`;
      }
    }
    // with the cycle tracker on, a picture-only difference outside the classes is a timing gap (a NMI
    // not yet annotated, docs/TIMING.md), not a logic defect
    if (cls === 'DEFECT' && ramEq && res.timing !== 'off') { cls = 'timing'; why = 'picture only (cycle tracker)'; }
    d.cls = cls;
    d.why = why;
    res.classes[cls]++;
    if (res.byClass[cls].length < 400) res.byClass[cls].push(cls === 'DEFECT' ? d : { frame: f, px: d.fbCount, rows: summarizeRows(d.rows), why });
  }
  res.defects = res.classes.DEFECT + (res.portError ? 1 : 0) + (res.portFrames < res.frames ? 1 : 0);
  delete res.divergent;
}

function summarizeRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    out.push(i === j ? `${rows[i]}` : `${rows[i]}-${rows[j]}`);
    i = j;
  }
  return out.join(',');
}

// ---------------------------------------------------------------------------------------------------
// Parallel driver

function child(args) {
  return new Promise((res) => {
    const pr = spawn(process.execPath, ['--no-warnings', '--max-old-space-size=4096', import.meta.filename, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    pr.stdout.on('data', (d) => { out += d; });
    pr.stderr.on('data', (d) => { err += d; });
    pr.on('close', (code) => res({ code, out: out.trim(), err: err.trim() }));
  });
}

async function pool(items, jobs, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

async function runMovies(args) {
  const dir = resolve(args.dir ?? MOVIES);
  let movies = args._.length ? args._.map((m) => (m.endsWith('.zmv') ? basename(m) : `${m}.zmv`))
    : readdirSync(dir).filter((f) => f.endsWith('.zmv'));
  const size = (m) => loadMovie(join(dir, m)).length;
  const sizes = Object.fromEntries(movies.map((m) => [m, size(m)]));
  movies = movies.sort((a, b) => sizes[b] - sizes[a]);
  const jobs = Number(args.jobs ?? Math.max(1, availableParallelism() - 1));
  mkdirSync(join(OUT, 'movies'), { recursive: true });
  const t0 = Date.now();
  const reports = [];
  await pool(movies, jobs, async (m) => {
    const json = join(OUT, 'movies', m.replace(/\.zmv$/, '.json'));
    const r = await child(['movie', join(dir, m), '--json', json, '--timing', String(args.timing ?? 'jsnes')]);
    if (r.code !== 0 && r.code !== 1) {
      console.log(`${m}: CRASH exit ${r.code}\n${r.err.slice(-2000)}`);
      reports.push({ movie: m.replace(/\.zmv$/, ''), crash: r.err.slice(-2000), defects: 1, frames: sizes[m], classes: {} });
      return;
    }
    const rep = JSON.parse(readFileSync(json, 'utf8'));
    reports.push(rep);
    console.log(line(rep));
  });
  reports.sort((a, b) => a.movie.localeCompare(b.movie));
  const tot = { movies: reports.length, frames: 0, compared: 0, fbCompared: 0, defects: 0, px: 0, pxFrames: 0, videoFrames: 0, videoDiff: 0, classes: {} };
  for (const r of reports) {
    tot.frames += r.frames; tot.compared += r.compared ?? 0; tot.fbCompared += r.fbCompared ?? 0; tot.defects += r.defects;
    tot.px += r.px ?? 0; tot.pxFrames += r.pxFrames ?? 0;
    tot.videoFrames += r.video?.compared ?? 0; tot.videoDiff += r.video?.differing ?? 0;
    for (const [k, v] of Object.entries(r.classes ?? {})) tot.classes[k] = (tot.classes[k] ?? 0) + v;
  }
  tot.seconds = Math.round((Date.now() - t0) / 1000);
  console.log('\n== totals', JSON.stringify(tot));
  console.log(`== picture: ${tot.pxFrames} differing frames, ${tot.px} px (goal: 0); `
    + `video frames: ${tot.videoDiff} differing of ${tot.videoFrames} (lag frames included; goal: 0)`);
  writeFileSync(join(OUT, 'movies-summary.json'), JSON.stringify({ totals: tot, reports }, null, 1));
  return tot.defects || (args['require-zero'] && (tot.px || tot.videoDiff)) ? 1 : 0;
}

function line(r) {
  const c = r.classes ?? {};
  return `${r.movie.padEnd(22)} frames ${String(r.frames).padStart(6)} cmp ${String(r.compared).padStart(6)} fb ${String(r.fbCompared).padStart(6)}  ` +
    `px ${String(r.px ?? '?').padStart(7)} in ${String(r.pxFrames ?? '?').padStart(5)} frames  ` +
    (r.video ? `video ${r.video.differing}/${r.video.compared}  ` : '') +
    `nested ${c['nested-nmi'] ?? 0} lag ${c.lag ?? 0} split63 ${c['split-63'] ?? 0} late ${c['late-write'] ?? 0} timing ${c.timing ?? 0}  DEFECT ${c.DEFECT ?? 0}` +
    (r.portError ? `  PORT ERROR f${r.portError.frame}: ${r.portError.error}` : '') +
    (r.DEFECT_first ? `  first defect f${r.DEFECT_first}` : '');
}

async function runOneMovie(args) {
  const path = resolve(args._[0]);
  const movie = loadMovie(path);
  const sramPath = args.sram ? resolve(args.sram) : sramFor(path);
  const sram = sramPath ? new Uint8Array(readFileSync(sramPath)) : null;
  const res = await lockstep({ movie, sram, name: basename(path, '.zmv'), timing: String(args.timing ?? 'jsnes') });
  res.sram = sramPath ? basename(sramPath) : null;
  res.DEFECT_first = res.byClass.DEFECT[0]?.frame ?? null;
  if (args.json) writeFileSync(resolve(args.json), JSON.stringify(res, null, 1));
  else console.log(line(res));
  return res.defects ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------
// Routine tests at high N

function routineFiles() {
  const dir = join(REPO_ROOT, 'tests/game');
  return readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && !/-oracle\.test|-integration\.test|-pure\.test/.test(f))
    .map((f) => {
      const src = readFileSync(join(dir, f), 'utf8');
      const reg = [...src.matchAll(/import '\.\/(p\d\d)-hybrid-register\.mjs'/g)].map((m) => m[1]);
      const hasReal = reg.some((p) => /_REAL/.test(readFileSync(join(dir, `${p}-hybrid-register.mjs`), 'utf8')));
      return { file: f, hasReal };
    });
}

async function runRoutines(args) {
  const n = String(args.n ?? 5000);
  const scale = String(args.scale ?? 150);
  const seeds = String(args.seeds ?? '0').split(',').map(Number);
  const jobs = Number(args.jobs ?? Math.max(1, availableParallelism() - 1));
  const only = args.only ? String(args.only).split(',') : null;
  const files = routineFiles().filter((f) => !only || only.some((o) => f.file.startsWith(o)));
  const env = { ...process.env, W3_N: n, WAVE4_N: n, ROUTINES_SCALE: scale };
  for (let p = 4; p <= 25; p++) env[`P${String(p).padStart(2, '0')}_N`] = n;
  const runs = [];
  for (const seed of seeds) {
    for (const f of files) {
      runs.push({ ...f, seed, real: false });
      if (f.hasReal && args.real !== 'no') runs.push({ ...f, seed, real: true });
    }
  }
  mkdirSync(join(OUT, 'routines'), { recursive: true });
  const results = [];
  const t0 = Date.now();
  await pool(runs, jobs, async (r) => {
    const e = { ...env, ROUTINES_SEED: String(r.seed) };
    if (r.real) for (let p = 1; p <= 25; p++) e[`P${String(p).padStart(2, '0')}_REAL`] = '1';
    const t = Date.now();
    const out = await new Promise((res) => {
      const pr = spawn(process.execPath, ['--test', '--test-reporter=tap', join('tests/game', r.file)], { cwd: REPO_ROOT, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      pr.stdout.on('data', (d) => { o += d; });
      pr.stderr.on('data', (d) => { o += d; });
      pr.on('close', (code) => res({ code, o }));
    });
    const tag = `${r.file.replace('.test.mjs', '')}${r.real ? '-real' : ''}-seed${r.seed}`;
    writeFileSync(join(OUT, 'routines', `${tag}.log`), out.o);
    const num = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out.o)?.[1] ?? NaN);
    const rr = { tag, code: out.code, tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), seconds: Math.round((Date.now() - t) / 1000) };
    results.push(rr);
    console.log(`${tag.padEnd(46)} ${rr.code === 0 ? 'ok  ' : 'FAIL'} tests ${rr.tests} pass ${rr.pass} fail ${rr.fail} skip ${rr.skipped} (${rr.seconds}s)`);
  });
  results.sort((a, b) => a.tag.localeCompare(b.tag));
  writeFileSync(join(OUT, `routines-summary-n${n}.json`), JSON.stringify({ n, scale, seeds, seconds: Math.round((Date.now() - t0) / 1000), results }, null, 1));
  const bad = results.filter((r) => r.code !== 0);
  console.log(`\n== ${results.length} runs, ${bad.length} failing${bad.length ? ': ' + bad.map((b) => b.tag).join(', ') : ''}`);
  return bad.length ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------
// Fuzz movies: a prefix of an existing movie (up to a chosen game state) + long semi-random play.

/** base movie, condition on the oracle RAM that ends the prefix, extra frames. */
export const FUZZ = {
  'fuzz-ow': { base: 'ow-tour', at: (r) => r[GameMode] === 5 && r[0x10] === 0, seed: 0xf001 },
  'fuzz-ow-items': { base: 'ow-enemies-tour', at: (r) => r[GameMode] === 5 && r[0x10] === 0, seed: 0xf002 },
  'fuzz-uw-level1': { base: 'uw-level1-full', at: (r) => r[GameMode] === 5 && r[0x10] === 1, seed: 0xf003 },
  'fuzz-uw-enemies-a': { base: 'uw-enemies-a', at: (r) => r[GameMode] === 5 && r[0x10] !== 0, seed: 0xf004 },
  'fuzz-uw-q2': { base: 'uw-enemies-b2', at: (r) => r[GameMode] === 5 && r[0x10] !== 0, seed: 0xf005 },
  'fuzz-boss-gleeok4': { base: 'boss-gleeok4', at: (r) => r[GameMode] === 5 && r[0x10] === 8 && r[0xeb] === 0x3c, seed: 0xf006 },
  'fuzz-boss-ganon': { base: 'boss-ganon', at: (r) => r[GameMode] === 5 && r[0x10] === 9 && r.subarray(0x350, 0x35b).includes(0x3e), seed: 0xf007 },
  'fuzz-boss-aquamentus': { base: 'boss-aquamentus', at: (r) => r[GameMode] === 5 && r[0x10] === 1 && r.subarray(0x350, 0x35b).includes(0x3d), seed: 0xf008 },
};

function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}

/** Semi-random play: held directions of random length, A/B taps, rare Start/Select (pause, menus). */
function fuzzInputs(seed, frames) {
  const rnd = xorshift(seed);
  const out = new Uint8Array(frames);
  const dirs = [0x01, 0x02, 0x04, 0x08, 0x01, 0x02, 0x04, 0x08, 0x09, 0x05, 0x0a, 0x06, 0];
  let i = 0;
  while (i < frames) {
    const k = rnd() % 1000;
    if (k < 8) { // Start: pause / submenu; held a few frames, then released for a while
      for (let j = 0; j < 3 && i < frames; j++) out[i++] = 0x10;
      const wait = 20 + (rnd() % 90);
      for (let j = 0; j < wait && i < frames; j++) out[i++] = (rnd() & 7) === 0 ? [0x01, 0x02, 0x04, 0x08][rnd() & 3] : 0;
      continue;
    }
    if (k < 12) { for (let j = 0; j < 2 && i < frames; j++) out[i++] = 0x20; continue; } // Select
    const dir = dirs[rnd() % dirs.length];
    const len = 1 + (rnd() % ((rnd() & 3) === 0 ? 120 : 30));
    const ab = rnd() % 6; // 0: tap A, 1: tap B, 2: mash A, 3: A+B, else none
    for (let j = 0; j < len && i < frames; j++) {
      let b = dir;
      if (ab === 0 && j === 0) b |= 0x80;
      if (ab === 1 && j === 0) b |= 0x40;
      if (ab === 2 && (j & 4) === 0) b |= 0x80;
      if (ab === 3 && (j & 2) === 0) b |= 0xc0;
      out[i++] = b;
    }
  }
  return out;
}

async function fuzzGen(args) {
  const frames = Number(args.frames ?? 24000);
  const rom = loadRomFile();
  for (const [name, spec] of Object.entries(FUZZ)) {
    if (args.only && !String(args.only).split(',').includes(name)) continue;
    const basePath = join(MOVIES, `${spec.base}.zmv`);
    const base = loadMovie(basePath);
    const sramPath = sramFor(basePath);
    const sram = sramPath ? new Uint8Array(readFileSync(sramPath)) : null;
    // find the prefix end in the oracle
    const o = await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 });
    let cut = null;
    o.run(base, { write(rec) { if (cut === null && rec.frame > 0 && spec.at(rec.ram)) cut = rec.frame; }, close() {} });
    if (cut === null) { console.log(`${name}: condition never met in ${spec.base}`); continue; }
    const p1 = new Uint8Array(cut + frames);
    p1.set(base.p1.subarray(0, cut));
    p1.set(fuzzInputs(spec.seed, frames), cut);
    const m = createMovie(p1, null, { name });
    const head = [
      `# Battery fuzz movie: ${spec.base}.zmv up to frame ${cut} (first frame of the chosen state),`,
      `# then ${frames} frames of semi-random play (seed 0x${spec.seed.toString(16)}): held directions, A/B taps,`,
      '# rare Start/Select. Generated by tools/oracle/battery.mjs fuzz-gen.',
    ].join('\n');
    const text = serializeZmv(m).replace(/^zmv 1\n/, `zmv 1\n${head}\n`);
    writeFileSync(join(MOVIES, `${name}.zmv`), text);
    // expect: the states actually visited (oracle), so zelda-rom-like checks have something to assert
    const modes = new Set(), levels = new Set();
    const o2 = await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 });
    o2.run(loadMovie(join(MOVIES, `${name}.zmv`)), { write(rec) { modes.add(rec.ram[GameMode]); levels.add(rec.ram[0x10]); }, close() {} });
    const expect = {
      ...(sramPath ? { sram: basename(sramPath) } : {}),
      comment: `Battery fuzz movie (tools/oracle/battery.mjs): ${spec.base} prefix to frame ${cut} + ${frames} semi-random frames.`,
      prefixEnd: cut,
      reaches: { GameMode: [...modes].sort((a, b) => a - b), CurLevel: [...levels].sort((a, b) => a - b) },
    };
    writeFileSync(join(MOVIES, `${name}.expect.json`), JSON.stringify(expect, null, 2) + '\n');
    console.log(`${name}: prefix ${cut} + ${frames}; modes ${expect.reaches.GameMode.map((x) => x.toString(16)).join(',')}; levels ${expect.reaches.CurLevel.join(',')}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------
// Boot from empty / corrupt SRAM

async function boot(args) {
  const rom = loadRomFile();
  const frames = Number(args.frames ?? 1500);
  // Title, Start -> menu, Start on slot 1 / register -> ... (a few menu moves); same inputs everywhere
  const p1 = new Uint8Array(frames);
  const press = (f, b, n = 2) => { for (let i = 0; i < n; i++) p1[f + i] = b; };
  press(130, 0x10); press(200, 0x20); press(230, 0x20); press(260, 0x20); press(290, 0x10);
  press(400, 0x80); press(430, 0x80); press(460, 0x20); press(490, 0x20); press(520, 0x10);
  press(700, 0x10); press(800, 0x10); press(900, 0x01, 40);
  const movie = createMovie(p1, null, { name: 'boot' });
  const sav = (f) => new Uint8Array(readFileSync(join(MOVIES, f)));
  const cases = [];
  cases.push(['empty (all $00)', null]);
  cases.push(['all $FF', new Uint8Array(0x2000).fill(0xff)]);
  const rnd = xorshift(0xb007);
  cases.push(['random garbage', Uint8Array.from({ length: 0x2000 }, () => rnd() & 0xff)]);
  // Player area $6000-$652F (Variables.inc): SaveRamBegin $6001 ($5A), open/close markers $651E/$6521
  // ($5A/$A5 per slot), FileAChecksums $6524 (2 bytes per slot), IsSaveFileBCommitted $652A; SaveRamEnd $7FFF.
  const edit = (s, fn) => { const c = Uint8Array.from(s); fn(c); return c; };
  for (const f of ['p22-items.sav', 'p08-items.sav', 'p19-items-q2.sav']) {
    const s = sav(f);
    cases.push([`${f} intact`, s]);
    cases.push([`${f} bad checksum slot 0 ($6524)`, edit(s, (c) => { c[0x524] ^= 0x01; })]);
    cases.push([`${f} bad checksum slot 2 ($6529)`, edit(s, (c) => { c[0x529] ^= 0x80; })]);
    cases.push([`${f} name byte flipped ($6002, checksum now bad)`, edit(s, (c) => { c[0x002] ^= 0x01; })]);
    cases.push([`${f} items scrambled (slot 0)`, edit(s, (c) => { for (let i = 0x1a; i < 0x42; i += 3) c[i] ^= 0x5a; })]);
    cases.push([`${f} open marker slot 1 broken ($651F)`, edit(s, (c) => { c[0x51f] = 0; })]);
    cases.push([`${f} close marker slot 0 broken ($6521)`, edit(s, (c) => { c[0x521] = 0x5a; })]);
    cases.push([`${f} SaveRamBegin broken ($6001)`, edit(s, (c) => { c[0x001] = 0x00; })]);
    cases.push([`${f} SaveRamEnd broken ($7FFF)`, edit(s, (c) => { c[0x1fff] = 0x00; })]);
    cases.push([`${f} file B uncommitted ($652A-$652C = 0)`, edit(s, (c) => { c[0x52a] = c[0x52b] = c[0x52c] = 0; })]);
  }
  const results = [];
  for (const [label, sram] of cases) {
    const modes = new Set();
    const res = await lockstep({ movie, sram, name: label, onFrame: (f, rec) => modes.add(rec.ram[GameMode]) });
    res.modes = [...modes].sort((a, b) => a - b).map((m) => m.toString(16));
    results.push(res);
    console.log(`${label.padEnd(58)} cmp ${res.compared} fb ${res.fbCompared} modes ${res.modes.join(',')} classes ${JSON.stringify(res.classes)}${res.portError ? ' PORT ERROR ' + res.portError.error : ''}`);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'boot.json'), JSON.stringify(results, null, 1));
  return results.some((r) => r.defects) ? 1 : 0;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest, { flags: ['require-zero'] });
  if (cmd === 'movies') return runMovies(args);
  if (cmd === 'movie') return runOneMovie(args);
  if (cmd === 'routines') return runRoutines(args);
  if (cmd === 'fuzz-gen') return fuzzGen(args);
  if (cmd === 'boot') return boot(args);
  console.error('usage: battery.mjs movies|movie|routines|fuzz-gen|boot ... (see the header)');
  return 2;
}

if (import.meta.main) runCli(main);
