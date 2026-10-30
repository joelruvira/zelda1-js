#!/usr/bin/env node
// Runs the original ROM in Mesen2 (headless) with an input movie and writes a .ztrace with the same
// format and frame definition as tools/oracle/run-oracle.mjs (diff.mjs / trace-info.mjs read it as is).
//
// Usage: node tools/oracle-mesen/run.mjs <movie.zmv|.json|.fm2|idle:N> [options]
//   --rom <path>        ROM file (default roms/zelda.nes)
//   --out <dir>         output directory (default out/oracle-mesen/<movie name>)
//   --frames <N>        play only the first N frames
//   --png <sel>         frames with framebuffer + PNG (same syntax as run-oracle; default: last)
//   --sram <file>       initial 8KB SRAM (default: the movie's .expect.json "sram", else all zero)
//   --power-on <hex>    power-on RAM fill byte (default 00, as the jsnes oracle)
//   --quiet
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TraceWriter } from '../oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { getPalette, canonicalizeIndices } from '../oracle/lib/palette.mjs';
import { parseArgs, parseFrameSelection, parsePowerOn, pngWritingSink } from '../oracle/lib/cli.mjs';
import { runMesen } from './lib/mesen.mjs';
import { loadMovieArg, sramForMovie, runCli } from './lib/common.mjs';

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet'] });
  if (!args._[0]) {
    console.error('usage: run.mjs <movie|idle:N> [--rom f] [--out dir] [--frames N] [--png sel] [--sram f] [--power-on hex]');
    return 2;
  }
  const movie = loadMovieArg(args._[0], args.frames);
  const romPath = args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH;
  const rom = loadRomFile(romPath);
  const { sram, sramPath } = sramForMovie(args._[0], args.sram);
  const powerOnFill = parsePowerOn(args['power-on']);
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/oracle-mesen', movie.name));
  mkdirSync(outDir, { recursive: true });
  const captureFb = parseFrameSelection(args.png ?? 'last', movie.length);
  const palette = await getPalette();
  const tracePath = join(outDir, 'trace.ztrace');
  const writer = new TraceWriter(tracePath, {
    source: 'oracle', emulator: 'mesen2-2.1.1', romSha1: rom.info.sha1, movie: movie.name, timing: movie.timing,
    frames: movie.length, powerOnFill, sram: sramPath,
  });
  const sink = pngWritingSink(writer, outDir, palette);
  const t0 = performance.now();
  let lag = 0, nested = 0, last = null, n = 0;
  try {
    for await (const rec of runMesen({ rom: rom.bytes, romPath, movie, sram, powerOnFill, captureFb })) {
      if (rec.fb) rec.fb = canonicalizeIndices(rec.fb, palette);
      if (rec.rtiVideo > rec.nmiVideo) lag++;
      if (rec.nmis > 1) nested++;
      sink.write(rec);
      last = rec;
      n++;
    }
  } finally {
    sink.close();
  }
  if (!args.quiet) {
    const s = (performance.now() - t0) / 1000;
    console.log(`trace: ${tracePath}`);
    console.log(`frames: ${n - 1} logical (+ frame 0), ${last?.rtiVideo ?? 0} video, ${lag} NMIs longer than a video frame, ` +
      `${nested} nested NMIs, ${s.toFixed(1)}s (${(n / s).toFixed(0)} fps)`);
  }
  return 0;
}

if (import.meta.main) runCli(main);
