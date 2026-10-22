// P16: every world-object routine (rocks, gravestones, trees, dock, block, whirlwind, pond, rupee stash)
// vs. the original 6502 code (jsnes CPU, real ROM) on random states. The routines P16 calls in other
// packages run as original code (p16-hybrid-register.mjs; P01 stays JS; P16_REAL=1 uses the real JS
// modules instead), so this isolates P16. Compares the whole RAM (stack page excepted), the SRAM and
// the output registers. Skipped without roms/zelda.nes or jsnes.
import './p16-hybrid-register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P16_N ?? 150);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram, cpu } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const W = await imp('../../src/game/worldobj/whirlwind.js');
const T = await imp('../../src/game/worldobj/tileobjects.js');
const B = await imp('../../src/game/worldobj/block.js');
const P = await imp('../../src/game/worldobj/pond.js');
const S = await imp('../../src/game/worldobj/rupeestash.js');

const DIRS = [1, 2, 4, 8];
const pick = (r, arr) => arr[r.int(arr.length)];
const TILE_OBJS = [0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x61];

// A random but plausible mode-5 state: Link in slot 0, tile objects and weapons around him.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0x530; i < 0x7f0; i++) sr[i] = r.chance(0.5) ? pick(r, [0x24, 0x26, 0x74, 0xb0, 0xbc, 0xc0, 0xc8, 0x70]) : r.byte();
  for (let i = 0x87e; i < 0xc90; i++) sr[i] = r.byte(); // level block (attributes, level info)
  for (let i = 0; i < 0x530; i++) sr[i] = r.byte(); // save files
  st[V.CurLevel] = r.chance(0.6) ? 0 : 1 + r.int(9);
  st[V.GameMode] = r.chance(0.8) ? 5 : pick(r, [7, 9, 0x0b]);
  st[V.RoomId] = r.chance(0.2) ? pick(r, [0x3f, 0x55, 0x42]) : r.int(0x80);
  st[V.CurSaveSlot] = r.int(3);
  st[V.DynTileBufLen] = r.int(0x20);
  // Always 0 in the game before the INC that precedes ChangeTileObjTiles (else the original returns
  // with bank 5 mapped into bank-4 code).
  st[V.ReturnToBank4] = 0;
  st[V.ObjX] = r.chance(0.5) ? pick(r, [0x60, 0x80, 0x78, 0x70, 0x40]) : r.byte();
  st[V.ObjY] = r.chance(0.5) ? pick(r, [0x3d, 0x7d, 0x7e, 0xad, 0x8d, 0x5d]) : r.byte();
  st[V.ObjDir] = r.chance(0.9) ? pick(r, DIRS) : r.int(16);
  st[V.ObjInputDir] = r.chance(0.3) ? 0 : pick(r, DIRS);
  st[V.ObjState] = r.chance(0.6) ? 0 : pick(r, [0x40, 0x10, r.byte()]);
  st[V.ObjGridOffset] = r.chance(0.6) ? 0 : r.byte();
  st[V.ObjCollidedTile] = r.chance(0.7) ? 0xbc + r.int(8) : r.byte();
  for (let i = 1; i < 0x14; i++) {
    st[V.ObjType + i] = r.chance(0.3) ? pick(r, TILE_OBJS) : r.chance(0.5) ? 0 : r.int(0x6a);
    st[V.ObjState + i] = r.chance(0.5) ? r.int(3) : r.byte();
    st[V.ObjDir + i] = pick(r, DIRS);
    st[V.ObjUninitialized + i] = r.chance(0.5) ? 0 : 0xff;
    st[V.ObjGridOffset + i] = r.chance(0.3) ? pick(r, [0x10, 0xf0, 0x0f, 0xf1]) : r.byte();
    if (r.chance(0.5)) {
      // Near Link.
      st[V.ObjX + i] = (st[V.ObjX] + r.int(0x24) - 0x12) & 0xff;
      st[V.ObjY + i] = (st[V.ObjY] + 3 + r.int(0x24) - 0x12) & 0xff;
      if (r.chance(0.4)) st[V.ObjX + i] = st[V.ObjX];
      if (r.chance(0.3)) st[V.ObjY + i] = (st[V.ObjY] + 3) & 0xff;
    }
  }
  st[V.ObjState + 0x10] = r.chance(0.4) ? pick(r, [0x13, 0x22]) : r.byte();
  st[V.ObjState + 0x11] = r.chance(0.4) ? pick(r, [0x13, 0x22]) : r.byte();
  st[V.ObjTimer + 0x10] = r.chance(0.5) ? r.int(3) : r.byte();
  st[V.ObjTimer + 0x11] = r.chance(0.5) ? r.int(3) : r.byte();
  st[V.ObjTimer + 1] = r.chance(0.5) ? 0 : r.byte();
  st[V.RoomAllDead] = r.chance(0.7) ? 1 : 0;
  st[V.InvBracelet] = r.int(2);
  st[V.InvRaft] = r.chance(0.8) ? 1 : 0;
  st[V.InvTriforce] = r.chance(0.2) ? 0 : r.byte();
  st[V.SummonedWhirlwind] = r.chance(0.7) ? 0 : 1;
  st[V.WhirlwindTeleportingState] = r.chance(0.5) ? 0 : r.int(3);
  st[V.SecretColorCycle] = r.int(0x0e);
  st[V.World_IsFillingHearts] = r.chance(0.5) ? 0 : 0x40;
  st[V.ObjState + 1] = r.int(4);
  st[V.ObjState + 2] = r.chance(0.5) ? 0 : 1;
  st[V.CurObjIndex] = 1 + r.int(0x0b);
  st[V.LevelBlockAttrsByteF] = r.byte();
  for (let i = 0; i < 3; i++) st[V.QuestNumbers + i] = r.int(2);
  // The world flags pointer of the level info points to the room flags in RAM ($067F, UW: $06FF).
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000] = st[V.CurLevel] ? 0xff : 0x7f;
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000 + 1] = 0x06;
  return { st, sr };
}

