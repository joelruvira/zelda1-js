// Routines of later packages advanced by the wave-4 integrator so the pure port plays the overworld and
// the first underworld rooms (P19 keese/stalfos/gibdo/gel, P20 statues/traps, P21
// CheckBossSoundEffectUW; UpdateGoriya and L_Walker_SetInputDirAndTryShootingBoomerang are in
// p17-routines.test.mjs) vs. the original 6502 code (jsnes CPU, real ROM) on random states. Stubs still
// run as original code (p01-hybrid-register); the other JS modules are the real ports. Compares the whole
// RAM (stack page excepted) and the SRAM. Skipped without roms/zelda.nes or jsnes.
import './p01-hybrid-register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.WAVE4_N ?? 200);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram, cpu } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const K = await imp('../../src/game/enemies/keese-bubble.js');
const SG = await imp('../../src/game/enemies/stalfos-gibdo-rope.js');
const ZG = await imp('../../src/game/enemies/zol-gel.js');
const ST = await imp('../../src/game/enemies/statues.js');
const TR = await imp('../../src/game/enemies/trap.js');
const AQ = await imp('../../src/game/bosses/aquamentus.js');

const DIRS = [1, 2, 4, 8];
const pick = (r, arr) => arr[r.int(arr.length)];

function randomState(r, o, g) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0x530; i < 0x7f0; i++) sr[i] = r.chance(0.5) ? pick(r, [0x24, 0x26, 0x74, 0xb0, 0xbc, 0xc0, 0x70]) : r.byte();
  for (let i = 0x87e; i < 0xc90; i++) sr[i] = r.byte();
  st[V.CurLevel] = 1 + r.int(9);
  st[V.GameMode] = 5;
  st[V.CurSaveSlot] = r.int(3);
  st[V.ObjX] = r.chance(0.5) ? pick(r, [0x20, 0x78, 0x80, 0xd0]) : r.byte();
  st[V.ObjY] = r.chance(0.5) ? pick(r, [0x5d, 0x8d, 0x90, 0xbd]) : r.byte();
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
    if (r.chance(0.5)) st[V.ObjGridOffset + i] = pick(r, [0, 0x10, 0xf0, 0x08]);
  }
  st[V.InvClock] = r.chance(0.8) ? 0 : 1;
  st[V.ItemLiftTimer] = r.chance(0.8) ? 0 : r.byte();
  st[V.ActiveMonsterShots] = r.int(6);
  st[V.LadderSlot] = 0;
  st[V.DoorwayDir] = 0;
  st[V.CurObjIndex] = g.x;
  st[V.ObjAnimCounter + g.x] = 1 + r.int(8);
  return { st, sr };
}

const slot = (r) => ({ x: 1 + r.int(0x0b) });
const typed = (types, more) => (st, sr, r, g) => {
  st[V.ObjType + g.x] = pick(r, types);
  more?.(st, sr, r, g);
};
const near = (st, r, g) => {
  if (r.chance(0.5)) st[V.ObjX + g.x] = (st[V.ObjX] + r.int(0x30) - 0x18) & 0xff;
  if (r.chance(0.5)) st[V.ObjY + g.x] = (st[V.ObjY] + r.int(0x30) - 0x18) & 0xff;
  if (r.chance(0.3)) st[V.ObjX + g.x] = st[V.ObjX];
  if (r.chance(0.3)) st[V.ObjY + g.x] = st[V.ObjY];
};

