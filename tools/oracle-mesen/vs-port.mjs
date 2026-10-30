#!/usr/bin/env node
// The port (src/headless.js, cycle tracker in 'hardware' mode by default) against Mesen2, frame by frame:
// RAM, SRAM and the WHOLE picture (rows 0-239: both draw row 0) on every frame, in lockstep with the
// Mesen stream (nothing is read from out/; Mesen runs fresh each time).
//
//   node tools/oracle-mesen/vs-port.mjs [movies...] [--timing hardware|jsnes|off] [--port module]
//        [--frames N] [--sram f.sav] [--png-dir d] [--png-per-class N] [--jobs J] [--require-zero]
//
// Movies: names in tests/oracle/movies or paths (default: the vs-jsnes validation set). Every differing
// frame gets a class hint from Mesen's own evidence (lib/classify.mjs: nested NMI, lag, split line,
// visible PPU writes with Mesen's raster position). Reports: out/oracle-mesen/vs-port/<movie>.json and
// summary.json. Exit 1 if RAM/SRAM differ in any frame (or, with --require-zero, if any pixel differs).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { getPalette, canonicalizeIndices, FB_SIZE } from '../oracle/lib/palette.mjs';
import { parseArgs } from '../oracle/lib/cli.mjs';
import { diffImageRgb } from '../oracle/lib/diff-core.mjs';
import { encodePng } from '../oracle/lib/png.mjs';
import { loadPort, validateGame, DEFAULT_PORT_MODULE } from '../oracle/lib/port-adapter.mjs';
import { runMesen } from './lib/mesen.mjs';
import { classify, CLASSES } from './lib/classify.mjs';
import { loadMovieArg, sramForMovie, runCli, ramDiffs, sramDiffs, fbDiff, summarizeRows, hex } from './lib/common.mjs';
import { VALIDATION_SET, moviePath } from './vs-jsnes.mjs';

const OUT = join(REPO_ROOT, 'out/oracle-mesen/vs-port');
const GameMode = 0x12;

