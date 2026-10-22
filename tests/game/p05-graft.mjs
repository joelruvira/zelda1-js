#!/usr/bin/env node
// P05 "graft" oracle run (technique of tests/game/p08-graft.mjs): the ORIGINAL game runs in jsnes
// and every call from original code to a P05 entry routine is executed by the JS port instead
// (RAM/SRAM/bank synced in and out, registers and flags per the port's contract, then a real RTS).
// The trace is diffed with the pure oracle trace: a divergence can only come from the P05 ports
// (or the JS routines they call; JS stubs of later packages run as original code through the hybrid
// hook). This exercises the P05 routines that only P13/P14 code calls (spawn positions, kill counts,
// cross-room tasks) before those callers are ported.
//
// Grafting the top-level UpdateMode5Play/InitMode5Play makes their inner P05 routines run as JS too;
// P05_GRAFT=Name,Name selects a subset (P05_GRAFT=inner = all but the top-level mode routines).
//
// Usage:
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p05-graft.mjs <movie> [--sram f] [--out dir]
//   node tools/oracle/run-oracle.mjs <movie> [--sram f] --png none
//   node tools/oracle/diff.mjs out/oracle/<m>/trace.ztrace out/graft/<m>/trace.ztrace --no-fb
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { TraceWriter } from '../../tools/oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { parseArgs, resolveMovie, readOptionalSram, runCli } from '../../tools/oracle/lib/cli.mjs';
import { loadSymbols, label, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram, cpu as portCpu } from '../../src/core/ram.js';
import { bus } from '../../src/core/bus.js';
import { switchBank } from '../../src/core/asm.js';

export const TOP_LEVEL = ['InitMode5Play', 'UpdateMode5Play'];

/** name -> (cpu regs) => register/flag updates {a?, x?, y?, c?, z?} after the call. */
export async function p05Grafts() {
  const M5 = await import('../../src/game/modes/mode5-play.js');
  const CR = await import('../../src/game/modes/crossroom.js');
  const D = await import('../../src/game/objects/dispatch.js');
  const S = await import('../../src/game/objects/slots.js');
  const Mo = await import('../../src/game/objects/metaobject.js');
  const R = await import('../../src/game/objects/roomobjects.js');
  const Sp = await import('../../src/game/objects/spawnpos.js');
  const K = await import('../../src/game/objects/killcounts.js');
  const carry = (c) => ({ c, a: undefined });
  return {
    InitMode5Play: () => (M5.InitMode5Play(), {}),
    UpdateMode5Play: () => (M5.UpdateMode5Play(), {}),
    UpdateHeartsAndRupees: () => (M5.UpdateHeartsAndRupees(), {}),
    UpdatePlayer: () => (M5.UpdatePlayer(), { x: 0 }),
    Link_EndMoveAndAnimateInRoom: (r) => {
      const modeA = ram[0x12] === 0x0a; // GameMode: returns at once, X untouched
      M5.Link_EndMoveAndAnimateInRoom();
      return { x: modeA ? r.x : 0 };
    },
    MaskCurPpuMaskGrayscale: () => ({ a: M5.MaskCurPpuMaskGrayscale() }),
    RunCrossRoomTasksAndBeginUpdateMode_PlayModesNoCellar: () => ({ a: CR.RunCrossRoomTasksAndBeginUpdateMode_PlayModesNoCellar() }),
    RunCrossRoomTasksAndBeginUpdateMode_EnterPlayModes: () => ({ a: CR.RunCrossRoomTasksAndBeginUpdateMode_EnterPlayModes() }),
    RunCrossRoomTasksAndBeginUpdateMode: () => ({ a: CR.RunCrossRoomTasksAndBeginUpdateMode() }),
    UpdateObject: (r) => (D.UpdateObject(r.a, r.x), {}),
    InitObject: () => (D.InitObject(), {}),
    UpdateMetaObject: (r) => (Mo.UpdateMetaObject(r.x), {}),
    UpdateMetaObjectEnd: (r) => ({ a: Mo.UpdateMetaObjectEnd(r.x) }),
    UpdateDeadDummy: (r) => (Mo.UpdateDeadDummy(r.x), {}),
    ExtractHitPointValue: (r) => ({ a: D.ExtractHitPointValue(r.a) }),
    InitTileObjOrItem: (r) => ({ a: D.InitTileObjOrItem(r.x) }),
    InitFluteSecret: (r) => ({ a: D.InitFluteSecret(r.x) }),
    UpdateWhirlwind: (r) => (D.UpdateWhirlwind(r.x), {}),
    DecrementInvincibilityTimer: (r) => (S.DecrementInvincibilityTimer(r.x), {}),
    DestroyMonster: (r) => ({ a: S.DestroyMonster(r.x) }),
    SetTypeAndClearObject: (r) => ({ a: S.SetTypeAndClearObject(r.a, r.x) }),
    DestroyObject_WRAM: (r) => ({ a: S.DestroyObject_WRAM(r.a, r.x) }),
    DestroyMonster_Bank4: (r) => ({ a: S.DestroyMonster_Bank4(r.x) }),
    FindEmptyMonsterSlot: () => { const o = S.FindEmptyMonsterSlot(); return { a: o.a, y: o.y, z: o.y === 0 }; },
    ResetObjMetastateAndTimer: (r) => ({ a: S.ResetObjMetastateAndTimer(r.x) }),
    ResetObjMetastate: (r) => ({ a: S.ResetObjMetastate(r.x) }),
    CreateRoomObjects: () => (R.CreateRoomObjects(), {}),
    AssignObjSpawnPositions: () => (Sp.AssignObjSpawnPositions(), {}),
    IsSafeToSpawn: (r) => carry(Sp.IsSafeToSpawn(r.x)),
    IsDistanceSafeToSpawn: (r) => carry(Sp.IsDistanceSafeToSpawn(r.x)),
    FindNextEdgeSpawnCell: () => (Sp.FindNextEdgeSpawnCell(), {}),
    ClearRoomHistory: () => ({ a: K.ClearRoomHistory(), z: false }), // last DEY gives $FF
    ModifyObjCountByHistoryOW: () => (K.ModifyObjCountByHistoryOW(), {}),
    ModifyObjCountByHistoryUW: () => (K.ModifyObjCountByHistoryUW(), {}),
    SaveKillCountOW: () => (K.SaveKillCountOW(), {}),
    SaveKillCountUW: () => (K.SaveKillCountUW(), {}),
  };
}

