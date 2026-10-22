// P18: every overworld-monster routine (octoroks, moblins, lynels, tektites, boulders, leevers, zora,
// peahats, ghinis, armos) vs. the original 6502 code (jsnes CPU, real ROM) on random states. The routines
// P18 calls in other packages run as original code (p18-hybrid-register.mjs; P01 stays JS; P18_REAL=1
// uses the real JS modules instead), so this isolates P18. Compares the whole RAM (stack page excepted),
// the SRAM and the output registers. Skipped without roms/zelda.nes or jsnes.
import './p18-hybrid-register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P18_N ?? 200);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram, cpu } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const Z = await imp('../../src/game/enemies/zora.js');
const O = await imp('../../src/game/enemies/octorok.js');
const M = await imp('../../src/game/enemies/moblin-lynel.js');
const T = await imp('../../src/game/enemies/tektite-boulder.js');
const L = await imp('../../src/game/enemies/leever.js');
const P = await imp('../../src/game/enemies/peahat.js');
const G = await imp('../../src/game/enemies/ghini.js');
const A = await imp('../../src/game/enemies/armos.js');

const DIRS = [1, 2, 4, 8];
// The valid 8-way directions (built, not copied from the ROM table Directions8).
const DIRS8 = [...DIRS, ...[4, 8].flatMap((v) => [1, 2].map((h) => v | h))];
const pick = (r, arr) => arr[r.int(arr.length)];
const WATER = [0x8d, 0x90, 0x95, 0x98, 0x99];
const OW_TILES = [0x24, 0x26, 0x74, 0xb0, 0xbc, 0xc0, 0xc8, 0x70, 0x8d, 0x8f, 0x95, 0x98, 0x99];

// A random but plausible mode-5 OW state: Link in slot 0, monsters and shots in slots 1..$B.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0x530; i < 0x7f0; i++) sr[i] = r.chance(0.6) ? pick(r, OW_TILES) : r.byte();
  for (let i = 0x87e; i < 0xc90; i++) sr[i] = r.byte();
  st[V.CurLevel] = r.chance(0.85) ? 0 : 1 + r.int(9);
  st[V.GameMode] = 5;
  st[V.ObjX] = r.chance(0.5) ? pick(r, [0x60, 0x80, 0x78, 0x40]) : r.byte();
  st[V.ObjY] = r.chance(0.5) ? pick(r, [0x5d, 0x7d, 0x8d, 0xad]) : r.byte();
  st[V.ObjDir] = pick(r, DIRS);
  st[V.ObjState] = r.chance(0.8) ? 0 : r.byte();
  st[V.ChaseTargetX] = r.chance(0.7) ? st[V.ObjX] : r.byte();
  st[V.ChaseTargetY] = r.chance(0.7) ? st[V.ObjY] : r.byte();
  for (let i = 1; i < 0x14; i++) {
    st[V.ObjType + i] = r.chance(0.4) ? 0 : r.int(0x5d);
    st[V.ObjDir + i] = r.chance(0.8) ? pick(r, DIRS) : r.int(16);
    st[V.ObjMetastate + i] = r.chance(0.8) ? 0 : r.byte();
    st[V.ObjShoveDir + i] = r.chance(0.7) ? 0 : r.byte();
    st[V.ObjStunTimer + i] = r.chance(0.8) ? 0 : r.byte();
    st[V.ObjInvincibilityTimer + i] = r.chance(0.7) ? 0 : r.byte();
    st[V.ObjTimer + i] = r.chance(0.5) ? 0 : r.byte();
    if (r.chance(0.5)) {
      st[V.ObjX + i] = (st[V.ObjX] + r.int(0x30) - 0x18) & 0xff;
      st[V.ObjY + i] = (st[V.ObjY] + r.int(0x30) - 0x18) & 0xff;
      if (r.chance(0.3)) st[V.ObjX + i] = st[V.ObjX];
      if (r.chance(0.3)) st[V.ObjY + i] = st[V.ObjY];
    }
    if (r.chance(0.5)) st[V.ObjGridOffset + i] = pick(r, [0, 0x10, 0xf0, 0x08, r.byte()]);
  }
  st[V.InvClock] = r.chance(0.8) ? 0 : 1;
  st[V.ActiveMonsterShots] = r.int(6);
  st[V.LadderSlot] = 0;
  st[V.DoorwayDir] = 0;
  st[V.ObjectFirstUnwalkableTile] = pick(r, [0x89, 0x78, 0x84]);
  return { st, sr };
}

