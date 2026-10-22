#!/usr/bin/env node
// Validates the frame-to-frame part of the timing model on the oracle: given only
//   * the cycle at which the previous NMI's RTI ended (the port's tracker knows it), and
//   * the PPU vblank times (262 x 341 dots per frame, 1 dot less on odd frames with rendering on),
// predict when each NMI starts (CPU cycle and raster dot) and whether its OAM DMA takes 513 or 514
// cycles. If the prediction is exact for every NMI of every movie, the port can carry exact timing
// from one frame to the next (including lag frames) with no input from the oracle.
//
// Usage: node tools/timing/nmi-model.mjs [movie.zmv ...]   (default: all movies)
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Oracle } from '../oracle/lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { loadMovie } from '../oracle/lib/movie.mjs';
import { readOptionalSram, runCli } from '../oracle/lib/cli.mjs';
import { sramForMovie } from './measure-movie.mjs';

const MOVIES = join(REPO_ROOT, 'tests/oracle/movies');

export async function collect(path, romBytes) {
  const movie = loadMovie(path);
  const oracle = await Oracle.create({ rom: romBytes, sram: readOptionalSram(sramForMovie(path)) });
  const cpu = oracle.nes.cpu, ppu = oracle.nes.ppu, mem = cpu.mem;
  const vbl = []; // absolute dot of each vblank (CPU cycle c covers dots 3c..3c+2)
  const nmis = [];
  let cur = null;
  const fire = ppu._fireVblankSet.bind(ppu);
  ppu._fireVblankSet = (c, dotsRemaining) => {
    const cycleIdx = cpu._cpuCycleBase + cpu.instrBusCycles - 1; // bus cycle being stepped
    vbl.push(dotsRemaining === 0 ? 3 * cycleIdx + 3 : 3 * cycleIdx + (3 - dotsRemaining));
    return fire(c, dotsRemaining);
  };
  const nmi = cpu.doNonMaskableInterrupt.bind(cpu);
  cpu.doNonMaskableInterrupt = (s) => {
    cur = { start: cpu._cpuCycleBase + cpu.instrBusCycles, vbl: vbl.length - 1, dma: 0, rendering: 0 };
    nmis.push(cur);
    return nmi(s);
  };
  const emulate = cpu.emulate;
  cpu.emulate = function () {
    const pc = (cpu.REG_PC + 1) & 0xffff;
    if (cur && !cpu.nmiImmediate && cpu.cyclesToHalt === 0 && mem[pc] === undefined) void 0;
    if (cur && !cpu.nmiImmediate && cpu.cyclesToHalt === 0 && oracle.nes.mmap.load(pc) === 0x40) {
      cur.end = cpu._cpuCycleBase + 6;
      cur = null;
    }
    return emulate();
  };
  const dmc = []; // cycles at which a DMC fetch halted the CPU (4 cycles in jsnes)
  const halt = cpu.haltCycles.bind(cpu);
  cpu.haltCycles = (n) => {
    if (cur && n >= 513 && !cur.dma) { cur.dma = n; cur.dmaCycle = cpu._cpuCycleBase + cpu.instrBusCycles; }
    // requested while the APU is clocked after an instruction: _cpuCycleBase is already its end
    if (n === 4) dmc.push(cpu._cpuCycleBase);
    return halt(n);
  };
  // rendering state at each pre-render line (decides the odd-frame skipped dot)
  oracle.run(movie, { write() {} });
  // jsnes frames are always 341 x 262 dots: rebuild vblank times from the first one (the per-event
  // estimate above is off while the CPU is halted by DMC/OAM DMA)
  const first = vbl.findIndex((v, k) => k > 0);
  const base = vbl[0];
  for (let k = 0; k < vbl.length; k++) vbl[k] = base + k * 89342;
  void first;
  return { name: movie.name, vbl, nmis, dmc };
}

/**
 * The model. Idle loop after RTI: JMP LoopForever (3 cycles) from cycle `end`. The NMI is taken at
 * the first instruction boundary b = end + 3k such that the vblank edge came at least `lead` dots
 * before the end of the instruction [b-3, b) (jsnes: >= 5 dots remaining -> taken after it), else
 * one instruction later. Returns the predicted start cycle.
 */
export function predictStart(end, vblDot, dmcHalts = []) {
  // Idle loop: JMP LoopForever, instruction [s, s+3) covers dots [3s, 3s+9). A DMC fetch requested
  // while an instruction runs halts the CPU 4 cycles right after it (jsnes; 1-4 on hardware).
  // Vblank edge inside an instruction with >= 5 dots left: NMI as soon as the CPU runs again
  // (after the halts); otherwise, or when the edge comes during a halt, after one more instruction.
  let k = 0;
  while (k < dmcHalts.length && dmcHalts[k] < end) k++;
  const haltsUntil = (t) => { let h = 0; while (k < dmcHalts.length && dmcHalts[k] <= t) { h += 4; k++; } return h; };
  let s = end;
  for (;;) {
    const iEnd = s + 3;
    const next = iEnd + haltsUntil(iEnd);
    if (3 * iEnd > vblDot) return 3 * iEnd - vblDot >= 5 ? next : next + 3;
    if (3 * next > vblDot) return next + 3;
    s = next;
  }
}

export async function main(argv) {
  const files = argv.length ? argv : readdirSync(MOVIES).filter((f) => f.endsWith('.zmv')).map((f) => join(MOVIES, f));
  const romBytes = loadRomFile().bytes;
  let total = 0, okStart = 0, okDma = 0, frameLens = new Map(), checked = 0, withDmc = 0, badDmc = 0;
  const bad = [];
  for (const f of files) {
    const { name, vbl, nmis, dmc } = await collect(f, romBytes);
    for (let k = 1; k < vbl.length; k++) {
      const d = vbl[k] - vbl[k - 1];
      frameLens.set(d, (frameLens.get(d) ?? 0) + 1);
    }
    for (let k = 1; k < nmis.length; k++) {
      const prev = nmis[k - 1], n = nmis[k];
      if (prev.end === undefined || n.vbl < 0) continue;
      total++;
      const s = predictStart(prev.end, vbl[n.vbl], dmc);
      const dmcInIdle = dmc.some((c) => c >= prev.end && c <= n.start);
      if (dmcInIdle) withDmc++;
      if (s === n.start) okStart++;
      else {
        if (dmcInIdle) badDmc++;
        if (bad.length < 20) bad.push(`${name}#${k + 1}: predicted ${s} actual ${n.start} (end ${prev.end}, vbl dot ${vbl[n.vbl]}${dmcInIdle ? ', DMC in idle loop' : ''})`);
      }
      if (n.dma) {
        checked++;
        // DMA write cycle = dmaCycle - 1 (jsnes increments after the write); 514 if even
        const pred = (n.dmaCycle) % 2 === 0 ? 514 : 513;
        if (pred === n.dma) okDma++;
      }
    }
    console.error(`${name}: ${nmis.length} NMIs`);
  }
  console.log(`NMI start predicted exactly: ${okStart}/${total} (${withDmc} NMIs had DMC fetches in the idle loop; ${badDmc} of the misses)`);
  console.log(`OAM DMA length from cycle parity: ${okDma}/${checked}`);
  console.log(`frame lengths (dots between vblanks): ${JSON.stringify(Object.fromEntries(frameLens))}`);
  if (bad.length) console.log(bad.join('\n'));
  return 0;
}

if (import.meta.main) runCli(main);
