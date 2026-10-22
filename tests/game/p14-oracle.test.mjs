// P14 against the oracle (RAM + SRAM on every frame, diff 0), hybrid: the port runs the movie
// (src/headless.js) and every routine still stubbed (later packages) runs as original 6502 code
// (tests/game/p01-hybrid.mjs). Doors, shutters, secrets, room flags, warps and mazes are JS.
// Movies (tests/oracle/movies): lost-woods-maze, ow-bomb-secret, recorder-warp, ow-shortcut
// (p14-items.sav) and uw-cellar, uw-block-shutter (p08-items.sav), made by
// tests/game/p14-make-movies.mjs; uw-doorways, uw-level1-full (p08-items.sav: doorways, key doors)
// and cave-and-cellar (caves, level entrance).
// Skips without roms/zelda.nes or jsnes; a movie whose SRAM file is missing is skipped.
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
  lib = { Oracle, rom: loadRomFile(), loadMovie, TraceCollector, compareTraces, loadIgnoreConfig, runPort, loadVarNames };
  return lib;
}

/** SRAM file of a movie: tests/oracle/movies/<name>, or out/sram/<name> -> tests/oracle/movies/<basename>. */
function sramPath(expect) {
  if (!expect.sram) return null;
  const local = join(MOVIES, expect.sram.replace(/^out\/sram\//, ''));
  if (existsSync(local)) return local;
  const out = join(ROOT, expect.sram);
  return existsSync(out) ? out : undefined;
}

async function hybrid(t, name) {
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  const path = sramPath(expect);
  if (path === undefined) { t.skip(`SRAM ${expect.sram} missing`); return; }
  const L = await libs();
  const sram = path ? new Uint8Array(readFileSync(path)) : null;
  const movie = L.loadMovie(join(MOVIES, `${name}.zmv`));
  const oracle = new L.TraceCollector({});
  (await L.Oracle.create({ rom: L.rom.bytes, sram, powerOnFill: 0 })).run(movie, oracle);
  const names = await L.loadVarNames();
  for (const [v, values] of Object.entries(expect.reaches ?? {})) {
    const addr = names.resolve(v);
    for (const value of [].concat(values)) {
      assert.ok(oracle.frames.some((f) => f.ram[addr] === value), `${name}: ${v} never reaches ${value}`);
    }
  }
  const port = new L.TraceCollector({});
  await L.runPort({ rom: L.rom.bytes, sram, powerOnFill: 0, inputs: movie, sink: port });
  const report = L.compareTraces(oracle, port, { ignore: L.loadIgnoreConfig().ignore, compareFb: false });
  const first = report.frames[0];
  assert.equal(report.equal, true, `${name}: first divergence at frame ${report.firstDivergence}: `
    + JSON.stringify(first && { ram: first.ram.slice(0, 8), sram: first.sram.slice(0, 8) })
    + (report.missing.length ? ` (missing ${report.missing.length} frames from ${report.missing[0]})` : ''));
}

for (const name of ['lost-woods-maze', 'ow-bomb-secret', 'recorder-warp', 'ow-shortcut', 'uw-cellar', 'uw-block-shutter', 'uw-doorways', 'uw-level1-full', 'cave-and-cellar']) {
  test(`P14 hybrid ${name}: port + stubs as original code, diff 0`, { skip }, async (t) => {
    await hybrid(t, name);
  });
}