const RA = (ret, o) => assert.equal(ret & 0xff, o.a, 'register A');
const RY = (ret, o) => assert.equal(ret, o.y, 'register Y');
const slot = (r) => ({ x: 1 + r.int(0x0b) });
const setType = (types) => (st, sr, r, g) => {
  st[V.ObjType + g.x] = pick(r, types);
  st[V.CurObjIndex] = g.x;
  if (r.chance(0.7)) st[V.ObjShoveDir + g.x] = 0;
  if (r.chance(0.7)) st[V.ObjStunTimer + g.x] = 0;
  if (r.chance(0.7)) st[V.ObjMetastate + g.x] = 0;
};
const mix = (...fs) => (st, sr, r, g) => { for (const f of fs) f(st, sr, r, g); };

const walker = (st, sr, r, g) => {
  if (r.chance(0.6)) st[V.ObjGridOffset + g.x] = pick(r, [0, 0x10, 0xf0]);
  if (r.chance(0.5)) st[V.ObjTurnTimer + g.x] = r.int(2);
  if (r.chance(0.5)) st[V.ObjShootTimer + g.x] = pick(r, [0, 1, 0x10, 0x11, 0x30]);
  if (r.chance(0.5)) st[V.ObjAnimCounter + g.x] = 1;
};
const jumper = (st, sr, r, g) => {
  st[V.ObjDir + g.x] = r.chance(0.9) ? pick(r, DIRS8) : r.byte();
  st[V.ObjState + g.x] = r.chance(0.5) ? 0 : r.chance(0.8) ? 1 : r.byte();
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = r.chance(0.5) ? 0 : pick(r, [0x20, 0x21, 0x40]);
  if (r.chance(0.5)) st[V.Jumper_ObjReversalCount + g.x] = r.int(3);
  if (r.chance(0.5)) st[V.Jumper_ObjSpeedWholeY + g.x] = pick(r, [0xfc, 0xfd, 0xfe, 0xff, 0, 1, 2]);
  if (r.chance(0.5)) st[V.Jumper_ObjTargetY + g.x] = (st[V.ObjY + g.x] + r.int(7) - 3) & 0xff;
  if (r.chance(0.3)) st[V.ObjY + g.x] = 0xf0 + r.int(16);
  if (r.chance(0.5)) st[V.ActiveBoulders] = r.int(4);
};
const burrower = (st, sr, r, g) => {
  st[V.ObjState + g.x] = r.chance(0.9) ? r.int(6) : r.byte();
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = r.chance(0.5) ? 0 : pick(r, [0xfd, 0xfe, 1]);
  if (r.chance(0.5)) st[V.ObjAnimCounter + g.x] = 1;
  if (r.chance(0.5)) st[V.ObjDir + g.x] = r.int(4);
  if (r.chance(0.5)) st[V.RedLeeverLongTimer] = 0;
  if (r.chance(0.5)) st[V.ActiveRedLeeverCount] = r.int(3);
  if (r.chance(0.5)) st[V.ZoraActive] = 1;
};
const flyer = (st, sr, r, g) => {
  st[V.ObjDir + g.x] = r.chance(0.9) ? pick(r, DIRS8) : r.byte();
  st[V.Flyer_ObjFlyingState + g.x] = r.int(6);
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0;
  if (r.chance(0.3)) st[V.Flyer_ObjTurns + g.x] = 1;
  if (r.chance(0.3)) st[V.Flyer_ObjSpeed + g.x] = pick(r, [0x1f, 0x20, 0x9f, 0xa0]);
};
const zoraRoom = (st, sr, r) => {
  st[V.RoomId] = r.int(0x80);
  if (r.chance(0.7)) sr[0x87e + st[V.RoomId]] |= 0x08;
  if (r.chance(0.7)) st[V.ZoraActive] = 0;
  for (let i = 1; i < 0x0c; i++) if (r.chance(0.3)) st[V.ObjType + i] = 0;
  // Water squares where the random coordinates land often enough.
  for (let i = 0x530; i < 0x7f0; i++) if (r.chance(0.4)) sr[i] = pick(r, WATER);
};
const armos = (st, sr, r, g) => {
  st[V.ObjType + g.x] = r.chance(0.7) ? 0x1e : 0x22;
  if (r.chance(0.6)) st[V.ObjTimer + g.x] = r.chance(0.7) ? 0 : r.int(4);
  const rooms = [0x24, 0x0b, 0x1c, 0x22, 0x34, 0x3d, 0x4e];
  const xs = [0xe0, 0xb0, 0xb0, 0x30, 0x40, 0x90, 0xa0];
  if (r.chance(0.6)) {
    const i = r.int(7);
    st[V.RoomId] = rooms[i];
    if (r.chance(0.8)) st[V.ObjX + g.x] = xs[i];
    if (r.chance(0.8)) st[V.ObjY + g.x] = 0x80;
  }
  st[V.DynTileBufLen] = r.int(0x20);
  st[V.ReturnToBank4] = 0;
  // A valid room flags pointer (GetRoomFlagUWItemState reads through it; open bus is not comparable).
  const flags = 0x6530 + r.int(0x200);
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000] = flags & 0xff;
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000 + 1] = flags >> 8;
  if (r.chance(0.5)) st[V.ObjUninitialized + g.x] = 0;
};

