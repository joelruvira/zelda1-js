#!/usr/bin/env node
// P11 "graft" oracle run (same technique as tests/game/p08-graft.mjs): the ORIGINAL game runs in
// jsnes (tools/oracle Oracle) and every call from original code to a P11 entry routine is executed by
// the JS port instead (RAM/SRAM/bank synced in and out, then a real RTS). The trace is diffed with
// the pure oracle trace: a divergence can only come from the P11 ports (or the JS routines they call).
// This exercises P11 inside the real game before its callers (P05 UpdateMode5Play/BeginUpdateWorld,
// P13 mode 7, P25 InitMode11) are ported. Only routines whose callers do not test flags after the
// call are grafted (the graft cannot return Z/C); the rest are covered by tests/game/p11-hud.test.mjs.
//
// Usage (the hybrid hook makes JS stubs run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p11-graft.mjs <movie> [--sram f] [--out dir]
//   node tools/oracle/run-oracle.mjs <movie> --sram f --png none
//   node tools/oracle/diff.mjs out/oracle/<m>/trace.ztrace out/graft/<m>/trace.ztrace --no-fb
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
export async function p11Grafts() {
  const Sub = await import('../../src/game/hud/submenu.js');
  const Sb = await import('../../src/game/hud/statusbar.js');
  const Me = await import('../../src/game/hud/meters.js');
  const Fm = await import('../../src/game/text/format.js');
  return {
    UpdateMenuAndMeters: () => (Sub.UpdateMenuAndMeters(), {}),
    DrawStatusBarItemsAndEnsureItemSelected: () => (Sb.DrawStatusBarItemsAndEnsureItemSelected(), {}),
    UpdateTriforcePositionMarker: () => (Sb.UpdateTriforcePositionMarker(), {}),
    UpdatePlayerPositionMarker: () => (Sb.UpdatePlayerPositionMarker(), {}),
    World_FillHearts: () => (Me.World_FillHearts(), {}),
    World_ChangeRupees: () => (Me.World_ChangeRupees(), {}),
    ScrollWorld: () => (Sub.ScrollWorld(), {}),
    FormatStatusBarText: () => (Fm.FormatStatusBarText(), {}),
  };
}

/** Installs the grafts on an Oracle (copy of p08-graft's installGrafts). Returns call counters. */
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
        // Hybrid stubs called by the JS run original code with their own stack at $01FD and down:
        // keep the game's stack page (the NMI's return addresses live there).
        const stack = Uint8Array.from(mem.subarray(0x100, 0x200));
        const out = g.fn({ a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y });
        mem.set(ram, 0);
        mem.set(stack, 0x100);
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
    console.error('usage: p11-graft.mjs <movie> [--sram f] [--out dir]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft', movie.name));
  mkdirSync(outDir, { recursive: true });
  const oracle = await Oracle.create({ rom: rom.bytes, sram: readOptionalSram(args.sram), powerOnFill: 0 });
  let grafts = await p11Grafts();
  if (process.env.P11_GRAFT) {
    const only = process.env.P11_GRAFT.split(',');
    grafts = Object.fromEntries(Object.entries(grafts).filter(([n]) => only.includes(n)));
  }
  const counts = installGrafts(oracle, grafts);
  const writer = new TraceWriter(join(outDir, 'trace.ztrace'), {
    source: 'p11-graft', emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
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
