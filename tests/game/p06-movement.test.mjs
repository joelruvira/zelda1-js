// P06 movement: every ported routine vs. the original 6502 code (jsnes CPU, real ROM) on random
// RAM/SRAM states. Routines of other packages that are still stubs run as original code (the
// stub.js -> p01-hybrid.mjs redirection below), so Walker_Move is checked as a whole.
// Compares RAM (stack page excepted, $010E/$010F included), SRAM below RAM_01_CODE, the PRG bank
// and the output registers each routine documents. Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { hasRom, realRom, ROOT } from '../core/helpers.mjs';
import { join } from 'node:path';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
});

const canRun = hasRom && existsSync(join(ROOT, 'tools/oracle/node_modules/jsnes/src/index.js'));
const skip = !canRun && 'needs roms/zelda.nes and tools/oracle jsnes';

let H, M, V, ram, sram, bus, rng;
if (canRun) {
  H = await import('./p01-hybrid.mjs');
  const { createGame } = await import('../../src/headless.js');
  await createGame({ rom: realRom() });
  (await import('../../src/core/asm.js')).switchBank(1);
  (await import('../../src/game/boot.js')).CopyCommonCodeToRam(); // RAM_01_CODE in SRAM, as InitMode does
  M = await import('../../src/game/movement/walker.js');
  V = await import('../../src/core/vars.js');
  ({ ram, sram } = await import('../../src/core/ram.js'));
  ({ bus } = await import('../../src/core/bus.js'));
  ({ rng } = await import('./p04-harness.mjs'));
}

const SRAM_CODE = 0x0c90; // RAM_01_CODE starts at $6C90: kept as copied by IsrReset
const DIRS = [0, 1, 2, 4, 8];

function pick(r, arr) { return arr[r.int(arr.length)]; }

