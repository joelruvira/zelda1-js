#!/usr/bin/env node
// P10 "graft" oracle run (technique of tests/game/p12-graft.mjs): the ORIGINAL game runs in jsnes and
// every call to a P10 routine (items, drops, taking items, fairy, lifting, power triforce) is executed
// by the JS port instead. The trace is diffed with the pure oracle trace: a divergence can only come
// from the P10 ports (or the JS routines they call). It also prints how many times each routine ran,
// which is the coverage of a scenario.
//
// Usage (the hybrid hook makes routines still stubbed in JS run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p10-graft.mjs <movie> [--sram f] [--out dir]
//   node tools/oracle/diff.mjs out/oracle/<m>/trace.ztrace out/graft-p10/<m>/trace.ztrace --no-fb
// P10_GRAFT_ONLY=Name1,Name2 grafts only those routines (to bisect a divergence); P10_GRAFT_SKIP=...
// grafts all but those. Note: a graft runs in 0 CPU cycles, so grafting the routines called every
// frame shortens the original's NMIs; near a lag frame this can move the NMI that the game re-enables
// inside vblank (a second NMI in the same video frame) and the graft trace then differs for one frame
// (triforce-level1 frame 1898 with CheckLiftItem+MoveAndDrawRoomItem+TryTakeRoomItem together; each
// alone gives diff 0). That is cycle timing of the harness, not a P10 divergence.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { TraceWriter } from '../../tools/oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { parseArgs, resolveMovie, readOptionalSram, runCli } from '../../tools/oracle/lib/cli.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram } from '../../src/core/ram.js';
import { RoomId } from '../../src/core/vars.js';
import { installGrafts } from './p12-graft.mjs';

/** Every P10 entry routine: name -> (regs) => register outputs {a?, x?, y?, c?, z?, nz?}. */
export async function p10Grafts() {
  const T = await import('../../src/game/items/take.js');
  const RI = await import('../../src/game/items/roomitem.js');
  const D = await import('../../src/game/items/drops.js');
  const F = await import('../../src/game/items/fairy.js');
  const none = (f) => () => (f(), {});
  const withX = (f) => (r) => (f(r.x), {});
  return {
    // Z_01 bank 1
    CheckPowerTriforceFanfare: none(T.CheckPowerTriforceFanfare),
    TakePowerTriforce: none(T.TakePowerTriforce),
    // Z_01 WRAM
    GetShortcutOrItemXY: () => RI.GetShortcutOrItemXY(),
    GetShortcutOrItemXYForRoom: (r) => RI.GetShortcutOrItemXYForRoom(r.y),
    SetRoomFlagUWItemState: () => (RI.SetRoomFlagUWItemState(), { y: ram[RoomId] }),
    GetRoomFlagUWItemState: () => { const a = RI.GetRoomFlagUWItemState(); return { a, y: ram[RoomId], nz: a }; },
    TryTakeRoomItem: none(T.TryTakeRoomItem),
    TryTakeItem: withX(T.TryTakeItem),
    TakeItem: (r) => (T.TakeItem(r.a), {}),
    SetItemValue: (r) => (T.SetItemValue(r.a, r.y), {}),
    CompareHeartsToContainers: () => {
      const a = T.CompareHeartsToContainers();
      return { a, z: a === ram[0x00], c: a >= ram[0x00] };
    },
    TakeOneRupee: none(T.TakeOneRupee),
    PlayKeyTakenTune: none(T.PlayKeyTakenTune),
    // Z_04
    SetUpDroppedItem: withX(D.SetUpDroppedItem),
    UpdateItem: withX(RI.UpdateItem),
    SetUpFairyObject: withX(F.SetUpFairyObject),
    ResetFlyerState: (r) => ({ a: F.ResetFlyerState(r.x) }),
    UpdateFairyObject: withX(F.UpdateFairyObject),
    DrawFairy: (r) => ({ x: F.DrawFairy(r.x) }),
    ControlFairyFlight: withX(F.ControlFairyFlight),
    Flyer_FairyDecideState: withX(F.Flyer_FairyDecideState),
    // Z_07
    MoveAndDrawRoomItem: none(RI.MoveAndDrawRoomItem),
    AnimateRoomItemObject: withX(RI.AnimateRoomItemObject),
    AnimateItemObject: (r) => { const x = RI.AnimateItemObject(r.a, r.x); return x === undefined ? {} : { x }; },
    CheckLiftItem: none(RI.CheckLiftItem),
    SetUpAndDrawLinkLiftingItem: none(RI.SetUpAndDrawLinkLiftingItem),
    DrawLinkLiftingItem: none(RI.DrawLinkLiftingItem),
  };
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet'] });
  if (!args._[0]) {
    console.error('usage: p10-graft.mjs <movie> [--sram f] [--out dir]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft-p10', movie.name));
  mkdirSync(outDir, { recursive: true });
  const sramInit = readOptionalSram(args.sram);
  const oracle = await Oracle.create({ rom: rom.bytes, sram: sramInit, powerOnFill: 0 });
  let grafts = await p10Grafts();
  if (process.env.P10_GRAFT_ONLY) {
    const only = process.env.P10_GRAFT_ONLY.split(',');
    grafts = Object.fromEntries(Object.entries(grafts).filter(([n]) => only.includes(n)));
  }
  if (process.env.P10_GRAFT_SKIP) {
    const skip = process.env.P10_GRAFT_SKIP.split(',');
    grafts = Object.fromEntries(Object.entries(grafts).filter(([n]) => !skip.includes(n)));
  }
  const counts = installGrafts(oracle, grafts);
  const writer = new TraceWriter(join(outDir, 'trace.ztrace'), {
    source: 'p10-graft', emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
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
