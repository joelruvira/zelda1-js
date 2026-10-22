// P06 test tool, "inverse hybrid": run the ORIGINAL game in jsnes (the oracle), but every time the
// 6502 reaches the entry of a ported P06 routine, run the JS port instead (on a copy of the
// emulator's RAM/SRAM/PRG bank) and return to the caller as its RTS would. Comparing that run with
// the pure original, frame by frame, checks the ports in real gameplay before the packages that call
// them (P05 objects, P08 Link, enemies) are ported.
//
//   node tests/game/p06-splice.mjs <movie.zmv> [--sram f.sav]   -> first divergent frame, or OK
//
// Routines of other packages that the ports call and that are still stubs run as original code
// (stub.js -> p01-hybrid.mjs, registered below before anything imports stub.js).
// Needs roms/zelda.nes and tools/oracle/node_modules/jsnes.

import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
});

const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
const { loadMovie } = await import('../../tools/oracle/lib/movie.mjs');
const { loadRom, loadSymbols, label } = await import('../../src/core/rom.js');
const { createMachine } = await import('../../src/core/machine.js');
const { ram, sram } = await import('../../src/core/ram.js');
const { bus } = await import('../../src/core/bus.js');
const V = await import('../../src/core/vars.js');
const M = await import('../../src/game/movement/walker.js');

const ROOT = new URL('../../', import.meta.url).pathname;

/** Output registers of each port: f(regs) -> {a?, x?, y?, c?} (missing = as the caller left them). */
const num = (k) => (v) => ({ [k]: v });
export const PORTS = {
  BoundDirectionHorizontally: (r) => ({ y: M.BoundDirectionHorizontally(r.x) }),
  BoundDirectionVertically: (r) => ({ y: M.BoundDirectionVertically(r.x) }),
  BoundByRoomWithA: (r) => ({ a: M.BoundByRoomWithA(r.a, r.x) }),
  BoundByRoom: (r) => ({ a: M.BoundByRoom(r.x) }),
  AddQSpeedToPositionFraction: (r) => ({ c: M.AddQSpeedToPositionFraction(r.x) }),
  SubQSpeedFromPositionFraction: (r) => ({ c: M.SubQSpeedFromPositionFraction(r.x) }),
  GetOppositeDir: (r) => M.GetOppositeDir(r.a),
  Abs: (r) => ({ a: r.n ? M.Negate(r.a) : r.a }), // the original tests the caller's N flag
  Negate: (r) => ({ a: M.Negate(r.a) }),
  GetDirectionsAndDistancesToTarget: (r) => ({ a: M.GetDirectionsAndDistancesToTarget(r.a, r.x) }),
  _CalcDiagonalSpeedIndex: (r) => ({ y: M._CalcDiagonalSpeedIndex(r.y) }),
  SetBoomerangSpeed: (r) => M.SetBoomerangSpeed(r.a, r.x),
  GetOneDirectionAndDistanceToTarget: (r) => ({ a: M.GetOneDirectionAndDistanceToTarget(r.a, r.y) }),
  SetupObjRoomBounds: () => ({ x: M.SetupObjRoomBounds() }),
  EnsureObjectAligned: (r) => M.EnsureObjectAligned(r.x),
  GetCollidableTileStill: (r) => ({ a: M.GetCollidableTileStill(r.x) }),
  GetCollidingTileMoving: (r) => ({ a: M.GetCollidingTileMoving(r.x) }),
  GetCollidableTile: (r) => ({ a: M.GetCollidableTile(r.x, r.y) }),
  Obj_Shove: (r) => M.Obj_Shove(r.x),
  ResetShoveInfo: (r) => ({ a: M.ResetShoveInfo(r.x) }),
  SetShoveInfoWith0: (r) => ({ a: M.SetShoveInfoWith0(r.a, r.x) }),
  Walker_Move: (r) => ({ x: M.Walker_Move(r.x) }),
  MoveObject: (r) => ({ x: M.MoveObject(r.x) }),
  Walker_CheckTileCollision: (r) => M.Walker_CheckTileCollision(r.x),
  TryNextDir: (r) => M.TryNextDir(r.x),
  ResetMovingDir: () => ({ a: M.ResetMovingDir() }),
  GoWalkableDir: (r) => M.GoWalkableDir(r.x),
  CheckScreenEdge: () => ({ x: M.CheckScreenEdge() }),
  GoToNextModeFromPlay: () => ({ a: 0, x: M.GoToNextModeFromPlay() }),
  CheckBoundary: (r) => M.CheckBoundary(r.x),
  Walker_GetNextAltDir: (r) => ({ a: M.Walker_GetNextAltDir(r.x) }),
  Walker_AltDir_GetRandomObjPerpendicularDir: (r) => ({ a: M.Walker_AltDir_GetRandomObjPerpendicularDir(r.x) }),
  Walker_AltDir_GetMovingOppositeDir: () => ({ a: M.Walker_AltDir_GetMovingOppositeDir() }),
  ReverseObjDir: (r) => ({ a: M.ReverseObjDir(r.x) }),
  Walker_AltDir_EndLoop: () => ({ a: M.Walker_AltDir_EndLoop() }),
  _FaceUnblockedDir: (r) => M._FaceUnblockedDir(r.x),
};
void num;

/**
 * Plays `movie` on the original (pure) and on the original with `names` spliced to the JS ports.
 * @returns {{frames:number, divergence:null|{frame:number, diffs:string[]}, calls:Object}}
 */
