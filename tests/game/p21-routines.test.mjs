// P21: every boss-A routine (Aquamentus, Dodongo, Manhandla, Gohma, Digdogger, CheckBossSoundEffectUW) vs.
// the original 6502 code (jsnes CPU, real ROM) on random states. The routines P21 calls in other packages
// run as the real JS ports (integration), so a divergence comes from P21 or from what it calls.
// Compares the whole RAM (stack page excepted), the SRAM and the output registers.
// Skipped without roms/zelda.nes or jsnes. P21_N = states per routine, P21_ONLY = a,b to filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P21_N ?? 300);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram, cpu } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const AQ = await imp('../../src/game/bosses/aquamentus.js');
const DO = await imp('../../src/game/bosses/dodongo.js');
const DI = await imp('../../src/game/bosses/digdogger.js');
const MA = await imp('../../src/game/bosses/manhandla.js');
const GO = await imp('../../src/game/bosses/gohma.js');

const DIRS = [1, 2, 4, 8];
const DIRS8 = [...DIRS, ...[4, 8].flatMap((v) => [1, 2].map((h) => v | h))];
const pick = (r, arr) => arr[r.int(arr.length)];
const UW_TILES = [0x74, 0x76, 0x78, 0x7a, 0xb0, 0xb4, 0xf4, 0xf8, 0x68, 0x6c, 0xaa];

