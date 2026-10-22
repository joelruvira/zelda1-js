// P05 against the oracle (RAM + SRAM on every frame, diff 0):
//  * hybrid: the port runs the movie (src/headless.js) and every routine still stubbed (later
//    packages, and parts of P13 while it is in progress) runs as original 6502 code
//    (tests/game/p01-hybrid.mjs). The mode 5 loop, object dispatch, metastates, spawn positions and
//    kill counts are JS.
//  * graft: the ORIGINAL game runs and every call to a P05 routine runs the JS port
//    (tests/game/p05-graft.mjs; "inner" = all but UpdateMode5Play/InitMode5Play, so the routines
//    called from the original mode 5 loop and from P13/P14 code are JS one by one).
// Movies: register-name, walk-first-screens, ow-enemies-spawn, room-revisit (both from
// out/sram/p08-items.sav, rebuilt by p08-make-movies if missing), pause-and-menu (p11-items.sav).
// The pure port (no hybrid) is checked in tests/game/p05-pure.test.mjs.
// Skips without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
});

const H = await import('./p01-hybrid.mjs');
const { hasRom, ROOT } = await import('../core/helpers.mjs');
const skip = !H.canRunHybrid || !hasRom ? 'needs roms/zelda.nes and tools/oracle jsnes' : false;
const MOVIES = join(import.meta.dirname, '../oracle/movies');

let lib = null;
async function libs() {
  if (lib) return lib;
  const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
  const { loadRomFile } = await import('../../tools/oracle/lib/rom-file.mjs');
  const { loadMovie } = await import('../../tools/oracle/lib/movie.mjs');
  const { TraceCollector } = await import('../../tools/oracle/lib/trace.mjs');
  const { compareTraces, loadIgnoreConfig } = await import('../../tools/oracle/lib/diff-core.mjs');
  const { runPort } = await import('../../tools/oracle/lib/port-adapter.mjs');
  const { loadVarNames } = await import('../../tools/oracle/lib/var-names.mjs');
  const { loadSymbols, loadRom } = await import('../../src/core/rom.js');
  const { createMachine } = await import('../../src/core/machine.js');
  const G = await import('./p05-graft.mjs');
  const rom = loadRomFile();
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  lib = { Oracle, rom, loadMovie, TraceCollector, compareTraces, loadIgnoreConfig, runPort, loadVarNames, G };
  return lib;
}

async function sramFor(expect) {
  if (!expect.sram) return null;
  if (expect.sram.startsWith('out/')) {
    const path = join(ROOT, expect.sram);
    if (!existsSync(path)) await (await import('./p08-make-movies.mjs')).ensureItemsSram();
    return new Uint8Array(readFileSync(path));
  }
  return new Uint8Array(readFileSync(join(MOVIES, expect.sram)));
}

const traces = new Map(); // movie -> oracle trace (pure original)
async function scenario(name) {
  const L = await libs();
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  const sram = await sramFor(expect);
  const movie = L.loadMovie(join(MOVIES, `${name}.zmv`));
  if (!traces.has(name)) {
    const t = new L.TraceCollector({});
    (await L.Oracle.create({ rom: L.rom.bytes, sram, powerOnFill: 0 })).run(movie, t);
    const names = await L.loadVarNames();
    for (const [v, values] of Object.entries(expect.reaches ?? {})) {
      const addr = names.resolve(v);
      for (const value of [].concat(values)) {
        assert.ok(t.frames.some((f) => f.ram[addr] === value), `${name}: ${v} never reaches ${value}`);
      }
    }
    traces.set(name, t);
  }
  return { L, sram, movie, oracle: traces.get(name) };
}

function assertSame(L, name, a, b) {
  const report = L.compareTraces(a, b, { ignore: L.loadIgnoreConfig().ignore, compareFb: false });
  const first = report.frames[0];
  assert.equal(report.equal, true, `${name}: first divergence at frame ${report.firstDivergence}: `
    + JSON.stringify(first && { ram: first.ram.slice(0, 8), sram: first.sram.slice(0, 8) })
    + (report.missing.length ? ` (missing ${report.missing.length} frames from ${report.missing[0]})` : ''));
}

async function hybrid(name) {
  const { L, sram, movie, oracle } = await scenario(name);
  const port = new L.TraceCollector({});
  await L.runPort({ rom: L.rom.bytes, sram, powerOnFill: 0, inputs: movie, sink: port });
  assertSame(L, name, oracle, port);
}

async function graft(name, sel) {
  const { L, sram, movie, oracle } = await scenario(name);
  const o = await L.Oracle.create({ rom: L.rom.bytes, sram, powerOnFill: 0 });
  const counts = L.G.installGrafts(o, L.G.selectGrafts(await L.G.p05Grafts(), sel));
  const t = new L.TraceCollector({});
  o.run(movie, t);
  assertSame(L, name, oracle, t);
  return counts;
}

for (const name of ['register-name', 'walk-first-screens', 'ow-enemies-spawn', 'room-revisit', 'pause-and-menu']) {
  test(`P05 hybrid ${name}: port + stubs as original code, diff 0`, { skip }, async () => {
    await hybrid(name);
  });
}

test('P05 graft walk-first-screens (mode 5 routines in the original game), diff 0', { skip }, async (t) => {
  const counts = await graft('walk-first-screens', 'UpdateMode5Play,InitMode5Play,AssignObjSpawnPositions,ModifyObjCountByHistoryOW,SaveKillCountOW,RunCrossRoomTasksAndBeginUpdateMode,RunCrossRoomTasksAndBeginUpdateMode_EnterPlayModes,ClearRoomHistory');
  t.diagnostic(`grafted calls: ${JSON.stringify(counts)}`);
  assert.ok(counts.UpdateMode5Play > 800 && counts.AssignObjSpawnPositions >= 5 && counts.SaveKillCountOW >= 4);
});

test('P05 graft room-revisit (inner routines one by one), diff 0', { skip }, async (t) => {
  const counts = await graft('room-revisit', 'inner');
  t.diagnostic(`grafted calls: ${JSON.stringify(counts)}`);
  assert.ok(counts.UpdateObject > 1000 && counts.ModifyObjCountByHistoryOW >= 10 && counts.SaveKillCountOW >= 10);
});