const OCTOROKS = [0x07, 0x08, 0x09, 0x0a];
// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const cases = [
  ['CheckZora', 4, () => ({}), () => Z.CheckZora(), null, zoraRoom],
  ['UpdateZora', 4, slot, (g) => Z.UpdateZora(g.x), null, mix(setType([0x11]), burrower)],
  ['InitBoulderSet', 4, slot, (g) => T.InitBoulderSet(g.x), null],
  ['InitBoulder', 4, slot, (g) => T.InitBoulder(g.x), null],
  ['InitTektite', 4, slot, (g) => T.InitTektite(g.x), RA],
  ['InitLeever', 4, slot, (g) => L.InitLeever(g.x), null, (st, sr, r, g) => { if (r.chance(0.7)) st[V.ObjDir + g.x] = 0; }],
  ['InitSlowOctorockOrGhini', 4, slot, (g) => O.InitSlowOctorockOrGhini(g.x), null,
    (st, sr, r, g) => { if (r.chance(0.7)) st[V.ObjDir + g.x] = 0; }],
  ['InitFastOctorock', 4, slot, (g) => O.InitFastOctorock(g.x), null,
    (st, sr, r, g) => { if (r.chance(0.7)) st[V.ObjDir + g.x] = 0; }],
  ['InitPeahat', 4, slot, (g) => P.InitPeahat(g.x), null],
  ['EndInitFlyer', 4, slot, (g) => P.EndInitFlyer(g.x), RA],
  ['UpdateMoblin', 4, slot, (g) => M.UpdateMoblin(g.x), null, mix(setType([0x03, 0x04]), walker)],
  ['UpdateLynel', 4, slot, (g) => M.UpdateLynel(g.x), null, mix(setType([0x01, 0x02]), walker)],
  ['UpdateBoulderSet', 4, slot, (g) => T.UpdateBoulderSet(g.x), null,
    (st, sr, r, g) => {
      setType([0x1f])(st, sr, r, g);
      if (r.chance(0.6)) st[V.ObjTimer + g.x] = 0;
      st[V.ActiveBoulders] = r.int(4);
      if (r.chance(0.3)) for (let i = 1; i < 0x0c; i++) if (st[V.ObjType + i] === 0) st[V.ObjType + i] = 1;
    }],
  ['UpdateTektiteOrBoulder', 4, slot, (g) => T.UpdateTektiteOrBoulder(g.x), null,
    mix(setType([0x0d, 0x0e, 0x20]), jumper)],
  ['Jumper_AnimateAndCheckCollisions', 4, slot, (g) => T.Jumper_AnimateAndCheckCollisions(g.x), null,
    mix(setType([0x0d, 0x0e, 0x20]), jumper)],
  ['Jumper_GetKind', 4, slot, (g) => T.Jumper_GetKind(g.x), RY,
    (st, sr, r, g) => { st[V.ObjType + g.x] = r.chance(0.7) ? pick(r, [0x0d, 0x0e, 0x20]) : r.byte(); }],
  ['Jumper_PointBoulderDownward', 4, slot, (g) => T.Jumper_PointBoulderDownward(g.x), null,
    mix(setType([0x0d, 0x0e, 0x20]), jumper)],
  ['Jumper_MoveY', 4, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b), y: pick(r, [2, 1, 0xfe, r.byte()]), c: r.int(2) }),
    (g) => { cpu.c = g.c; return T.Jumper_MoveY(g.a, g.x, g.y); }, null, jumper],
  ['Jumper_ResetVSpeedFrac', 4, slot, (g) => T.Jumper_ResetVSpeedFrac(g.x), RA],
  ['UpdateBlueLeever', 4, slot, (g) => L.UpdateBlueLeever(g.x), null, mix(setType([0x0f]), walker, burrower)],
  ['UpdateBurrower', 4, slot, (g) => L.UpdateBurrower(g.x), null, mix(setType([0x0f, 0x10, 0x11]), burrower)],
  ['Burrower_AnimateDrawAndCheckCollisions', 4, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b) }),
    (g) => L.Burrower_AnimateDrawAndCheckCollisions(g.a, g.x), null, mix(setType([0x0f, 0x10, 0x11]), burrower)],
  ['UpdateRedLeever', 4, slot, (g) => L.UpdateRedLeever(g.x), null,
    mix(setType([0x10]), burrower, (st, sr, r, g) => {
      if (r.chance(0.5)) st[V.ObjState + g.x] = r.chance(0.5) ? 0 : 3;
      if (r.chance(0.5)) st[V.ObjY] = pick(r, [0x5d, 0x6d, 0x8d, 0xad, 0x4d]);
      if (r.chance(0.5)) st[V.ObjX] = pick(r, [0x10, 0x20, 0x80, 0xd8, 0xe8]);
    })],
  ['RedLeever_CycleStateDrawAndCheckCollisions', 4, slot, (g) => L.RedLeever_CycleStateDrawAndCheckCollisions(g.x), null,
    mix(setType([0x10]), burrower)],
  ['RedLeever_AnimateAndCheckCollisions', 4, slot, (g) => L.RedLeever_AnimateAndCheckCollisions(g.x), null,
    mix(setType([0x10]), burrower)],
  ['UpdateOctorock', 4, slot, (g) => O.UpdateOctorock(g.x), null, mix(setType(OCTOROKS), walker)],
  ['DrawObjectMirroredAndCheckCollisions', 4, (r) => ({ a: r.int(8), x: 1 + r.int(0x0b) }),
    (g) => O.DrawObjectMirroredAndCheckCollisions(g.a, g.x), null, setType([0x0d, 0x0e, 0x07, 0x0a])],
  ['UpdateGhini', 4, slot, (g) => G.UpdateGhini(g.x), null,
    mix(setType([0x21]), walker, (st, sr, r) => { for (let i = 1; i < 0x0c; i++) if (r.chance(0.3)) st[V.ObjType + i] = 0x22; })],
  ['DrawGhiniAndCheckCollisions', 4, slot, (g) => G.DrawGhiniAndCheckCollisions(g.x), null,
    mix(setType([0x21, 0x22]), (st, sr, r, g) => { st[V.ObjDir + g.x] = pick(r, DIRS8); })],
  ['DrawObjectNotMirroredAndCheckLinkCollision', 4, (r) => ({ a: r.int(4), x: 1 + r.int(0x0b) }),
    (g) => G.DrawObjectNotMirroredAndCheckLinkCollision(g.a, g.x), null, setType([0x21, 0x22, 0x20])],
  ['InitArmosOrFlyingGhini', 4, slot, (g) => A.InitArmosOrFlyingGhini(g.x), null, mix(setType([0x1e]), armos)],
  ['UpdateArmos', 4, slot, (g) => A.UpdateArmos(g.x), null,
    mix(setType([0x1e]), walker, (st, sr, r, g) => { if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0; })],
  ['DrawArmosAndCheckCollisions', 4, slot, (g) => A.DrawArmosAndCheckCollisions(g.x), null,
    mix(setType([0x1e]), (st, sr, r, g) => { if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0; if (r.chance(0.3)) st[V.ObjDir + g.x] = 8; })],
  ['UpdateFlyingGhini', 4, slot, (g) => G.UpdateFlyingGhini(g.x), null, mix(setType([0x22]), flyer)],
  ['ControlFlyingGhiniFlight', 4, slot, (g) => G.ControlFlyingGhiniFlight(g.x), null,
    mix(setType([0x22]), flyer, (st, sr, r, g) => { st[V.Flyer_ObjFlyingState + g.x] = r.int(6); })],
  ['Flyer_GhiniDecideState', 4, slot, (g) => G.Flyer_GhiniDecideState(g.x), RA,
    (st, sr, r, g) => { if (r.chance(0.5)) st[V.Random + g.x] = pick(r, [0x07, 0x08, 0x9f, 0xa0]); }],
  ['UpdatePeahat', 4, slot, (g) => P.UpdatePeahat(g.x), null, mix(setType([0x1a]), flyer)],
  ['ControlPeahatFlight', 4, slot, (g) => P.ControlPeahatFlight(g.x), null,
    mix(setType([0x1a]), flyer, (st, sr, r, g) => { st[V.Flyer_ObjFlyingState + g.x] = r.int(6); })],
  ['Flyer_PeahatDecideState', 4, slot, (g) => P.Flyer_PeahatDecideState(g.x), RA,
    (st, sr, r, g) => { if (r.chance(0.5)) st[V.Random + g.x] = pick(r, [0x1f, 0x20, 0xaf, 0xb0]); }],
  ['Flyer_SetFlyingStateAnd6Turns', 4, (r) => ({ x: 1 + r.int(0x0b), y: r.int(6) }),
    (g) => P.Flyer_SetFlyingStateAnd6Turns(g.x, g.y), RA],
];

