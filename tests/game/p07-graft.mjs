#!/usr/bin/env node
// P07 "graft" oracle run (technique of tests/game/p05-graft.mjs): the ORIGINAL game runs in jsnes and
// every call from original code to a P07 entry routine (collisions, damage, Link harmed, shove) is
// executed by the JS port instead (RAM/SRAM/bank synced in and out, registers and flags per the port's
// contract, then a real RTS). In the hybrid port most monsters are still original 6502 code calling
// the original CheckMonsterCollisions; the graft makes every one of those calls run the JS port.
//
// Usage (the hybrid hook makes routines still stubbed in JS run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p07-graft.mjs <movie> [--sram f] [--out dir]
//   node tools/oracle/run-oracle.mjs <movie> [--sram f] --png none
//   node tools/oracle/diff.mjs out/oracle/<m>/trace.ztrace out/graft07/<m>/trace.ztrace --no-fb
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { TraceWriter } from '../../tools/oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { parseArgs, resolveMovie, readOptionalSram, runCli } from '../../tools/oracle/lib/cli.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram } from '../../src/core/ram.js';
import { installGrafts } from './p05-graft.mjs';

/** name -> (cpu regs) => register/flag updates {a?, x?, y?, c?, z?} after the call. */
export async function p07Grafts() {
  const C = await import('../../src/game/combat/collisions.js');
  const D = await import('../../src/game/combat/damage.js');
  const L = await import('../../src/game/combat/link-harm.js');
  const collide = (a) => ({ a, y: ram[0x00], z: a === 0 });
  return {
    CheckMonsterCollisions: (r) => (C.CheckMonsterCollisions(r.x), {}),
    GetObjectMiddle: (r) => ({ a: C.GetObjectMiddle(r.x) }),
    CheckLinkCollision: (r) => (C.CheckLinkCollision(r.x), {}),
    CheckLinkCollisionPreinit: (r) => (C.CheckLinkCollisionPreinit(r.x), {}),
    Link_BeHarmed: (r) => (L.Link_BeHarmed(r.x), {}),
    CheckMonsterBoomerangOrFoodCollision: (r) => (C.CheckMonsterBoomerangOrFoodCollision(r.x, r.y), {}),
    CheckMonsterWeaponCollision: (r) => ({ y: C.CheckMonsterWeaponCollision(r.a, r.x) }),
    HandleMonsterWeaponCollision: (r) => (D.HandleMonsterWeaponCollision(r.x, r.y), {}),
    DealDamage: (r) => (D.DealDamage(r.x), {}),
    ResetShoveInfoAndInvincibilityTimer: (r) => ({ a: D.ResetShoveInfoAndInvincibilityTimer(r.a, r.x) }),
    CheckMonsterSwordShotOrMagicShotCollision: (r) => (C.CheckMonsterSwordShotOrMagicShotCollision(r.x, r.y), {}),
    CheckMonsterBombOrFireCollision: (r) => (C.CheckMonsterBombOrFireCollision(r.x, r.y), {}),
    CheckMonsterSwordCollision: (r) => (C.CheckMonsterSwordCollision(r.x, r.y), {}),
    CheckMonsterArrowOrRodCollision: (r) => (C.CheckMonsterArrowOrRodCollision(r.x, r.y), {}),
    CheckMonsterShotCollision: (r) => (C.CheckMonsterShotCollision(r.a, r.x), {}),
    ParryOrShove: (r) => (D.ParryOrShove(r.x, r.y), {}),
    PlayParryTune: () => ({ a: D.PlayParryTune() }),
    CheckMonsterSlenderWeaponCollision: (r) => ({ y: C.CheckMonsterSlenderWeaponCollision(r.a, r.x) }),
    CheckMonsterSlenderWeaponCollision2: (r) => ({ y: C.CheckMonsterSlenderWeaponCollision2(r.x) }),
    DoObjectsCollide: (r) => collide(C.DoObjectsCollide(r.a)),
    DoObjectsCollideWithThresholds: () => collide(C.DoObjectsCollideWithThresholds()),
    BeginShove: (r) => (L.BeginShove(r.x), {}),
  };
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet'] });
  if (!args._[0]) {
    console.error('usage: p07-graft.mjs <movie> [--sram f] [--out dir]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft07', movie.name));
  mkdirSync(outDir, { recursive: true });
  const oracle = await Oracle.create({ rom: rom.bytes, sram: readOptionalSram(args.sram), powerOnFill: 0 });
  const counts = installGrafts(oracle, await p07Grafts());
  const writer = new TraceWriter(join(outDir, 'trace.ztrace'), {
    source: 'p07-graft', emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
    timing: movie.timing, frames: movie.length, powerOnFill: 0, sram: args.sram ?? null,
  });
  try {
    oracle.run(movie, { write: (rec) => writer.write(rec) });
  } finally {
    writer.close();
  }
  if (!args.quiet) console.log(`grafted calls: ${JSON.stringify(counts)}`);
  return 0;
}

if (import.meta.main) runCli(main);
