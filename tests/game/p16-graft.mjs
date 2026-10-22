#!/usr/bin/env node
// P16 "graft" oracle run: the ORIGINAL game runs in jsnes (tools/oracle Oracle), but every call to a
// P16 entry routine (tile objects, block, whirlwind, pond, rupee stash) is executed by the JS port instead
// (RAM/SRAM/bank synced in and out, registers per the port's contract, then an RTS; see p08-graft.mjs).
// The trace it writes is compared with the pure oracle trace: any divergence comes from the P16 ports
// (or the JS routines they call). This checks P16 in real gameplay before the pure port can run the
// scenarios (its callers and siblings of the same wave are still being ported).
//
// Usage (the hybrid hook makes routines still stubbed in JS run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p16-graft.mjs <movie> [--sram f] [--out dir]
//   then: node tools/oracle/diff.mjs out/oracle/<m>/trace.ztrace out/graft16/<m>/trace.ztrace --no-fb
// Or everything at once (exit code 0 = identical): ... p16-graft.mjs <movie> [--sram f] --compare
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { TraceWriter } from '../../tools/oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { parseArgs, resolveMovie, readOptionalSram, runCli } from '../../tools/oracle/lib/cli.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { installGrafts } from './p08-graft.mjs';

/** name -> (cpu regs) => register updates {a?, x?, y?} after the call. */
export async function p16Grafts() {
  const W = await import('../../src/game/worldobj/whirlwind.js');
  const T = await import('../../src/game/worldobj/tileobjects.js');
  const B = await import('../../src/game/worldobj/block.js');
  const P = await import('../../src/game/worldobj/pond.js');
  const S = await import('../../src/game/worldobj/rupeestash.js');
  return {
    CheckTileObjectsBlocking: () => ({ x: T.CheckTileObjectsBlocking() }),
    CheckPassiveTileObjects: () => ({ x: T.CheckPassiveTileObjects() }),
    UpdateWhirlwind_Full: (r) => ({ x: W.UpdateWhirlwind_Full(r.x) }),
    SummonWhirlwind: () => (W.SummonWhirlwind(), {}),
    CheckInitWhirlwindAndBeginUpdate: () => ({ a: W.CheckInitWhirlwindAndBeginUpdate() }),
    InitRupeeStash_Full: (r) => ({ x: S.InitRupeeStash_Full(r.x) }),
    InitOneSimpleObject: (r) => ({ a: S.InitOneSimpleObject(r.x) }),
    UpdateRupeeStash_Full: (r) => ({ x: S.UpdateRupeeStash_Full(r.x) }),
    ResetRoomTileObjInfo: () => ({ a: T.ResetRoomTileObjInfo() }),
    UpdateBlock: (r) => (B.UpdateBlock(r.x), {}),
    InitPondFairy: (r) => (P.InitPondFairy(r.x), {}),
    UpdatePondFairy: (r) => (P.UpdatePondFairy(r.x), {}),
    UpdateRockOrGravestone: (r) => (T.UpdateRockOrGravestone(r.x), {}),
    UpdateRockWall: (r) => (T.UpdateRockWall(r.x), {}),
    UpdateTree: (r) => (T.UpdateTree(r.x), {}),
    UpdateDock: (r) => (T.UpdateDock(r.x), {}),
    SetupTileObjectOW: () => (T.SetupTileObjectOW(), {}),
    FindAndCreatePushBlockObject: () => (B.FindAndCreatePushBlockObject(), {}),
    UpdateFluteSecret: (r) => (P.UpdateFluteSecret(r.x), {}),
    AnimatePond: () => (P.AnimatePond(), {}),
  };
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet', 'compare'] });
  if (!args._[0]) {
    console.error('usage: p16-graft.mjs <movie> [--sram f] [--out dir] [--compare]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft16', movie.name));
  mkdirSync(outDir, { recursive: true });
  const sramInit = readOptionalSram(args.sram);
  const header = (source) => ({
    source, emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
    timing: movie.timing, frames: movie.length, powerOnFill: 0, sram: args.sram ?? null,
  });
  const oracle = await Oracle.create({ rom: rom.bytes, sram: sramInit, powerOnFill: 0 });
  const counts = installGrafts(oracle, await p16Grafts());
  const tracePath = join(outDir, 'trace.ztrace');
  const writer = new TraceWriter(tracePath, header('p16-graft'));
  try {
    oracle.run(movie, { write: (rec) => writer.write(rec) });
  } finally {
    writer.close();
  }
  if (!args.quiet) console.log(`grafted calls: ${JSON.stringify(counts)}`);
  if (!args.compare) return 0;

  // Pure original run of the same movie, then the diff (RAM + SRAM, no framebuffer).
  const pureDir = join(REPO_ROOT, 'out/oracle', movie.name);
  mkdirSync(pureDir, { recursive: true });
  const purePath = join(pureDir, 'trace.ztrace');
  const pure = await Oracle.create({ rom: rom.bytes, sram: readOptionalSram(args.sram), powerOnFill: 0 });
  const w2 = new TraceWriter(purePath, header('oracle'));
  try {
    pure.run(movie, { write: (rec) => w2.write(rec) });
  } finally {
    w2.close();
  }
  const { main: diffMain } = await import('../../tools/oracle/diff.mjs');
  return diffMain([purePath, tracePath, '--no-fb']);
}

if (import.meta.main) runCli(main);