const A = (ret, o) => assert.equal(ret, o.a, 'register A');
const X = (ret, o) => assert.equal(ret, o.x, 'register X');
const C = (ret, o) => assert.equal(ret, o.c, 'carry');
const slot = (r) => ({ x: 1 + r.int(0x0b) });
const tileSlot = (types) => (st, sr, r, g) => { st[V.ObjType + g.x] = pick(r, types); };

// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const cases = [
  ['InitWhirlwind', 1, (r) => ({ a: r.byte(), x: 1 + r.int(0x0b) }), (g) => W.InitWhirlwind(g.a, g.x), A],
  ['SetUpWhirlwind', 1, slot, (g) => W.SetUpWhirlwind(g.x), A],
  ['UpdateWhirlwind_Full', 1, slot, (g) => W.UpdateWhirlwind_Full(g.x), null,
    (st, sr, r, g) => { st[V.ObjType + g.x] = 0x2e; if (r.chance(0.3)) st[V.ObjX + g.x] = pick(r, [0x7e, 0xee, 0xef]); }],
  ['DestroyWhirlwind', 1, slot, (g) => W.DestroyWhirlwind(g.x), A],
  ['SummonWhirlwind', 7, () => ({}), () => W.SummonWhirlwind(), null],
  ['AdvanceTeleportingLevelIndex', 1, () => ({}), () => W.AdvanceTeleportingLevelIndex(), null],
  ['DrawWhirlwind', 1, slot, (g) => W.DrawWhirlwind(g.x), null, (st, sr, r, g) => { st[V.ObjType + g.x] = 0x2e; }],
  ['CheckInitWhirlwindAndBeginUpdate', 1, () => ({}), () => W.CheckInitWhirlwindAndBeginUpdate(), null],
  ['CheckTileObjectsBlocking', 1, () => ({}), () => T.CheckTileObjectsBlocking(), X],
  ['CheckPassiveTileObjects', 1, () => ({}), () => T.CheckPassiveTileObjects(), X],
  ['InitRupeeStash_Full', 1, slot, (g) => S.InitRupeeStash_Full(g.x), X],
  ['InitOneSimpleObject', 1, slot, (g) => S.InitOneSimpleObject(g.x), A],
  ['UpdateRupeeStash_Full', 1, slot, (g) => S.UpdateRupeeStash_Full(g.x), X,
    (st, sr, r, g) => { st[V.ObjType + g.x] = 0x35; }],
  ['ResetRoomTileObjInfo', 2, () => ({}), () => T.ResetRoomTileObjInfo(), A],
  ['UpdateBlock', 4, slot, (g) => B.UpdateBlock(g.x), null,
    (st, sr, r, g) => { st[V.ObjType + g.x] = 0x68; st[V.ObjState + g.x] = r.int(3); if (r.chance(0.5)) st[V.ObjPushTimer + g.x] = 0x0f; }],
  ['UpdateBlock0Idle', 4, slot, (g) => B.UpdateBlock0Idle(g.x), null,
    (st, sr, r, g) => { st[V.ObjType + g.x] = 0x68; if (r.chance(0.5)) st[V.ObjPushTimer + g.x] = 0x0f; }],
  ['DrawBlock', 4, slot, (g) => B.DrawBlock(g.x), X, (st, sr, r, g) => { st[V.ObjType + g.x] = 0x68; }],
  ['UpdateBlock1Moving', 4, slot, (g) => B.UpdateBlock1Moving(g.x), null, (st, sr, r, g) => { st[V.ObjType + g.x] = 0x68; }],
  ['UpdateBlock2Done', 4, slot, (g) => B.UpdateBlock2Done(g.x), null],
  ['InitPondFairy', 4, slot, (g) => P.InitPondFairy(g.x), null],
  ['UpdatePondFairy', 4, () => ({ x: 1 }), (g) => P.UpdatePondFairy(g.x), null,
    (st, sr, r) => {
      st[V.ObjType + 1] = 0x2f;
      if (r.chance(0.5)) { st[V.ObjY] = 0xad; st[V.ObjX] = 0x68 + r.int(0x20); }
      for (let i = 2; i < 10; i++) st[V.ObjState + i] = r.chance(0.6) ? 0 : 1;
      st[V.ObjState + 2] = r.int(2);
      if (r.chance(0.5)) st[V.ObjAngleWhole + 2] = pick(r, [0x14, 0x10, 0x0c, 0x08, 0x04, 0x00, 0x1c]);
    }],
  ['PondFairy_MoveHearts', 4, () => ({}), () => P.PondFairy_MoveHearts(), X,
    (st, sr, r) => {
      st[V.ObjType + 1] = 0x2f;
      for (let i = 2; i < 10; i++) st[V.ObjState + i] = r.chance(0.6) ? 0 : 1;
      if (r.chance(0.5)) st[V.ObjAngleWhole + 2] = pick(r, [0x14, 0x10, 0x0c, 0x08, 0x04, 0x00, 0x1c]);
    }],
  ['UpdateRockOrGravestone', 4, slot, (g) => T.UpdateRockOrGravestone(g.x), null, tileSlot([0x62, 0x65, 0x66])],
  ['RevealSecretTileObj', 4, (r) => ({ a: pick(r, [0x70, 0x24, r.byte()]), x: 1 + r.int(0x0b) }),
    (g) => T.RevealSecretTileObj(g.a, g.x), null],
  ['UpdateRockWall', 4, slot, (g) => T.UpdateRockWall(g.x), null, tileSlot([0x63, 0x67])],
  ['UpdateTree', 4, slot, (g) => T.UpdateTree(g.x), null, tileSlot([0x64])],
  ['RevealAndFlagSecretStairsObj', 4, slot, (g) => T.RevealAndFlagSecretStairsObj(g.x), null],
  ['RevealAndFlagSecretTileObj', 4, (r) => ({ a: pick(r, [0x70, 0x24, r.byte()]), x: 1 + r.int(0x0b) }),
    (g) => T.RevealAndFlagSecretTileObj(g.a, g.x), null],
  ['CheckTileObjWeaponCollision', 4, (r) => ({ x: 1 + r.int(0x0b), y: 0x10 + r.int(2) }),
    (g) => { ram[0x00] = g.y; return T.CheckTileObjWeaponCollision(g.x, g.y); }, A,
    (st, sr, r, g) => { st[0x00] = g.y; }],
  ['IsQuestSecretMismatch', 4, () => ({}), () => T.IsQuestSecretMismatch(), C],
  ['UpdateDock', 4, slot, (g) => T.UpdateDock(g.x), null,
    (st, sr, r, g) => {
      st[V.ObjType + g.x] = 0x61;
      st[V.ObjState + g.x] = r.int(3);
      st[V.RoomId] = pick(r, [0x3f, 0x55]);
      if (r.chance(0.6)) st[V.ObjX] = st[V.RoomId] === 0x55 ? 0x80 : 0x60;
      if (r.chance(0.6)) st[V.ObjY] = pick(r, [0x3d, 0x3e, 0x7d, 0x7e]);
    }],
  ['SetupTileObjectOW', 5, () => ({}), () => T.SetupTileObjectOW(), null],
  ['FindAndCreatePushBlockObject', 5, () => ({}), () => B.FindAndCreatePushBlockObject(), null,
    (st, sr, r) => {
      if (r.chance(0.2)) { sr[V.LevelBlockAttrsD - 0x6000 + st[V.RoomId]] = 0x21; return; }
      // Some block tile in row $A.
      if (r.chance(0.7)) sr[0x530 + (4 + 2 * r.int(12)) * 22 + 0x0a] = 0xb0;
    }],
  ['UpdateFluteSecret', 4, slot, (g) => P.UpdateFluteSecret(g.x), null,
    (st, sr, r) => { if (r.chance(0.7)) st[V.FrameCounter] = (r.byte() & 0xf8) | 4; }],
  ['CueTransferPondPaletteRow', 4, (r) => ({ y: r.int(0x0c) }), (g) => P.CueTransferPondPaletteRow(g.y), null],
  ['AnimatePond', 5, () => ({}), () => P.AnimatePond(), null,
    (st, sr, r) => { st[V.SecretColorCycle] = 1 + r.int(0x0c); }],
];

