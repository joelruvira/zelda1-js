// Asm CFG (tools/timing/lib/cfg.mjs) and cycle tracker (tools/timing/lib/tracker.mjs) on the real ROM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasRom, hasDisasm, realRom } from '../core/helpers.mjs';

const skip = !hasRom ? 'no ROM (roms/zelda.nes)' : !hasDisasm ? 'no disassembly' : false;
const load = async () => {
  const { loadRom } = await import('../../src/core/rom.js');
  const { buildCfg } = await import('../../tools/timing/lib/cfg.mjs');
  const { Tracker, TimingError } = await import('../../tools/timing/lib/tracker.mjs');
  const cfg = buildCfg(loadRom(realRom()));
  return { cfg, Tracker, TimingError };
};

test('every asm instruction matches the ROM opcode', { skip }, async () => {
  const { cfg } = await load();
  assert.deepEqual(cfg.errors, []);
  assert.ok(cfg.instrs.length > 18000);
  assert.ok(cfg.routines.has('IsrNmi') && cfg.routines.has('WaitAndScrollToSplitBottom'));
});

test('IsrNmi prologue: PPUCTRL written on cycle 26 of the NMI; SwitchBank costs 40 cycles', { skip }, async () => {
  const { cfg, Tracker } = await load();
  const t = new Tracker(cfg);
  t.beginNmi({ absStart: 0, dot0: 7, bank: 0 });
  t.br('Z_07:391', true); // SwitchNameTablesReq = 0: BEQ taken
  assert.equal(t.io(0x2000, true), 7 + 3 * 26);
  const sb = cfg.instrs.findIndex((i) => i.labels.includes('SwitchBank'));
  assert.equal(t.opaque(sb), 6 + 5 * 4 + 4 * 2 + 6);
});

test('a missing breadcrumb is reported at the asm branch', { skip }, async () => {
  const { cfg, Tracker, TimingError } = await load();
  const t = new Tracker(cfg);
  t.beginNmi({ absStart: 0, dot0: 7, bank: 0 });
  assert.throws(() => t.io(0x2000, true), (e) => e instanceof TimingError && /Z_07:391 BEQ/.test(e.message));
});

test('OAM DMA: 513 cycles on an odd write cycle, 514 on an even one', { skip }, async () => {
  const { cfg, Tracker } = await load();
  for (const [absStart, extra] of [[4526669, 514], [4496888, 513]]) {
    const t = new Tracker(cfg);
    t.beginNmi({ absStart, dot0: 7, bank: 0 });
    t.br('Z_07:391', true);
    t.io(0x2000, true);
    t.br('Z_07:403', false); t.br('Z_07:405', false); t.br('Z_07:407', false);
    t.io(0x2001, true);
    t.io(0x2003, true);
    t.io(0x4014, true);
    const after = t.cycles;
    t.io(0x2005, true);
    assert.equal(t.cycles - after, 6, 'LDA # + STA $2005');
    assert.equal(after - 66, extra, `DMA write on cycle 65, absStart ${absStart}`);
  }
});
