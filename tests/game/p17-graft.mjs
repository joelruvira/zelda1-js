#!/usr/bin/env node
// P17 "graft" oracle run: the ORIGINAL game runs in jsnes (tools/oracle Oracle), but every call to a
// P17 entry routine (monster shots, fireballs, arrows, shooting, wanderer AI, flyer engine, rotation) is
// executed by the JS port instead (RAM/SRAM/bank synced in and out, registers and carry per the port's
// contract, then an RTS; see p08-graft.mjs). The trace is compared with the pure oracle trace: any
// divergence comes from the P17 ports (or the JS routines they call). This checks P17 in real gameplay
// before its callers (P18-P22 monsters) are ported.
//
// Usage (the hybrid hook makes routines still stubbed in JS run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p17-graft.mjs <movie> [--sram f] --compare
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { TraceWriter } from '../../tools/oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { parseArgs, resolveMovie, readOptionalSram, runCli } from '../../tools/oracle/lib/cli.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { installGrafts } from './p08-graft.mjs';

/**
 * name -> (cpu regs) => register updates {a?, x?, y?} after the call. Routines that return C set the
 * jsnes carry directly (installGrafts does not touch the flags; the RTS keeps them).
 */
export async function p17Grafts(oracle) {
  const C = await import('../../src/game/enemies/common.js');
  const S = await import('../../src/game/enemies/shots.js');
  const F = await import('../../src/game/enemies/flyer.js');
  const carry = (r) => {
    oracle.nes.cpu.F_CARRY = r.c;
    return { a: r.a, x: r.x, y: r.y };
  };
  return {
    MoveShot: (r) => ({ a: S.MoveShot(r.a, r.x) }),
    PlayBossHitCryIfNeeded: (r) => ({ a: C.PlayBossHitCryIfNeeded(r.x) }),
    PlayBossDeathCryIfNeeded: (r) => ({ a: C.PlayBossDeathCryIfNeeded(r.x) }),
    PlayBossDeathCry: () => ({ a: C.PlayBossDeathCry() }),
    InitMonsterShot: (r) => ({ a: S.InitMonsterShot(r.x) }),
    _InitMonsterShot_Unknown54: (r) => ({ a: S._InitMonsterShot_Unknown54(r.x) }),
    InitWalker: (r) => (C.InitWalker(r.x), {}),
    UpdateCommonWanderer: (r) => (C.UpdateCommonWanderer(r.a, r.x), {}),
    Wanderer_TargetPlayer: (r) => (C.Wanderer_TargetPlayer(r.x), {}),
    ShootFireball: (r) => { const o = S.ShootFireball(r.a, r.x); return { a: o.a, y: o.y }; },
    UpdateMonsterShot: (r) => (S.UpdateMonsterShot(r.x), {}),
    L_DrawShot: (r) => (S.L_DrawShot(r.x), {}),
    DestroyCountedMonsterShot: (r) => (S.DestroyCountedMonsterShot(r.x), {}),
    BounceShot: (r) => (S.BounceShot(r.x), {}),
    CheckShotLinkCollision: (r) => (S.CheckShotLinkCollision(r.x), {}),
    UpdateFireball: (r) => (S.UpdateFireball(r.x), {}),
    Fireball_MoveOneAxis: (r) => ({ a: S.Fireball_MoveOneAxis(r.a, r.x, r.y) }),
    _TryShooting: (r) => (S._TryShooting(r.a, r.x, r.y), {}),
    _ShootIfWanted2: (r) => carry(S._ShootIfWanted2(r.a, r.x)),
    UpdateMonsterArrow: (r) => (S.UpdateMonsterArrow(r.x), {}),
    _ShootIfWanted: (r) => carry(S._ShootIfWanted(r.a, r.x, r.y)),
    ShootLimited: (r) => carry(S.ShootLimited(r.x)),
    Shoot: () => carry(S.Shoot()),
    Flyer_DoNothing: (r) => (F.Flyer_DoNothing(r.x), {}),
    Flyer_Delay: (r) => (F.Flyer_Delay(r.x), {}),
    Flyer_SlowDown: (r) => (F.Flyer_SlowDown(r.x), {}),
    Flyer_SpeedUp: (r) => (F.Flyer_SpeedUp(r.x), {}),
    Flyer_SetFlyingState: (r) => ({ a: F.Flyer_SetFlyingState(r.a, r.x) }),
    MoveFlyer: (r) => (F.MoveFlyer(r.x), {}),
    BoundFlyer: (r) => ({ a: F.BoundFlyer(r.x) }),
    ReverseObjDir8: (r) => ({ a: F.ReverseObjDir8(r.x) }),
    Flyer_Chase: (r) => (F.Flyer_Chase(r.x), {}),
    SetFlyingState1: (r) => ({ a: F.SetFlyingState1(r.x) }),
    TurnTowardsPlayer8: (r) => (F.TurnTowardsPlayer8(r.x), {}),
    SetDir8ForIndex: (r) => ({ a: F.SetDir8ForIndex(r.x, r.y) }),
    Flyer_Wander: (r) => (F.Flyer_Wander(r.x), {}),
    TurnRandomlyDir8: (r) => (F.TurnRandomlyDir8(r.x), {}),
    GetObjDir8Index: (r) => ({ y: F.GetObjDir8Index(r.x) }),
    RotateObjectLocation: (r) => ({ a: C.RotateObjectLocation(r.a, r.x, r.y) }),
    ShiftMultiply: (r) => ({ a: C.ShiftMultiply(r.a, r.y) }),
    DecreaseObjectAngle: (r) => ({ a: C.DecreaseObjectAngle(r.a, r.x) }),
  };
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet', 'compare'] });
  if (!args._[0]) {
    console.error('usage: p17-graft.mjs <movie> [--sram f] [--out dir] [--compare]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft17', movie.name));
  mkdirSync(outDir, { recursive: true });
  const header = (source) => ({
    source, emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
    timing: movie.timing, frames: movie.length, powerOnFill: 0, sram: args.sram ?? null,
  });
  const oracle = await Oracle.create({ rom: rom.bytes, sram: readOptionalSram(args.sram), powerOnFill: 0 });
  const counts = installGrafts(oracle, await p17Grafts(oracle));
  const tracePath = join(outDir, 'trace.ztrace');
  const writer = new TraceWriter(tracePath, header('p17-graft'));
  try {
    oracle.run(movie, { write: (rec) => writer.write(rec) });
  } finally {
    writer.close();
  }
  if (!args.quiet) console.log(`grafted calls: ${JSON.stringify(counts)}`);
  if (!args.compare) return 0;

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
