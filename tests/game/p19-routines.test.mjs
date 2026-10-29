// P19: every underworld-monster-A routine (goriyas, darknuts, stalfos, gibdos, ropes, keeses, bubbles,
// zols/gels, pols voice, like like, vire) vs. the original 6502 code (jsnes CPU, real ROM) on random
// states. The routines P19 calls in other packages run as original code (p19-hybrid-register.mjs; P01
// stays JS; P19_REAL=1 uses the real JS modules instead), so this isolates P19. Compares the whole RAM
// (stack page excepted), the SRAM and the output registers. Skipped without roms/zelda.nes or jsnes.
import './p19-hybrid-register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P19_N ?? 200);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram, cpu } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const GO = await imp('../../src/game/enemies/goriya.js');
const DK = await imp('../../src/game/enemies/darknut.js');
const SGR = await imp('../../src/game/enemies/stalfos-gibdo-rope.js');
const KB = await imp('../../src/game/enemies/keese-bubble.js');
const ZG = await imp('../../src/game/enemies/zol-gel.js');
const PV = await imp('../../src/game/enemies/polsvoice.js');
const LL = await imp('../../src/game/enemies/likelike.js');
const VI = await imp('../../src/game/enemies/vire.js');

const DIRS = [1, 2, 4, 8];
const DIRS8 = [...DIRS, ...[4, 8].flatMap((v) => [1, 2].map((h) => v | h))];
const pick = (r, arr) => arr[r.int(arr.length)];
const UW_TILES = [0x74, 0x76, 0x78, 0x7a, 0xb0, 0xb4, 0xf4, 0xf8, 0x68, 0x6c, 0xaa];

// A random but plausible mode-5 UW state: Link in slot 0, monsters and shots in slots 1..$B.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0x530; i < 0x7f0; i++) sr[i] = r.chance(0.6) ? pick(r, UW_TILES) : r.byte();
  for (let i = 0x87e; i < 0xc90; i++) sr[i] = r.byte();
  st[V.CurLevel] = r.chance(0.9) ? 1 + r.int(9) : 0;
  st[V.GameMode] = 5;
  st[V.CurSaveSlot] = r.int(3);
  st[V.QuestNumbers + st[V.CurSaveSlot]] = r.chance(0.5) ? 0 : 1;
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
  st[V.ObjectFirstUnwalkableTile] = pick(r, [0x78, 0x84, 0x89]);
  return { st, sr };
}

const RA = (ret, o) => assert.equal(ret & 0xff, o.a, 'register A');
const RC = (ret, o) => assert.equal(cpu.c, o.c, 'carry');
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
  if (r.chance(0.3)) st[V.ObjWantsToShoot + g.x] = r.int(2);
};
const flyer = (st, sr, r, g) => {
  st[V.ObjDir + g.x] = r.chance(0.9) ? pick(r, DIRS8) : r.byte();
  st[V.Flyer_ObjFlyingState + g.x] = r.int(6);
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0;
  if (r.chance(0.3)) st[V.Flyer_ObjTurns + g.x] = 1;
  if (r.chance(0.3)) st[V.Flyer_ObjSpeed + g.x] = pick(r, [0x1f, 0x20, 0x7f, 0xa0]);
  if (r.chance(0.5)) st[V.ItemLiftTimer] = 0;
};
// Zols/gels/vires: states and alignment.
// n = number of valid states; strict: only those (a jump table dispatches on the state).
const zol = (n, strict = false) => (st, sr, r, g) => {
  st[V.ObjState + g.x] = strict || r.chance(0.9) ? r.int(n) : r.byte();
  if (r.chance(0.5)) st[V.ObjY + g.x] = (st[V.ObjY + g.x] & 0xf0) | 0x0d;
  if (r.chance(0.5)) st[V.ObjX + g.x] &= 0xf0;
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = r.int(7);
  if (r.chance(0.4)) for (let i = 1; i < 0x0c; i++) if (r.chance(0.6)) st[V.ObjType + i] = 0;
  if (r.chance(0.3)) for (let i = 1; i < 0x0c; i++) if (st[V.ObjType + i] === 0) st[V.ObjType + i] = 1;
};
const pols = (st, sr, r, g) => {
  st[V.ObjState + g.x] = r.chance(0.5) ? 0 : 1;
  st[V.ObjDir + g.x] = r.chance(0.9) ? pick(r, DIRS) : r.byte();
  if (r.chance(0.5)) st[V.ObjRemDistance + g.x] = r.int(3);
  if (r.chance(0.5)) st[V.PolsVoice_ObjSpeedWhole + g.x] = pick(r, [0xfd, 0xfe, 0xff, 0, 1]);
  if (r.chance(0.5)) st[V.PolsVoice_ObjTargetY + g.x] = (st[V.ObjY + g.x] + r.int(9) - 4) & 0xff;
  if (r.chance(0.3)) st[V.ObjY + g.x] = pick(r, [0x70, 0x77, 0x78, 0xa7, 0xa8, 0xb0]);
};
const likelike = (st, sr, r, g) => {
  if (r.chance(0.5)) st[V.ObjCaptureTimer + g.x] = r.chance(0.5) ? 0 : pick(r, [1, 0x5f, 0x60, 0xc0]);
  if (r.chance(0.5)) st[V.ObjAnimCounter + g.x] = 1;
  if (r.chance(0.5)) st[V.ObjAnimFrame + g.x] = r.int(4);
  if (r.chance(0.5)) st[V.LinkParalyzed] = r.int(2);
};
const quest = (st, sr, r) => { st[V.QuestNumbers + st[V.CurSaveSlot]] = r.int(2); };

// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const cases = [
  ['UpdateGoriya', 4, slot, (g) => GO.UpdateGoriya(g.x), null, mix(setType([0x05, 0x06, 0x1e, 0x03, 0x01]), walker)],
  ['L_Walker_SetInputDirAndTryShootingBoomerang', 4, slot, (g) => GO.L_Walker_SetInputDirAndTryShootingBoomerang(g.x), null,
    mix(setType([0x05, 0x06, 0x07]), walker, (st, sr, r, g) => {
      if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0;
      if (r.chance(0.5)) st[V.Random + g.x] = pick(r, [0x23, 0x77, 0x22]);
    })],
  ['InitBubble', 4, slot, (g) => KB.InitBubble(g.x), null, (st, sr, r, g) => { if (r.chance(0.7)) st[V.ObjDir + g.x] = 0; }],
  ['InitBlueKeese', 4, slot, (g) => KB.InitBlueKeese(g.x), RA],
  ['InitRedOrBlackKeese', 4, slot, (g) => KB.InitRedOrBlackKeese(g.x), RA],
  ['UpdateBubble', 4, slot, (g) => KB.UpdateBubble(g.x), null,
    mix(setType([0x2b, 0x2c, 0x2d]), walker, (st, sr, r, g) => {
      if (r.chance(0.5)) { st[V.ObjX + g.x] = st[V.ObjX]; st[V.ObjY + g.x] = st[V.ObjY]; }
      if (r.chance(0.7)) st[V.ObjInvincibilityTimer] = 0;
    })],
  ['AnimateAndDrawCommonObject', 4, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b) }),
    (g) => KB.AnimateAndDrawCommonObject(g.a, g.x), null, setType([0x2a, 0x2b, 0x1b])],
  ['UpdateKeese', 4, slot, (g) => KB.UpdateKeese(g.x), null, mix(setType([0x1b, 0x1c, 0x1d]), flyer)],
  ['ControlKeeseFlight', 4, slot, (g) => KB.ControlKeeseFlight(g.x), null, mix(setType([0x1b, 0x1c]), flyer)],
  ['Flyer_KeeseDecideState', 4, slot, (g) => KB.Flyer_KeeseDecideState(g.x), RA,
    (st, sr, r, g) => { if (r.chance(0.5)) st[V.Random + 1 + g.x] = pick(r, [0x1f, 0x20, 0x9f, 0xa0]); }],
  ['Flyer_SetStateAndTurns', 4, (r) => ({ x: 1 + r.int(0x0b), y: r.int(6) }), (g) => KB.Flyer_SetStateAndTurns(g.x, g.y), RA],
  ['UpdateZol', 4, slot, (g) => ZG.UpdateZol(g.x), null, mix(setType([0x13]), walker, zol(3, true))],
  ['UpdateZolState', 4, slot, (g) => ZG.UpdateZolState(g.x), null, mix(setType([0x13]), walker, zol(3, true))],
  ['UpdateZolState0_Wander', 4, slot, (g) => ZG.UpdateZolState0_Wander(g.x), null, mix(setType([0x13]), walker, zol(1))],
  ['UpdateZolState1_Shove', 4, slot, (g) => ZG.UpdateZolState1_Shove(g.x), null, mix(setType([0x13, 0x12]), zol(2))],
  ['UpdateZolState2_Split', 4, slot, (g) => ZG.UpdateZolState2_Split(g.x), null, mix(setType([0x13]), zol(3))],
  ['CreateChildGel', 4, slot, (g) => ZG.CreateChildGel(g.x).y, RY, mix(setType([0x13]), zol(3))],
  ['Zol_CheckCollisions', 4, slot, (g) => ZG.Zol_CheckCollisions(g.x), null, mix(setType([0x13]), zol(2))],
  ['InitGel', 4, slot, (g) => ZG.InitGel(g.x), null, (st, sr, r, g) => { if (r.chance(0.7)) st[V.ObjDir + g.x] = 0; }],
  ['UpdateGel', 4, slot, (g) => ZG.UpdateGel(g.x), null, mix(setType([0x14, 0x15]), walker, zol(3))],
  ['Gel_Move', 4, slot, (g) => ZG.Gel_Move(g.x), null, mix(setType([0x14, 0x15]), walker, zol(3))],
  ['UpdateNormalZolOrGel', 4, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b) }), (g) => ZG.UpdateNormalZolOrGel(g.a, g.x), null,
    mix(setType([0x13, 0x14, 0x15]), walker, zol(3))],
  ['Gel_MoveSplitting', 4, slot, (g) => ZG.Gel_MoveSplitting(g.x), RC, mix(setType([0x14, 0x13]), zol(2))],
  ['Gel_CheckCollisions', 4, slot, (g) => ZG.Gel_CheckCollisions(g.x), null, setType([0x14, 0x15])],
  ['InitRope', 4, slot, (g) => SGR.InitRope(g.x), null, mix(quest, (st, sr, r, g) => { if (r.chance(0.7)) st[V.ObjDir + g.x] = 0; })],
  ['UpdateRope', 4, slot, (g) => SGR.UpdateRope(g.x), null,
    mix(setType([0x28]), walker, quest, (st, sr, r, g) => {
      if (r.chance(0.5)) st[V.ObjQSpeedFrac + g.x] = pick(r, [0x20, 0x60, 0x40]);
      if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0;
      if (r.chance(0.4)) st[V.ObjX + g.x] = (st[V.ObjX] + r.int(8)) & 0xff;
      if (r.chance(0.4)) st[V.ObjY + g.x] = (st[V.ObjY] + r.int(8)) & 0xff;
    })],
  ['UpdateStalfos', 4, slot, (g) => SGR.UpdateStalfos(g.x), null,
    mix(setType([0x2a]), walker, quest, (st, sr, r, g) => {
      if (r.chance(0.5)) st[V.Random + g.x] = pick(r, [0xf7, 0xf8, 0xff]);
      if (r.chance(0.5)) st[V.ObjInvincibilityTimer + g.x] = 0;
    })],
  ['InitDarknut', 4, slot, (g) => DK.InitDarknut(g.x), null,
    mix(setType([0x0b, 0x0c]), (st, sr, r, g) => { if (r.chance(0.7)) st[V.ObjDir + g.x] = 0; })],
  ['UpdateGibdo', 4, slot, (g) => SGR.UpdateGibdo(g.x), null, mix(setType([0x30]), walker)],
  ['UpdateDarknut', 4, slot, (g) => DK.UpdateDarknut(g.x), null, mix(setType([0x0b, 0x0c]), walker)],
  ['UpdatePolsVoice', 4, slot, (g) => PV.UpdatePolsVoice(g.x), null, mix(setType([0x16]), pols)],
  ['L_PolsVoice_DrawAndCheckCollisions', 4, slot, (g) => PV.L_PolsVoice_DrawAndCheckCollisions(g.x), null, mix(setType([0x16]), pols)],
  ['UpdatePolsVoiceState1_Jumping', 4, slot, (g) => PV.UpdatePolsVoiceState1_Jumping(g.x), RC, mix(setType([0x16]), pols)],
  ['PolsVoice_IsSquareWalkable', 4, slot, (g) => PV.PolsVoice_IsSquareWalkable(g.x), RC, mix(setType([0x16]), pols)],
  ['PolsVoice_GetCollidingTile', 4, slot, (g) => PV.PolsVoice_GetCollidingTile(g.x), RC, mix(setType([0x16]), pols)],
  ['PolsVoice_MoveX', 4, slot, (g) => PV.PolsVoice_MoveX(g.x), RY, mix(setType([0x16]), pols)],
  ['UpdateLikeLike', 4, slot, (g) => LL.UpdateLikeLike(g.x), null, mix(setType([0x17]), walker, likelike)],
  ['UpdateVire', 4, slot, (g) => VI.UpdateVire(g.x), null, mix(setType([0x12]), walker, zol(2, true))],
  ['UpdateVireState', 4, slot, (g) => VI.UpdateVireState(g.x), null, mix(setType([0x12]), walker, zol(2, true))],
  ['UpdateVireState0', 4, slot, (g) => VI.UpdateVireState0(g.x), null, mix(setType([0x12]), walker)],
  ['CheckVireCollisions', 4, slot, (g) => VI.CheckVireCollisions(g.x), null, mix(setType([0x12]), zol(2))],
  ['DrawVire', 4, slot, (g) => VI.DrawVire(g.x), null, setType([0x12])],
];

test('P19 routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P19_ONLY && !process.env.P19_ONLY.split(',').includes(name)) continue;
    await t.test(name, async () => {
      const r = rng(0x19 + name.length * 7919 + name.charCodeAt(3) * 31);
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
          if (/did not return/.test(e.message)) { hung++; continue; }
          throw e;
        }
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        if (d.length && process.env.P19_DUMP) (await import('node:fs')).writeFileSync(process.env.P19_DUMP, JSON.stringify({ st: [...st], sr: [...sr], g }));
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
      assert.ok(hung <= N / 4, `${name}: ${hung}/${N} random states hang the original`);
      if (hung) t.diagnostic(`${name}: ${hung}/${N} states skipped (the original does not return)`);
    });
  }
});
