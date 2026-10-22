// P05 objects: every ported routine vs. the original 6502 code (jsnes CPU, real ROM) on random
// RAM/SRAM states. Routines of other packages that are still stubs run as original code (the
// stub.js -> p01-hybrid.mjs redirection below), so the dispatchers (InitObject, UpdateObject...) are
// checked as a whole. Compares RAM (stack page excepted, $010E/$010F included), SRAM below
// RAM_01_CODE, the PRG bank and the output registers/flags each routine documents.
// The frame-level behaviour (UpdateMode5Play, InitMode5Play, cross-room tasks) is checked against
// the oracle in tests/game/p05-oracle.test.mjs. Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hasRom, realRom, ROOT } from '../core/helpers.mjs';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
});

const canRun = hasRom && existsSync(join(ROOT, 'tools/oracle/node_modules/jsnes/src/index.js'));
const skip = !canRun && 'needs roms/zelda.nes and tools/oracle jsnes';

let H, V, ram, sram, bus, rng, label;
let S, D, Mo, R, Sp, K, M5, CR;
if (canRun) {
  H = await import('./p01-hybrid.mjs');
  const { createGame } = await import('../../src/headless.js');
  await createGame({ rom: realRom() });
  (await import('../../src/core/asm.js')).switchBank(1);
  (await import('../../src/game/boot.js')).CopyCommonCodeToRam(); // RAM_01_CODE in SRAM, as InitMode does
  (await import('../../src/core/asm.js')).switchBank(6);
  (await import('../../src/game/boot.js')).CopyCommonDataToRam();
  V = await import('../../src/core/vars.js');
  ({ ram, sram } = await import('../../src/core/ram.js'));
  ({ bus } = await import('../../src/core/bus.js'));
  ({ label } = await import('../../src/core/rom.js'));
  ({ rng } = await import('./p04-harness.mjs'));
  S = await import('../../src/game/objects/slots.js');
  D = await import('../../src/game/objects/dispatch.js');
  Mo = await import('../../src/game/objects/metaobject.js');
  R = await import('../../src/game/objects/roomobjects.js');
  Sp = await import('../../src/game/objects/spawnpos.js');
  K = await import('../../src/game/objects/killcounts.js');
  M5 = await import('../../src/game/modes/mode5-play.js');
  CR = await import('../../src/game/modes/crossroom.js');
}

const SRAM_CODE = 0x0c90; // RAM_01_CODE starts at $6C90: kept as copied
let base = null; // SRAM as copied at boot (RAM_06_DATA etc.), restored before each case

function pick(r, arr) { return arr[r.int(arr.length)]; }

/** A random but plausible play state. */
function randomState(r) {
  base ??= Uint8Array.from(sram);
  for (let i = 0; i < 0x800; i++) ram[i] = r.byte();
  sram.set(base);
  for (let i = 0; i < 0x530; i++) sram[i] = r.byte(); // save files (world flags...)
  for (let i = 0x87e; i < 0xc90; i++) sram[i] = r.byte(); // level block
  const OW = r.chance(0.5);
  ram[V.CurLevel] = OW ? 0 : 1 + r.int(9);
  ram[V.RoomId] = r.int(0x80);
  ram[V.GameMode] = r.chance(0.6) ? 5 : pick(r, [4, 6, 9, 0x0a, 0x0b, 0x0c]);
  // Play area tiles: walkable-ish, the first unwalkable tile high enough.
  ram[V.ObjectFirstUnwalkableTile] = pick(r, [0x78, 0x84, 0x89, 0x8d, 0xf4, 0x26]);
  for (let i = 0x530; i < 0x7f0; i++) sram[i] = r.chance(0.7) ? r.int(0x78) : r.byte();
  // World flags pointer into the save area (as the level block holds it).
  const wf = 0x6000 + 0x100 + r.int(0x300);
  sram[V.LevelInfo_WorldFlagsAddr - 0x6000] = wf & 0xff;
  sram[V.LevelInfo_WorldFlagsAddr - 0x6000 + 1] = wf >> 8;
  for (let s = 0; s < 0x14; s++) {
    if (r.chance(0.6)) ram[V.ObjMetastate + s] = r.chance(0.5) ? 0 : pick(r, [1, 2, 3, 4, 0x10, 0x11, 0x13, 0x14]);
    if (r.chance(0.5)) ram[V.ObjUninitialized + s] = 0;
    if (r.chance(0.5)) ram[V.ObjInvincibilityTimer + s] = 0;
    if (r.chance(0.8)) ram[V.ObjDir + s] = pick(r, [1, 2, 4, 8]);
    if (r.chance(0.5)) ram[V.ObjShoveDir + s] = 0;
  }
  for (let s = 1; s < 0x0c; s++) if (r.chance(0.4)) ram[V.ObjType + s] = 0;
  if (r.chance(0.5)) ram[V.MonstersFromEdgesLongTimer] = 0;
  if (r.chance(0.5)) ram[V.LevelBlockAttrsByteF] &= ~0x08;
  if (r.chance(0.3)) ram[V.CurEdgeSpawnCell] = pick(r, [0x40, 0x4f, 0xe0, 0xef, 0x47, 0xe7, 0x80, 0x8f]);
  if (r.chance(0.5)) ram[V.RoomHistory + r.int(6)] = ram[V.RoomId];
  if (r.chance(0.7)) ram[V.CurRoomHistoryIndex] = r.int(6);
  bus.mapper.setPrgBank(r.chance(0.5) ? 5 : r.int(8));
}