test('P16 routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P16_ONLY && !process.env.P16_ONLY.split(',').includes(name)) continue;
    await t.test(name, async () => {
      const r = rng(0x16 + name.length * 7919 + name.charCodeAt(3) * 31);
      let hung = 0;
      for (let i = 0; i < N; i++) {
        const g = { a: 0, x: 0, y: 0, ...regs(r) };
        const { st, sr } = randomState(r, o);
        tweak?.(st, sr, r, g);
        let orig;
        try {
          orig = o.run(name, st, sr, bank, g);
        } catch (e) {
          // A random state the original cannot handle either (runs into data): not a valid case.
          if (!/did not return/.test(e.message)) throw e;
          hung++;
          continue;
        }
        ram.set(st);
        sram.set(sr);
        bus.mapper.shift = 0x10;
        switchBank(bank);
        cpu.c = 0;
        const ret = js(g);
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        if (d.length && process.env.P16_DUMP) (await import('node:fs')).writeFileSync(process.env.P16_DUMP, JSON.stringify({ st: [...st], sr: [...sr], g }));
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
      assert.ok(hung <= N / 4, `${name}: ${hung}/${N} random states hang the original`);
      if (hung) t.diagnostic(`${name}: ${hung}/${N} states skipped (the original does not return)`);
    });
  }
});
