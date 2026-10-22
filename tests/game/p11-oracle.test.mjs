// P11 against the oracle: the scenarios pause-and-menu and uw-level1-map (prepared SRAM
// tests/oracle/movies/p11-items.sav) are played in the original game twice: pure, and with every
// call to a P11 entry routine executed by the JS port (tests/game/p11-graft.mjs). RAM and SRAM must
// be identical on every frame (diff 0), and the movies must reach their expected states.
// Once P05 (UpdateMode5Play) and P13 are ported, the same movies run end-to-end with
// `node tools/oracle/run-oracle.mjs <movie> --sram tests/oracle/movies/p11-items.sav` + run-port.
// Skips without roms/zelda.nes or jsnes.
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

async function scenario(name) {
  const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
  const { loadRomFile } = await import('../../tools/oracle/lib/rom-file.mjs');
  const { loadMovie } = await import('../../tools/oracle/lib/movie.mjs');
  const { TraceCollector } = await import('../../tools/oracle/lib/trace.mjs');
  const { compareTraces, loadIgnoreConfig } = await import('../../tools/oracle/lib/diff-core.mjs');
  const { loadVarNames } = await import('../../tools/oracle/lib/var-names.mjs');
  const { loadSymbols, loadRom } = await import('../../src/core/rom.js');
  const { createMachine } = await import('../../src/core/machine.js');
  const { installGrafts, p11Grafts } = await import('./p11-graft.mjs');

  const rom = loadRomFile();
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  const sram = new Uint8Array(readFileSync(join(MOVIES, expect.sram)));
  const movie = loadMovie(join(MOVIES, `${name}.zmv`));

  const pure = new TraceCollector({});
  (await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 })).run(movie, pure);
  const grafted = new TraceCollector({});
  const oracle = await Oracle.create({ rom: rom.bytes, sram, powerOnFill: 0 });
  const counts = installGrafts(oracle, await p11Grafts());
  oracle.run(movie, grafted);

  const names = await loadVarNames();
  for (const [v, values] of Object.entries(expect.reaches ?? {})) {
    const addr = names.resolve(v);
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

test('pause-and-menu: P11 grafted into the original game, diff 0', { skip }, async (t) => {
  const counts = await scenario('pause-and-menu');
  t.diagnostic(`grafted calls: ${JSON.stringify(counts)}`);
  assert.ok(counts.UpdateMenuAndMeters > 400);
});

test('uw-level1-map: P11 grafted into the original game, diff 0', { skip }, async (t) => {
  const counts = await scenario('uw-level1-map');
  t.diagnostic(`grafted calls: ${JSON.stringify(counts)}`);
  assert.ok(counts.UpdateMenuAndMeters > 300 && counts.ScrollWorld > 300 && counts.UpdateTriforcePositionMarker > 300);
});
