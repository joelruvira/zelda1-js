// P10 (items) against the oracle on its scenarios:
//   title-idle        AnimateItemObject in the story's item parade (pure port: the whole demo)
//   ow-enemies-spawn  drops (SetUpDroppedItem, UpdateItem, lifetime) in $78/$68 (P05 movie)
//   room-revisit      drops taken by Link (rupees, 5 rupees) (P05 movie)
//   cave-and-cellar   sword cave: TakeItem with lifting (CheckLiftItem, DrawLinkLiftingItem)
//   triforce-level1   level 1 to Aquamentus: dropped and room items (keys, map, boomerang, bombs,
//                     hearts), heart container, triforce piece (mode $12); tests/game/p10-make-movies.mjs
// Checks per movie:
//  1. the oracle run reaches the scenario's states (*.expect.json) and Link never dies;
//  2. graft: the ORIGINAL game runs in jsnes with every P10 routine executed by the JS port
//     (tests/game/p10-graft.mjs; routines of later packages run as original code): RAM/SRAM diff 0;
//  3. hybrid port: src/headless.js with the routines still stubbed running as original 6502 code
//     (tests/game/p01-hybrid-register.mjs): RAM/SRAM diff 0;
//  4. full port: diff 0, skipped while the port hits a NotImplementedError (later packages).
// Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTrace } from '../../tools/oracle/lib/trace.mjs';
import { loadVarNames } from '../../tools/oracle/lib/var-names.mjs';
import { hasRom, ROOT } from '../core/helpers.mjs';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';

const ok = hasRom && (await hasJsnes());
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const MOVIES = join(ROOT, 'tests/oracle/movies');
const SCENARIOS = ['title-idle', 'ow-enemies-spawn', 'room-revisit', 'cave-and-cellar', 'triforce-level1'];
// See tests/game/p10-graft.mjs: grafting all three per-frame routines moves a lag NMI in this movie.
const GRAFT_SKIP = { 'triforce-level1': 'TryTakeRoomItem' };

function node(args, env = {}) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 1 << 26, env: { ...process.env, ...env } }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

for (const name of SCENARIOS) {
  test(`P10 ${name}: oracle expectations, graft, hybrid and full port`, { skip, timeout: 3600000 }, async (t) => {
    const movie = join(MOVIES, `${name}.zmv`);
    if (!existsSync(movie)) {
      t.skip(`${name}.zmv not generated`);
      return;
    }
    const expectPath = join(MOVIES, `${name}.expect.json`);
    const expect = existsSync(expectPath) ? JSON.parse(readFileSync(expectPath, 'utf8')) : {};
    const sramArgs = [];
    if (expect.sram) {
      const sramPath = expect.sram.startsWith('out/') ? expect.sram : `tests/oracle/movies/${expect.sram}`;
      if (sramPath === 'out/sram/p08-items.sav') {
        const { ensureItemsSram } = await import('./p08-make-movies.mjs');
        await ensureItemsSram();
      }
      if (!existsSync(join(ROOT, sramPath))) {
        t.skip(`${sramPath} missing (run tests/game/p10-make-movies.mjs)`);
        return;
      }
      sramArgs.push('--sram', sramPath);
    }
    const oracleDir = `out/p10/oracle/${name}`;
    await t.test('oracle', async () => {
      const r = node(['tools/oracle/run-oracle.mjs', movie, '--png', 'none', '--quiet', '--out', oracleDir, ...sramArgs]);
      assert.equal(r.code, 0, r.out);
      const frames = readTrace(join(ROOT, oracleDir, 'trace.ztrace')).frames;
      assert.ok(!frames.some((f) => f.ram[0x12] === 0x11), `${name}: Link dies (GameMode $11)`);
      const names = await loadVarNames();
      for (const [v, values] of Object.entries(expect.reaches ?? {})) {
        const addr = names.resolve(v);
        for (const value of [].concat(values)) {
          assert.ok(frames.some((f) => f.ram[addr] === value), `${name}: ${v} never reaches ${value}`);
        }
      }
    });
    await t.test('graft', () => {
      let r = node(['--import', './tests/game/p01-hybrid-register.mjs', 'tests/game/p10-graft.mjs', movie,
        '--out', `out/p10/graft/${name}`, ...sramArgs], GRAFT_SKIP[name] ? { P10_GRAFT_SKIP: GRAFT_SKIP[name] } : {});
      assert.equal(r.code, 0, r.out);
      t.diagnostic(`${name}: ${r.out.trim().split('\n').find((l) => l.startsWith('grafted')) ?? ''}`);
      r = node(['tools/oracle/diff.mjs', `${oracleDir}/trace.ztrace`, `out/p10/graft/${name}/trace.ztrace`, '--no-fb']);
      assert.equal(r.code, 0, r.out);
    });
    await t.test('hybrid port', () => {
      const r = node(['--import', './tests/game/p01-hybrid-register.mjs', 'tools/oracle/run-port.mjs',
        '--inputs-from', `${oracleDir}/trace.ztrace`, '--out', `out/p10/hybrid/${name}`, ...sramArgs]);
      assert.equal(r.code, 0, r.out);
      const d = node(['tools/oracle/diff.mjs', `${oracleDir}/trace.ztrace`, `out/p10/hybrid/${name}/trace.ztrace`, '--no-fb']);
      assert.equal(d.code, 0, d.out);
    });
    await t.test('full port', (st) => {
      const r = node(['tools/oracle/run-port.mjs', '--inputs-from', `${oracleDir}/trace.ztrace`,
        '--out', `out/p10/port/${name}`, ...sramArgs]);
      if (r.code !== 0 && /NotImplementedError|is not ported yet/.test(r.out)) {
        st.skip(`port incomplete: ${(r.out.match(/[^\n]*is not ported yet/) ?? ['NotImplementedError'])[0]}`);
        return;
      }
      assert.equal(r.code, 0, r.out);
      const d = node(['tools/oracle/diff.mjs', `${oracleDir}/trace.ztrace`, `out/p10/port/${name}/trace.ztrace`, '--no-fb']);
      assert.equal(d.code, 0, d.out);
    });
  });
}
