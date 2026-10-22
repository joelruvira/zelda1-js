// P18 against the oracle (RAM + SRAM on every frame, diff 0):
//  * graft: the ORIGINAL game runs and every call to a P18 routine (the overworld monsters, CheckZora)
//    runs the JS port (tests/game/p18-graft.mjs);
//  * hybrid: the port runs the movie (src/headless.js) with every routine still stubbed (P19's goriya
//    walker, ...) running as original 6502 code (tests/game/p01-hybrid.mjs).
// Movies: ow-enemies-tour (one room per OW monster type, tests/game/p18-make-movies.mjs, SRAM
// p18-items.sav), walk-first-screens (octoroks, tektites, CheckZora), ow-graveyard (armos, lynel, peahat,
// ghini). The pure port is checked by tests/game/p18-pure.test.mjs. Skips without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
});

const H = await import('./p01-hybrid.mjs');
const { hasRom } = await import('../core/helpers.mjs');
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
  const { loadSymbols, loadRom } = await import('../../src/core/rom.js');
  const { createMachine } = await import('../../src/core/machine.js');
  const G8 = await import('./p08-graft.mjs');
  const G18 = await import('./p18-graft.mjs');
  const rom = loadRomFile();
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  lib = { Oracle, rom, loadMovie, TraceCollector, compareTraces, loadIgnoreConfig, runPort, G8, G18 };
  return lib;
}

const traces = new Map();
async function scenario(name) {
  const L = await libs();
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  const sram = expect.sram ? new Uint8Array(readFileSync(join(MOVIES, expect.sram.replace(/^out\/sram\//, '')))) : null;
  const movie = L.loadMovie(join(MOVIES, `${name}.zmv`));
  if (!traces.has(name)) {
    const t = new L.TraceCollector({});
    (await L.Oracle.create({ rom: L.rom.bytes, sram, powerOnFill: 0 })).run(movie, t);
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

// movie -> routines that must have been grafted at least once (the scenario exercises them).
const MOVIE_SET = {
  'ow-enemies-tour': ['CheckZora', 'UpdateZora', 'InitSlowOctorockOrGhini', 'InitFastOctorock', 'UpdateOctorock',
    'InitPeahat', 'UpdatePeahat', 'InitTektite', 'UpdateTektiteOrBoulder', 'InitLeever', 'UpdateBlueLeever',
    'UpdateRedLeever', 'InitBoulderSet', 'UpdateBoulderSet', 'InitBoulder', 'UpdateLynel', 'UpdateMoblin',
    'InitArmosOrFlyingGhini', 'UpdateArmos', 'UpdateGhini', 'UpdateFlyingGhini'],
  'walk-first-screens': ['CheckZora', 'UpdateOctorock', 'UpdateTektiteOrBoulder'],
  'ow-graveyard': ['InitArmosOrFlyingGhini', 'UpdateArmos', 'UpdateLynel', 'UpdatePeahat', 'UpdateGhini'],
};

for (const [name, mustRun] of Object.entries(MOVIE_SET)) {
  test(`P18 graft ${name} (P18 routines in the original game), diff 0`, { skip, timeout: 900000 }, async (t) => {
    const { L, sram, movie, oracle } = await scenario(name);
    const o = await L.Oracle.create({ rom: L.rom.bytes, sram, powerOnFill: 0 });
    const counts = L.G8.installGrafts(o, await L.G18.p18Grafts(o));
    const tr = new L.TraceCollector({});
    o.run(movie, tr);
    t.diagnostic(`grafted calls: ${JSON.stringify(counts)}`);
    for (const r of mustRun) assert.ok(counts[r] > 0, `${name}: ${r} never called`);
    assertSame(L, name, oracle, tr);
  });
}

for (const name of ['ow-enemies-tour', 'walk-first-screens']) {
  test(`P18 hybrid ${name}: port + stubs as original code, diff 0`, { skip, timeout: 900000 }, async () => {
    const { L, sram, movie, oracle } = await scenario(name);
    const port = new L.TraceCollector({});
    await L.runPort({ rom: L.rom.bytes, sram, powerOnFill: 0, inputs: movie, sink: port });
    assertSame(L, name, oracle, port);
  });
}
