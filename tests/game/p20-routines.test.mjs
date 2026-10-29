// P20: every underworld-monster-B routine (wallmasters, wizzrobes, statues, traps, lamnolas) vs. the
// original 6502 code (jsnes CPU, real ROM) on random states. The routines P20 calls in other packages
// run as the real JS ports (integration), so a divergence comes from P20 or from what it calls.
// Compares the whole RAM (stack page excepted), the SRAM and the output registers.
// Skipped without roms/zelda.nes or jsnes. P20_N = states per routine, P20_ONLY = a,b to filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P20_N ?? 200);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram, cpu } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const WM = await imp('../../src/game/enemies/wallmaster.js');
const WZ = await imp('../../src/game/enemies/wizzrobe.js');
const ST = await imp('../../src/game/enemies/statues.js');
const TR = await imp('../../src/game/enemies/trap.js');
const LA = await imp('../../src/game/enemies/lamnola.js');

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
const RC = (ret, o) => assert.equal(ret ? 1 : 0, o.c, 'carry');
const RY = (ret, o) => assert.equal(ret & 0xff, o.y, 'register Y');
const RX = (ret, o) => assert.equal(ret & 0xff, o.x, 'register X');

const wallmaster = (st, sr, r, g) => {
  st[V.ObjState + g.x] = r.chance(0.5) ? 0 : r.chance(0.9) ? 1 : r.byte();
  if (r.chance(0.6)) st[V.ObjTimer + 1] = 0;
  if (r.chance(0.6)) st[V.ObjState] = r.chance(0.8) ? 0 : 0x40;
  if (r.chance(0.6)) st[V.ObjX] = pick(r, [0x20, 0xd0, 0x28, 0x29, 0xc7, 0xc8, 0x30, 0x40, 0x80, 0xb0]);
  if (r.chance(0.6)) st[V.ObjY] = pick(r, [0x5d, 0xbd, 0x6c, 0x6d, 0x7d, 0x8d, 0xb4, 0xb5, 0x9d]);
  if (r.chance(0.5)) st[V.Wallmaster_ObjStep + g.x] = r.int(0x20);
  if (r.chance(0.5)) st[V.Wallmaster_ObjTilesCrossed + g.x] = r.int(8);
  if (r.chance(0.5)) st[V.ObjCaptureTimer + g.x] = r.chance(0.5) ? 0 : r.byte();
  if (r.chance(0.5)) st[V.ObjGridOffset + g.x] = pick(r, [0, 0x10, 0xf0, 0x08]);
  if (r.chance(0.5)) st[V.ObjShoveDir + g.x] = 0;
  if (r.chance(0.5)) st[V.ObjStunTimer + g.x] = 0;
  if (r.chance(0.5)) st[V.InvClock] = 0;
  if (r.chance(0.5)) { st[V.ObjX + g.x] = st[V.ObjX]; st[V.ObjY + g.x] = st[V.ObjY]; }
};
const wizzrobe = (st, sr, r, g) => {
  if (r.chance(0.5)) st[V.ObjState + g.x] = r.byte();
  if (r.chance(0.5)) st[V.ObjRemDistance + g.x] = r.chance(0.5) ? 0 : r.byte();
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = r.chance(0.5) ? 0 : r.int(4);
  if (r.chance(0.5)) st[V.FrameCounter] = r.chance(0.5) ? 0 : pick(r, [0x20, 0x40, 0x01, 0x21]);
  if (r.chance(0.5)) st[V.ObjX + g.x] &= 0xf0;
  if (r.chance(0.5)) st[V.ObjY + g.x] = (st[V.ObjY + g.x] & 0xf0) | 0x0d;
  if (r.chance(0.3)) st[V.ObjX] = st[V.ObjX + g.x] & 0xf0;
  if (r.chance(0.3)) st[V.ObjY] = st[V.ObjY + g.x];
  if (r.chance(0.5)) st[V.BlueWizzrobe_ObjTurnCounter + g.x] = r.byte();
  if (r.chance(0.5)) st[V.RedWizzrobe_ObjFadeCounter + g.x] = r.byte();
  if (r.chance(0.5)) st[V.InvClock] = 0;
  if (r.chance(0.5)) st[V.ObjDir + g.x] = pick(r, DIRS);
};
const statues = (st, sr, r) => {
  if (r.chance(0.5)) st[V.PersonFireballsEnabled] = r.chance(0.5) ? 0 : r.byte();
  for (let i = 0; i < 4; i++) if (r.chance(0.5)) st[V.Statue_ObjFireballTimer + i] = r.int(3);
  if (r.chance(0.6)) for (let i = 1; i < 0x0c; i++) if (r.chance(0.5)) st[V.ObjType + i] = 0;
  st[V.CurLevel] = 1 + r.int(9);
};
const trap = (st, sr, r, g) => {
  st[V.ObjType + g.x] = pick(r, [0x49, 0x4a]);
  st[V.CurObjIndex] = g.x;
  if (r.chance(0.5)) st[V.ObjState + g.x] = r.int(3);
  if (r.chance(0.5)) st[V.ObjY + g.x] = st[V.ObjY] + r.int(0x1c) - 0x0e;
  if (r.chance(0.5)) st[V.ObjX + g.x] = st[V.ObjX] + r.int(0x1c) - 0x0e;
  if (r.chance(0.3)) st[V.ObjX + g.x] = pick(r, [0x20, 0xd0, 0x73, 0x7d]);
  if (r.chance(0.3)) st[V.ObjY + g.x] = pick(r, [0x5d, 0xbd, 0x8b, 0x95]);
  if (r.chance(0.5)) st[V.ObjGridOffset + g.x] = 0;
};
const lamnola = (st, sr, r, g) => {
  const ty = pick(r, [0x3a, 0x3b]);
  for (let i = 1; i <= 10; i++) st[V.ObjType + i] = r.chance(0.85) ? ty : 0x5d;
  if (r.chance(0.3)) st[V.ObjType + 5] = ty;
  if (r.chance(0.3)) st[V.ObjType + 10] = ty;
  st[V.Lamnola_Type] = ty;
  st[V.Lamnola_Speed] = ty - 0x39;
  st[V.ObjType + 1] = ty;
  st[V.ObjType + 6] = ty;
  for (let i = 1; i <= 10; i++) {
    st[V.ObjDir + i] = r.chance(0.1) ? 0 : pick(r, DIRS);
    if (r.chance(0.6)) st[V.ObjX + i] = (r.int(14) * 16 + 0x10) | (r.chance(0.3) ? r.int(16) : 0);
    if (r.chance(0.6)) st[V.ObjY + i] = ((r.int(9) * 16 + 0x50) | (r.chance(0.3) ? r.int(16) : 0)) - 3;
    if (r.chance(0.5)) st[V.ObjMetastate + i] = 0;
  }
  if (r.chance(0.5)) st[V.InvClock] = 0;
};
const slotIn = (lo, hi) => (r) => ({ x: lo + r.int(hi - lo + 1) });
const setType = (types) => (st, sr, r, g) => {
  st[V.ObjType + g.x] = pick(r, types);
  st[V.CurObjIndex] = g.x;
  if (r.chance(0.7)) st[V.ObjShoveDir + g.x] = 0;
  if (r.chance(0.7)) st[V.ObjStunTimer + g.x] = 0;
  if (r.chance(0.7)) st[V.ObjMetastate + g.x] = 0;
};
const mix = (...fs) => (st, sr, r, g) => { for (const f of fs) f(st, sr, r, g); };
const slot = slotIn(1, 0x0b);
const W = mix(setType([0x27]), wallmaster);
// Wallmaster in state 1 right on top of a vulnerable Link: covers the capture during this frame's check.
const WCAP = mix(W, (st, sr, r, g) => {
  st[V.ObjState + g.x] = 1;
  st[V.ObjX + g.x] = st[V.ObjX]; st[V.ObjY + g.x] = st[V.ObjY];
  st[V.ObjCaptureTimer + g.x] = 0; st[V.ObjMetastate + g.x] = 0; st[V.ObjShoveDir + g.x] = 0;
  st[V.ObjInvincibilityTimer + g.x] = 0; st[V.ObjInvincibilityTimer] = 0; st[V.ObjState] = 0;
  st[V.InvClock] = 0; st[V.ObjStunTimer] = 0; st[V.ObjStunTimer + g.x] = 0; st[V.LinkParalyzed] = 0;
  st[V.ObjGridOffset + g.x] = 0x08;
});
const BW = mix(setType([0x23]), wizzrobe);
const RW = mix(setType([0x24]), wizzrobe);
const AW = mix(setType([0x23, 0x24]), wizzrobe);

// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const cases = [
  ['InitTrap_Full', 1, slotIn(1, 4), (g) => TR.InitTrap_Full(g.x), null, trap],
  ['UpdateTrap_Full', 1, slot, (g) => TR.UpdateTrap_Full(g.x), null, trap],
  ['L_Trap_DrawAndCheckCollisions', 1, slot, (g) => TR.L_Trap_DrawAndCheckCollisions(g.x), null, trap],
  ['UpdateStatues', 4, () => ({}), () => ST.UpdateStatues(), null, statues],
  ['UpdateWallmaster', 4, slot, (g) => WM.UpdateWallmaster(g.x), null, W],
  ['L_Wallmaster_State1', 4, slot, (g) => WM.L_Wallmaster_State1(g.x), null, W],
  ['L_Wallmaster_State1', 4, slot, (g) => WM.L_Wallmaster_State1(g.x), null, WCAP],
  ['Wallmaster_PrepareToDraw', 4, slot, (g) => WM.Wallmaster_PrepareToDraw(g.x), null, W],
  ['Wallmaster_CalcStartPosition', 4, (r) => ({ a: pick(r, [0, 0x40]), x: 1 + r.int(0x0b), y: pick(r, [0, 0x20]) }),
    (g) => WM.Wallmaster_CalcStartPosition(g.a, g.x, g.y), RY, mix(W, (st, sr, r) => {
      st[0x00] = r.byte(); st[0x01] = r.byte(); st[0x02] = pick(r, [8, 0x10, r.byte()]);
    })],
  ['Wallmaster_PutSpritesBehindBgIfNeeded', 4, () => ({}), () => WM.Wallmaster_PutSpritesBehindBgIfNeeded(), null, W],
  ['Wallmaster_PutSpriteBehindBgIfNeeded', 4, (r) => ({ y: r.int(0x40) * 4 }), (g) => WM.Wallmaster_PutSpriteBehindBgIfNeeded(g.y), null, W],
  ['UpdateBlueWizzrobe', 4, slot, (g) => WZ.UpdateBlueWizzrobe(g.x), null, BW],
  ['Wizzrobe_DrawAndCheckCollisionsIntermittently', 4, slot, (g) => WZ.Wizzrobe_DrawAndCheckCollisionsIntermittently(g.x), null, AW],
  ['L_Wizzrobe_DrawAndCheckCollisions', 4, slot, (g) => WZ.L_Wizzrobe_DrawAndCheckCollisions(g.x), null, AW],
  ['BlueWizzrobe_WalkOrTeleport', 4, slot, (g) => WZ.BlueWizzrobe_WalkOrTeleport(g.x), null, BW],
  ['GoEveryOtherFrame', 4, slot, (g) => WZ.GoEveryOtherFrame(g.x), null, BW],
  ['BlueWizzrobe_TurnSometimesAndMoveAndCheckTile', 4, slot, (g) => WZ.BlueWizzrobe_TurnSometimesAndMoveAndCheckTile(g.x), null, BW],
  ['BlueWizzrobe_MoveAndCheckTile', 4, slot, (g) => WZ.BlueWizzrobe_MoveAndCheckTile(g.x), null, BW],
  ['BlueWizzrobe_AdvanceCounterAndTurnTowardLinkIfNeeded', 4, slot, (g) => WZ.BlueWizzrobe_AdvanceCounterAndTurnTowardLinkIfNeeded(g.x), null, BW],
  ['L_BlueWizzrobe_TurnTowardLinkIfNeeded', 4, slot, (g) => WZ.L_BlueWizzrobe_TurnTowardLinkIfNeeded(g.x), null, BW],
  ['BlueWizzrobe_TurnTowardLink', 4, slot, (g) => WZ.BlueWizzrobe_TurnTowardLink(g.x), null, BW],
  ['BlueWizzrobe_Move', 4, slot, (g) => WZ.BlueWizzrobe_Move(g.x), null, BW],
  ['BlueWizzrobe_ChooseTeleportTarget', 4, slot, (g) => WZ.BlueWizzrobe_ChooseTeleportTarget(g.x), null, BW],
  ['BeginTeleporting', 4, slot, (g) => WZ.BeginTeleporting(g.x), null, BW],
  ['BlueWizzrobe_AlignWithNearestSquareAndRandomizeTimer', 4, slot, (g) => WZ.BlueWizzrobe_AlignWithNearestSquareAndRandomizeTimer(g.x), RA, BW],
  ['BlueWizzrobe_AlignWithNearestSquare', 4, slot, (g) => WZ.BlueWizzrobe_AlignWithNearestSquare(g.x), RA, BW],
  ['RedWizzrobe_AlignAndSetY', 4, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b) }), (g) => WZ.RedWizzrobe_AlignAndSetY(g.a, g.x), RA, RW],
  ['Wizzrobe_GetCollidableTile', 4, slot, (g) => WZ.Wizzrobe_GetCollidableTile(g.x), RC, AW],
  ['Wizzrobe_GetCollidableTileForDir', 4, (r) => ({ x: 1 + r.int(0x0b), y: pick(r, [1, 2, 4, 5, 6, 8, 9, 10]) }),
    (g) => WZ.Wizzrobe_GetCollidableTileForDir(g.x, g.y), RC, AW],
  ['Wizzrobe_GetBaseCollidableTile', 4, slot, (g) => WZ.Wizzrobe_GetBaseCollidableTile(g.x), RC, AW],
  ['BlueWizzrobe_TryShooting', 4, slot, (g) => WZ.BlueWizzrobe_TryShooting(g.x), null, BW],
  ['BlueWizzrobe_CheckSquareColumn', 4, slot, (g) => WZ.BlueWizzrobe_CheckSquareColumn(g.x), null, BW],
  ['ShootMagicShot58', 4, slot, (g) => WZ.ShootMagicShot58(g.x), null, AW],
  ['ShootMagicShot', 4, (r) => ({ a: pick(r, [0x58, 0x57, 0x56]), x: 1 + r.int(0x0b) }), (g) => WZ.ShootMagicShot(g.a, g.x), null, AW],
  ['UpdateRedWizzrobe', 4, slot, (g) => WZ.UpdateRedWizzrobe(g.x), null, RW],
  ['UpdateRedWizzrobe_0', 4, slot, (g) => WZ.UpdateRedWizzrobe_0(g.x), null, RW],
  ['UpdateRedWizzrobe_1', 4, slot, (g) => WZ.UpdateRedWizzrobe_1(g.x), null, RW],
  ['UpdateRedWizzrobe_2', 4, slot, (g) => WZ.UpdateRedWizzrobe_2(g.x), null, RW],
  ['UpdateRedWizzrobe_3', 4, slot, (g) => WZ.UpdateRedWizzrobe_3(g.x), null, RW],
  ['Wizzrobe_DrawAndCheckCollisions', 4, slot, (g) => WZ.Wizzrobe_DrawAndCheckCollisions(g.x), null, AW],
  // The four bare-RTS labels (non-entry parts of P20 routines).
  ['L11E17_Exit', 4, slot, () => WZ.L11E17_Exit(), null, BW],
  ['L11EAF_Exit', 4, slot, () => WZ.L11EAF_Exit(), null, BW],
  ['L11F7E_Exit', 4, slot, () => WZ.L11F7E_Exit(), null, BW],
  ['L12A6F_Exit', 4, slot, () => LA.L12A6F_Exit(), null, lamnola],
  ['InitLamnola', 4, () => ({ x: 1 }), (g) => LA.InitLamnola(g.x), RA, lamnola],
  ['UpdateLamnola', 4, slotIn(1, 10), (g) => LA.UpdateLamnola(g.x), null, lamnola],
  ['Lamnola_UpdateHead', 4, (r) => ({ x: pick(r, [5, 10]) }), (g) => LA.Lamnola_UpdateHead(g.x), null, lamnola],
  ['Lamnola_Move', 4, slotIn(1, 10), (g) => LA.Lamnola_Move(g.x), null, lamnola],
];

test('P20 routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P20_ONLY && !process.env.P20_ONLY.split(',').includes(name)) continue;
    await t.test(name, async () => {
      const r = rng(0x20 + name.length * 7919 + name.charCodeAt(3) * 31);
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
        if (d.length && process.env.P20_DUMP) (await import('node:fs')).writeFileSync(process.env.P20_DUMP, JSON.stringify({ st: [...st], sr: [...sr], g }));
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
      assert.ok(hung <= N / 4, `${name}: ${hung}/${N} random states hang the original`);
      if (hung) t.diagnostic(`${name}: ${hung}/${N} states skipped (the original does not return)`);
    });
  }
});
