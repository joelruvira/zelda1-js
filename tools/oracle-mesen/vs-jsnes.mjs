#!/usr/bin/env node
// Validation of the two oracles against each other: Mesen2 (hardware-accurate) and jsnes (the CI oracle)
// play the same movie in lockstep; RAM, SRAM and the whole picture (rows 1-239) are compared on every
// frame and every difference is classified (lib/classify.mjs).
//
//   node tools/oracle-mesen/vs-jsnes.mjs [movies...] [--jobs J] [--png-dir d] [--png-per-class N] [--frames N]
//
// Movies: names in tests/oracle/movies or paths (default: the validation set below). The initial SRAM is
// the movie's .expect.json "sram" (as battery.mjs). Reports: out/oracle-mesen/vs-jsnes/<movie>.json and
// summary.json. Exit 1 if RAM/SRAM differ in any frame.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { getPalette, canonicalizeIndices } from '../oracle/lib/palette.mjs';
import { parseArgs } from '../oracle/lib/cli.mjs';
import { diffImageRgb } from '../oracle/lib/diff-core.mjs';
import { encodePng } from '../oracle/lib/png.mjs';
import { runMesen } from './lib/mesen.mjs';
import { JsnesStepper } from './lib/jsnes-stepper.mjs';
import { classify, CLASSES } from './lib/classify.mjs';
import { loadMovieArg, sramForMovie, runCli, ramDiffs, sramDiffs, fbDiff, summarizeRows, hex } from './lib/common.mjs';

export const VALIDATION_SET = ['power-on-600', 'title-start', 'walk-first-screens', 'uw-level1-full', 'boss-gleeok4'];
const MOVIES = join(REPO_ROOT, 'tests/oracle/movies');
const OUT = join(REPO_ROOT, 'out/oracle-mesen/vs-jsnes');
const GameMode = 0x12;

export function moviePath(m) {
  if (m.startsWith('idle:') || existsSync(m)) return m;
  return join(MOVIES, m.endsWith('.zmv') ? m : `${m}.zmv`);
}

/** Lockstep of one movie. Returns the report. */
export async function compareMesenJsnes(spec, { frames, pngDir = null, pngPerClass = 3, sramFile } = {}) {
  const movie = loadMovieArg(spec, frames);
  const rom = loadRomFile(DEFAULT_ROM_PATH);
  const { sram, sramPath } = sramForMovie(spec, sramFile);
  const palette = await getPalette();
  const js = await JsnesStepper.create({ rom: rom.bytes, sram, powerOnFill: 0, movie });
  const rep = {
    movie: movie.name, frames: movie.length, sram: sramPath, compared: 0, fbCompared: 0, noFbMesen: 0, noFbJsnes: 0,
    ramFrames: 0, pxFrames: 0, px: 0, classes: Object.fromEntries(CLASSES.map((c) => [c, 0])),
    classPx: Object.fromEntries(CLASSES.map((c) => [c, 0])), examples: Object.fromEntries(CLASSES.map((c) => [c, []])),
    lag: { mesen: 0, jsnes: 0 }, nested: { mesen: [], jsnes: [] }, nmiScan: {}, rtiVideoDelta: null,
  };
  const pngCount = {};
  let prevM = null, prevJ = null;
  const t0 = performance.now();
  for await (const m of runMesen({ rom: rom.bytes, romPath: DEFAULT_ROM_PATH, movie, sram, powerOnFill: 0, captureFb: (f) => f >= 0 })) {
    const j = js.next();
    if (!j || j.frame !== m.frame) throw new Error(`frame mismatch: mesen ${m.frame}, jsnes ${j?.frame}`);
    const f = m.frame;
    rep.compared++;
    if (m.rtiVideo > m.nmiVideo) rep.lag.mesen++;
    if (j.info && j.info.endVideo > j.info.startVideo) rep.lag.jsnes++;
    if (m.nmis > 1 && rep.nested.mesen.length < 100) rep.nested.mesen.push(f);
    if (j.info?.nmis > 1 && rep.nested.jsnes.length < 100) rep.nested.jsnes.push(f);
    if (f > 0) rep.nmiScan[m.nmiScan] = (rep.nmiScan[m.nmiScan] ?? 0) + 1;
    const r = ramDiffs(j.ram, m.ram);
    const s = sramDiffs(j.sram, m.sram);
    const mfb = m.fb ? canonicalizeIndices(m.fb, palette) : null;
    if (!mfb) rep.noFbMesen++;
    if (!j.fb) rep.noFbJsnes++;
    let fd = { count: 0, rows: [] };
    if (mfb && j.fb) { fd = fbDiff(j.fb, mfb); rep.fbCompared++; }
    if (r.length || s.length) rep.ramFrames++;
    if (r.length || s.length || fd.count) {
      const d = { frame: f, ramCount: r.length, sramCount: s.length, rows: fd.rows, count: fd.count };
      const mask2001 = [...(j.info?.writes ?? []), ...(prevJ?.info?.writes ?? [])].filter((w) => w.reg === 0x2001).map((w) => w.val);
      const { cls, why } = classify(d, { mesen: m, mesenPrev: prevM, other: j, otherPrev: prevJ, fbA: j.fb, fbB: mfb, writes: j.info?.writes, mask2001,
        mode: m.ram[GameMode], prevMode: prevM?.ram[GameMode], otherName: 'jsnes' });
      rep.classes[cls]++;
      rep.classPx[cls] += fd.count;
      if (fd.count) { rep.pxFrames++; rep.px += fd.count; }
      if (rep.examples[cls].length < 40) {
        rep.examples[cls].push({ frame: f, mode: hex(m.ram[GameMode]), px: fd.count, rows: summarizeRows(fd.rows), why,
          ...(r.length || s.length ? { ram: [...r, ...s].slice(0, 16).map((a) => `${hex(a, 4)} jsnes=${hex(a < 0x800 ? j.ram[a] : j.sram[a - 0x6000])} mesen=${hex(a < 0x800 ? m.ram[a] : m.sram[a - 0x6000])}`) } : {}) });
      }
      if (pngDir && fd.count && (pngCount[cls] = (pngCount[cls] ?? 0) + 1) <= pngPerClass) {
        mkdirSync(pngDir, { recursive: true });
        const img = diffImageRgb(j.fb, mfb, palette, { ignoreRow0: true });
        writeFileSync(join(pngDir, `${movie.name}_${String(f).padStart(6, '0')}_${cls}.png`), encodePng(img.width, img.height, img.rgb));
      }
    }
    prevM = m;
    prevJ = j;
  }
  rep.seconds = Math.round((performance.now() - t0) / 100) / 10;
  rep.ok = rep.ramFrames === 0 && rep.compared === movie.length + 1;
  return rep;
}

