#!/usr/bin/env node
// P08 "graft" oracle run: the ORIGINAL game runs in jsnes (tools/oracle Oracle), but every call to a
// P08 routine is executed by the JS port instead (RAM/SRAM/bank synced in and out, registers per the
// port's contract, then an RTS). The trace it writes is compared with the pure oracle trace: any
// divergence comes from the P08 ports (or the JS routines they call). This exercises P08 inside the
// real game before its callers (P05 UpdatePlayer, P13 transitions) are ported.
//
// Usage (the hybrid hook makes routines still stubbed in JS run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p08-graft.mjs <movie> [--sram f] [--out dir]
//   then: node tools/oracle/diff.mjs out/oracle/<m>/trace.ztrace out/graft/<m>/trace.ztrace --no-fb
// Prints how many times each routine was grafted.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { TraceWriter } from '../../tools/oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { parseArgs, resolveMovie, readOptionalSram, runCli } from '../../tools/oracle/lib/cli.mjs';
import { loadSymbols, label, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram } from '../../src/core/ram.js';
import { bus } from '../../src/core/bus.js';
import { switchBank } from '../../src/core/asm.js';

/** name -> (cpu regs) => register updates {a?, x?, y?} after the call. */
export async function p08Grafts() {
  const In = await import('../../src/game/link/input.js');
  const Mv = await import('../../src/game/link/move.js');
  const La = await import('../../src/game/link/ladder.js');
  const An = await import('../../src/game/link/anim.js');
  return {
    DrawLinkBetweenRooms: () => (An.DrawLinkBetweenRooms(), {}),
    Link_FilterInput: () => (In.Link_FilterInput(), {}),
    MaskInputInBorder: (r) => (In.MaskInputInBorder(r.a, r.y), {}),
    CheckLadder: () => ({ x: La.CheckLadder() }),
    SetMovingDirAndSwitchToPlayerSlot: (r) => ({ x: La.SetMovingDirAndSwitchToPlayerSlot(r.a) }),
    Link_ModifyDirInDoorway: () => (In.Link_ModifyDirInDoorway(), {}),
    Link_HandleInput: () => (In.Link_HandleInput(), {}),
    InitLinkSpeed: () => ({ a: Mv.InitLinkSpeed() }),
    Link_ModifyDirOnGridLine: () => (Mv.Link_ModifyDirOnGridLine(), {}),
    SetObjDirAndInputDir: (r) => ({ a: Mv.SetObjDirAndInputDir(r.a) }),
    SetLinkInputDir: (r) => ({ a: Mv.SetLinkInputDir(r.a) }),
    Link_EndMoveAndAnimate_Bank4: () => (An.Link_EndMoveAndAnimate_Bank4(), {}),
    Link_EndMoveAndDraw_Bank1: () => (An.Link_EndMoveAndDraw_Bank1(), {}),
    Link_EndMoveAndAnimate_Bank1: () => (An.Link_EndMoveAndAnimate_Bank1(), {}),
    Link_EndMoveAndDraw_Bank4: () => (An.Link_EndMoveAndDraw_Bank4(), {}),
    Link_EndMoveAndDraw: () => (An.Link_EndMoveAndDraw(), {}),
    Link_EndMoveAndAnimateBetweenRooms: () => (An.Link_EndMoveAndAnimateBetweenRooms(), {}),
    Link_EndMoveAndAnimate: () => (An.Link_EndMoveAndAnimate(), {}),
    AnimateLinkBase: () => ({ y: An.AnimateLinkBase(0) }),
    AnimateLinkObjState: () => (An.AnimateLinkObjState(), {}),
  };
}

/** Installs the grafts on an Oracle. Returns the per-routine call counters. */
export function installGrafts(oracle, grafts) {
  const counts = {};
  const byAddr = new Map();
  for (const [name, fn] of Object.entries(grafts)) {
    const { addr, bank } = label(name);
    byAddr.set(addr, { name, fn, bank: addr >= 0xc000 ? null : bank });
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
        if (process.env.P08_GRAFT_LOG) console.log(`graft ${g.name} frame ${oracle.completedFrames} bank ${curBank} a=${cpu.REG_ACC} x=${cpu.REG_X} y=${cpu.REG_Y}`);
        ram.set(mem.subarray(0, 0x800));
        sram.set(mem.subarray(0x6000, 0x8000));
        bus.mapper.shift = 0x10;
        switchBank(curBank);
        const stack = Uint8Array.from(mem.subarray(0x110, 0x200));
        const out = g.fn({ a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y });
        mem.set(ram, 0);
        // The hardware stack ($0110-$01FF) is not port state: keep the game's return addresses
        // (the hybrid stubs run their 6502 code on a stack of their own and copy it back).
        mem.set(stack, 0x110);
        mem.set(sram, 0x6000);
        if (out.a !== undefined) cpu.REG_ACC = out.a & 0xff;
        if (out.x !== undefined) cpu.REG_X = out.x & 0xff;
        if (out.y !== undefined) cpu.REG_Y = out.y & 0xff;
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
    console.error('usage: p08-graft.mjs <movie> [--sram f] [--out dir]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft', movie.name));
  mkdirSync(outDir, { recursive: true });
  const sramInit = readOptionalSram(args.sram);
  const oracle = await Oracle.create({ rom: rom.bytes, sram: sramInit, powerOnFill: 0 });
  const counts = installGrafts(oracle, await p08Grafts());
  const writer = new TraceWriter(join(outDir, 'trace.ztrace'), {
    source: 'p08-graft', emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
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
