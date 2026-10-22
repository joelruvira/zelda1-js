// P08 against the oracle on its scenarios (walk-first-screens, ow-walk-sword, ladder-crossing,
// uw-doorways). Two checks per movie:
//  1. graft: the ORIGINAL game runs in jsnes with every P08 routine executed by the JS port
//     (tests/game/p08-graft.mjs, routines not yet ported in JS run as original code): RAM/SRAM diff 0
//     against the pure oracle. This validates P08 inside the real game before its callers exist in JS.
//  2. full port (src/headless.js): diff 0 — skipped while the port still hits a NotImplementedError
//     (P05 UpdateMode5Play, P13 transitions... are later/parallel packages).
// The movies after walk-first-screens start from tests/oracle/movies/p08-items.sav, rebuilt here if missing from the oracle
// (tests/game/p08-make-movies.mjs). Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readTrace } from '../../tools/oracle/lib/trace.mjs';
import { loadVarNames } from '../../tools/oracle/lib/var-names.mjs';
import { join } from 'node:path';
import { hasRom, ROOT } from '../core/helpers.mjs';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';

const ok = hasRom && (await hasJsnes());
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const MOVIES = join(ROOT, 'tests/oracle/movies');
const SRAM = 'tests/oracle/movies/p08-items.sav';

const SCENARIOS = [
  ['walk-first-screens', null],
  ['ow-walk-sword', SRAM],
  ['ladder-crossing', SRAM],
  ['uw-doorways', SRAM],
];

function node(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('P08 scenarios: graft (P08 in JS inside the original game) and full port vs the oracle', { skip, timeout: 1800000 }, async (t) => {
  const { ensureItemsSram } = await import('./p08-make-movies.mjs');
  await ensureItemsSram();
  for (const [name, sram] of SCENARIOS) {
    const movie = join(MOVIES, `${name}.zmv`);
    if (!existsSync(movie)) {
      await t.test(name, { skip: `${name}.zmv not generated (node tests/game/p08-make-movies.mjs)` }, () => {});
      continue;
    }
    const sramArgs = sram ? ['--sram', sram] : [];
    const oracleDir = `out/oracle/${name}`;
    await t.test(`${name}: graft`, async () => {
      let r = node(['tools/oracle/run-oracle.mjs', movie, '--png', 'none', '--quiet', '--out', oracleDir, ...sramArgs]);
      assert.equal(r.code, 0, r.out);
      // The oracle run reaches the scenario's states (*.expect.json).
      const expectPath = join(MOVIES, `${name}.expect.json`);
      if (existsSync(expectPath)) {
        const expect = JSON.parse(readFileSync(expectPath, 'utf8'));
        const names = await loadVarNames();
        const frames = readTrace(join(ROOT, oracleDir, 'trace.ztrace')).frames;
        for (const [v, values] of Object.entries(expect.reaches ?? {})) {
          const addr = names.resolve(v);
          for (const value of values) assert.ok(frames.some((f) => f.ram[addr] === value), `${name}: ${v} never reaches ${value}`);
        }
      }
      r = node(['--import', './tests/game/p01-hybrid-register.mjs', 'tests/game/p08-graft.mjs', movie,
        '--out', `out/graft/${name}`, ...sramArgs]);
      assert.equal(r.code, 0, r.out);
      t.diagnostic(`${name}: ${r.out.trim().split('\n').find((l) => l.startsWith('grafted')) ?? ''}`);
      r = node(['tools/oracle/diff.mjs', `${oracleDir}/trace.ztrace`, `out/graft/${name}/trace.ztrace`, '--no-fb']);
      assert.equal(r.code, 0, r.out);
    });
    await t.test(`${name}: full port`, (st) => {
      const r = node(['tools/oracle/run-port.mjs', '--inputs-from', `${oracleDir}/trace.ztrace`, '--out', `out/port/${name}`]);
      if (r.code !== 0 && /NotImplementedError|is not ported yet/.test(r.out)) {
        st.skip(`port incomplete: ${(r.out.match(/[^\n]*is not ported yet/) ?? ['NotImplementedError'])[0]}`);
        return;
      }
      assert.equal(r.code, 0, r.out);
      const d = node(['tools/oracle/diff.mjs', `${oracleDir}/trace.ztrace`, `out/port/${name}/trace.ztrace`, '--no-fb']);
      assert.equal(d.code, 0, d.out);
    });
  }
});
