#!/usr/bin/env node
// P12 "graft" oracle run (technique of tests/game/p08-graft.mjs): the ORIGINAL game runs in jsnes and
// every call from original code to a P12 routine (room layout, tile map, door drawing) is executed by
// the JS port instead: RAM/SRAM/bank synced in and out, registers and the flags the callers test
// (C, Z/N) set from the port's contract, then a real RTS. The trace is diffed with the pure oracle
// trace: a divergence can only come from the P12 ports (or the JS routines they call). This checks
// P12 inside the real game (OW scrolls, caves, UW rooms, doors) before its callers (P13) are ported.
//
// Usage (the hybrid hook makes routines still stubbed in JS run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p12-graft.mjs <movie> [--sram f] [--out dir]
//   node tools/oracle/run-oracle.mjs <movie> --png none
//   node tools/oracle/diff.mjs out/oracle/<m>/trace.ztrace out/graft-p12/<m>/trace.ztrace --no-fb
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
import { CurRow } from '../../src/core/vars.js';

/** name -> (regs) => outputs {a?, x?, y?, c?, z?, nz?} (nz: set Z/N from this value). */
export async function p12Grafts() {
  const Lay = await import('../../src/game/world/layout.js');
  const Ow = await import('../../src/game/world/overworld.js');
  const Uw = await import('../../src/game/world/underworld.js');
  const Dd = await import('../../src/game/world/doors-draw.js');
  const Tm = await import('../../src/game/world/tilemap.js');
  return {
    MapScreenPosToPpuAddr: () => ({ a: Tm.MapScreenPosToPpuAddr() }),
    WriteDoorFaceTileHorizontally: (r) => { const x = Dd.WriteDoorFaceTileHorizontally(r.x); return { x, z: portCpu.z }; },
    FillWalls: () => (Uw.FillWalls(), {}),
    LayOutDoors: () => (Dd.LayOutDoors(), {}),
    L_LayOutDoors_LoopDoors: (r) => (Dd.L_LayOutDoors_LoopDoors(r.x), {}),
    FetchDoorAddrsFaceTilesSrcAndPlayAreaDst: (r) => ({ x: Dd.FetchDoorAddrsFaceTilesSrcAndPlayAreaDst(r.a, r.y) }),
    LayoutUWFloor: () => (Uw.LayoutUWFloor(), {}),
    LayOutRoom: () => (Lay.LayOutRoom(), {}),
    CopyColumnToTileBuf: () => (Tm.CopyColumnToTileBuf(), {}),
    CopyRowToTileBuf: () => ({ nz: Tm.CopyRowToTileBuf() }),
    LayoutRoomOW: () => (Ow.LayoutRoomOW(), {}),
    LayoutRoomOrCaveOW: () => (Ow.LayoutRoomOrCaveOW(), {}),
    CheckShortcut: () => (Ow.CheckShortcut(), {}),
    PatchColumnDirectoryForCellar: () => (Lay.PatchColumnDirectoryForCellar(), {}),
    LayoutCaveAndAvanceSubmode: () => (Lay.LayoutCaveAndAvanceSubmode(), {}),
    LayoutShortcutAndAdvanceSubmode: () => (Lay.LayoutShortcutAndAdvanceSubmode(), {}),
    LayoutCellarAndAdvanceSubmode: () => (Lay.LayoutCellarAndAdvanceSubmode(), {}),
    ChangePlayMapSquareOW: (r) => ({ x: Tm.ChangePlayMapSquareOW(r.x) }),
    FetchTileMapAddr: () => ({ nz: Tm.FetchTileMapAddr() }),
    CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone: () => ({ c: Tm.CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone() }),
    CopyNextRowToTransferBuf: () => { const c = Tm.CopyNextRowToTransferBuf(); return { a: ram[CurRow], c }; },
    LayoutRoom_SubmodeTask: () => (Lay.LayoutRoom_SubmodeTask(), {}),
    IsDarkRoom_Bank5: (r) => { const a = Lay.IsDarkRoom_Bank5(r.y); return { a, nz: a }; },
    ChangeTileObjTiles: (r) => { const a = Tm.ChangeTileObjTiles(r.a, r.x); return { a, x: r.x, nz: a }; },
    FillTileMap: () => ({ nz: Tm.FillTileMap() }),
  };
}

/** Installs the grafts on an Oracle. Returns the per-routine call counters. */
export function installGrafts(oracle, grafts) {
  const counts = {};
  const byAddr = new Map();
  for (const [name, fn] of Object.entries(grafts)) {
    const { addr, bank } = label(name);
    // fixed bank and WRAM code run whatever bank is mapped at $8000
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
        const stack = Uint8Array.from(mem.subarray(0x110, 0x200));
        portCpu.c = cpu.F_CARRY;
        const out = g.fn({ a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y });
        mem.set(ram, 0);
        mem.set(stack, 0x110); // the game's return addresses (not port state)
        mem.set(sram, 0x6000);
        if (out.a !== undefined) cpu.REG_ACC = out.a & 0xff;
        if (out.x !== undefined) cpu.REG_X = out.x & 0xff;
        if (out.y !== undefined) cpu.REG_Y = out.y & 0xff;
        if (out.c !== undefined) cpu.F_CARRY = out.c ? 1 : 0;
        if (out.nz !== undefined) { cpu.F_ZERO = out.nz & 0xff; cpu.F_SIGN = (out.nz >> 7) & 1; }
        if (out.z !== undefined) cpu.F_ZERO = out.z ? 0 : 1; // jsnes: F_ZERO holds a value, 0 = Z set
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

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet'] });
  if (!args._[0]) {
    console.error('usage: p12-graft.mjs <movie> [--sram f] [--out dir]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft-p12', movie.name));
  mkdirSync(outDir, { recursive: true });
  const sramInit = readOptionalSram(args.sram);
  const oracle = await Oracle.create({ rom: rom.bytes, sram: sramInit, powerOnFill: 0 });
  const counts = installGrafts(oracle, await p12Grafts());
  const writer = new TraceWriter(join(outDir, 'trace.ztrace'), {
    source: 'p12-graft', emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
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
