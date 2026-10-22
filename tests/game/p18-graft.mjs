#!/usr/bin/env node
// P18 "graft" oracle run: the ORIGINAL game runs in jsnes (tools/oracle Oracle), but every call to a
// P18 entry routine (overworld monsters: octoroks, moblins, lynels, tektites, boulders, leevers, zora,
// peahats, ghinis, armos) is executed by the JS port instead (RAM/SRAM/bank synced in and out,
// registers per the port's contract, then an RTS; see p08-graft.mjs). The trace is compared with the
// pure oracle trace: any divergence comes from the P18 ports (or the JS routines they call).
//
// Usage (the hybrid hook makes routines still stubbed in JS, e.g. P19 UpdateGoriya, run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p18-graft.mjs <movie> [--sram f] --compare
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { TraceWriter } from '../../tools/oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { parseArgs, resolveMovie, readOptionalSram, runCli } from '../../tools/oracle/lib/cli.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { cpu as portCpu } from '../../src/core/ram.js';
import { installGrafts } from './p08-graft.mjs';

/** name -> (cpu regs) => register updates {a?, x?, y?} after the call. */
export async function p18Grafts(oracle) {
  const Z = await import('../../src/game/enemies/zora.js');
  const O = await import('../../src/game/enemies/octorok.js');
  const M = await import('../../src/game/enemies/moblin-lynel.js');
  const T = await import('../../src/game/enemies/tektite-boulder.js');
  const L = await import('../../src/game/enemies/leever.js');
  const P = await import('../../src/game/enemies/peahat.js');
  const G = await import('../../src/game/enemies/ghini.js');
  const A = await import('../../src/game/enemies/armos.js');
  const x1 = (f) => (r) => (f(r.x), {});
  return {
    CheckZora: () => (Z.CheckZora(), {}),
    UpdateZora: x1(Z.UpdateZora),
    InitBoulderSet: x1(T.InitBoulderSet),
    InitBoulder: x1(T.InitBoulder),
    InitTektite: (r) => ({ a: T.InitTektite(r.x) }),
    InitLeever: x1(L.InitLeever),
    InitSlowOctorockOrGhini: x1(O.InitSlowOctorockOrGhini),
    InitFastOctorock: x1(O.InitFastOctorock),
    InitPeahat: x1(P.InitPeahat),
    EndInitFlyer: (r) => ({ a: P.EndInitFlyer(r.x) }),
    UpdateMoblin: x1(M.UpdateMoblin),
    UpdateLynel: x1(M.UpdateLynel),
    UpdateBoulderSet: x1(T.UpdateBoulderSet),
    UpdateTektiteOrBoulder: x1(T.UpdateTektiteOrBoulder),
    Jumper_AnimateAndCheckCollisions: x1(T.Jumper_AnimateAndCheckCollisions),
    Jumper_GetKind: (r) => ({ y: T.Jumper_GetKind(r.x) }),
    Jumper_PointBoulderDownward: x1(T.Jumper_PointBoulderDownward),
    Jumper_MoveY: (r) => {
      portCpu.c = oracle.nes.cpu.F_CARRY;
      T.Jumper_MoveY(r.a, r.x, r.y);
      return {};
    },
    Jumper_ResetVSpeedFrac: (r) => ({ a: T.Jumper_ResetVSpeedFrac(r.x) }),
    UpdateBlueLeever: x1(L.UpdateBlueLeever),
    UpdateBurrower: x1(L.UpdateBurrower),
    Burrower_AnimateDrawAndCheckCollisions: (r) => (L.Burrower_AnimateDrawAndCheckCollisions(r.a, r.x), {}),
    UpdateRedLeever: x1(L.UpdateRedLeever),
    RedLeever_CycleStateDrawAndCheckCollisions: x1(L.RedLeever_CycleStateDrawAndCheckCollisions),
    RedLeever_AnimateAndCheckCollisions: x1(L.RedLeever_AnimateAndCheckCollisions),
    UpdateOctorock: x1(O.UpdateOctorock),
    DrawObjectMirroredAndCheckCollisions: (r) => (O.DrawObjectMirroredAndCheckCollisions(r.a, r.x), {}),
    UpdateGhini: x1(G.UpdateGhini),
    DrawGhiniAndCheckCollisions: x1(G.DrawGhiniAndCheckCollisions),
    DrawObjectNotMirroredAndCheckLinkCollision: (r) => (G.DrawObjectNotMirroredAndCheckLinkCollision(r.a, r.x), {}),
    InitArmosOrFlyingGhini: x1(A.InitArmosOrFlyingGhini),
    UpdateArmos: x1(A.UpdateArmos),
    DrawArmosAndCheckCollisions: x1(A.DrawArmosAndCheckCollisions),
    UpdateFlyingGhini: x1(G.UpdateFlyingGhini),
    ControlFlyingGhiniFlight: x1(G.ControlFlyingGhiniFlight),
    Flyer_GhiniDecideState: (r) => ({ a: G.Flyer_GhiniDecideState(r.x) }),
    UpdatePeahat: x1(P.UpdatePeahat),
    ControlPeahatFlight: x1(P.ControlPeahatFlight),
    Flyer_PeahatDecideState: (r) => ({ a: P.Flyer_PeahatDecideState(r.x) }),
    Flyer_SetFlyingStateAnd6Turns: (r) => ({ a: P.Flyer_SetFlyingStateAnd6Turns(r.x, r.y) }),
  };
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet', 'compare'] });
  if (!args._[0]) {
    console.error('usage: p18-graft.mjs <movie> [--sram f] [--out dir] [--compare]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft18', movie.name));
  mkdirSync(outDir, { recursive: true });
  const header = (source) => ({
    source, emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
    timing: movie.timing, frames: movie.length, powerOnFill: 0, sram: args.sram ?? null,
  });
  const oracle = await Oracle.create({ rom: rom.bytes, sram: readOptionalSram(args.sram), powerOnFill: 0 });
  const counts = installGrafts(oracle, await p18Grafts(oracle));
  const tracePath = join(outDir, 'trace.ztrace');
  const writer = new TraceWriter(tracePath, header('p18-graft'));
  try {
    oracle.run(movie, { write: (rec) => writer.write(rec) });
  } finally {
    writer.close();
  }
  if (!args.quiet) console.log(`grafted calls: ${JSON.stringify(counts)}`);
  if (!args.compare) return 0;

  const pureDir = join(outDir, 'oracle');
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
