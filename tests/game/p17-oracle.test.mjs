// P17 against the oracle (RAM + SRAM on every frame, diff 0):
//  * graft: the ORIGINAL game runs and every call to a P17 routine (from the original monsters, bosses,
//    pond fairy...) runs the JS port (tests/game/p17-graft.mjs);
//  * hybrid: the port runs the movie (src/headless.js) with every routine still stubbed running as
//    original 6502 code (tests/game/p01-hybrid.mjs): P17 runs from the JS object dispatch (shots,
//    fireballs, arrows, InitWalker) and from P16 (pond hearts rotation).
// Movies: shield-parry / link-knockback / ow-enemies-spawn (octorok rocks, wanderers, shooting),
// lost-woods-maze (moblin arrows), triforce-level1 (keese flyer engine, fireballs, aquamentus cries),
// pond-fairy (RotateObjectLocation / DecreaseObjectAngle). The pure port is checked by the integration
// tests once P18 (CheckZora, monsters) is in. Skips without roms/zelda.nes or jsnes.
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
  const G17 = await import('./p17-graft.mjs');
  const rom = loadRomFile();
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  lib = { Oracle, rom, loadMovie, TraceCollector, compareTraces, loadIgnoreConfig, runPort, G8, G17 };
  return lib;
}

const traces = new Map();
async function scenario(name) {
  const L = await libs();
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  // Prepared SRAMs live in tests/oracle/movies (older expects still name out/sram/...).
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
  'shield-parry': ['Wanderer_TargetPlayer', '_TryShooting', 'InitMonsterShot', 'UpdateMonsterShot', 'InitWalker'],
  'link-knockback': ['Wanderer_TargetPlayer', 'UpdateMonsterShot'],
  'ow-enemies-spawn': ['Wanderer_TargetPlayer', '_TryShooting'],
  'lost-woods-maze': ['UpdateMonsterArrow', 'UpdateFireball', 'ShootFireball'],
  'triforce-level1': ['UpdateCommonWanderer', 'MoveFlyer', 'Flyer_SpeedUp', 'Flyer_Wander', 'Flyer_Chase',
    'Flyer_SlowDown', '_ShootIfWanted', 'PlayBossHitCryIfNeeded', 'PlayBossDeathCryIfNeeded', 'UpdateFireball'],
  'pond-fairy': ['RotateObjectLocation', 'DecreaseObjectAngle'],
};

for (const [name, mustRun] of Object.entries(MOVIE_SET)) {
  test(`P17 graft ${name} (P17 routines in the original game), diff 0`, { skip, timeout: 600000 }, async (t) => {
    const { L, sram, movie, oracle } = await scenario(name);
    const o = await L.Oracle.create({ rom: L.rom.bytes, sram, powerOnFill: 0 });
    const counts = L.G8.installGrafts(o, await L.G17.p17Grafts(o));
    const tr = new L.TraceCollector({});
    o.run(movie, tr);
    t.diagnostic(`grafted calls: ${JSON.stringify(counts)}`);
    for (const r of mustRun) assert.ok(counts[r] > 0, `${name}: ${r} never called`);
    assertSame(L, name, oracle, tr);
  });
}

for (const name of ['shield-parry', 'pond-fairy']) {
  test(`P17 hybrid ${name}: port + stubs as original code, diff 0`, { skip, timeout: 600000 }, async () => {
    const { L, sram, movie, oracle } = await scenario(name);
    const port = new L.TraceCollector({});
    await L.runPort({ rom: L.rom.bytes, sram, powerOnFill: 0, inputs: movie, sink: port });
    assertSame(L, name, oracle, port);
  });
}