function snapshot() {
  return { ram: Uint8Array.from(ram), sram: Uint8Array.from(sram.subarray(0, SRAM_CODE)), bank: bus.mapper.prgBank };
}
function restore(s) {
  ram.set(s.ram);
  sram.set(s.sram);
  bus.mapper.setPrgBank(s.bank);
}
function diffs(a, b) {
  const out = [];
  for (let i = 0; i < 0x800 && out.length < 8; i++) {
    if (i >= 0x100 && i < 0x200 && i !== 0x10e && i !== 0x10f) continue;
    if (a.ram[i] !== b.ram[i]) out.push(`$${i.toString(16).padStart(4, '0')}: port ${a.ram[i].toString(16)} orig ${b.ram[i].toString(16)}`);
  }
  for (let i = 0; i < SRAM_CODE && out.length < 8; i++) {
    if (a.sram[i] !== b.sram[i]) out.push(`$${(0x6000 + i).toString(16)}: port ${a.sram[i].toString(16)} orig ${b.sram[i].toString(16)}`);
  }
  if (a.bank !== b.bank) out.push(`bank: port ${a.bank} orig ${b.bank}`);
  return out;
}

const val = (ret, k) => (typeof ret === 'object' && ret !== null ? ret[k] : ret);
const reg = (k) => (ret, o) => (val(ret, k) === o[k] ? null : `${k}: port ${val(ret, k)} orig ${o[k]}`);
const both = (...cs) => (ret, o) => cs.map((c) => c(ret, o)).find((m) => m) ?? null;
const none = () => null;
const anyX = (r) => ({ x: r.int(0x14) });
const monster = (r) => ({ x: 1 + r.int(0x0b) });
const curObj = (r) => { const x = 1 + r.int(0x0b); return { x }; };
const setCur = (r, g) => { ram[V.CurObjIndex] = g.x; };

