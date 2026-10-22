// Prototype (tools/timing/proto): the port with the cycle tracker reproduces title-start frame 121.
// The breadcrumbs are text patches of src/ (proto/annotations.mjs); if a ported file changed so a
// patch no longer applies, the test is skipped with a message instead of failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { hasRom, hasDisasm, ROOT } from '../core/helpers.mjs';

const skip = !hasRom ? 'no ROM' : !hasDisasm ? 'no disassembly' : !(await hasJsnes()) ? 'jsnes not installed' : false;
const run = (...extra) => spawnSync(process.execPath, ['--no-warnings', '--import', join(ROOT, 'tools/timing/proto/register.mjs'),
  join(ROOT, 'tools/timing/proto/frame121.mjs'), ...extra], { cwd: ROOT, encoding: 'utf8' });

test('frames 7-121 chained from one seed: every NMI start, PPU access and NMI length exact; frame 121 == dot-accurate replay', { skip }, (t) => {
  const r = run('--from', '7');
  const out = r.stdout + r.stderr;
  if (/annotation for .* matches/.test(out)) return t.skip('src/ changed: update tools/timing/proto/annotations.mjs');
  assert.equal(r.status, 0, out);
  assert.match(out, /NMI start predicted 115\/115; frames with a PPU access off-cycle or a wrong NMI length: 0/);
  assert.match(out, /all at the same cycle/);
  assert.match(out, /port vs dot-accurate replay 0 px/);
  assert.match(out, /NMI ends at cycle (\d+) \(oracle \1\)/);
});

test('frame 121 with jsnes per-scanline semantics: identical to the oracle', { skip }, (t) => {
  const r = run('--jsnes-compat');
  const out = r.stdout + r.stderr;
  if (/annotation for .* matches/.test(out)) return t.skip('src/ changed: update tools/timing/proto/annotations.mjs');
  assert.match(out, /port vs oracle 0 px/);
});
