#!/usr/bin/env node
// P09 "graft" oracle run (technique of tests/game/p12-graft.mjs): the ORIGINAL game runs in jsnes and
// every call to a P09 entry routine (sword, shots, boomerang, arrow, bomb, fire, candle, rod, flute,
// WieldItem...) is executed by the JS port instead: RAM/SRAM/bank synced in and out, registers and
// flags per the port's contract, then a real RTS. The trace is diffed with the pure oracle trace: a
// divergence can only come from the P09 ports (or the JS routines they call). It prints how many
// times each routine ran (the coverage of a scenario).
//
// Usage (the hybrid hook makes routines still stubbed in JS, e.g. P17's MoveShot, run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p09-graft.mjs <movie> [--sram f] [--compare]
// P09_GRAFT_ONLY=Name1,Name2 grafts only those routines (to bisect); P09_GRAFT_SKIP=... all but those.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { TraceWriter } from '../../tools/oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { parseArgs, resolveMovie, readOptionalSram, runCli } from '../../tools/oracle/lib/cli.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { installGrafts } from './p12-graft.mjs';

/** Every P09 entry routine: name -> (regs) => register outputs {a?, x?, y?, c?, z?, nz?}. */
export async function p09Grafts() {
  const Wi = await import('../../src/game/weapons/wield.js');
  const Sw = await import('../../src/game/weapons/sword.js');
  const Sh = await import('../../src/game/weapons/shots.js');
  const Bo = await import('../../src/game/weapons/boomerang.js');
  const Ar = await import('../../src/game/weapons/arrow.js');
  const Bm = await import('../../src/game/weapons/bomb.js');
  const Fi = await import('../../src/game/weapons/fire.js');
  const Ro = await import('../../src/game/weapons/rod.js');
  const Fl = await import('../../src/game/weapons/flute.js');
  const none = (f) => () => (f(), {});
  const withX = (f) => (r) => (f(r.x), {});
  const keepX = (f) => (r) => (f(r.x), { x: r.x });
  const all = {
    // Z_01 (WRAM)
    WieldBomb: none(Bm.WieldBomb),
    PlaceWeaponForPlayerStateAndAnimAndWeaponState: (r) => ({ a: Wi.PlaceWeaponForPlayerStateAndAnimAndWeaponState(r.a, r.x) }),
    PlaceWeaponForPlayerStateAndAnim: (r) => ({ a: Wi.PlaceWeaponForPlayerStateAndAnim(r.x) }),
    PlaceWeaponForPlayerState: (r) => ({ a: Wi.PlaceWeaponForPlayerState(r.x) }),
    PlaceWeapon: (r) => ({ a: Wi.PlaceWeapon(r.a, r.x) }),
    ChooseOffsetForDirectionH: (r) => ({ a: Wi.ChooseOffsetForDirectionH(r.a), c: 0 }),
    WieldCandle: () => ({ x: Fi.WieldCandle() }),
    UpdateBombFlashEffect: keepX(Bm.UpdateBombFlashEffect),
    // Z_04
    UpdateCandle: none(Fi.UpdateCandle),
    UpdateCandle_Begin: none(Fi.UpdateCandle_Begin),
    UpdateCandle_Done: none(Fi.UpdateCandle_Done),
    UpdateCandle_Brightening: none(Fi.UpdateCandle_Brightening),
    IsDarkRoom_Bank4: (r) => { const a = Fi.IsDarkRoom_Bank4(r.y); return { a, nz: a }; },
    // Z_05
    WieldSword: none(Sw.WieldSword),
    WieldItem: none(Wi.WieldItem),
    WieldBoomerang: none(Bo.WieldBoomerang),
    WieldArrow: none(Ar.WieldArrow),
    WieldWeapon: (r) => (Wi.WieldWeapon(r.a, r.x), {}),
    WieldNothing: none(Wi.WieldNothing),
    WieldFood: none(Bo.WieldFood),
    WieldPotion: none(Wi.WieldPotion),
    WieldRod: none(Ro.WieldRod),
    // Z_07
    WieldFlute: none(Fl.WieldFlute),
    UpdateSwordShotOrMagicShot: withX(Sh.UpdateSwordShotOrMagicShot),
    DrawSwordShotOrMagicShot: (r) => ({ x: Sh.DrawSwordShotOrMagicShot(r.x) }),
    HandleShotBlocked: withX(Sh.HandleShotBlocked),
    DeactivateLinkShot: () => ({ a: Sh.DeactivateLinkShot(), x: 0x0e, nz: 0 }),
    SpreadShot: withX(Sh.SpreadShot),
    UpdateBoomerangOrFood: withX(Bo.UpdateBoomerangOrFood),
    UpdateArrowOrBoomerang: keepX(Ar.UpdateArrowOrBoomerang),
    DrawArrow: (r) => ({ x: Ar.DrawArrow(r.x) }),
    SetAttrAndDrawArrow: (r) => ({ x: Ar.SetAttrAndDrawArrow(r.a, r.x, r.y) }),
    CheckState20: (r) => (Ar.CheckState20(r.a, r.x), { x: r.x }),
    HandleArrowOrBoomerangBlocked: (r) => ({ x: Ar.HandleArrowOrBoomerangBlocked(r.x) }),
    AnimateBoomerangAndCheckCollision: (r) => ({ x: Ar.AnimateBoomerangAndCheckCollision(r.x) }),
    DrawBoomerangAndCheckCollision: (r) => ({ x: Ar.DrawBoomerangAndCheckCollision(r.x) }),
    OffsetAndDrawArrow: (r) => ({ x: Ar.OffsetAndDrawArrow(r.x, r.y) }),
    L_DrawArrowOrBoomerang: (r) => ({ x: Ar.L_DrawArrowOrBoomerang(r.x, r.y) }),
    UpdateRodOrArrow: withX(Ro.UpdateRodOrArrow),
    UpdateSwordOrRod: withX(Sw.UpdateSwordOrRod),
    ResetObjState: (r) => ({ a: Sw.ResetObjState(r.x), nz: 0 }),
    UpdateFire: withX(Fi.UpdateFire),
    GetWideObjectMiddle: (r) => ({ a: Fi.GetWideObjectMiddle(r.x, r.y) }),
    UpdateBombOrFire: withX(Bm.UpdateBombOrFire),
    DrawBombOrCloudAt: (r) => ({ x: Bm.DrawBombOrCloudAt(r.x) }),
    DrawBombOrCloudNoFlashing: (r) => ({ x: Bm.DrawBombOrCloudNoFlashing(r.x) }),
    DrawCloud: (r) => ({ x: Bm.DrawCloud(r.a, r.x) }),
    DrawOtherBombClouds: keepX(Bm.DrawOtherBombClouds),
  };
  const only = process.env.P09_GRAFT_ONLY?.split(',');
  const skip = process.env.P09_GRAFT_SKIP?.split(',') ?? [];
  return Object.fromEntries(Object.entries(all)
    .filter(([n]) => (!only || only.includes(n)) && !skip.includes(n)));
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet', 'compare'] });
  if (!args._[0]) {
    console.error('usage: p09-graft.mjs <movie> [--sram f] [--out dir] [--compare]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft-p09', movie.name));
  mkdirSync(outDir, { recursive: true });
  const header = (source) => ({
    source, emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
    timing: movie.timing, frames: movie.length, powerOnFill: 0, sram: args.sram ?? null,
  });
  const oracle = await Oracle.create({ rom: rom.bytes, sram: readOptionalSram(args.sram), powerOnFill: 0 });
  const counts = installGrafts(oracle, await p09Grafts());
  const tracePath = join(outDir, 'trace.ztrace');
  const writer = new TraceWriter(tracePath, header('p09-graft'));
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
