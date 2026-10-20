#!/usr/bin/env node
// Runs the port's headless runner (src/headless.js) with the same inputs as the oracle
// and writes a trace in the same format.
//
// Usage: node tools/oracle/run-port.mjs (<movie|idle:N> | --inputs-from <oracle.ztrace>) [options]
//   --inputs-from <trace>  replay the exact per-frame inputs recorded by the oracle (recommended;
//                          required for .fm2 movies). PNG frames default to the oracle's.
//   --port <module>        headless runner module (default src/headless.js)
//   --rom <path>           ROM file (default roms/zelda.nes)
//   --out <dir>            output directory (default out/port/<name>)
//   --png <sel>            frames to capture (see run-oracle.mjs)
//   --sram <file>          initial SRAM; --power-on <hex> power-on RAM fill (default 00)
import { mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { TraceWriter, readTrace } from './lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from './lib/rom-file.mjs';
import { runPort, inputsFromTrace, DEFAULT_PORT_MODULE } from './lib/port-adapter.mjs';
import { getPalette } from './lib/palette.mjs';
import {
  parseArgs, resolveMovie, parseFrameSelection, parsePowerOn, readOptionalSram, pngWritingSink, runCli,
} from './lib/cli.mjs';

export async function main(argv) {
  const args = parseArgs(argv);
  let inputs, name, captureFb, powerOnFill = parsePowerOn(args['power-on']);
  let sramPath = args.sram;
  if (args['inputs-from']) {
    const ref = readTrace(resolve(args['inputs-from']));
    inputs = inputsFromTrace(ref);
    name = ref.meta.movie ?? basename(dirname(resolve(args['inputs-from'])));
    const fbFrames = new Set(ref.frames.filter((f) => f.fb).map((f) => f.frame));
    captureFb = args.png ? parseFrameSelection(args.png, inputs.length) : (f) => fbFrames.has(f);
    if (args['power-on'] === undefined && ref.meta.powerOnFill !== undefined) powerOnFill = ref.meta.powerOnFill;
    sramPath ??= ref.meta.sram ?? undefined;
  } else if (args._[0]) {
    inputs = resolveMovie(args._[0]);
    if (inputs.timing !== 'nmi') {
      throw new Error('movie uses video timing (fm2): run the oracle first and pass --inputs-from <trace>');
    }
    name = inputs.name;
    captureFb = parseFrameSelection(args.png ?? 'last', inputs.length);
  } else {
    console.error('usage: run-port.mjs (<movie|idle:N> | --inputs-from trace) [--port m] [--out dir]');
    return 2;
  }
  if (powerOnFill === 'jsnes') throw new Error('--power-on jsnes cannot be reproduced by the port; use a hex byte');
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/port', name));
  mkdirSync(outDir, { recursive: true });
  const modulePath = args.port ? resolve(args.port) : DEFAULT_PORT_MODULE;
  const tracePath = join(outDir, 'trace.ztrace');
  const writer = new TraceWriter(tracePath, {
    source: 'port', module: modulePath, romSha1: rom.info.sha1, movie: name, timing: 'nmi',
    frames: inputs.length, powerOnFill, sram: sramPath ?? null,
  });
  const sink = pngWritingSink(writer, outDir, await getPalette());
  try {
    await runPort({
      modulePath, rom: rom.bytes, sram: readOptionalSram(sramPath), powerOnFill, inputs, sink, captureFb,
    });
  } finally {
    sink.close();
  }
  console.log(`trace: ${tracePath} (${writer.count} records)`);
  return 0;
}

if (import.meta.main) runCli(main);
