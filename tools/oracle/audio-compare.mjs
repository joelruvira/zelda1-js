#!/usr/bin/env node
// Compares the ported sound driver (src/game/audio, package P02) with the original.
//
// Usage: node tools/oracle/audio-compare.mjs <movie|idle:N> [--sweep] [--mode call|frame|both] [--verbose]
//   --mode call  (default) for every DriveAudio call of the original: load the RAM it had on entry
//                into the port, run the ported DriveAudio with the same X, and compare the whole
//                2 KB of RAM after the call and the exact sequence of $4000-$4017 writes.
//   --mode frame run the full port (src/headless.js) with the movie and compare the APU writes of
//                every logical frame (needs IsrNmi/IsrReset ported: P01).
//   --sweep      after the movie (default register-name: Link standing in the first screen),
//                inject requests for every song, tune, effect and sample (and pauses) at
//                DriveAudio entry; the movie is padded with idle frames to cover the schedule.
//   --songFrames N frames per song in --sweep (default: long enough for looping songs to wrap).
// Exit code 0 = identical, 1 = divergence.
import { resolve, join } from 'node:path';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from './lib/rom-file.mjs';
import { parseArgs, resolveMovie, runCli } from './lib/cli.mjs';
import { idleMovie } from './lib/movie.mjs';
import { loadVarNames, hex } from './lib/var-names.mjs';
import { runAudioOracle, fullSweepSchedule, fmtWrite } from './lib/audio-oracle.mjs';

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['sweep', 'verbose', 'quiet'] });
  const spec = args._[0] ?? (args.sweep ? join(REPO_ROOT, 'tests/oracle/movies/register-name.zmv') : null);
  if (!spec) {
    console.error('usage: audio-compare.mjs <movie|idle:N> [--sweep] [--mode call|frame|both]');
    return 2;
  }
  const mode = args.mode ?? 'call';
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  let movie = resolveMovie(spec);
  let pokes = new Map();
  if (args.sweep) {
    const sched = fullSweepSchedule({
      start: movie.length + 20, songFrames: args.songFrames ? Number(args.songFrames) : undefined,
    });
    pokes = sched.pokes;
    if (movie.length < sched.frames) {
      const pad = idleMovie(sched.frames - movie.length);
      movie = { ...movie, p1: [...movie.p1, ...pad.p1], p2: [...movie.p2, ...pad.p2], length: sched.frames };
    }
  }

  const { loadSymbols, label, loadRom } = await import('../../src/core/rom.js');
  await loadSymbols();
  const driveAudioAddr = label('DriveAudio').addr;
  const names = await loadVarNames();
  const t0 = Date.now();
  const { calls, frameWrites } = await runAudioOracle({ rom: rom.bytes, movie, driveAudioAddr, pokes });
  if (!args.quiet) console.log(`oracle: ${calls.length} DriveAudio calls, ${frameWrites.length} frames (${Date.now() - t0} ms)`);

  let failed = 0;
  if (mode === 'call' || mode === 'both') failed += await compareCalls(calls, rom.bytes, { loadRom, names, verbose: args.verbose, quiet: args.quiet });
  if (mode === 'frame' || mode === 'both') failed += await compareFrames(frameWrites, rom.bytes, movie, { verbose: args.verbose, quiet: args.quiet });
  return failed ? 1 : 0;
}

/** Per-call comparison (independent of the rest of the port). */
export async function compareCalls(calls, romBytes, { loadRom, names, verbose = false, quiet = false, maxReports = 5 } = {}) {
  const { createMachine } = await import('../../src/core/machine.js');
  const { switchBank } = await import('../../src/core/asm.js');
  const { DriveAudio } = await import('../../src/game/audio/driver.js');
  const machine = createMachine(loadRom(romBytes));
  const writes = [];
  machine.bus.apuWrite = (addr, value) => writes.push((addr << 8) | value);
  let bad = 0;
  for (const c of calls) {
    machine.ram.set(c.pre);
    switchBank(0);
    writes.length = 0;
    DriveAudio(c.x);
    const ramDiff = [];
    for (let a = 0; a < 0x800; a++) {
      if (a >= 0x100 && a < 0x200) continue; // stack (the port does not use it)
      if (machine.ram[a] !== c.post[a]) ramDiff.push(a);
    }
    const wDiff = writes.length !== c.writes.length || writes.some((w, i) => w !== c.writes[i]);
    if (ramDiff.length || wDiff) {
      bad++;
      if (bad <= maxReports || verbose) {
        console.log(`call ${c.index} (NMI ${c.frame}, X=$${c.x.toString(16)}): DIFF`);
        for (const a of ramDiff.slice(0, 12)) {
          console.log(`  ${hex(a)} ${names?.name(a) ?? ''}: pre ${hex(c.pre[a], 2)} oracle ${hex(c.post[a], 2)} port ${hex(machine.ram[a], 2)}`);
        }
        if (wDiff) {
          console.log(`  oracle writes: ${c.writes.map(fmtWrite).join(' ')}`);
          console.log(`  port   writes: ${writes.map(fmtWrite).join(' ')}`);
        }
      }
    }
  }
  if (!quiet) console.log(`call mode: ${calls.length - bad}/${calls.length} DriveAudio calls identical (RAM + APU writes)`);
  return bad;
}

/** Per-frame comparison of the APU write sequence through the full port (needs P01). */
export async function compareFrames(frameWrites, romBytes, movie, { verbose = false, quiet = false } = {}) {
  const { createGame } = await import('../../src/headless.js');
  const { bus } = await import('../../src/core/bus.js');
  const writes = [[]]; // writes[0] = IsrReset/RunGame (bus.apuWrite survives createMachine)
  bus.apuWrite = (addr, value) => writes[writes.length - 1].push((addr << 8) | value);
  let game;
  try {
    game = await createGame({ rom: romBytes });
  } catch (err) {
    bus.apuWrite = null;
    if (err?.name !== 'NotImplementedError') throw err;
    if (!quiet) console.log(`frame mode: stopped in IsrReset (${err.message})`);
    return 0;
  }
  if (!game.ported) {
    bus.apuWrite = null;
    if (!quiet) console.log('frame mode: skipped (IsrReset/IsrNmi not ported yet: P01)');
    return 0;
  }
  let bad = 0;
  const n = Math.min(movie.length, frameWrites.length - 1);
  for (let f = 0; f <= n; f++) {
    if (f > 0) {
      writes.push([]);
      try {
        game.stepFrame(movie.p1[f - 1], movie.p2[f - 1]);
      } catch (err) {
        if (err?.name !== 'NotImplementedError') throw err;
        if (!quiet) console.log(`frame mode: stopped at frame ${f} (${err.message}); frames 0..${f - 1} compared`);
        bus.apuWrite = null;
        return bad;
      }
    }
    const a = frameWrites[f], b = writes[f];
    if (a.length !== b.length || a.some((w, i) => w !== b[i])) {
      bad++;
      if (bad <= 5 || verbose) {
        console.log(`frame ${f}: APU writes differ`);
        console.log(`  oracle: ${a.map(fmtWrite).join(' ')}`);
        console.log(`  port  : ${b.map(fmtWrite).join(' ')}`);
      }
    }
  }
  bus.apuWrite = null;
  if (!quiet) console.log(`frame mode: ${n + 1 - bad}/${n + 1} frames (0..${n}) with identical APU writes`);
  return bad;
}

if (import.meta.main) runCli(main);
