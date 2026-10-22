// P15 (cave people, shops, money game, hints, underworld people, Grumble, bonfires): every routine of the
// package vs. the original 6502 code (jsnes CPU, real ROM) on random RAM/SRAM states biased towards the
// interesting paths. Whole RAM (stack page excepted), SRAM and the returned registers are compared.
// Cases that reach a routine of a package not ported yet (NotImplementedError) are counted and skipped.
// Skipped without roms/zelda.nes or jsnes. P15_N = cases per routine (default 300).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P15_N ?? 300);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const { NotImplementedError } = await import('../../src/game/stub.js');
const imp = async (p) => (ok ? import(p) : {});
const C = await imp('../../src/game/npc/cave.js');
const S = await imp('../../src/game/npc/shop.js');
const T = await imp('../../src/game/npc/textbox.js');
const U = await imp('../../src/game/npc/uwperson.js');
const G = await imp('../../src/game/npc/grumble.js');

const pick = (r, arr) => arr[r.int(arr.length)];

function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0; i < 0xc90; i++) sr[i] = r.byte();
  st[V.GameMode] = pick(r, [0x05, 0x0b, 0x0b, 0x09]);
  st[V.CurLevel] = r.int(10);
  st[V.RoomId] = r.byte() & 0x7f;
  st[V.DynTileBufLen] = r.int(0x20);
  st[V.ObjTimer + 1] = pick(r, [0, 0, 1, r.byte()]);
  st[V.ObjState] = pick(r, [0, 0x40, r.byte()]);
  st[V.ObjMetastate + 1] = pick(r, [0, 0, 0, r.byte()]);
  st[V.ObjInvincibilityTimer] = pick(r, [0, r.byte()]);
  st[V.PersonTextSelector] = r.int(0x26) * 2; // PersonTextAddrs has $26 entries
  st[V.PersonTextIndex] = r.int(0x60);
  st[V.RupeesToSubtract] = pick(r, [0, 0, r.byte()]);
  st[V.InvRupees] = pick(r, [0, 9, 10, 0x31, 0x32, 0x33, 0x63, 0x64, 0x65, r.byte()]);
  // The world flags pointer points to the room flags in RAM ($067F, UW: $06FF) or to SRAM.
  const p = pick(r, [0x067f, 0x06ff, 0x6530 + r.int(0x100)]);
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000] = p & 0xff;
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000 + 1] = p >> 8;
  return { st, sr };
}

const CAVE_TYPES = [];
for (let t = 0x6a; t <= 0x7d; t++) CAVE_TYPES.push(t);

/** A cave person in slot 1 with consistent cave flags/wares; Link maybe standing on a ware. */
function caveState(r, st, sr, states) {
  st[V.ObjType + 1] = pick(r, CAVE_TYPES);
  st[V.ObjState + 1] = pick(r, states);
  st[V.CaveFlags] = r.byte();
  for (let i = 0; i < 3; i++) {
    st[V.CaveItemIds + i] = pick(r, [0x3f, 0xff, r.byte() & 0x3f, r.byte()]);
    st[V.CavePrices + i] = pick(r, [0, 5, 10, 0x14, 0x32, r.byte()]);
    st[V.MoneyGameAmounts + i] = pick(r, [0x0a, 0x28, 0x14, 0x32, r.byte()]);
  }
  st[V.CaveChosenIndex] = r.int(3);
  if (r.chance(0.6)) {
    st[V.ObjX] = pick(r, [0x58, 0x78, 0x98]);
    st[V.ObjY] = (0x98 + r.int(13) - 6) & 0xff;
  }
  st[V.HeartValues] = r.byte();
  st[V.InvLetter] = pick(r, [0, 1, 2]);
  st[V.SelectedItemSlot] = pick(r, [0x0f, 0x07, r.byte() & 0x0f]);
  st[V.Item_ObjItemLifetime + 0x13] = pick(r, [0, 0, 0xf0, 0xf1, r.byte()]);
  void sr;
}

function uwState(r, st, sr, states, types = [0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52]) {
  st[V.ObjType + 1] = pick(r, types);
  st[V.ObjState + 1] = pick(r, states);
  st[V.InvTriforce] = pick(r, [0xff, r.byte()]);
  st[V.HeartValues] = pick(r, [0x00, 0x10, 0x22, 0x2f, 0x30, 0x31, 0x40, r.byte()]);
  if (r.chance(0.6)) {
    st[V.ObjX] = pick(r, [0x58, 0x78, 0x98]);
    st[V.ObjY] = (0x98 + r.int(13) - 6) & 0xff;
  }
  st[V.Item_ObjItemLifetime + 0x13] = pick(r, [0, 0, 0xf0, 0xf1, r.byte()]);
  void sr;
}

const A = (ret, o) => assert.equal(ret & 0xff, o.a, 'register A');
const slot = (r) => (r.chance(0.8) ? 1 : 1 + r.int(0x0b));

