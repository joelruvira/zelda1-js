// P17: every enemy-core routine (shots, fireballs, arrows, shooting, wanderer AI, flyer engine, rotation)
// vs. the original 6502 code (jsnes CPU, real ROM) on random states. The routines P17 calls in other
// packages run as original code (p17-hybrid-register.mjs; P01 stays JS; P17_REAL=1 uses the real JS
// modules instead), so this isolates P17. Compares the whole RAM (stack page excepted), the SRAM and
// the output registers. Skipped without roms/zelda.nes or jsnes.
import './p17-hybrid-register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P17_N ?? 200);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram, cpu } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const C = await imp('../../src/game/enemies/common.js');
const S = await imp('../../src/game/enemies/shots.js');
const F = await imp('../../src/game/enemies/flyer.js');
// P19 routines advanced by the wave-4 integrator (every wanderer falls into them).
const G = await imp('../../src/game/enemies/goriya.js');

const DIRS = [1, 2, 4, 8];
// The valid 8-way directions: each cardinal bit, plus each vertical|horizontal pair (built, not copied
// from the ROM table Directions8; only used as a set for random states).
const DIRS8 = [...DIRS, ...[4, 8].flatMap((v) => [1, 2].map((h) => v | h))];
const SHOTS = [0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c];
const WALKERS = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x12, 0x13];
const pick = (r, arr) => arr[r.int(arr.length)];

// A random but plausible mode-5 state: Link in slot 0, monsters and shots in slots 1..$B.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0x530; i < 0x7f0; i++) sr[i] = r.chance(0.5) ? pick(r, [0x24, 0x26, 0x74, 0xb0, 0xbc, 0xc0, 0xc8, 0x70]) : r.byte();
  for (let i = 0x87e; i < 0xc90; i++) sr[i] = r.byte();
  st[V.CurLevel] = r.chance(0.6) ? 0 : 1 + r.int(9);
  st[V.GameMode] = 5;
  st[V.ObjX] = r.chance(0.5) ? pick(r, [0x60, 0x80, 0x78, 0x40]) : r.byte();
  st[V.ObjY] = r.chance(0.5) ? pick(r, [0x5d, 0x7d, 0x8d]) : r.byte();
  st[V.ObjDir] = pick(r, DIRS);
  st[V.ObjState] = r.chance(0.8) ? 0 : r.byte();
  st[V.ChaseTargetX] = r.chance(0.7) ? st[V.ObjX] : r.byte();
  st[V.ChaseTargetY] = r.chance(0.7) ? st[V.ObjY] : r.byte();
  for (let i = 1; i < 0x14; i++) {
    st[V.ObjType + i] = r.chance(0.4) ? 0 : r.chance(0.5) ? pick(r, SHOTS) : r.int(0x5d);
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
  return { st, sr };
}

const A = (ret, o) => assert.equal(ret & 0xff, o.a, 'register A');
const Y = (ret, o) => assert.equal(ret, o.y, 'register Y');
const RY = (ret, o) => assert.equal(ret.y, o.y, 'register Y');
const SHOT = (ret, o) => {
  assert.equal(ret.c, o.c, 'carry');
  if (ret.c) { assert.equal(ret.y, o.y, 'register Y'); assert.equal(ret.x, o.x, 'register X'); }
};
const slot = (r) => ({ x: 1 + r.int(0x0b) });
// The game updates object X with CurObjIndex = X (Shoot reads the shooter from CurObjIndex).
const setType = (types) => (st, sr, r, g) => { st[V.ObjType + g.x] = pick(r, types); st[V.CurObjIndex] = g.x; };
const flyer = (st, sr, r, g) => {
  st[V.ObjType + g.x] = pick(r, [0x1b, 0x1c, 0x1d, 0x1a, 0x41, 0x20, 0x26, 0x47]);
  st[V.ObjDir + g.x] = r.chance(0.9) ? pick(r, DIRS8) : r.byte();
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0;
  if (r.chance(0.3)) st[V.Flyer_ObjTurns + g.x] = 1;
};
const shooter = (st, sr, r, g) => {
  st[V.CurObjIndex] = g.x;
  st[V.ObjWantsToShoot + g.x] = r.chance(0.3) ? 0 : 1;
  if (r.chance(0.3)) for (let i = 1; i < 0x0c; i++) if (st[V.ObjType + i] === 0) st[V.ObjType + i] = 1;
};

// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const cases = [
  ['MoveShot', 4, (r) => ({ a: r.chance(0.9) ? pick(r, DIRS) : r.byte(), x: 0x0e + r.int(5) }),
    (g) => S.MoveShot(g.a, g.x), null,
    (st, sr, r) => { st[0x0e] = r.chance(0.5) ? 0 : r.byte(); }],
  ['PlayBossHitCryIfNeeded', 4, slot, (g) => C.PlayBossHitCryIfNeeded(g.x), A,
    (st, sr, r, g) => { if (r.chance(0.5)) st[V.ObjInvincibilityTimer + g.x] = 0x10; }],
  ['PlayBossDeathCryIfNeeded', 4, slot, (g) => C.PlayBossDeathCryIfNeeded(g.x), A],
  ['PlayBossDeathCry', 4, () => ({}), () => C.PlayBossDeathCry(), A],
  ['InitMonsterShot', 4, slot, (g) => S.InitMonsterShot(g.x), A],
  ['_InitMonsterShot_Unknown54', 4, slot, (g) => S._InitMonsterShot_Unknown54(g.x), A],
  ['Unused_10021', 4, slot, (g) => C.Unused_10021(g.x), null,
    (st, sr, r, g) => { if (r.chance(0.7)) st[V.ObjDir + g.x] = 0; }],
  ['InitWalker', 4, slot, (g) => C.InitWalker(g.x), null,
    (st, sr, r, g) => { if (r.chance(0.8)) st[V.ObjDir + g.x] = 0; }],
  ['UpdateCommonWanderer', 4, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b) }), (g) => C.UpdateCommonWanderer(g.a, g.x), null,
    (st, sr, r, g) => {
      setType(WALKERS)(st, sr, r, g);
      if (r.chance(0.6)) st[V.ObjGridOffset + g.x] = pick(r, [0, 0x10, 0xf0]);
      if (r.chance(0.5)) st[V.ObjTurnTimer + g.x] = r.int(2);
    }],
  ['L_Walker_SetInputDirAndTryShootingBoomerang', 4, slot, (g) => G.L_Walker_SetInputDirAndTryShootingBoomerang(g.x), null,
    (st, sr, r, g) => {
      setType([0x05, 0x06, ...WALKERS])(st, sr, r, g);
      shooter(st, sr, r, g);
      if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0;
      if (r.chance(0.5)) st[V.Random + g.x] = pick(r, [0x23, 0x77]);
    }],
  ['UpdateGoriya', 4, slot, (g) => G.UpdateGoriya(g.x), null,
    (st, sr, r, g) => {
      setType([0x05, 0x06, 0x1e, ...WALKERS])(st, sr, r, g);
      shooter(st, sr, r, g);
      st[V.ObjShoveDir + g.x] = 0;
      if (r.chance(0.5)) st[V.ObjState + g.x] = 0;
      if (r.chance(0.5)) st[V.ObjType + 1 + g.x] = 0x1e;
      if (r.chance(0.6)) st[V.ObjGridOffset + g.x] = pick(r, [0, 0x10, 0xf0]);
      if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0;
    }],
  ['Unused_10082', 4, slot, (g) => C.Unused_10082(g.x), null, setType(WALKERS)],
  ['Wanderer_TargetPlayer', 4, slot, (g) => C.Wanderer_TargetPlayer(g.x), null,
    (st, sr, r, g) => {
      setType(WALKERS)(st, sr, r, g);
      st[V.ObjShoveDir + g.x] = 0;
      if (r.chance(0.6)) st[V.ObjGridOffset + g.x] = pick(r, [0, 0x10, 0xf0]);
      if (r.chance(0.5)) st[V.ObjTurnTimer + g.x] = r.int(2);
      if (r.chance(0.3)) st[V.ObjState] = 0xff;
    }],
  ['ShootFireball', 4, (r) => ({ a: pick(r, [0x55, 0x56]), x: 1 + r.int(0x0b) }), (g) => S.ShootFireball(g.a, g.x), RY],
  ['UpdateMonsterShot', 4, slot, (g) => S.UpdateMonsterShot(g.x), null,
    (st, sr, r, g) => {
      setType(SHOTS)(st, sr, r, g);
      st[V.ObjState + g.x] = r.chance(0.6) ? 0x10 : pick(r, [0x30, 0x20, r.byte()]);
      st[V.ObjQSpeedFrac + g.x] = 0xc0;
    }],
  ['L_DrawShot', 4, slot, (g) => S.L_DrawShot(g.x), null, setType(SHOTS)],
  ['DestroyMonsterShot', 4, slot, (g) => S.DestroyMonsterShot(g.x), null, setType(SHOTS)],
  ['DestroyCountedMonsterShot', 4, slot, (g) => S.DestroyCountedMonsterShot(g.x), null, setType(SHOTS)],
  ['BounceShot', 4, slot, (g) => S.BounceShot(g.x), null,
    (st, sr, r, g) => {
      setType(SHOTS)(st, sr, r, g);
      if (r.chance(0.8)) st[V.Shot_ObjBounceDir + g.x] = pick(r, DIRS);
      if (r.chance(0.5)) st[V.Shot_ObjBounceDist + g.x] = pick(r, [0x1c, 0x1d, 0x1e, 0x10]);
    }],
  ['CheckShotLinkCollision', 4, slot, (g) => S.CheckShotLinkCollision(g.x), null, setType(SHOTS)],
  ['UpdateFireball', 4, slot, (g) => S.UpdateFireball(g.x), null,
    (st, sr, r, g) => {
      st[V.ObjType + g.x] = pick(r, [0x55, 0x56]);
      st[V.ObjState + g.x] = r.chance(0.4) ? 0 : 0x10;
    }],
  ['Fireball_MoveOneAxis', 4, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b), y: r.byte() }),
    (g) => S.Fireball_MoveOneAxis(g.a, g.x, g.y), A,
    (st, sr, r) => { st[0x0f] = r.chance(0.8) ? pick(r, DIRS) : r.byte(); }],
  ['_TryShooting', 4, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b), y: pick(r, [0x53, 0x54, 0x5b, 0x57]) }),
    (g) => S._TryShooting(g.a, g.x, g.y), null,
    (st, sr, r, g) => {
      shooter(st, sr, r, g);
      setType(WALKERS)(st, sr, r, g);
      if (r.chance(0.6)) st[V.ObjShootTimer + g.x] = pick(r, [0, 1, 0x10, 0x11, 0x80, 0x30]);
      if (r.chance(0.5)) st[V.Random + g.x] = 0xf8 + r.int(8);
    }],
  ['_ShootIfWanted2', 4, (r) => ({ a: pick(r, [0x53, 0x54, 0x5b, 0x57, 0x2a]), x: 1 + r.int(0x0b) }),
    (g) => S._ShootIfWanted2(g.a, g.x), SHOT, shooter],
  ['UpdateMonsterArrow', 4, slot, (g) => S.UpdateMonsterArrow(g.x), null,
    (st, sr, r, g) => {
      st[V.ObjType + g.x] = 0x5b;
      st[V.ObjState + g.x] = pick(r, [0x10, 0x20, 0x30, 0x10, r.byte()]);
      if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0;
      st[V.ObjRefId + g.x] = r.int(0x0c);
    }],
  ['_ShootIfWanted', 4, (r) => ({ a: pick(r, [0x53, 0x54, 0x5b, 0x57, 0x2a]), x: 1 + r.int(0x0b) }),
    (g) => S._ShootIfWanted(g.a, g.x), SHOT, shooter],
  ['ShootLimited', 4, slot, (g) => S.ShootLimited(g.x), SHOT,
    (st, sr, r, g) => { shooter(st, sr, r, g); st[0x00] = pick(r, [0x53, 0x5b, 0x2a, 0x14]); }],
  ['Shoot', 4, slot, () => S.Shoot(), SHOT,
    (st, sr, r, g) => { st[V.CurObjIndex] = g.x; st[0x00] = pick(r, [0x53, 0x5b, 0x1b]); st[V.EmptyMonsterSlot] = 1 + r.int(0x0b); }],
  ['Flyer_DoNothing', 4, slot, (g) => F.Flyer_DoNothing(g.x), null],
  ['Flyer_Delay', 4, slot, (g) => F.Flyer_Delay(g.x), null, flyer],
  ['Flyer_SlowDown', 4, slot, (g) => F.Flyer_SlowDown(g.x), null,
    (st, sr, r, g) => { flyer(st, sr, r, g); if (r.chance(0.5)) st[V.Flyer_ObjSpeed + g.x] = 0x20; }],
  ['Flyer_SpeedUp', 4, slot, (g) => F.Flyer_SpeedUp(g.x), null,
    (st, sr, r, g) => { flyer(st, sr, r, g); if (r.chance(0.5)) st[V.Flyer_ObjSpeed + g.x] = pick(r, [0x1f, 0x9f, 0x7f, 0xff]); }],
  ['Flyer_SetFlyingState', 4, (r) => ({ a: r.int(6), x: 1 + r.int(0x0b) }), (g) => F.Flyer_SetFlyingState(g.a, g.x), A],
  ['MoveFlyer', 4, slot, (g) => F.MoveFlyer(g.x), null, flyer],
  ['BoundFlyer', 4, slot, (g) => F.BoundFlyer(g.x), A, flyer],
  ['ReverseObjDir8', 4, slot, (g) => F.ReverseObjDir8(g.x), null, flyer],
  ['Flyer_Chase', 4, slot, (g) => F.Flyer_Chase(g.x), null, flyer],
  ['SetFlyingState1', 4, slot, (g) => F.SetFlyingState1(g.x), A],
  ['TurnTowardsPlayer8', 4, slot, (g) => F.TurnTowardsPlayer8(g.x), null, flyer],
  ['SetDir8ForIndex', 4, (r) => ({ x: 1 + r.int(0x0b), y: r.int(8) }), (g) => F.SetDir8ForIndex(g.x, g.y), A],
  ['Flyer_Wander', 4, slot, (g) => F.Flyer_Wander(g.x), null, flyer],
  ['TurnRandomlyDir8', 4, slot, (g) => F.TurnRandomlyDir8(g.x), null, flyer],
  ['GetObjDir8Index', 4, slot, (g) => F.GetObjDir8Index(g.x), Y, flyer],
  ['RotateObjectLocation', 4, (r) => ({ a: 1 + r.int(8), x: 1 + r.int(0x0b), y: 1 + r.int(8) }),
    (g) => C.RotateObjectLocation(g.a, g.x, g.y), A,
    (st, sr, r, g) => { st[V.ObjAngleWhole + g.x] &= 0x1f; }],
  ['ShiftMultiply', 4, (r) => ({ a: r.byte(), y: r.chance(0.9) ? 1 + r.int(8) : r.byte() }),
    (g) => C.ShiftMultiply(g.a, g.y), A],
  ['DecreaseObjectAngle', 4, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b) }), (g) => C.DecreaseObjectAngle(g.a, g.x), A],
];

test('P17 routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P17_ONLY && !process.env.P17_ONLY.split(',').includes(name)) continue;
    await t.test(name, async () => {
      const r = rng(0x17 + name.length * 7919 + name.charCodeAt(3) * 31);
      let hung = 0;
      for (let i = 0; i < N; i++) {
        const g = { a: 0, x: 0, y: 0, ...regs(r) };
        const { st, sr } = randomState(r, o);
        tweak?.(st, sr, r, g);
        let orig;
        try {
          orig = o.run(name, st, sr, bank, g);
        } catch (e) {
          if (!/did not return/.test(e.message)) throw e;
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
          // The original may run into code the hybrid cannot (e.g. a stubbed routine that does not return).
          if (/did not return/.test(e.message)) { hung++; continue; }
          throw e;
        }
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        if (d.length && process.env.P17_DUMP) (await import('node:fs')).writeFileSync(process.env.P17_DUMP, JSON.stringify({ st: [...st], sr: [...sr], g }));
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
      assert.ok(hung <= N / 4, `${name}: ${hung}/${N} random states hang the original`);
      if (hung) t.diagnostic(`${name}: ${hung}/${N} states skipped (the original does not return)`);
    });
  }
});
