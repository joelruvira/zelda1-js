#!/usr/bin/env node
// Measures, in the oracle, which instructions ever pay a data-dependent page-crossing cycle
// (abs,X / abs,Y / (zp),Y reads) and how often. Static costs (branches, fixed modes) need no
// runtime help; these are the only places where the port must supply an index to stay exact.
//
// Usage: node tools/timing/pagecross.mjs [movie.zmv ...]  (default: a representative set)
import { join } from 'node:path';

import { Oracle } from '../oracle/lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { loadMovie } from '../oracle/lib/movie.mjs';
import { readOptionalSram, runCli } from '../oracle/lib/cli.mjs';
import { loadRom } from '../../src/core/rom.js';
import { OPCODES } from './lib/opcodes.mjs';
import { buildCfg, instrAt } from './lib/cfg.mjs';
import { sramForMovie } from './measure-movie.mjs';

const DEFAULT = ['title-start', 'ow-tour', 'uw-level1-full', 'p06-to-level1', 'save-and-continue', 'register-name'];

export async function main(argv) {
  const movies = (argv.length ? argv : DEFAULT.map((m) => join(REPO_ROOT, 'tests/oracle/movies', `${m}.zmv`)));
  const romFile = loadRomFile();
  const cfg = buildCfg(loadRom(romFile.bytes));
  const stats = new Map(); // instr idx -> {exec, cross}
  let totalIndexedReads = 0, totalCross = 0;
  for (const path of movies) {
    const movie = loadMovie(path);
    const oracle = await Oracle.create({ rom: romFile.bytes, sram: readOptionalSram(sramForMovie(path)) });
    const cpu = oracle.nes.cpu, mem = cpu.mem;
    const emulate = cpu.emulate;
    cpu.emulate = function () {
      const intr = cpu.nmiImmediate || (cpu.irqRequested && cpu.F_INTERRUPT === 0) || cpu.cyclesToHalt !== 0;
      const pc = (cpu.REG_PC + 1) & 0xffff;
      const bank = oracle.prgBank;
      const r = emulate();
      if (intr) return r;
      const info = OPCODES[pc < 0x2000 ? mem[pc] : oracle.nes.mmap.load(pc)];
      if (!info || !info.penalty) return r;
      totalIndexedReads++;
      const crossed = cpu.instrBusCycles > info.cycles; // 1 extra bus cycle (dummy read)
      const idx = instrAt(cfg, pc, bank);
      let s = stats.get(idx);
      if (!s) stats.set(idx, (s = { exec: 0, cross: 0 }));
      s.exec++;
      if (crossed) { s.cross++; totalCross++; }
      return r;
    };
    oracle.run(movie, { write() {} });
    console.error(`${movie.name}: done`);
  }
  const crossing = [...stats].filter(([, s]) => s.cross > 0).sort((a, b) => b[1].cross - a[1].cross);
  const staticCandidates = cfg.instrs.filter((i) => i.penalty).length;
  console.log(`indexed reads with possible penalty in the program: ${staticCandidates} instructions`);
  console.log(`executed: ${stats.size} distinct, ${totalIndexedReads} executions; page crossed at ${crossing.length} instructions, ${totalCross} times`);
  for (const [idx, s] of crossing) {
    const i = cfg.instrs[idx];
    console.log(`  ${i?.routine ?? '?'} ${i?.file}:${i?.line} ${i?.mn} ${i?.operandText}  crossed ${s.cross}/${s.exec}`);
  }
  return 0;
}

if (import.meta.main) runCli(main);