/** A random but plausible game state for object `x`. */
function randomState(r, x) {
  for (let i = 0; i < 0x800; i++) ram[i] = r.byte();
  for (let i = 0; i < SRAM_CODE; i++) sram[i] = r.byte();
  const OW = r.chance(0.5);
  ram[V.CurLevel] = OW ? 0 : 1 + r.int(9);
  // Room bounds as SetupObjRoomBounds leaves them (or random).
  if (r.chance(0.9)) {
    const b = OW ? [0x11, 0xe0, 0x4e, 0xcd, 0x89] : [0x21, 0xd0, 0x5e, 0xbd, 0x78];
    for (let i = 0; i < 5; i++) ram[V.RoomBoundLeft + i] = b[i];
  }
  // Tiles: mostly walkable-ish values around the first unwalkable tile.
  if (r.chance(0.8)) {
    const fu = ram[V.ObjectFirstUnwalkableTile];
    for (let i = 0x530; i < 0x7f0; i++) {
      sram[i] = r.chance(0.5) ? (fu - 1 - r.int(8)) & 0xff : r.chance(0.3) ? pick(r, [0x8d, 0x91, 0x9c, 0xac, 0xad, 0xcc, 0xd2, 0xd5, 0xdf, 0x26]) : r.byte();
    }
  }
  for (let s = 0; s < 0x14; s++) {
    if (r.chance(0.6)) ram[V.ObjGridOffset + s] = 0;
    if (r.chance(0.7)) ram[V.ObjShoveDir + s] = 0;
    if (r.chance(0.5)) ram[V.ObjStunTimer + s] = 0;
    if (r.chance(0.8)) ram[V.ObjDir + s] = pick(r, [1, 2, 4, 8]);
    if (r.chance(0.7)) ram[V.ObjInputDir + s] = r.chance(0.8) ? pick(r, DIRS) : r.int(16);
    if (r.chance(0.5)) ram[V.ObjX + s] = r.byte() & 0xf8;
    if (r.chance(0.5)) ram[V.ObjY + s] = (r.byte() & 0xf8) | 5;
    if (r.chance(0.3)) ram[V.ObjAttr + s] &= ~0x10;
  }
  if (r.chance(0.3)) ram[V.ObjX + x] = pick(r, [0x00, 0xf0, 0x10, 0x80, 0xe0, 0x11]);
  if (r.chance(0.3)) ram[V.ObjY + x] = pick(r, [0x3d, 0xdd, 0x4d, 0x55, 0xbd, 0xcd]);
  if (r.chance(0.7)) ram[V.InvClock] = 0;
  ram[0x0f] = r.chance(0.85) ? pick(r, DIRS) : r.byte();
  if (r.chance(0.5)) ram[0x0e] = 0;
  ram[V.GameMode] = r.chance(0.7) ? 5 : pick(r, [4, 9, 0x0a, 0x0b, 0x0c, 6, 7, 0x10]);
  if (r.chance(0.7)) ram[V.DoorwayDir] = 0;
  // A slot index (zero-page arrays indexed with an out-of-range slot would wrap in page 0).
  ram[V.LadderSlot] = r.chance(0.7) ? 0 : 1 + r.int(0x13);
  if (r.chance(0.5)) ram[V.ObjState] &= 0x0f;
  if (r.chance(0.2)) ram[V.ObjType + 1] = pick(r, [0x36, 0x4b, 0x50, 0x52, 0x53]);
  if (r.chance(0.2)) ram[V.RoomId] = 0x1f;
  if (r.chance(0.5)) ram[V.WhirlwindTeleportingState] = 0;
  // CheckSubroom searches this array for RoomId (until found): make sure it is there.
  sram[V.LevelInfo_CellarRoomIdArray - 0x6000 + r.int(6)] = ram[V.RoomId];
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

/**
 * [name, regs(r) -> {a,x,y}, port(regs) -> ret, compare(ret, orig) -> mismatch string|null, tweak]
 */
const reg = (k) => (ret, o) => ((typeof ret === 'object' ? ret[k] : ret) === o[k] ? null : `${k}: port ${typeof ret === 'object' ? ret[k] : ret} orig ${o[k]}`);
const none = () => null;
const anyX = (r) => ({ x: r.int(0x14) });
const monster = (r) => ({ x: 1 + r.int(0x0b) });

const cases = [
  ['BoundDirectionHorizontally', anyX, (g) => M.BoundDirectionHorizontally(g.x), reg('y')],
  ['BoundDirectionVertically', anyX, (g) => M.BoundDirectionVertically(g.x), reg('y')],
  ['BoundByRoomWithA', (r) => ({ a: pick(r, DIRS), x: r.int(0x14) }), (g) => M.BoundByRoomWithA(g.a, g.x), reg('a')],
  ['BoundByRoom', anyX, (g) => M.BoundByRoom(g.x), reg('a')],
  ['AddQSpeedToPositionFraction', anyX, (g) => M.AddQSpeedToPositionFraction(g.x), reg('c'),
    (r, g) => { if (r.chance(0.5)) ram[V.ObjGridOffset + g.x] = pick(r, [8, 0xf8, 0x10, 0xf0]); }],
  ['SubQSpeedFromPositionFraction', anyX, (g) => M.SubQSpeedFromPositionFraction(g.x), reg('c'),
    (r, g) => { if (r.chance(0.5)) ram[V.ObjGridOffset + g.x] = pick(r, [8, 0xf8, 0x10, 0xf0]); }],
  ['GetOppositeDir', (r) => ({ a: r.chance(0.8) ? pick(r, [1, 2, 4, 8, 3, 0x0c]) : r.byte() }), (g) => M.GetOppositeDir(g.a),
    (ret, o) => reg('a')(ret, o) ?? reg('y')(ret, o)],
  // Abs: the original tests the N flag left by the caller's last load; the routine oracle can't
  // set it, so Abs is checked against Negate below.
  ['Negate', (r) => ({ a: r.byte() }), (g) => M.Negate(g.a), reg('a')],
  ['GetDirectionsAndDistancesToTarget', (r) => ({ a: r.int(0x14), x: r.int(0x14) }),
    (g) => M.GetDirectionsAndDistancesToTarget(g.a, g.x), reg('a'), (r) => { ram[0] = 0; }],
  ['_CalcDiagonalSpeedIndex', (r) => ({ y: r.chance(0.8) ? 4 : r.int(9) }), (g) => M._CalcDiagonalSpeedIndex(g.y), reg('y')],
  ['SetBoomerangSpeed', (r) => ({ a: r.byte(), x: r.int(0x14) }), (g) => M.SetBoomerangSpeed(g.a, g.x), none,
    (r, g) => { if (r.chance(0.5)) ram[V.ObjState + g.x] = 0x40 | r.int(16); if (r.chance(0.3)) ram[V.ObjMovingLimit + g.x] = 1; }],
  ['GetOneDirectionAndDistanceToTarget', (r) => ({ a: r.byte(), y: r.byte() }), (g) => M.GetOneDirectionAndDistanceToTarget(g.a, g.y), reg('a'),
    (r) => { ram[0x0a] = pick(r, [2, 8]); }],
  ['SetupObjRoomBounds', () => ({}), () => M.SetupObjRoomBounds(), reg('x')],
  ['EnsureObjectAligned', anyX, (g) => M.EnsureObjectAligned(g.x), none],
  ['GetCollidableTileStill', anyX, (g) => M.GetCollidableTileStill(g.x), reg('a')],
  ['GetCollidingTileMoving', anyX, (g) => M.GetCollidingTileMoving(g.x), reg('a')],
  ['GetCollidableTile', (r) => ({ x: r.int(0x14), y: pick(r, [0, 8, 0x10, 0xf0, 0xf8]) }), (g) => M.GetCollidableTile(g.x, g.y), reg('a')],
  ['Obj_Shove', anyX, (g) => M.Obj_Shove(g.x), none,
    (r, g) => {
      if (r.chance(0.7)) ram[V.ObjShoveDir + g.x] = (r.chance(0.5) ? 0x80 : 0) | pick(r, [1, 2, 4, 8]);
      if (r.chance(0.6)) ram[V.ObjShoveDistance + g.x] = r.int(0x20);
    }],
  ['ResetShoveInfo', anyX, (g) => M.ResetShoveInfo(g.x), reg('a')],
  ['SetShoveInfoWith0', (r) => ({ a: r.chance(0.5) ? 0 : r.byte(), x: r.int(0x14) }), (g) => M.SetShoveInfoWith0(g.a, g.x), reg('a')],
  ['Walker_Move', (r) => ({ x: r.chance(0.5) ? 0 : 1 + r.int(0x0b) }), (g) => M.Walker_Move(g.x), reg('x'),
    (r, g) => { if (r.chance(0.3)) ram[V.ObjQSpeedFrac + g.x] = pick(r, [0x20, 0x40, 0x60, 0x80]); }],
  ['MoveObject', anyX, (g) => M.MoveObject(g.x), reg('x')],
  ['Walker_CheckTileCollision', (r) => ({ x: r.chance(0.5) ? 0 : 1 + r.int(0x0b) }), (g) => M.Walker_CheckTileCollision(g.x), none],
  ['TryNextDir', monster, (g) => M.TryNextDir(g.x), none, (r) => { ram[0x0e] = r.int(4); }],
  ['ResetMovingDir', () => ({}), () => M.ResetMovingDir(), reg('a')],
  ['GoWalkableDir', (r) => ({ x: r.chance(0.5) ? 0 : 1 + r.int(0x0b) }), (g) => M.GoWalkableDir(g.x), none, (r) => { ram[0x0e] = r.int(4); }],
  ['CheckScreenEdge', () => ({}), () => M.CheckScreenEdge(), reg('x')],
  ['GoToNextModeFromPlay', () => ({}), () => M.GoToNextModeFromPlay(), reg('x')],
  ['CheckBoundary', monster, (g) => M.CheckBoundary(g.x), none, (r) => { ram[0x0e] = r.int(4); }],
  ['Walker_GetNextAltDir', anyX, (g) => M.Walker_GetNextAltDir(g.x), reg('a'), (r) => { ram[0x0e] = r.int(4); }],
  ['Walker_AltDir_GetRandomObjPerpendicularDir', anyX, (g) => M.Walker_AltDir_GetRandomObjPerpendicularDir(g.x), reg('a')],
  ['Walker_AltDir_GetMovingOppositeDir', () => ({}), () => M.Walker_AltDir_GetMovingOppositeDir(), reg('a')],
  ['ReverseObjDir', anyX, (g) => M.ReverseObjDir(g.x), reg('a')],
  ['Walker_AltDir_EndLoop', () => ({}), () => M.Walker_AltDir_EndLoop(), reg('a')],
  ['_FaceUnblockedDir', monster, (g) => M._FaceUnblockedDir(g.x), none],
];

const N = Number(process.env.P06_N ?? 400);
for (const [name, regsOf, port, cmp, tweak] of cases) {
  test(`P06 ${name} matches the original`, { skip }, () => {
    const r = rng(0x5060 + name.length * 977 + name.charCodeAt(0));
    for (let i = 0; i < N; i++) {
      const g = regsOf(r);
      randomState(r, g.x ?? 0);
      tweak?.(r, g);
      if (name === 'SetupObjRoomBounds') bus.mapper.setPrgBank(5); // banked code: its caller maps bank 5
      const start = snapshot();
      const before = { ...H.calls };
      const ret = port(g);
      const stubbed = Object.keys(H.calls).filter((k) => H.calls[k] !== before[k]);
      const p = snapshot();
      restore(start);
      const o = H.runOriginal(name, { a: g.a ?? 0, x: g.x ?? 0, y: g.y ?? 0 });
      const d = diffs(p, snapshot());
      const m = cmp(ret, o);
      if (m) d.push(m);
      if (d.length) d.push(`stubs run as original: ${stubbed.join(',') || 'none'}`);
      if (d.length && process.env.P06_DEBUG) {
        const o2 = snapshot();
        for (let k = 0; k < 0x800; k++) if ((k < 0x100 || k >= 0x200) && (start.ram[k] !== p.ram[k] || start.ram[k] !== o2.ram[k])) d.push(`  $${k.toString(16)} start ${start.ram[k].toString(16)} port ${p.ram[k].toString(16)} orig ${o2.ram[k].toString(16)}`);
      }
      assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
    }
  });
}

test('P06 Abs = Negate for negative values, identity otherwise', { skip }, () => {
  for (let a = 0; a < 256; a++) {
    const o = H.runOriginal('Negate', { a });
    assert.equal(M.Abs(a), a & 0x80 ? o.a : a);
  }
});