const cases = [
  ['DestroyObject_WRAM', (r) => ({ a: r.chance(0.8) ? 0 : r.byte(), x: r.int(0x14) }), (g) => S.DestroyObject_WRAM(g.a, g.x), reg('a')],
  ['DestroyMonster_Bank4', anyX, (g) => S.DestroyMonster_Bank4(g.x), reg('a')],
  ['DestroyMonster', anyX, (g) => S.DestroyMonster(g.x), reg('a')],
  ['SetTypeAndClearObject', (r) => ({ a: r.byte(), x: r.int(0x14) }), (g) => S.SetTypeAndClearObject(g.a, g.x), reg('a')],
  ['FindEmptyMonsterSlot', () => ({}), () => S.FindEmptyMonsterSlot(), both(reg('a'), reg('y'))],
  ['DecrementInvincibilityTimer', anyX, (g) => S.DecrementInvincibilityTimer(g.x), none],
  ['ResetObjMetastateAndTimer', anyX, (g) => S.ResetObjMetastateAndTimer(g.x), reg('a')],
  ['ResetObjMetastate', anyX, (g) => S.ResetObjMetastate(g.x), reg('a')],
  ['InitTileObjOrItem', anyX, (g) => D.InitTileObjOrItem(g.x), reg('a')],
  ['InitFluteSecret', anyX, (g) => D.InitFluteSecret(g.x), reg('a')],
  ['UpdateDeadDummy', anyX, (g) => Mo.UpdateDeadDummy(g.x), none],
  ['ExtractHitPointValue', (r) => ({ a: r.byte() }), (g) => D.ExtractHitPointValue(g.a), reg('a')],
  ['ClearRoomHistory', () => ({}), () => K.ClearRoomHistory(), reg('a')],
  ['MaskCurPpuMaskGrayscale', () => ({}), () => M5.MaskCurPpuMaskGrayscale(), reg('a')],
  ['IsSafeToSpawn', monster, (g) => Sp.IsSafeToSpawn(g.x), reg('c')],
  ['IsDistanceSafeToSpawn', (r) => ({ x: r.int(0x0c) }), (g) => Sp.IsDistanceSafeToSpawn(g.x), reg('c'),
    (r, g) => { if (r.chance(0.6)) ram[V.ObjX + g.x] = (ram[V.ObjX] + r.int(0x50) - 0x28) & 0xff; if (r.chance(0.6)) ram[V.ObjY + g.x] = (ram[V.ObjY] + r.int(0x50) - 0x28) & 0xff; }],
  ['FindNextEdgeSpawnCell', () => ({}), () => Sp.FindNextEdgeSpawnCell(), none,
    (r) => { ram[V.CurEdgeSpawnCell] = (r.int(11) + 4) << 4 | pick(r, [0, 0x0f, r.int(16)]); }],
  ['AssignObjSpawnPositions', () => ({}), () => Sp.AssignObjSpawnPositions(), none,
    (r) => {
      ram[0x02] = pick(r, [0, 0x37, r.byte()]);
      ram[V.RoomObjCount] = r.chance(0.3) ? 0 : 1 + r.int(9);
      ram[V.SpawnCycle] = r.int(9);
      ram[V.ObjDir] = pick(r, [1, 2, 4, 8]); // other values point the spawn list at I/O registers
      ram[V.ObjectFirstUnwalkableTile] = 0x84;
      for (let i = 0x530; i < 0x7f0; i++) sram[i] = r.int(0x84); // a safe spot always exists
    }],
  ['ModifyObjCountByHistoryOW', () => ({}), () => K.ModifyObjCountByHistoryOW(), none,
    (r) => { ram[0x03] = r.int(10); ram[0x02] = r.byte(); }],
  ['ModifyObjCountByHistoryUW', () => ({}), () => K.ModifyObjCountByHistoryUW(), none,
    (r) => { ram[0x03] = r.int(10); ram[0x02] = pick(r, [0x31, 0x32, 0x3a, 0x3b, 0x48, 0x49, r.byte()]); if (r.chance(0.5)) ram[V.LevelKillCounts + ram[V.RoomId]] = r.int(4); }],
  ['SaveKillCountOW', () => ({}), () => K.SaveKillCountOW(), none,
    (r) => { ram[V.RoomKillCount] = r.int(10); ram[V.RoomObjCount] = r.int(10); }],
  ['SaveKillCountUW', () => ({}), () => K.SaveKillCountUW(), none,
    (r) => {
      ram[V.RoomKillCount] = r.int(6); ram[V.RoomObjCount] = r.int(6);
      ram[V.RoomObjTemplateType] = pick(r, [0x31, 0x32, 0x3a, 0x3b, 0x48, 0x49, r.byte()]);
      ram[V.LevelKillCounts + ram[V.RoomId]] = r.int(4);
    }],
  ['CreateRoomObjects', () => ({}), () => R.CreateRoomObjects(), none,
    (r) => { if (r.chance(0.3)) ram[V.RoomId] = 0x5f; bus.mapper.setPrgBank(5); }],
  ['UpdateMetaObject', monster, (g) => Mo.UpdateMetaObject(g.x), none,
    (r, g) => {
      ram[V.ObjMetastate + g.x] = pick(r, [1, 2, 3, 4, 0x10, 0x11, 0x13, 0x14]);
      if (r.chance(0.5)) ram[V.ObjTimer + g.x] = 0;
      ram[V.ObjType + g.x] = pick(r, [0x07, 0x11, 0x14, 0x1c, 0x5d, 0x0d, 0x2a]);
      bus.mapper.setPrgBank(4);
    }],
  ['InitObject', curObj, () => D.InitObject(), none,
    (r, g) => {
      setCur(r, g);
      ram[V.ObjType + g.x] = r.chance(0.7) ? r.int(0x5f) : 0x5f + r.int(0x21);
    }],
  ['UpdateObject', curObj, (g) => D.UpdateObject(g.a, g.x), none,
    (r, g) => {
      setCur(r, g);
      ram[V.ObjType + g.x] = r.int(0x80);
      g.a = ram[V.ObjType + g.x];
      if (r.chance(0.5)) ram[V.ObjUninitialized + g.x] = 0;
    }],
  ['RunCrossRoomTasksAndBeginUpdateMode', () => ({}), () => CR.RunCrossRoomTasksAndBeginUpdateMode(), reg('a'),
    (r) => { ram[V.WhirlwindTeleportingState] = 0; ram[V.GameMode] = pick(r, [4, 5, 6, 9]); }],
];

