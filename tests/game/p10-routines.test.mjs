// P10: every item routine vs. the original 6502 code (jsnes CPU, real ROM) on random states.
// The routines P10 calls in other packages (P01's EndGameMode included) run as original code
// (p10-hybrid-register.mjs; P10_REAL=1 uses the real JS modules instead), so this isolates P10 from
// the packages being ported in parallel. Compares the whole RAM (stack page excepted), the SRAM and
// the output registers. Skipped without roms/zelda.nes or jsnes.
import './p10-hybrid-register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P10_N ?? 300);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const T = await imp('../../src/game/items/take.js');
const RI = await imp('../../src/game/items/roomitem.js');
const D = await imp('../../src/game/items/drops.js');
const F = await imp('../../src/game/items/fairy.js');

const pick = (r, arr) => arr[r.int(arr.length)];
const MONSTERS = [0x5d, 0x14, 0x15, 0x1b, 0x1c, 0x1d, 0x17, 0x07, 0x08, 0x0e, 0x04, 0x0f, 0x23, 0x21, 0x22, 0x0d,
  0x10, 0x13, 0x28, 0x2a, 0x27, 0x16, 0x09, 0x0a, 0x03, 0x01, 0x12, 0x06, 0x0b, 0x24, 0x30, 0x02, 0x05, 0x11];

// A random but plausible play state: Link in slot 0, items in object slots, a level block in SRAM.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0; i < 0x530; i++) sr[i] = r.byte(); // save files
  for (let i = 0x7f0; i < 0xc90; i++) if (i >= 0x87e) sr[i] = r.byte(); // level block
  st[V.CurLevel] = r.chance(0.4) ? 0 : 1 + r.int(9);
  st[V.GameMode] = r.chance(0.6) ? 5 : pick(r, [9, 0x0a, 0x0b, 0x0c]);
  st[V.GameSubmode] = r.int(4);
  st[V.RoomId] = r.int(0x80);
  st[V.CurSaveSlot] = r.int(3);
  st[V.InvRing] = r.int(3);
  st[V.ObjState] = r.chance(0.6) ? 0 : pick(r, [0x40, 0x41, 0x10, 0x20, 0xc0, r.byte()]);
  st[V.ObjX] = r.byte();
  st[V.ObjY] = r.byte();
  for (let x = 1; x < 0x14; x++) {
    if (r.chance(0.6)) {
      st[V.ObjX + x] = (st[V.ObjX] + r.int(21) - 10) & 0xff;
      st[V.ObjY + x] = (st[V.ObjY] + 3 + r.int(21) - 10) & 0xff;
    }
    st[V.Item_ObjItemLifetime + x] = r.chance(0.6) ? r.int(0xf0) : pick(r, [0, 1, 0xf0, 0xf1, 0xff, r.byte()]);
    st[V.Item_ObjItemId + x] = r.chance(0.85) ? r.int(0x24) : pick(r, [0x23, 0xff, r.byte()]);
    st[V.Flyer_ObjFlyingState + x] = r.int(4);
    st[V.Item_ObjMonsterType + x] = r.chance(0.8) ? pick(r, MONSTERS) : r.byte();
    if (r.chance(0.3)) st[V.ObjState + x] = 0;
  }
  // Item takers' states: 0, active or inactive (bit 7).
  for (const s of [0x0d, 0x0f, 0x12]) st[V.ObjState + s] = pick(r, [0, 0x10, 0x01, 0x80, 0xff, r.byte()]);
  st[V.RoomItemId] = r.chance(0.2) ? 0x3f : r.int(0x24);
  st[V.ObjType + 1] = r.chance(0.4) ? pick(r, [0x17, 0x2a, 0x30]) : r.byte();
  st[V.ItemTypeToLift] = r.chance(0.3) ? 0 : r.int(0x24);
  st[V.ItemLiftTimer] = r.chance(0.3) ? 1 : r.byte();
  st[V.TriforceFanfareActive] = r.chance(0.3) ? 0 : 1;
  st[V.ObjTimer] = r.chance(0.3) ? 0 : r.byte();
  st[V.WorldKillCycle] = r.int(10);
  st[V.WorldKillCount] = r.chance(0.2) ? 0x10 : r.byte();
  st[V.HelpDropCount] = r.chance(0.5) ? r.int(0x0a) : r.byte();
  st[V.HelpDropValue] = r.chance(0.5) ? 0 : r.byte();
  st[V.RollingSpriteIndex] = r.int(0x40);
  st[V.LeftAlignHalfWidthObj] = r.chance(0.8) ? 0 : 1;
  st[V.MaxBombs] = pick(r, [8, 12, 16, r.byte()]);
  // The world flags pointer of the level info points to the room flags in RAM ($067F, UW: $06FF).
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000] = st[V.CurLevel] ? 0xff : 0x7f;
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000 + 1] = 0x06;
  return { st, sr };
}

const A = (ret, o) => assert.equal(ret, o.a, 'register A');
const AY = (ret, o) => { assert.equal(ret.a, o.a, 'register A'); assert.equal(ret.y, o.y, 'register Y'); };
const slot = (r) => 1 + r.int(0x13);
const mslot = (r) => 1 + r.int(0x0b);
// UpdateItem: the Triforce of Power ($0E) is only a room item (TryTakeRoomItem, bank 7); as an item
// object its L_TakePowerTriforce would return into bank 4 code with bank 1 mapped.
const setCur = (st, sr, r, g) => {
  st[V.CurObjIndex] = g.x;
  if (st[V.Item_ObjItemId + g.x] === 0x0e) st[V.Item_ObjItemId + g.x] = 0x0f;
};
const cls = (r) => ({ a: pick(r, [0x00, 0x10, 0x20, 0x30]), x: r.int(0x24), y: r.int(0x20) });

// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const cases = [
  ['CheckPowerTriforceFanfare', 1, () => ({}), () => T.CheckPowerTriforceFanfare(), null],
  ['TakePowerTriforce', 1, () => ({}), () => T.TakePowerTriforce(), null],
  ['GetShortcutOrItemXY', 5, () => ({}), () => RI.GetShortcutOrItemXY(), AY],
  ['GetShortcutOrItemXYForRoom', 5, (r) => ({ y: r.int(0x80) }), (g) => RI.GetShortcutOrItemXYForRoom(g.y), AY],
  ['SetRoomFlagUWItemState', 5, () => ({}), () => RI.SetRoomFlagUWItemState(), null],
  ['GetRoomFlagUWItemState', 5, () => ({}), () => RI.GetRoomFlagUWItemState(), A],
  ['TryTakeRoomItem', 5, () => ({}), () => T.TryTakeRoomItem(), null],
  ['TryTakeItem', 4, (r) => ({ x: slot(r) }), (g) => T.TryTakeItem(g.x), null, (st, sr, r) => { st[0x04] = r.int(0x24); }],
  ['TakeItem', 4, (r) => ({ a: r.chance(0.9) ? r.int(0x24) : r.byte() }), (g) => T.TakeItem(g.a), null],
  ['SetItemValue', 4, (r) => ({ a: r.byte(), y: r.int(0x24) }), (g) => T.SetItemValue(g.a, g.y), null],
  ['Take5Rupees', 4, () => ({}), () => T.Take5Rupees(), null],
  ['CheckClass1', 4, cls, (g) => T.CheckClass1(g.a, g.x, g.y), null],
  ['TakeClass0Complex', 4, cls, (g) => T.TakeClass0Complex(g.a, g.x, g.y), null],
  ['TakeHearts', 4, () => ({}), () => T.TakeHearts(), null, (st, sr, r) => { st[0x0a] = r.int(0x10); }],
  ['TakeHeartsNoSound', 4, () => ({}), () => T.TakeHeartsNoSound(), null, (st, sr, r) => { st[0x0a] = r.int(0x10); }],
  ['CompareHeartsToContainers', 4, () => ({}), () => T.CompareHeartsToContainers(), A],
  ['L_TakePowerTriforce', 4, () => ({}), () => T.L_TakePowerTriforce(), null],
  ['HandleClass2', 4, cls, (g) => T.HandleClass2(g.a, g.x, g.y), null, (st, sr, r) => { st[0x0a] = r.int(4); }],
  ['TakeOneRupee', 4, () => ({}), () => T.TakeOneRupee(), null],
  ['PlayKeyTakenTune', 4, () => ({}), () => T.PlayKeyTakenTune(), null],
  ['SetUpDroppedItem', 4, (r) => ({ x: mslot(r) }), (g) => D.SetUpDroppedItem(g.x), null],
  ['UpdateItem', 4, (r) => ({ x: mslot(r) }), (g) => RI.UpdateItem(g.x), null, setCur],
  ['SetUpFairyObject', 4, (r) => ({ x: mslot(r) }), (g) => F.SetUpFairyObject(g.x), null],
  ['ResetFlyerState', 4, (r) => ({ x: mslot(r) }), (g) => F.ResetFlyerState(g.x), A],
  ['UpdateFairyObject', 4, (r) => ({ x: mslot(r) }), (g) => F.UpdateFairyObject(g.x), null],
  ['DrawFairy', 4, (r) => ({ x: mslot(r) }), (g) => F.DrawFairy(g.x), null],
  ['ControlFairyFlight', 4, (r) => ({ x: mslot(r) }), (g) => F.ControlFairyFlight(g.x), null],
  ['Flyer_FairyDecideState', 4, (r) => ({ x: mslot(r) }), (g) => F.Flyer_FairyDecideState(g.x), null],
  ['AnimateRoomItemOnMonster', 4, () => ({ x: 1 }), (g) => RI.AnimateRoomItemOnMonster(g.x), null],
  ['MoveAndDrawRoomItem', 4, () => ({}), () => RI.MoveAndDrawRoomItem(), null],
  ['AnimateRoomItemObject', 4, (r) => ({ x: pick(r, [1, 0x13]) }), (g) => RI.AnimateRoomItemObject(g.x), null],
  ['AnimateItemObject', 4, (r) => ({ a: r.int(0x30), x: slot(r) }), (g) => RI.AnimateItemObject(g.a, g.x), null],
  ['CheckLiftItem', 4, () => ({}), () => RI.CheckLiftItem(), null],
  ['SetUpAndDrawLinkLiftingItem', 4, () => ({}), () => RI.SetUpAndDrawLinkLiftingItem(), null],
  ['DrawLinkLiftingItem', 4, () => ({}), () => RI.DrawLinkLiftingItem(), null],
  ['EndLinkLiftingItem', 4, () => ({}), () => RI.EndLinkLiftingItem(), null],
];

test('P10 routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P10_ONLY && !process.env.P10_ONLY.split(',').includes(name)) continue;
    await t.test(name, () => {
      const r = rng(0x10 + name.length * 7919 + name.charCodeAt(3) * 31);
      for (let i = 0; i < N; i++) {
        const g = { a: 0, x: 0, y: 0, ...regs(r) };
        const { st, sr } = randomState(r, o);
        tweak?.(st, sr, r, g);
        const orig = o.run(name, st, sr, bank, g);
        ram.set(st);
        sram.set(sr);
        bus.mapper.shift = 0x10;
        switchBank(bank);
        const ret = js(g);
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
    });
  }
});