export async function spliceCompare(movie, { sram: sram0 = null, names = Object.keys(PORTS), maxDiffs = 12 } = {}) {
  const romBytes = readFileSync(resolve(ROOT, 'roms/zelda.nes'));
  await loadSymbols();
  createMachine(loadRom(romBytes)); // the port's bus/ROM for table() and read()

  const collect = async (splice) => {
    const oracle = await Oracle.create({ rom: romBytes, sram: sram0 });
    const frames = [];
    const calls = {};
    if (splice) installSplice(oracle, names, calls);
    oracle.run(movie, { write: (rec) => frames.push({ ram: rec.ram, sram: rec.sram }) });
    return { frames, calls };
  };
  const pure = await collect(false);
  const spliced = await collect(true);
  const n = Math.min(pure.frames.length, spliced.frames.length);
  for (let f = 0; f < n; f++) {
    const d = frameDiff(pure.frames[f], spliced.frames[f], maxDiffs);
    if (d.length) return { frames: n, divergence: { frame: f, diffs: d }, calls: spliced.calls, original: pure.frames };
  }
  return { frames: n, divergence: null, calls: spliced.calls, original: pure.frames };
}

const NAMES = (() => {
  const m = new Map();
  for (const [k, v] of Object.entries(V)) {
    if (typeof v !== 'number') continue;
    const size = V.VAR_SIZE?.[k] ?? 1;
    for (let i = 0; i < size; i++) if (!m.has(v + i)) m.set(v + i, i ? `${k}+${i}` : k);
  }
  return m;
})();
const hex = (v, n = 2) => v.toString(16).padStart(n, '0');

function frameDiff(a, b, max) {
  const out = [];
  for (let i = 0; i < 0x800 && out.length < max; i++) {
    if (i >= 0x110 && i < 0x200) continue; // stack (the port does not use it)
    if (a.ram[i] !== b.ram[i]) out.push(`$${hex(i, 4)} ${NAMES.get(i) ?? ''}: orig ${hex(a.ram[i])} spliced ${hex(b.ram[i])}`);
  }
  for (let i = 0; i < 0x2000 && out.length < max; i++) {
    if (i >= 0x0c90 && i < 0x1f00) continue; // RAM_01_CODE
    if (a.sram[i] !== b.sram[i]) out.push(`$${hex(0x6000 + i, 4)} ${NAMES.get(0x6000 + i) ?? ''}: orig ${hex(a.sram[i])} spliced ${hex(b.sram[i])}`);
  }
  return out;
}

function installSplice(oracle, names, calls) {
  const nes = oracle.nes;
  const cpu = nes.cpu;
  const mem = cpu.mem;
  const entries = new Map();
  for (const name of names) {
    const { bank, addr } = label(name);
    entries.set(addr, { name, bank: addr >= 0x8000 && addr < 0xc000 ? bank : null, fn: PORTS[name] });
  }
  const emulate = cpu.emulate.bind(cpu);
  cpu.emulate = () => {
    const pc = (cpu.REG_PC + 1) & 0xffff;
    const e = entries.get(pc);
    if (!e || cpu.nmiImmediate || (cpu.irqRequested && cpu.F_INTERRUPT === 0) || cpu.cyclesToHalt !== 0) return emulate();
    if (e.bank !== null && oracle.prgBank !== e.bank) return emulate();
    calls[e.name] = (calls[e.name] ?? 0) + 1;
    // Machine state -> port.
    ram.set(mem.subarray(0, 0x800));
    sram.set(mem.subarray(0x6000, 0x8000));
    const bank0 = oracle.prgBank ?? 0;
    bus.mapper.setPrgBank(bank0);
    const out = e.fn({ a: cpu.REG_ACC, x: cpu.REG_X, y: cpu.REG_Y, c: cpu.F_CARRY, n: cpu.F_SIGN }) ?? {};
    // Port -> machine (the stack page is the emulator's own).
    mem.set(ram.subarray(0, 0x100), 0);
    mem.set(ram.subarray(0x200, 0x800), 0x200);
    mem[0x10e] = ram[0x10e];
    mem[0x10f] = ram[0x10f];
    mem.set(sram, 0x6000);
    if (bus.mapper.prgBank !== bank0) {
      for (let i = 0; i < 5; i++) nes.mmap.write(0xe000, (bus.mapper.prgBank >> i) & 1); // SwitchBank
    }
    if (typeof out === 'object') {
      if (out.a !== undefined) {
        cpu.REG_ACC = out.a & 0xff;
        cpu.F_ZERO = cpu.REG_ACC;
        cpu.F_SIGN = cpu.REG_ACC >> 7;
      }
      if (out.x !== undefined) cpu.REG_X = out.x & 0xff;
      if (out.y !== undefined) cpu.REG_Y = out.y & 0xff;
      if (out.c !== undefined) cpu.F_CARRY = out.c;
    }
    // RTS
    cpu.REG_PC = cpu.pull();
    cpu.REG_PC += cpu.pull() << 8;
    return 6;
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const movie = loadMovie(resolve(args[0]));
  const si = args.indexOf('--sram');
  const sramFile = si >= 0 ? readFileSync(resolve(args[si + 1])) : null;
  const r = await spliceCompare(movie, { sram: sramFile });
  console.log(`frames: ${r.frames}; spliced calls: ${JSON.stringify(r.calls)}`);
  if (r.divergence) {
    console.log(`DIVERGENCE at frame ${r.divergence.frame}:\n  ${r.divergence.diffs.join('\n  ')}`);
    process.exit(1);
  }
  console.log('OK: identical RAM/SRAM in every frame');
}