// A random but plausible mode-5 UW state: Link in slot 0, monsters, weapons and shots in slots 1..$13.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0x530; i < 0x7f0; i++) sr[i] = r.chance(0.6) ? pick(r, UW_TILES) : r.byte();
  for (let i = 0x87e; i < 0xc90; i++) sr[i] = r.byte();
  st[V.CurLevel] = 1 + r.int(9);
  st[V.GameMode] = 5;
  st[V.CurSaveSlot] = r.int(3);
  st[V.QuestNumbers + st[V.CurSaveSlot]] = r.chance(0.5) ? 0 : 1;
  st[V.ObjX] = r.chance(0.5) ? pick(r, [0x60, 0x80, 0x78, 0x40, 0xb0]) : r.byte();
  st[V.ObjY] = r.chance(0.5) ? pick(r, [0x5d, 0x7d, 0x8d, 0xad]) : r.byte();
  st[V.ObjDir] = pick(r, DIRS);
  st[V.ObjState] = r.chance(0.8) ? 0 : r.byte();
  st[V.ChaseTargetX] = r.chance(0.7) ? st[V.ObjX] : r.byte();
  st[V.ChaseTargetY] = r.chance(0.7) ? st[V.ObjY] : r.byte();
  for (let i = 1; i < 0x14; i++) {
    st[V.ObjType + i] = r.chance(0.4) ? 0 : r.int(0x5d);
    st[V.ObjDir + i] = r.chance(0.8) ? pick(r, DIRS8) : r.int(16);
    st[V.ObjMetastate + i] = r.chance(0.8) ? 0 : r.byte();
    st[V.ObjShoveDir + i] = r.chance(0.7) ? 0 : r.byte();
    st[V.ObjStunTimer + i] = r.chance(0.8) ? 0 : r.byte();
    st[V.ObjInvincibilityTimer + i] = r.chance(0.7) ? 0 : r.byte();
    st[V.ObjTimer + i] = r.chance(0.5) ? 0 : r.byte();
    if (r.chance(0.5)) {
      st[V.ObjX + i] = (st[V.ObjX] + r.int(0x30) - 0x18) & 0xff;
      st[V.ObjY + i] = (st[V.ObjY] + r.int(0x30) - 0x18) & 0xff;
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
const RX = (ret, o) => assert.equal(ret & 0xff, o.x, 'register X');
const RAy = (ret, o) => assert.equal(ret.y & 0xff, o.y, 'register Y');

const mix = (...fs) => (st, sr, r, g) => { for (const f of fs) f(st, sr, r, g); };
const slotIn = (lo, hi) => (r) => ({ x: lo + r.int(hi - lo + 1) });
const slot = slotIn(1, 0x0b);
const setType = (types) => (st, sr, r, g) => {
  st[V.ObjType + g.x] = pick(r, types);
  st[V.CurObjIndex] = g.x;
  if (r.chance(0.7)) st[V.ObjShoveDir + g.x] = 0;
  if (r.chance(0.7)) st[V.ObjStunTimer + g.x] = 0;
  if (r.chance(0.7)) st[V.ObjMetastate + g.x] = 0;
  if (r.chance(0.5)) st[V.InvClock] = 0;
};
// Fewer free slots now and then (ShootFireball with no slot leaves Y = 0).
const crowd = (st, sr, r) => {
  if (r.chance(0.3)) for (let i = 1; i < 0x0c; i++) st[V.ObjType + i] = st[V.ObjType + i] || 1 + r.int(0x5c);
};

const aquamentus = mix(setType([0x3d]), crowd, (st, sr, r, g) => {
  if (r.chance(0.5)) st[V.ObjX + g.x] = pick(r, [0x87, 0x88, 0x89, 0xb0, 0xc7, 0xc8, 0xc9]);
  if (r.chance(0.5)) st[V.ObjGridOffset + g.x] = r.chance(0.5) ? 0 : r.int(0x10);
  if (r.chance(0.5)) st[V.FrameCounter] &= 0xf8;
  if (r.chance(0.5)) st[V.ObjDir + g.x] = pick(r, [1, 2]);
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = r.chance(0.5) ? 0 : r.int(0x40);
  for (let i = 1; i < 0x0c; i++) if (r.chance(0.3)) { st[V.ObjType + i] = 0x55; st[V.Aquamentus_ObjFireballOffset + i] = pick(r, [0, 1, 0xff]); }
});
const dodongo = mix(setType([0x31]), (st, sr, r, g) => {
  st[V.ObjState + g.x] = r.int(3);
  st[V.Dodongo_ObjBloatedSubstate + g.x] = r.int(5);
  if (r.chance(0.5)) st[V.Dodongo_ObjBloatedTimer + g.x] = pick(r, [0, 1, 2, 0x20]);
  if (r.chance(0.5)) st[V.Dodongo_ObjBombHits + g.x] = r.int(3);
  if (r.chance(0.5)) st[V.ObjStunTimer + g.x] = pick(r, [0, 1, 2, 0x20, 0x90]);
  if (r.chance(0.6)) st[V.ObjDir + g.x] = pick(r, DIRS);
  st[V.ObjState + 0x10] = pick(r, [0, 0x12, 0x13, 0x14, 0x15, 0x16, 0x18, 0x20, 0x22, r.byte()]);
  if (r.chance(0.7)) {
    st[V.ObjX + 0x10] = (st[V.ObjX + g.x] + r.int(0x30) - 0x10) & 0xff;
    st[V.ObjY + 0x10] = (st[V.ObjY + g.x] + r.int(0x20) - 0x10) & 0xff;
  }
  if (r.chance(0.3)) st[V.ObjState + 0x0d] = pick(r, [1, 2, 3]);
});
const bombRange = (st, sr, r) => {
  for (let i = 0; i < 4; i++) st[i] = r.byte();
  if (r.chance(0.7)) { st[2] = (st[0] + r.int(0x28) - 0x14) & 0xff; st[3] = (st[1] + r.int(0x28) - 0x14) & 0xff; }
  st[4] = r.int(0x20) - 0x10 & 0xff; st[5] = r.int(0x20) - 0x10 & 0xff;
};
const digdogger = mix(setType([0x18, 0x38, 0x39]), (st, sr, r, g) => {
  st[V.Digdogger_ObjIsChild + g.x] = r.chance(0.5) ? 0 : r.chance(0.9) ? 1 : r.byte();
  st[V.Digdogger_ObjSpeedFlag + g.x] = r.int(2);
  if (r.chance(0.5)) st[V.Digdogger_ObjSpeedWhole + g.x] = r.int(2);
  if (r.chance(0.5)) st[V.Digdogger_ObjTargetSpeedWhole + g.x] = st[V.Digdogger_ObjSpeedWhole + g.x];
  if (r.chance(0.5)) st[V.Digdogger_ObjTargetSpeedFrac + g.x] = (st[V.Digdogger_ObjSpeedFrac + g.x] + pick(r, [1, 0xff, 0])) & 0xff;
  st[V.UsedFlute] = r.chance(0.5) ? 0 : 1 + r.int(2);
  st[V.ChildDigdoggerCount] = 1 + r.int(3);
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = pick(r, [0, 8, 0x10, 0x40, 3]);
  if (r.chance(0.5)) st[V.ObjStunTimer + g.x] = 0;
});
const digSlot = slotIn(1, 8);
const manhandla = mix(setType([0x3c]), crowd, (st, sr, r, g) => {
  for (let i = 1; i <= 5; i++) if (r.chance(0.8)) st[V.ObjType + i] = r.chance(0.9) ? 0x3c : 0x5d;
  st[V.ObjType + g.x] = 0x3c;
  if (r.chance(0.5)) st[V.ObjType + 7] = 0;
  if (r.chance(0.5)) st[V.Manhandla_SegmentJustDied] = 0;
  if (r.chance(0.5)) st[V.Manhandla_BounceDir] = r.chance(0.5) ? 0 : pick(r, DIRS8);
  if (r.chance(0.5)) st[V.ObjMetastate + g.x] = r.chance(0.5) ? 0 : 0x10;
  if (r.chance(0.5)) st[V.Manhandla_ObjSpeedWhole + g.x] = r.int(3);
  if (r.chance(0.3)) st[V.Random + 1 + g.x] = 0xe0 + r.int(0x20);
});
const manSlot = slotIn(1, 5);
const gohma = mix(setType([0x33, 0x34]), crowd, (st, sr, r, g) => {
  if (r.chance(0.5)) st[V.Gohma_ObjGoStraight + g.x] = r.chance(0.3) ? 0 : 1;
  if (r.chance(0.5)) st[V.Gohma_ObjDistTraveled + g.x] = pick(r, [0x1f, 0x20, 0]);
  if (r.chance(0.5)) st[V.Gohma_ObjNextOpenEyeCounter + g.x] = pick(r, [0, 1]);
  if (r.chance(0.5)) st[V.Gohma_ObjEyeOpenTimer + g.x] = pick(r, [0, 1, 0x10, 0x11, 0x70, 0x71, 0x80]);
  if (r.chance(0.5)) st[V.Gohma_ObjEyeAnimCounter + g.x] = pick(r, [7, 8, 0]);
  if (r.chance(0.5)) st[V.Gohma_ObjShootTimer + g.x] = pick(r, [1, 2, 0]);
  if (r.chance(0.5)) st[V.Gohma_ObjEyeState + g.x] = r.int(4);
  if (r.chance(0.5)) st[V.ObjDir + g.x] = pick(r, [1, 2, 4]);
});
const gohmaWeapon = mix(gohma, (st, sr, r, g) => {
  st[0x0f] = 1 + r.int(5);
  st[V.ObjDir + g.y] = pick(r, [8, 4, 1, 2]);
  st[V.Gohma_ObjEyeState + g.x] = r.chance(0.6) ? 3 : r.int(4);
  st[0x07] = r.int(0x40);
});
const soundUW = (st, sr, r) => {
  // The level block's world-flags pointer always points into the save files; a random one can point
  // at the stack page (mirror $09FC = $01FC: the original reads its own return address there; battery:
  // case 261 of seed 1, N=5000).
  const wf = 0x6100 + r.int(0x300);
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000] = wf & 0xff;
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000 + 1] = wf >> 8;
  st[V.RoomId] = r.byte();
  if (r.chance(0.5)) sr[V.LevelInfo_BossRoomId - 0x6000] = st[V.RoomId];
};

// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const cases = [
  ['InitAquamentus', 4, slot, (g) => AQ.InitAquamentus(g.x), RA, aquamentus],
  ['UpdateAquamentus', 4, slot, (g) => AQ.UpdateAquamentus(g.x), RA, aquamentus],
  ['CheckBossHitReaction', 4, slot, (g) => AQ.CheckBossHitReaction(g.x), RA, aquamentus],
  ['Aquamentus_Move', 4, slot, (g) => AQ.Aquamentus_Move(g.x), null, aquamentus],
  ['Aquamentus_Shoot', 4, slot, (g) => AQ.Aquamentus_Shoot(g.x), RX, aquamentus],
  ['ShootFireball55', 4, slot, (g) => AQ.ShootFireball55(g.x), RAy, aquamentus],
  ['Aquamentus_Draw', 4, slot, (g) => AQ.Aquamentus_Draw(g.x), null, aquamentus],
  ['WriteBossSprite', 4, (r) => ({ a: r.byte(), x: 1 }), (g) => AQ.WriteBossSprite(g.a), RA, aquamentus],
  ['CheckBossSoundEffectUW', 5, () => ({}), () => AQ.CheckBossSoundEffectUW(), null, soundUW],
  ['InitDodongo', 4, slot, (g) => DO.InitDodongo(g.x), null, dodongo],
  ['UpdateDodongo', 4, slot, (g) => DO.UpdateDodongo(g.x), null, dodongo],
  ['UpdateDodongoState', 4, slot, (g) => DO.UpdateDodongoState(g.x), null, dodongo],
  ['UpdateDodongoState0_Move', 4, slot, (g) => DO.UpdateDodongoState0_Move(g.x), null, dodongo],
  ['UpdateDodongoState2_Stunned', 4, slot, (g) => DO.UpdateDodongoState2_Stunned(g.x), null, dodongo],
  ['UpdateDodongoState1_Bloated', 4, slot, (g) => DO.UpdateDodongoState1_Bloated(g.x), null, dodongo],
  ['UpdateDodongoState1_Bloated_Sub_Wait', 4, slot, (g) => DO.UpdateDodongoState1_Bloated_Sub_Wait(g.x), null, dodongo],
  ['L_Dodongo_DecrementBloatedTimer', 4, slot, (g) => DO.L_Dodongo_DecrementBloatedTimer(g.x), null, dodongo],
  ['UpdateDodongoState1_Bloated_Sub_Die', 4, slot, (g) => DO.UpdateDodongoState1_Bloated_Sub_Die(g.x), RA, dodongo],
  ['UpdateDodongoState1_Bloated_Sub_End', 4, slot, (g) => DO.UpdateDodongoState1_Bloated_Sub_End(g.x), RA, dodongo],
  ['Dodongo_CheckCollisions', 4, slot, (g) => DO.Dodongo_CheckCollisions(g.x), null, dodongo],
  ['L11989_Exit', 4, slot, () => DO.L11989_Exit(), null, dodongo],
  ['Dodongo_CheckCollisionsStandardSize', 4, slot, (g) => DO.Dodongo_CheckCollisionsStandardSize(g.x), null, dodongo],
  ['Dodongo_CheckBombHit', 4, slot, (g) => DO.Dodongo_CheckBombHit(g.x), null, dodongo],
  ['Dodongo_TryEatBomb', 4, slot, (g) => DO.Dodongo_TryEatBomb(g.x), null, mix(dodongo, bombRange)],
  ['Dodongo_IsBombInRange', 4, (r) => ({ y: r.int(2) }), (g) => DO.Dodongo_IsBombInRange(g.y), RA, mix(dodongo, bombRange)],
  ['Dodongo_Draw', 4, slot, (g) => DO.Dodongo_Draw(g.x), null, dodongo],
  ['Anim_SetSpriteDescriptorLevelPaletteRow', 4, slot, () => DO.Anim_SetSpriteDescriptorLevelPaletteRow(), RA, dodongo],
  ['L11B00_Exit', 4, slot, () => DO.L11B00_Exit(), null, dodongo],
  ['InitDigdogger1', 4, digSlot, (g) => DI.InitDigdogger1(g.x), RA, digdogger],
  ['InitDigdogger2', 4, digSlot, (g) => DI.InitDigdogger2(g.x), RA, digdogger],
  ['L_Digdogger_AfterFlute', 4, (r) => ({ x: 1 + r.int(8), y: 1 + r.int(2) }), (g) => DI.L_Digdogger_AfterFlute(g.x, g.y),
    null, mix(digdogger, (st, sr, r, g) => { st[V.UsedFlute] = g.y; })],
  ['L_Digdogger_TurnTowardLink', 4, digSlot, (g) => DI.L_Digdogger_TurnTowardLink(g.x), null, digdogger],
  ['UpdateDigdogger', 4, digSlot, (g) => DI.UpdateDigdogger(g.x), null, digdogger],
  ['L_Digdogger_Turn', 4, digSlot, (g) => DI.L_Digdogger_Turn(g.x), null, digdogger],
  ['L_Digdogger_Move', 4, digSlot, (g) => DI.L_Digdogger_Move(g.x), null, digdogger],
  ['L_Digdogger_DrawAndCheckCollisions', 4, digSlot, (g) => DI.L_Digdogger_DrawAndCheckCollisions(g.x), null, digdogger],
  ['CheckBigDigdoggerCollisions', 4, digSlot, (g) => DI.CheckBigDigdoggerCollisions(g.x), null, digdogger],
  ['L_Digdogger_DrawAsLittle', 4, digSlot, (g) => DI.L_Digdogger_DrawAsLittle(g.x), RA, digdogger],
  ['Digdogger_ChangeSpeed', 4, digSlot, (g) => DI.Digdogger_ChangeSpeed(g.x), null, digdogger],
  ['Digdogger_SpeedUp', 4, digSlot, (g) => DI.Digdogger_SpeedUp(g.x), null, digdogger],
  ['Digdogger_SlowDown', 4, digSlot, (g) => DI.Digdogger_SlowDown(g.x), null, digdogger],
  ['SetTargetSpeed', 4, (r) => ({ a: r.byte(), x: 1 + r.int(8) }), (g) => DI.SetTargetSpeed(g.a, g.x), null, digdogger],
  ['L116EA_Exit', 4, digSlot, () => DI.L116EA_Exit(), null, digdogger],
  ['Digdogger_Move', 4, digSlot, (g) => DI.Digdogger_Move(g.x), RA, digdogger],
  ['Digdogger_Draw', 4, digSlot, (g) => DI.Digdogger_Draw(g.x), null, digdogger],
  ['InitManhandla', 4, () => ({ x: 1 }), (g) => MA.InitManhandla(g.x), RA, manhandla],
  ['UpdateManhandla', 4, manSlot, (g) => MA.UpdateManhandla(g.x), null, manhandla],
  ['UpdateManhandla', 4, () => ({ x: 5 }), (g) => MA.UpdateManhandla(g.x), null, manhandla],
  ['Manhandla_CheckCollisions', 4, manSlot, (g) => MA.Manhandla_CheckCollisions(g.x), null, manhandla],
  ['Manhandla_SetAllSegmentsDirection', 4, (r) => ({ a: r.byte(), x: 5 }), (g) => MA.Manhandla_SetAllSegmentsDirection(g.a), null, manhandla],
  ['Manhandla_Move', 4, manSlot, (g) => MA.Manhandla_Move(g.x), RA, manhandla],
  ['Manhandla_Draw', 4, manSlot, (g) => MA.Manhandla_Draw(g.x), null, manhandla],
  ['InitGohma', 4, slot, (g) => GO.InitGohma(g.x), RA, gohma],
  ['UpdateGohma', 4, slot, (g) => GO.UpdateGohma(g.x), null, gohma],
  ['Gohma_AnimateAndDraw', 4, (r) => ({ a: r.int(4), x: 1 + r.int(0x0b) }), (g) => GO.Gohma_AnimateAndDraw(g.a, g.x), null, gohma],
  ['Gohma_DrawLegsOneSide', 4, (r) => ({ y: r.int(2), x: 1 + r.int(0x0b) }), (g) => GO.Gohma_DrawLegsOneSide(g.y, g.x), null, gohma],
  ['Gohma_SetSpriteAttributes', 4, slot, (g) => GO.Gohma_SetSpriteAttributes(g.x), RA, gohma],
  ['Gohma_CheckCollisions', 4, slot, (g) => GO.Gohma_CheckCollisions(g.x), null, gohma],
  ['Gohma_HandleWeaponCollision', 4, (r) => ({ x: 1 + r.int(0x0b), y: pick(r, [0x0d, 0x0e, 0x0f, 0x10, 0x12]) }),
    (g) => GO.Gohma_HandleWeaponCollision(g.x, g.y), null, gohmaWeapon],
];

test('P21 routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P21_ONLY && !process.env.P21_ONLY.split(',').includes(name)) continue;
    await t.test(name, async () => {
      const r = rng(0x21 + name.length * 7919 + name.charCodeAt(3) * 31);
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
        if (d.length && process.env.P21_DUMP) (await import('node:fs')).writeFileSync(process.env.P21_DUMP, JSON.stringify({ st: [...st], sr: [...sr], g }));
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
      assert.ok(hung <= N / 4, `${name}: ${hung}/${N} random states hang the original`);
      if (hung) t.diagnostic(`${name}: ${hung}/${N} states skipped (the original does not return)`);
    });
  }
});