export async function comparePortMesen(spec, { frames, timing = 'hardware', modulePath = DEFAULT_PORT_MODULE, pngDir = null, pngPerClass = 3, sramFile } = {}) {
  const movie = loadMovieArg(spec, frames);
  const rom = loadRomFile(DEFAULT_ROM_PATH);
  const { sram, sramPath } = sramForMovie(spec, sramFile);
  const palette = await getPalette();
  const mod = await loadPort(modulePath);
  const inputFor = (n) => [movie.p1[n - 1] ?? 0, movie.p2?.[n - 1] ?? 0];
  const game = await mod.createGame({ rom: rom.bytes, sram: sram ? Uint8Array.from(sram) : null, powerOnFill: 0, timing, inputFor });
  validateGame(game);
  const pfb = new Uint8Array(FB_SIZE);
  const portFb = () => {
    const raw = typeof game.renderFrame === 'function' ? game.renderFrame() : game.framebuffer;
    return raw ? canonicalizeIndices(raw, palette, pfb) : null;
  };
  const rep = {
    movie: movie.name, frames: movie.length, sram: sramPath, timing, port: modulePath, compared: 0, fbCompared: 0,
    ramFrames: 0, firstRam: null, firstPicture: null, pxFrames: 0, px: 0,
    classes: Object.fromEntries(CLASSES.map((c) => [c, 0])), classPx: Object.fromEntries(CLASSES.map((c) => [c, 0])),
    examples: Object.fromEntries(CLASSES.map((c) => [c, []])), portError: null,
  };
  const pngCount = {};
  let prevM = null;
  const t0 = performance.now();
  for await (const m of runMesen({ rom: rom.bytes, romPath: DEFAULT_ROM_PATH, movie, sram, powerOnFill: 0, captureFb: (f) => f > 0 })) {
    const f = m.frame;
    if (rep.portError) continue; // drain the stream
    if (f > 0) {
      try {
        if (movie.timing === 'nmi') game.stepFrame(movie.p1[f - 1] ?? 0, movie.p2?.[f - 1] ?? 0);
        else game.stepFrame(m.p1, m.p2);
      } catch (e) {
        rep.portError = { frame: f, error: String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ') };
        continue;
      }
    }
    rep.compared++;
    const r = ramDiffs(m.ram, game.ram);
    const s = sramDiffs(m.sram, game.sram);
    const mfb = m.fb ? canonicalizeIndices(m.fb, palette) : null;
    const p = f > 0 && mfb ? portFb() : null;
    let fd = { count: 0, rows: [] };
    if (mfb && p) { fd = fbDiff(mfb, p, 0); rep.fbCompared++; }
    if (r.length || s.length) { rep.ramFrames++; rep.firstRam ??= f; }
    if (r.length || s.length || fd.count) {
      const d = { frame: f, ramCount: r.length, sramCount: s.length, rows: fd.rows, count: fd.count };
      const { cls, why } = classify(d, { mesen: m, mesenPrev: prevM, other: null, otherPrev: null, fbA: mfb, fbB: p,
        writes: null, mask2001: [], mode: m.ram[GameMode], prevMode: prevM?.ram[GameMode], otherName: 'port' });
      rep.classes[cls]++;
      rep.classPx[cls] += fd.count;
      if (fd.count) { rep.pxFrames++; rep.px += fd.count; rep.firstPicture ??= f; }
      if (rep.examples[cls].length < 40) {
        rep.examples[cls].push({ frame: f, mode: hex(m.ram[GameMode]), px: fd.count, rows: summarizeRows(fd.rows), why,
          mesenWrites: m.writes.slice(0, 8).map((w) => `$${w.reg.toString(16)}=${w.val.toString(16)}@${w.row}:${w.dot}`).join(' '),
          ...(r.length || s.length ? { ram: [...r, ...s].slice(0, 16).map((a) => `${hex(a, 4)} mesen=${hex(a < 0x800 ? m.ram[a] : m.sram[a - 0x6000])} port=${hex(a < 0x800 ? game.ram[a] : game.sram[a - 0x6000])}`) } : {}) });
      }
      if (pngDir && fd.count && (pngCount[cls] = (pngCount[cls] ?? 0) + 1) <= pngPerClass) {
        mkdirSync(pngDir, { recursive: true });
        const img = diffImageRgb(mfb, p, palette, { ignoreRow0: false });
        writeFileSync(join(pngDir, `${movie.name}_${String(f).padStart(6, '0')}_${cls}.png`), encodePng(img.width, img.height, img.rgb));
      }
    }
    prevM = m;
  }
  rep.seconds = Math.round((performance.now() - t0) / 100) / 10;
  rep.ok = rep.ramFrames === 0 && !rep.portError && rep.compared === movie.length + 1;
  return rep;
}

function line(r) {
  const c = Object.entries(r.classes).filter(([, v]) => v).map(([k, v]) => `${k} ${v} (${r.classPx[k]} px)`).join(', ');
  return `${r.movie.padEnd(20)} frames ${String(r.frames).padStart(6)} cmp ${r.compared} fb ${r.fbCompared}  RAM-diff frames ${r.ramFrames}` +
    (r.firstRam !== null ? ` (first ${r.firstRam})` : '') + `  picture-diff frames ${r.pxFrames} (${r.px} px)` +
    (r.firstPicture !== null ? ` first ${r.firstPicture}` : '') +
    (r.portError ? `\n    PORT ERROR f${r.portError.frame}: ${r.portError.error}` : '') + (c ? `\n    ${c}` : '');
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
  const args = parseArgs(argv, { flags: ['single', 'require-zero'] });
  const movies = args._.length ? args._ : VALIDATION_SET;
  mkdirSync(OUT, { recursive: true });
  const opts = {
    frames: args.frames, timing: String(args.timing ?? 'hardware'), modulePath: args.port ? resolve(args.port) : DEFAULT_PORT_MODULE,
    pngDir: args['png-dir'] ? resolve(args['png-dir']) : null, pngPerClass: Number(args['png-per-class'] ?? 3), sramFile: args.sram,
  };
  const failed = (rep) => !rep.ok || (args['require-zero'] && rep.px > 0);
  if (args.single || movies.length === 1) {
    const rep = await comparePortMesen(moviePath(movies[0]), opts);
    writeFileSync(join(OUT, `${rep.movie}.json`), JSON.stringify(rep, null, 1));
    console.log(line(rep));
    return failed(rep) ? 1 : 0;
  }
  const queue = [...movies];
  const reports = [];
  let fail = 0;
  await Promise.all(Array.from({ length: Math.min(Number(args.jobs ?? 3), queue.length) }, async () => {
    while (queue.length) {
      const m = queue.shift();
      const extra = [];
      for (const k of ['frames', 'timing', 'port', 'png-dir', 'png-per-class', 'sram']) if (args[k] !== undefined) extra.push(`--${k}`, String(args[k]));
      if (args['require-zero']) extra.push('--require-zero');
      const r = await child([moviePath(m), '--single', ...extra]);
      const name = basename(m).replace(/\.zmv$/, '');
      const json = join(OUT, `${name}.json`);
      if (r.code > 1 || !existsSync(json)) { console.log(`${name}: ERROR exit ${r.code}\n${(r.err || r.out).slice(-3000)}`); fail++; continue; }
      const rep = JSON.parse(readFileSync(json, 'utf8'));
      reports.push(rep);
      if (failed(rep)) fail++;
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