function line(r) {
  const c = Object.entries(r.classes).filter(([, v]) => v).map(([k, v]) => `${k} ${v} (${r.classPx[k]} px)`).join(', ');
  return `${r.movie.padEnd(20)} frames ${String(r.frames).padStart(6)} cmp ${r.compared} fb ${r.fbCompared}  RAM-diff frames ${r.ramFrames}  ` +
    `picture-diff frames ${r.pxFrames} (${r.px} px)  lag m/j ${r.lag.mesen}/${r.lag.jsnes} nested m/j ${r.nested.mesen.length}/${r.nested.jsnes.length}` +
    (c ? `\n    ${c}` : '');
}

function child(args) {
  return new Promise((res) => {
    const pr = spawn(process.execPath, ['--no-warnings', '--max-old-space-size=4096', import.meta.filename, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    pr.stdout.on('data', (d) => { out += d; });
    pr.stderr.on('data', (d) => { err += d; });
    pr.on('close', (code) => res({ code, out, err }));
  });
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['single'] });
  const movies = args._.length ? args._ : VALIDATION_SET;
  mkdirSync(OUT, { recursive: true });
  const opts = { frames: args.frames, pngDir: args['png-dir'] ? resolve(args['png-dir']) : null, pngPerClass: Number(args['png-per-class'] ?? 3), sramFile: args.sram };
  if (args.single || movies.length === 1) {
    const spec = moviePath(movies[0]);
    const rep = await compareMesenJsnes(spec, opts);
    writeFileSync(join(OUT, `${rep.movie}.json`), JSON.stringify(rep, null, 1));
    console.log(line(rep));
    return rep.ok ? 0 : 1;
  }
  const jobs = Number(args.jobs ?? 3);
  const queue = [...movies];
  const reports = [];
  let fail = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) {
      const m = queue.shift();
      const extra = [];
      for (const k of ['frames', 'png-dir', 'png-per-class', 'sram']) if (args[k] !== undefined) extra.push(`--${k}`, String(args[k]));
      const r = await child([moviePath(m), '--single', ...extra]);
      const name = basename(m).replace(/\.zmv$/, '');
      const json = join(OUT, `${name.startsWith('idle:') ? `idle-${name.slice(5)}` : name}.json`);
      if (r.code > 1 || !existsSync(json)) { console.log(`${name}: ERROR exit ${r.code}\n${r.err.slice(-3000)}`); fail++; continue; }
      const rep = JSON.parse(readFileSync(json, 'utf8'));
      reports.push(rep);
      if (!rep.ok) fail++;
      console.log(line(rep));
    }
  }));
  const tot = { movies: reports.length, frames: 0, ramFrames: 0, pxFrames: 0, px: 0, classes: {}, classPx: {} };
  for (const r of reports) {
    tot.frames += r.frames; tot.ramFrames += r.ramFrames; tot.pxFrames += r.pxFrames; tot.px += r.px;
    for (const k of CLASSES) { tot.classes[k] = (tot.classes[k] ?? 0) + r.classes[k]; tot.classPx[k] = (tot.classPx[k] ?? 0) + r.classPx[k]; }
  }
  console.log(`== totals ${JSON.stringify(tot)}`);
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ totals: tot, reports }, null, 1));
  return fail ? 1 : 0;
}

if (import.meta.main) runCli(main);
