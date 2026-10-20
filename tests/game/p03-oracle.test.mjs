// P03 against the oracle: movies that go through mode 2 (level load), run with the other packages of
// the wave as original code (tests/game/p03-hybrid-register.mjs). RAM, SRAM ($687E-$6C8F level block and
// info included) and the last frame's image must be identical. Skipped without roms/zelda.nes or jsnes.
//   register-name      : first quest, overworld
//   register-zelda-q2  : name ZELDA -> second quest file -> UpdateMode2Load_Full@PatchQ2Rooms
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists } from '../../tools/oracle/lib/rom-file.mjs';
import { ROOT } from '../core/helpers.mjs';

const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;

function run(args, hook) {
  const r = spawnSync(process.execPath, [...(hook ? ['--import', join(ROOT, 'tests/game/p03-hybrid-register.mjs')] : []), ...args],
    { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => !/Warning|trace-warnings/.test(l)).slice(-15).join('\n') };
}

for (const movie of ['register-name', 'register-zelda-q2']) {
  test(`P03 hybrid ${movie}: RAM, SRAM and image identical through mode 2`, { skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), `p03-${movie}-`));
    try {
      const o = join(dir, 'o');
      const p = join(dir, 'p');
      let r = run([join(ROOT, 'tools/oracle/run-oracle.mjs'), join(ROOT, 'tests/oracle/movies', `${movie}.zmv`), '--out', o, '--png', 'last', '--quiet']);
      assert.equal(r.code, 0, r.out);
      r = run([join(ROOT, 'tools/oracle/run-port.mjs'), '--inputs-from', join(o, 'trace.ztrace'), '--out', p], true);
      assert.equal(r.code, 0, r.out);
      r = run([join(ROOT, 'tools/oracle/diff.mjs'), join(o, 'trace.ztrace'), join(p, 'trace.ztrace')]);
      assert.equal(r.code, 0, r.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
