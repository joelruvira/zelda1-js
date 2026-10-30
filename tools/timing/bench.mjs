#!/usr/bin/env node
// Cost of the cycle tracker (docs/TIMING.md §6): plays a movie in the headless port with timing off,
// jsnes and hardware, and reports ms per frame (logic + PPU rendering) and per-NMI tracker stats.
//
//   node tools/timing/bench.mjs [movie.zmv|name] [--frames N] [--modes off,jsnes,hardware]
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadRomFile, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { loadMovie } from '../oracle/lib/movie.mjs';
import { parseArgs, runCli } from '../oracle/lib/cli.mjs';
import { sramForMovie } from './measure-movie.mjs';

export async function main(argv) {
  const args = parseArgs(argv);
  const spec = args._[0] ?? 'walk-first-screens';
  const path = existsSync(spec) ? resolve(spec) : join(REPO_ROOT, 'tests/oracle/movies', spec.endsWith('.zmv') ? spec : `${spec}.zmv`);
  const movie = loadMovie(path);
  const n = Math.min(movie.length, Number(args.frames ?? movie.length));
  const sramPath = sramForMovie(path);
  const sram = sramPath && existsSync(sramPath) ? new Uint8Array(readFileSync(sramPath)) : null;
  const rom = loadRomFile();
  const { createGame } = await import('../../src/headless.js');
  for (const mode of String(args.modes ?? 'off,jsnes,hardware').split(',')) {
    for (let rep = 0; rep < 2; rep++) { // first run warms up the JIT
      const game = await createGame({ rom: rom.bytes, sram: sram ? Uint8Array.from(sram) : null, timing: mode });
      const t0 = performance.now();
      for (let f = 1; f <= n; f++) game.stepFrame(movie.p1[f - 1] ?? 0, movie.p2?.[f - 1] ?? 0);
      const ms = performance.now() - t0;
      if (rep === 1) {
        const st = game.timing?.stats;
        console.log(`${mode.padEnd(9)} ${n} frames: ${(ms / n).toFixed(3)} ms/frame` +
          (st ? `  (${(st.crumbs / st.nmis).toFixed(0)} breadcrumbs/NMI, ${st.failures} NMIs with a breadcrumb failure)` : ''));
      }
    }
  }
  return 0;
}

if (import.meta.main) runCli(main);
