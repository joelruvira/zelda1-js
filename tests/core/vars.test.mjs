import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as V from '../../src/core/vars.js';
import { ROOT, DISASM, hasDisasm } from './helpers.mjs';

test('generated variables have the disassembly addresses', () => {
  assert.equal(V.GameMode, 0x12);
  assert.equal(V.ObjX, 0x70);
  assert.equal(V.FrameCounter, 0x15);
  assert.equal(V.Sprites, 0x200);
  assert.equal(V.PpuData_2007, 0x2007);
  assert.equal(V.SaveRamEnd, 0x7fff);
  assert.equal(V.GLEEOK_SPEEDY, 3);
  assert.equal(V.VAR_REGION.InvRupees, 'ram');
  assert.equal(V.VAR_REGION.PlayAreaTiles, 'sram');
  assert.equal(V.VAR_SIZE.ObjX, 0x14);
});

test('every address variable is RAM, SRAM or an IO register', () => {
  for (const [name, region] of Object.entries(V.VAR_REGION)) {
    assert.notEqual(region, 'other', name);
    if (region === 'ram') assert.ok(V[name] < 0x800, name);
  }
});

test('src/core/vars.js is up to date with the .inc files', { skip: !hasDisasm && 'disassembly not present' }, () => {
  const out = join(mkdtempSync(join(tmpdir(), 'vars-')), 'vars.js');
  execFileSync(process.execPath, [join(ROOT, 'scripts/gen-vars.mjs'), DISASM, out], { stdio: 'pipe' });
  assert.equal(readFileSync(out, 'utf8'), readFileSync(join(ROOT, 'src/core/vars.js'), 'utf8'));
});