// [routine, bank, regs(r), js(regs), tweak]
const cases = [
  ['InitBlueKeese', 4, slot, (g) => K.InitBlueKeese(g.x)],
  ['InitRedOrBlackKeese', 4, slot, (g) => K.InitRedOrBlackKeese(g.x)],
  ['UpdateKeese', 4, slot, (g) => K.UpdateKeese(g.x), typed([0x1b, 0x1c, 0x1d], (st, sr, r, g) => {
    st[V.Flyer_ObjFlyingState + g.x] = r.int(6);
    st[V.ObjShoveDir + g.x] = 0;
    near(st, r, g);
  })],
  ['AnimateAndDrawCommonObject', 4, (r) => ({ a: 1 + r.int(8), x: 1 + r.int(0x0b) }),
    (g) => K.AnimateAndDrawCommonObject(g.a, g.x), typed([0x0b, 0x0c, 0x0d, 0x2a])],
  ['UpdateStalfos', 4, slot, (g) => SG.UpdateStalfos(g.x), typed([0x2a], (st, sr, r, g) => {
    st[V.QuestNumbers + st[V.CurSaveSlot]] = r.chance(0.7) ? 1 : 0;
    st[V.ObjShootTimer + g.x] = r.chance(0.4) ? pick(r, [0, 1, 0x11, 0x10, 0x30]) : r.byte();
    if (r.chance(0.5)) st[V.ObjInvincibilityTimer + g.x] = 0;
    if (r.chance(0.5)) st[V.ObjStunTimer + g.x] = 0;
    st[V.ObjWantsToShoot + g.x] = r.int(2);
    near(st, r, g);
  })],
  ['UpdateGibdo', 4, slot, (g) => SG.UpdateGibdo(g.x), typed([0x30], (st, sr, r, g) => near(st, r, g))],
  ['InitGel', 4, slot, (g) => ZG.InitGel(g.x), typed([0x14])],
  ['UpdateGel', 4, slot, (g) => ZG.UpdateGel(g.x), typed([0x14], (st, sr, r, g) => {
    st[V.ObjState + g.x] = r.int(3);
    if (r.chance(0.5)) st[V.ObjTimer + g.x] = r.int(6);
    st[V.ObjShoveDir + g.x] = 0;
    near(st, r, g);
  })],
  ['UpdateStatues', 4, () => ({}), () => ST.UpdateStatues(), (st, sr, r) => {
    st[V.PersonFireballsEnabled] = r.chance(0.4) ? 1 : 0;
    for (let i = 0; i < 4; i++) if (r.chance(0.5)) st[V.Statue_ObjFireballTimer + i] = r.int(2);
    for (let i = 6; i < 0x0c; i++) if (r.chance(0.5)) st[V.ObjType + i] = 0;
    for (let i = 0; i < 4; i++) if (r.chance(0.5)) st[V.Random + i] = r.int(0xf0);
  }],
  ['InitTrap_Full', 1, (r) => ({ x: 1 + r.int(5) }), (g) => TR.InitTrap_Full(g.x), typed([0x49, 0x4a])],
  ['UpdateTrap_Full', 1, (r) => ({ x: 1 + r.int(6) }), (g) => TR.UpdateTrap_Full(g.x), typed([0x49], (st, sr, r, g) => {
    st[V.ObjState + g.x] = r.chance(0.5) ? 0 : 1 + r.int(2);
    st[V.ObjShoveDir + g.x] = 0;
    near(st, r, g);
    if (r.chance(0.3)) st[V.ObjMovingLimit + g.x] = st[V.ObjX + g.x];
  })],
  ['CheckBossSoundEffectUW', 5, () => ({}), () => AQ.CheckBossSoundEffectUW(), (st, sr, r) => {
    st[V.RoomId] = r.byte() & 0x7f;
  }],
];

test('wave-4 advanced routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, tweak] of cases) {
    await t.test(name, async () => {
      const r = rng(0x44 + name.length * 7919 + name.charCodeAt(2) * 31);
      let hung = 0;
      for (let i = 0; i < N; i++) {
        const g = { a: 0, x: 0, y: 0, ...regs(r) };
        const { st, sr } = randomState(r, o, g);
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
        try {
          js(g);
        } catch (e) {
          if (/did not return/.test(e.message)) { hung++; continue; }
          throw e;
        }
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
      }
      assert.ok(hung <= N / 4, `${name}: ${hung}/${N} random states hang the original`);
    });
  }
});
