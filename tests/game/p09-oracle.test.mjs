// P09 against the oracle: the weapon scenarios (tests/game/p09-make-movies.mjs: ow-sword-kill,
// items-all, dark-room-candle; P08's ow-walk-sword; prepared SRAM tests/oracle/movies/p08-items.sav or
// p09-items.sav) are played in the original game twice: pure, and with every call to a P09 entry
// routine executed by the JS port (tests/game/p09-graft.mjs). RAM and SRAM must be identical on every
// frame (diff 0), and the movies must reach their expected states. The same movies in the pure port:
// tests/game/p09-pure.test.mjs. Skips without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

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

async function scenario(name) {
  const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
  const { loadRomFile } = await import('../../tools/oracle/lib/rom-file.mjs');
  const { loadMovie } = await import('../../tools/oracle/lib/movie.mjs');
  const { TraceCollector } = await import('../../tools/oracle/lib/trace.mjs');
  const { compareTraces, loadIgnoreConfig } = await import('../../tools/oracle/lib/diff-core.mjs');
  const { loadVarNames } = await import('../../tools/oracle/lib/var-names.mjs');
  const { loadSymbols, loadRom } = await import('../../src/core/rom.js');
  const { createMachine } = await import('../../src/core/machine.js');
  const { installGrafts } = await import('./p12-graft.mjs');
  const { p09Grafts } = await import('./p09-graft.mjs');

  const rom = loadRomFile();
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  // ow-walk-sword (P08) names out/sram/p08-items.sav: the same file lives in tests/oracle/movies.
  const sram = new Uint8Array(readFileSync(join(MOVIES, basename(expect.sram))));
  const movie = loadMovie(join(MOVIES, `${name}.zmv`));

  const pure = new TraceCollector({});
  (await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 })).run(movie, pure);
  const grafted = new TraceCollector({});
  const oracle = await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 });
  const counts = installGrafts(oracle, await p09Grafts());
  oracle.run(movie, grafted);

  const names = await loadVarNames();
  for (const [v, values] of Object.entries(expect.reaches ?? {})) {
    const [base, off] = v.split('+');
    const addr = names.resolve(base) + Number(off ?? 0);
    for (const value of [].concat(values)) {
      assert.ok(pure.frames.some((f) => f.ram[addr] === value), `${name}: ${v} never reaches ${value}`);
    }
  }
  const report = compareTraces(pure, grafted, { ignore: loadIgnoreConfig().ignore, compareFb: false });
  const first = report.frames[0];
  assert.equal(report.equal, true, `${name}: first divergence at frame ${report.firstDivergence}: `
    + JSON.stringify(first && { ram: first.ram.slice(0, 8), sram: first.sram.slice(0, 8) }));
  return counts;
}

// [movie, routines that must have been grafted (at least once)]
const SCENARIOS = [
  ['ow-walk-sword', ['WieldSword', 'UpdateSwordOrRod', 'UpdateSwordShotOrMagicShot']],
  ['ow-sword-kill', ['WieldSword', 'UpdateSwordOrRod', 'UpdateSwordShotOrMagicShot']],
  ['items-all', ['WieldItem', 'UpdateBoomerangOrFood', 'UpdateBombOrFire', 'UpdateRodOrArrow', 'DrawCloud']],
  ['dark-room-candle', ['WieldItem', 'UpdateCandle', 'UpdateBombOrFire']],
];

for (const [name, routines] of SCENARIOS) {
  test(`${name}: P09 grafted into the original game, diff 0`, { skip, timeout: 600000 }, async (t) => {
    const counts = await scenario(name);
    t.diagnostic(`grafted calls: ${JSON.stringify(counts)}`);
    for (const r of routines) assert.ok(counts[r] > 0, `${name}: ${r} never called`);
  });
}