const cases = [
  // name, bank mapped by the caller, registers, state tweak, JS call, result check
  ['InitCave', 1, (r) => ({ x: slot(r) }), (r, st, sr) => caveState(r, st, sr, [0]), (g) => C.InitCave(g.x), null],
  ['UnhaltLink', 1, () => ({}), null, () => C.UnhaltLink(), A],
  ['SetUpCommonCaveObjects', 1, (r) => ({ a: r.byte(), x: slot(r), y: r.byte() }), null,
    (g) => C.SetUpCommonCaveObjects(g.a, g.x, g.y), null],
  ['UpdateCavePerson', 1, (r) => ({ x: 1 }), (r, st, sr) => caveState(r, st, sr, [0, 1, 2, 3, 4, 5, 6, 7, 8]),
    (g) => C.UpdateCavePerson(g.x), null],
  ['DrawCavePerson', 1, (r) => ({ x: slot(r) }), (r, st, sr) => caveState(r, st, sr, [0]), (g) => C.DrawCavePerson(g.x), null],
  ['DrawCaveItems', 1, () => ({}), (r, st, sr) => caveState(r, st, sr, [0]), () => C.DrawCaveItems(), null],
  ['UpdateCavePersonState_TransferPrices', 1, () => ({}), (r, st, sr) => caveState(r, st, sr, [0]),
    () => S.UpdateCavePersonState_TransferPrices(), null],
  ['WritePricesTransferBuf', 1, () => ({}), (r, st, sr) => caveState(r, st, sr, [0]), () => S.WritePricesTransferBuf(), null],
  ['WritePricesToDynamicTransferBuf', 1, (r) => ({ a: pick(r, [0x21, 0x24, r.byte()]) }),
    (r, st, sr) => caveState(r, st, sr, [0]), (g) => S.WritePricesToDynamicTransferBuf(g.a), null],
  ['CueTransferBufAndAdvanceState', 1, (r) => ({ a: r.byte() }), null, (g) => T.CueTransferBufAndAdvanceState(g.a), null],
  ['SwapSpaceAndSign', 1, (r) => ({ a: pick(r, [0x24, r.byte()]) }), null, (g) => S.SwapSpaceAndSign(g.a), A],
  ['CopyPriceListTemplate', 1, () => ({}), null, () => S.CopyPriceListTemplate(), null],
  ['UpdatePersonState_Textbox', 1, () => ({}), (r, st) => {
    st[V.ObjTimer + 1] = pick(r, [0, 0, 0, 1, r.byte()]);
    st[V.ObjState + 1] = r.byte();
  }, () => T.UpdatePersonState_Textbox(), null],
  ['UpdateCavePersonState_TalkOrShopOrDoorCharge', 1, () => ({}), (r, st, sr) => caveState(r, st, sr, [2]),
    () => C.UpdateCavePersonState_TalkOrShopOrDoorCharge(), null],
  ['ClearPricesCaveFlag', 1, () => ({}), null, () => C.ClearPricesCaveFlag(), null],
  ['UpdatePersonState_DelayThenHide', 1, () => ({}), null, () => C.UpdatePersonState_DelayThenHide(), null],
  ['UpdateCavePersonState_HintOrMoneyGame', 1, () => ({}), (r, st, sr) => caveState(r, st, sr, [5]),
    () => S.UpdateCavePersonState_HintOrMoneyGame(), null],
  ['PostCredit', 1, (r) => ({ a: r.byte() }), null, (g) => S.PostCredit(g.a), null],
  ['PostDebit', 1, (r) => ({ a: r.byte() }), null, (g) => S.PostDebit(g.a), null],
  ['PrependSignToPrice', 1, (r) => ({ a: pick(r, [0x14, 0x32, r.byte()]), y: pick(r, [1, 5, 9]) }), null,
    (g) => S.PrependSignToPrice(g.a, g.y), null],
  ['UpdateCavePersonState_DoNothing', 1, () => ({}), null, () => C.UpdateCavePersonState_DoNothing(), null],
  ['UpdatePersonState_CueTransferBlankPersonWares', 1, () => ({}), null,
    () => T.UpdatePersonState_CueTransferBlankPersonWares(), null],
  ['InitUnderworldPerson_Full', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0]),
    (g) => U.InitUnderworldPerson_Full(g.x), null],
  ['InitUnderworldPersonA', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0]), (g) => U.InitUnderworldPersonA(g.x), null],
  ['InitUnderworldPersonLifeOrMoney_Full', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0]),
    (g) => U.InitUnderworldPersonLifeOrMoney_Full(g.x), null],
  ['InitUnderworldPersonB', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0]), (g) => U.InitUnderworldPersonB(g.x), null],
  ['InitUnderworldPersonC', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0], [0x4b, 0x4c, 0x4d, 0x4e]),
    (g) => U.InitUnderworldPersonC(g.x), null],
  ['InitGrumble_Full', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0], [0x3e]), (g) => G.InitGrumble_Full(g.x), null],
  ['PlayCharacterSfx', 1, () => ({}), null, () => T.PlayCharacterSfx(), null],
  ['UpdateUnderworldPerson_Full', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0, 1, 2]),
    (g) => U.UpdateUnderworldPerson_Full(g.x), null],
  ['UpdatePersonState_ResetCharOffset', 1, () => ({}), null, () => U.UpdatePersonState_ResetCharOffset(), null],
  ['UpdatePersonState_DoNothing', 1, () => ({}), null, () => U.UpdatePersonState_DoNothing(), null],
  ['Person_CheckCollisions', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0]), (g) => U.Person_CheckCollisions(g.x), null],
  ['UpdateUnderworldPersonComplex', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0, 1, 2, 3, 4]),
    (g) => U.UpdateUnderworldPersonComplex(g.x), null],
  ['UpdateUnderworldPersonComplexState_Begin', 1, () => ({}), (r, st, sr) => uwState(r, st, sr, [0]),
    () => U.UpdateUnderworldPersonComplexState_Begin(), null],
  ['UpdateUnderworldPersonComplexState_SenseLink', 1, () => ({}), (r, st, sr) => uwState(r, st, sr, [2]),
    () => U.UpdateUnderworldPersonComplexState_SenseLink(), null],
  ['UpdateUnderworldPersonComplexState_DelayAndQuit', 1, () => ({}), null,
    () => U.UpdateUnderworldPersonComplexState_DelayAndQuit(), null],
  ['Person_DrawAndCheckCollisions', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0]),
    (g) => U.Person_DrawAndCheckCollisions(g.x), null],
  ['UpdateUnderworldPersonLifeOrMoney_Full', 1, (r) => ({ x: 1 }), (r, st, sr) => uwState(r, st, sr, [0, 1, 2, 3, 4]),
    (g) => U.UpdateUnderworldPersonLifeOrMoney_Full(g.x), null],
  ['DrawLifeOrMoneyItems', 1, () => ({}), (r, st, sr) => uwState(r, st, sr, [0]), () => U.DrawLifeOrMoneyItems(), null],
  ['UpdateUnderworldPersonLifeOrMoneyState_0', 1, () => ({}), null, () => U.UpdateUnderworldPersonLifeOrMoneyState_0(), null],
  ['UpdateUnderworldPersonLifeOrMoneyState_2', 1, () => ({}), (r, st, sr) => uwState(r, st, sr, [2]),
    () => U.UpdateUnderworldPersonLifeOrMoneyState_2(), null],
  ['UpdateGrumble_Full', 1, (r) => ({ x: 1 }), (r, st, sr) => {
    uwState(r, st, sr, [0, 1, 2, 3], [0x3e]);
    st[V.ObjState + 0x0f] = pick(r, [0, 0x80, r.byte()]);
  }, (g) => G.UpdateGrumble_Full(g.x), null],
  ['UpdateGrumble1', 1, () => ({}), (r, st) => { st[V.ObjState + 0x0f] = pick(r, [0, 0x80, r.byte()]); },
    () => G.UpdateGrumble1(), null],
  ['L_Person_FlagItemTakenAndAdvanceState', 1, () => ({}), null, () => U.L_Person_FlagItemTakenAndAdvanceState(), null],
  ['UpdateGrumble3', 1, () => ({}), null, () => G.UpdateGrumble3(), null],
  ['InitUnderworldPerson_DoNothing', 1, () => ({}), null, () => U.InitUnderworldPerson_DoNothing(), null],
  ['CheckPersonBlocking', 4, () => ({}), (r, st) => {
    st[V.ObjY] = pick(r, [0x8d, 0x8e, r.byte()]);
    st[0x0f] = pick(r, [8, 4, 2, 1, r.byte()]);
  }, () => U.CheckPersonBlocking(), null],
  ['Person_DrawAndCheckCollisions_Common', 4, (r) => ({ x: slot(r) }), (r, st, sr) => uwState(r, st, sr, [0]),
    (g) => U.Person_DrawAndCheckCollisions_Common(g.x), null],
  ['Person_Draw', 4, (r) => ({ x: slot(r) }), null, (g) => U.Person_Draw(g.x), null],
  ['UpdateStandingFire', 4, (r) => ({ x: pick(r, [2, 3, slot(r)]) }), (r, st) => {
    st[V.ObjType + 2] = pick(r, [0x40, 0x40, r.byte()]);
    st[V.ObjType + 3] = pick(r, [0x40, 0x40, r.byte()]);
  }, (g) => C.UpdateStandingFire(g.x), null],
];

test('P15 routines match the original 6502 code on random states', { skip }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, tweak, js, cmp] of cases) {
    await t.test(name, () => {
      const r = rng(0x1515 + name.length * 7919 + name.charCodeAt(3) * 31);
      let skipped = 0;
      for (let i = 0; i < N; i++) {
        const g = { a: 0, x: 0, y: 0, c: 0, ...regs(r) };
        const { st, sr } = randomState(r, o);
        tweak?.(r, st, sr);
        const orig = o.run(name, st, sr, bank, g);
        ram.set(st);
        sram.set(sr);
        bus.mapper.shift = 0x10;
        switchBank(bank);
        let ret;
        try {
          ret = js(g);
        } catch (e) {
          if (e instanceof NotImplementedError) { skipped++; continue; } // a later package's routine
          throw e;
        }
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
      if (skipped) t.diagnostic(`${name}: ${skipped} cases reach an unported routine`);
    });
  }
});