const N = Number(process.env.P05_N ?? 300);
for (const [name, regsOf, port, cmp, tweak] of cases) {
  test(`P05 ${name} matches the original`, { skip }, () => {
    const r = rng(0x5050 + name.length * 977 + name.charCodeAt(0));
    let skipped = 0;
    for (let i = 0; i < N; i++) {
      const g = regsOf(r);
      randomState(r);
      tweak?.(r, g);
      // Banked code: its caller has mapped its bank.
      const { addr, bank } = label(name);
      if (addr >= 0x8000 && addr < 0xc000) bus.mapper.setPrgBank(bank);
      const start = snapshot();
      const before = { ...H.calls };
      let ret;
      try {
        ret = port(g);
      } catch (e) {
        // An original routine (stub run as 6502 code) that never returns on a random state.
        // Or a JS port whose TableJump index is out of its table (the original jumps to garbage).
        if (/did not return|Game crashed|TableJump: no handler/.test(e.message)) { skipped++; continue; }
        throw new Error(`${name} case ${i}: ${e.message}`);
      }
      const stubbed = Object.keys(H.calls).filter((k) => H.calls[k] !== before[k]);
      const p = snapshot();
      restore(start);
      let o;
      try {
        o = H.runOriginal(name, { a: g.a ?? 0, x: g.x ?? 0, y: g.y ?? 0 });
      } catch (e) {
        // Random states can crash original enemy/cave code run inside the routine (the stubs it
        // calls in the port get the same RAM, but not always the same A/Y/C).
        // Or a JS port whose TableJump index is out of its table (the original jumps to garbage).
        if (/did not return|Game crashed|TableJump: no handler/.test(e.message)) { skipped++; continue; }
        throw new Error(`${name} case ${i} regs ${JSON.stringify(g)}: original: ${e.message}; port ran ${stubbed.join(',')}`);
      }
      const d = diffs(p, snapshot());
      const m = cmp(ret, o);
      if (m) d.push(m);
      if (d.length) d.push(`stubs run as original: ${stubbed.join(',') || 'none'}`);
      if (d.length && process.env.P05_DEBUG) {
        for (const v of (process.env.P05_DEBUG).split(',')) d.push(`${v} = ${start.ram[V[v]]?.toString(16)}`);
      }
      assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
    }
    assert.ok(skipped < N / 4, `${name}: ${skipped} cases did not return`);
  });
}
