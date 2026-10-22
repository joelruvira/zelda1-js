#!/usr/bin/env node
// P15 "graft" oracle run: the ORIGINAL game runs in jsnes (tools/oracle Oracle), but every call to a
// P15 entry routine (cave people, shops, money game, underworld people, Grumble, bonfires,
// CheckPersonBlocking) is executed by the JS port instead (RAM/SRAM/bank synced in and out, then an RTS;
// same mechanism as p08-graft.mjs, except that routines of the RAM code ($6C90-$7EFF) are grafted
// whatever bank is mapped). The trace is compared with the pure oracle trace: any divergence comes
// from the P15 ports (or the JS routines they call). This checks P15 in real gameplay before the pure
// port can run the scenarios (P09 weapons and other routines of this wave are still being ported).
//
// Usage (the hybrid hook makes routines still stubbed in JS run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p15-graft.mjs <movie> [--sram f] --compare
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
export async function p15Grafts() {
  const C = await import('../../src/game/npc/cave.js');
  const U = await import('../../src/game/npc/uwperson.js');
  const G = await import('../../src/game/npc/grumble.js');
  return {
    InitCave: (r) => (C.InitCave(r.x), {}),
    UpdateCavePerson: (r) => (C.UpdateCavePerson(r.x), {}),
    UpdateStandingFire: (r) => (C.UpdateStandingFire(r.x), {}),
    InitUnderworldPerson_Full: (r) => (U.InitUnderworldPerson_Full(r.x), {}),
    InitUnderworldPersonLifeOrMoney_Full: (r) => (U.InitUnderworldPersonLifeOrMoney_Full(r.x), {}),
    UpdateUnderworldPerson_Full: (r) => (U.UpdateUnderworldPerson_Full(r.x), {}),
    UpdateUnderworldPersonLifeOrMoney_Full: (r) => (U.UpdateUnderworldPersonLifeOrMoney_Full(r.x), {}),
    InitGrumble_Full: (r) => (G.InitGrumble_Full(r.x), {}),
    UpdateGrumble_Full: (r) => (G.UpdateGrumble_Full(r.x), {}),
    // RAM code: A = 0 after ResetMovingDir, else A = [0F] & 8 or ObjY (callers only read [0F]).
    CheckPersonBlocking: (r) => {
      const a = U.CheckPersonBlocking();
      return a === undefined ? {} : { a };
    },
    Person_DrawAndCheckCollisions_Common: (r) => (U.Person_DrawAndCheckCollisions_Common(r.x), {}),
  };
}

/** Like p08-graft.mjs#installGrafts; routines in the RAM code run whatever bank is mapped. */
export function installGrafts15(oracle, grafts) {
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
        if (process.env.P15_GRAFT_LOG) console.log(`graft ${g.name} frame ${oracle.completedFrames} bank ${curBank} a=${cpu.REG_ACC} x=${cpu.REG_X} y=${cpu.REG_Y}`);
        ram.set(mem.subarray(0, 0x800));
        sram.set(mem.subarray(0x6000, 0x8000));
        bus.mapper.shift = 0x10;
        switchBank(curBank);
        const stack = Uint8Array.from(mem.subarray(0x110, 0x200));
        const out = g.fn({ a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y });
        mem.set(ram, 0);
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
  const args = parseArgs(argv, { flags: ['quiet', 'compare'] });
  if (!args._[0]) {
    console.error('usage: p15-graft.mjs <movie> [--sram f] [--out dir] [--compare]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft15', movie.name));
  mkdirSync(outDir, { recursive: true });
  const header = (source) => ({
    source, emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
    timing: movie.timing, frames: movie.length, powerOnFill: 0, sram: args.sram ?? null,
  });
  const oracle = await Oracle.create({ rom: rom.bytes, sram: readOptionalSram(args.sram), powerOnFill: 0 });
  const counts = installGrafts15(oracle, await p15Grafts());
  const tracePath = join(outDir, 'trace.ztrace');
  const writer = new TraceWriter(tracePath, header('p15-graft'));
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
