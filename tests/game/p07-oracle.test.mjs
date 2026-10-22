// P07 against the oracle (RAM + SRAM on every frame, diff 0):
//  * graft: the ORIGINAL game runs and every call to a P07 routine (from the original monsters, the
//    mode 5 loop, fire...) runs the JS port (tests/game/p07-graft.mjs);
//  * hybrid: the port runs the movie (src/headless.js) with every routine still stubbed running as
//    original 6502 code (tests/game/p01-hybrid.mjs).
// Movies (tests/game/p07-make-movies.mjs; SRAM tests/oracle/movies/p08-items.sav): link-knockback
// (octoroks touch Link: HarmLink, BeginShove, Link_BeHarmed), shield-parry (rocks parried), plus
// ow-enemies-spawn (monsters killed with the sword: DealDamage, HandleMonsterDied, monster shoves).
// The pure port is checked by the integration tests once the rest of the wave is in.
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
  const G5 = await import('./p05-graft.mjs');
  const G7 = await import('./p07-graft.mjs');
  const rom = loadRomFile();
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  lib = { Oracle, rom, loadMovie, TraceCollector, compareTraces, loadIgnoreConfig, runPort, loadVarNames, G5, G7 };
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

const traces = new Map();
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
  return { L, sram, movie, expect, oracle: traces.get(name) };
}

function assertSame(L, name, a, b) {
  const report = L.compareTraces(a, b, { ignore: L.loadIgnoreConfig().ignore, compareFb: false });
  const first = report.frames[0];
  assert.equal(report.equal, true, `${name}: first divergence at frame ${report.firstDivergence}: `
    + JSON.stringify(first && { ram: first.ram.slice(0, 8), sram: first.sram.slice(0, 8) })
    + (report.missing.length ? ` (missing ${report.missing.length} frames from ${report.missing[0]})` : ''));
}

const ObjShoveDir = 0xc0, Tune0Request = 0x604;
function events(frames) {
  let shoves = 0, parries = 0;
  for (let i = 1; i < frames.length; i++) {
    const m = frames[i].ram, p = frames[i - 1].ram;
    if ((m[ObjShoveDir] & 0x80) && !(p[ObjShoveDir] & 0x80)) shoves++;
    if (m[Tune0Request] & 0x01) parries++;
  }
  return { shoves, parries };
}

const MOVIE_SET = ['link-knockback', 'shield-parry', 'ow-enemies-spawn'];

for (const name of MOVIE_SET) {
  test(`P07 graft ${name} (P07 routines in the original game), diff 0`, { skip }, async (t) => {
    const { L, sram, movie, oracle, expect } = await scenario(name);
    const ev = events(oracle.frames);
    t.diagnostic(`oracle events: ${JSON.stringify(ev)}`);
    if (expect.events?.linkShoved) assert.ok(ev.shoves >= expect.events.linkShoved, 'Link is shoved');
    if (expect.events?.parries) assert.ok(ev.parries >= expect.events.parries, 'shots are parried');
    const o = await L.Oracle.create({ rom: L.rom.bytes, sram, powerOnFill: 0 });
    const counts = L.G5.installGrafts(o, await L.G7.p07Grafts());
    const tr = new L.TraceCollector({});
    o.run(movie, tr);
    t.diagnostic(`grafted calls: ${JSON.stringify(counts)}`);
    assert.ok(counts.CheckMonsterCollisions > 500);
    assertSame(L, name, oracle, tr);
  });

  test(`P07 hybrid ${name}: port + stubs as original code, diff 0`, { skip }, async () => {
    const { L, sram, movie, oracle } = await scenario(name);
    const port = new L.TraceCollector({});
    await L.runPort({ rom: L.rom.bytes, sram, powerOnFill: 0, inputs: movie, sink: port });
    assertSame(L, name, oracle, port);
  });
}