/** Installs the grafts on an Oracle (p08-graft's installGrafts + C/Z flags). Returns call counters. */
export function installGrafts(oracle, grafts) {
  const counts = {};
  const byAddr = new Map();
  for (const [name, fn] of Object.entries(grafts)) {
    const { addr, bank } = label(name);
    byAddr.set(addr, { name, fn, bank: addr >= 0xc000 || addr < 0x8000 ? null : bank });
  }
  const rts = label('L1F36A_Exit').addr; // an RTS in the fixed bank
  const nes = oracle.nes;
  const cpu = nes.cpu;
  const mem = cpu.mem;
  const emulate = cpu.emulate.bind(cpu);
  cpu.emulate = () => {
    if (!cpu.nmiImmediate && !(cpu.irqRequested && cpu.F_INTERRUPT === 0) && cpu.cyclesToHalt === 0) {
      const pc = (cpu.REG_PC + 1) & 0xffff;
      const g = byAddr.get(pc);
      const curBank = oracle.prgBank ?? 0;
      if (g && (g.bank === null || g.bank === curBank)) {
        counts[g.name] = (counts[g.name] ?? 0) + 1;
        ram.set(mem.subarray(0, 0x800));
        sram.set(mem.subarray(0x6000, 0x8000));
        bus.mapper.shift = 0x10;
        switchBank(curBank);
        // The hardware stack ($0110-$01FF; $010E/$010F are real variables) keeps the game's return
        // addresses: hybrid stubs called by the JS run original code on a stack of their own.
        const stack = Uint8Array.from(mem.subarray(0x110, 0x200));
        portCpu.c = cpu.F_CARRY;
        const out = g.fn({ a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y });
        mem.set(ram, 0);
        mem.set(stack, 0x110);
        mem.set(sram, 0x6000);
        if (out.a !== undefined) cpu.REG_ACC = out.a & 0xff;
        if (out.x !== undefined) cpu.REG_X = out.x & 0xff;
        if (out.y !== undefined) cpu.REG_Y = out.y & 0xff;
        if (out.c !== undefined) cpu.F_CARRY = out.c ? 1 : 0;
        if (out.z !== undefined) cpu.F_ZERO = out.z ? 0 : 1; // jsnes: F_ZERO holds the result byte
        const bank = bus.mapper.prgBank & 0x0f;
        if (bank !== curBank) {
          nes.mmap.loadRomBank(bank, 0x8000);
          oracle.prgBank = bank;
        }
        cpu.REG_PC = rts - 1; // return to the caller through a real RTS
      }
    }
    return emulate();
  };
  return counts;
}

/** The grafts selected by P05_GRAFT (comma list, or "inner" = all but the top-level mode routines). */
export function selectGrafts(grafts, sel = process.env.P05_GRAFT) {
  if (!sel) return grafts;
  if (sel === 'inner') return Object.fromEntries(Object.entries(grafts).filter(([n]) => !TOP_LEVEL.includes(n)));
  const only = sel.split(',');
  return Object.fromEntries(Object.entries(grafts).filter(([n]) => only.includes(n)));
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet'] });
  if (!args._[0]) {
    console.error('usage: p05-graft.mjs <movie> [--sram f] [--out dir]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft', movie.name));
  mkdirSync(outDir, { recursive: true });
  const oracle = await Oracle.create({ rom: rom.bytes, sram: readOptionalSram(args.sram), powerOnFill: 0 });
  const counts = installGrafts(oracle, selectGrafts(await p05Grafts()));
  const writer = new TraceWriter(join(outDir, 'trace.ztrace'), {
    source: 'p05-graft', emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
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
