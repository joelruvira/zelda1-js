#!/usr/bin/env node
// Runs the original ROM in jsnes with an input movie and writes a per-frame trace.
//
// Usage: node tools/oracle/run-oracle.mjs <movie.zmv|.json|.fm2|idle:N> [options]
//   --rom <path>        ROM file (default roms/zelda.nes)
//   --out <dir>         output directory (default out/oracle/<movie name>)
//   --frames <N>        play only the first N frames (pads with no input if longer)
//   --png <sel>         frames to capture as PNG + framebuffer in the trace:
//                       "0,60,600" | "every:60" | "10-20" | "last" | "all" (default: last)
//   --sram <file>       initial 8KB SRAM (.sav); default all zero (no saves)
//   --power-on <hex>    power-on RAM fill byte (default 00) or "jsnes" for jsnes' pattern
//   --quiet             no summary
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from './lib/nes-oracle.mjs';
import { TraceWriter } from './lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from './lib/rom-file.mjs';
import { createMovie } from './lib/movie.mjs';
import { getPalette } from './lib/palette.mjs';
import {
  parseArgs, resolveMovie, parseFrameSelection, parsePowerOn, readOptionalSram, pngWritingSink, runCli,
} from './lib/cli.mjs';

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet'] });
  if (!args._[0]) {
    console.error('usage: run-oracle.mjs <movie|idle:N> [--rom f] [--out dir] [--frames N] [--png sel]');
    return 2;
  }
  let movie = resolveMovie(args._[0]);
  if (args.frames !== undefined) {
    const n = Number(args.frames);
    const p1 = new Uint8Array(n), p2 = new Uint8Array(n);
    p1.set(movie.p1.subarray(0, n));
    p2.set(movie.p2.subarray(0, n));
    movie = createMovie(p1, p2, { timing: movie.timing, name: movie.name, meta: movie.meta });
  }
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  for (const w of rom.info.warnings) console.warn(`warning: ${w}`);
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/oracle', movie.name));
  mkdirSync(outDir, { recursive: true });
  const powerOnFill = parsePowerOn(args['power-on']);
  const sram = readOptionalSram(args.sram);
  const captureFb = parseFrameSelection(args.png ?? 'last', movie.length);

  const oracle = await Oracle.create({ rom: rom.bytes, sram, powerOnFill });
  const tracePath = join(outDir, 'trace.ztrace');
  const writer = new TraceWriter(tracePath, {
    source: 'oracle',
    emulator: 'jsnes',
    romSha1: rom.info.sha1,
    movie: movie.name,
    timing: movie.timing,
    frames: movie.length,
    powerOnFill,
    sram: args.sram ?? null,
  });
  let lag = 0, lastVideo = null;
  const sink = pngWritingSink({
    write(rec) {
      if (lastVideo !== null && rec.videoFrame - lastVideo > 1) lag += rec.videoFrame - lastVideo - 1;
      lastVideo = rec.videoFrame;
      writer.write(rec);
    },
    close: () => writer.close(),
  }, outDir, await getPalette());
  const t0 = performance.now();
  try {
    oracle.run(movie, sink, { captureFb });
  } finally {
    sink.close();
  }
  if (!args.quiet) {
    const ms = performance.now() - t0;
    console.log(`trace: ${tracePath}`);
    console.log(`frames: ${writer.count - 1} logical (+ frame 0), ${oracle.videoFrames} video, ` +
      `${lag} lag, ${(ms / 1000).toFixed(2)}s (${((writer.count / ms) * 1000).toFixed(0)} fps)`);
    console.log(`rom sha1: ${rom.info.sha1}`);
  }
  return 0;
}

if (import.meta.main) runCli(main);