test('P18 routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P18_ONLY && !process.env.P18_ONLY.split(',').includes(name)) continue;
    await t.test(name, async () => {
      const r = rng(0x18 + name.length * 7919 + name.charCodeAt(3) * 31);
      let hung = 0;
      for (let i = 0; i < N; i++) {
        const g = { a: 0, x: 0, y: 0, c: 0, ...regs(r) };
        const { st, sr } = randomState(r, o);
        tweak?.(st, sr, r, g);
        let orig;
        try {
          orig = o.run(name, st, sr, bank, g);
        } catch (e) {
          if (!/did not return|Game crashed/.test(e.message)) throw e;
          hung++;
          continue;
        }
        ram.set(st);
        sram.set(sr);
        bus.mapper.shift = 0x10;
        switchBank(bank);
        cpu.c = 0;
        let ret;
        try {
          ret = js(g);
        } catch (e) {
          // The original may run into code the hybrid cannot (e.g. a routine that does not return).
          if (/did not return/.test(e.message)) { hung++; continue; }
          throw e;
        }
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        if (d.length && process.env.P18_DUMP) (await import('node:fs')).writeFileSync(process.env.P18_DUMP, JSON.stringify({ st: [...st], sr: [...sr], g }));
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
      assert.ok(hung <= N / 4, `${name}: ${hung}/${N} random states hang the original`);
      if (hung) t.diagnostic(`${name}: ${hung}/${N} states skipped (the original does not return)`);
    });
  }
});
