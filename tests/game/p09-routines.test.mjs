// P09: every weapon routine (sword, shots, boomerang, arrows, bombs, fire/candle, rod, flute, WieldItem)
// vs. the original 6502 code (jsnes CPU, real ROM) on random states. The routines P09 calls in other
// packages run as original code (p09-hybrid-register.mjs; P01 stays JS; P09_REAL=1 uses the real JS
// modules instead), so this isolates P09. Compares the whole RAM (stack page excepted), the SRAM and
// the output registers. Skipped without roms/zelda.nes or jsnes.
import './p09-hybrid-register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P09_N ?? 150);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram, cpu } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const Wi = await imp('../../src/game/weapons/wield.js');
const Sw = await imp('../../src/game/weapons/sword.js');
const Sh = await imp('../../src/game/weapons/shots.js');
const Bo = await imp('../../src/game/weapons/boomerang.js');
const Ar = await imp('../../src/game/weapons/arrow.js');
const Bm = await imp('../../src/game/weapons/bomb.js');
const Fi = await imp('../../src/game/weapons/fire.js');
const Ro = await imp('../../src/game/weapons/rod.js');
const Fl = await imp('../../src/game/weapons/flute.js');

const DIRS = [1, 2, 4, 8];
const pick = (r, arr) => arr[r.int(arr.length)];

// A random but plausible mode-5 state: Link in slot 0, monsters and weapons around him.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0; i < 0x530; i++) sr[i] = r.byte(); // save files
  for (let i = 0x530; i < 0x7f0; i++) sr[i] = r.chance(0.5) ? pick(r, [0x24, 0x26, 0x74, 0xb0, 0xbc, 0xc0, 0xc8, 0x70]) : r.byte();
  for (let i = 0x87e; i < 0xc90; i++) sr[i] = r.byte(); // level block (attributes, level info)
  st[V.CurLevel] = r.chance(0.5) ? 0 : 1 + r.int(9);
  st[V.GameMode] = r.chance(0.8) ? 5 : pick(r, [9, 0x0b, 0x0c]);
  st[V.RoomId] = r.chance(0.3) ? pick(r, [0x42, 0x06, 0x29, 0x72, 0x66]) : r.int(0x80);
  st[V.CurSaveSlot] = r.int(3);
  for (let i = 0; i < 3; i++) st[V.QuestNumbers + i] = r.int(2);
  st[V.DynTileBufLen] = r.int(0x20);
  st[V.ObjX] = r.chance(0.5) ? pick(r, [0x78, 0x10, 0xe0, 0x20, 0xd0, 0x00, 0xf0]) : r.byte();
  st[V.ObjY] = r.chance(0.5) ? pick(r, [0x8d, 0x5d, 0xbd, 0x3d, 0xdd]) : r.byte();
  st[V.ObjDir] = r.chance(0.9) ? pick(r, DIRS) : r.int(16);
  st[V.ObjInputDir] = r.chance(0.4) ? 0 : r.chance(0.7) ? pick(r, DIRS) : pick(r, [5, 6, 9, 10]);
  st[V.ObjState] = r.chance(0.6) ? 0 : pick(r, [0x10, 0x20, 0x30, r.byte()]);
  st[V.ObjGridOffset] = r.chance(0.6) ? 0 : r.byte();
  st[V.ObjInvincibilityTimer] = r.chance(0.6) ? 0 : r.byte();
  for (let i = 1; i < 0x0d; i++) {
    st[V.ObjType + i] = r.chance(0.5) ? 0 : pick(r, [0x5b, 0x57, 0x58, 0x5c, 0x05, 0x06, r.int(0x6a)]);
    st[V.ObjMetastate + i] = r.chance(0.8) ? 0 : r.byte();
    if (r.chance(0.5)) {
      st[V.ObjX + i] = (st[V.ObjX] + r.int(0x24) - 0x12) & 0xff;
      st[V.ObjY + i] = (st[V.ObjY] + r.int(0x24) - 0x12) & 0xff;
    }
  }
  // Weapon slots $0D-$12.
  st[V.ObjState + 0x0d] = r.chance(0.3) ? 0 : pick(r, [1, 2, 3, 4, 5, 0x31, 0x32, 0x33, 0x34, 0x35, r.byte()]);
  st[V.ObjState + 0x0e] = r.chance(0.3) ? 0 : pick(r, [0x10, 0x11, 0x80, 0x81, r.byte()]);
  st[V.ObjState + 0x0f] = r.chance(0.3) ? 0 : pick(r, [0x10, 0x15, 0x20, 0x28, 0x30, 0x33, 0x40, 0x47, 0x50, 0x80, 0x81, 0x82]);
  for (const s of [0x10, 0x11]) {
    st[V.ObjState + s] = r.chance(0.3) ? 0 : pick(r, [0x11, 0x12, 0x13, 0x14, 0x15, 0x21, 0x22]);
    st[V.ObjTimer + s] = r.chance(0.5) ? r.int(3) : pick(r, [0x16, 0x11, 0x12, 0x0d, r.byte()]);
  }
  st[V.ObjState + 0x12] = r.chance(0.3) ? 0 : pick(r, [0x10, 0x20, 0x28, 0x31, 0x32, 0x33, 0x34, 0x35, 0x90]);
  for (let s = 0x0d; s <= 0x12; s++) {
    st[V.ObjDir + s] = r.chance(0.8) ? pick(r, DIRS) : pick(r, [5, 6, 9, 10, 0xfe, 0xe9, r.byte()]);
    st[V.ObjAnimCounter + s] = r.chance(0.5) ? 1 + r.int(2) : r.byte();
    st[V.ObjGridOffset + s] = r.chance(0.4) ? pick(r, [0, 0x08, 0x10, 0xf0, 0xf8, 0x0f, 0xf1]) : r.byte();
    if (r.chance(0.4)) st[V.ObjTimer + s] = 0;
    if (r.chance(0.3)) st[V.ObjMovingLimit + s] = r.int(3);
  }
  st[V.Items] = r.int(4);
  st[V.InvBombs] = r.chance(0.2) ? 0 : r.byte();
  st[V.InvArrow] = r.int(3);
  st[V.Bow] = r.int(2);
  st[V.InvCandle] = r.int(3);
  st[V.UsedCandle] = r.int(2);
  st[V.InvBook] = r.int(2);
  st[V.InvRupees] = r.chance(0.2) ? 0 : r.byte();
  st[V.InvBoomerang] = r.int(2);
  st[V.InvMagicBoomerang] = r.int(2);
  st[V.Potion] = r.int(3);
  st[V.InvRing] = r.int(3);
  st[V.SelectedItemSlot] = r.chance(0.1) ? 0x0f : r.int(9);
  st[V.CandleState] = r.int(3);
  st[V.SecretColorCycle] = r.chance(0.6) ? 0 : r.byte();
  st[V.UsedFlute] = r.int(2);
  st[V.ForceSwordShot] = r.chance(0.8) ? 0 : r.byte();
  st[V.HeartValues] = r.chance(0.5) ? pick(r, [0x22, 0xff, 0x77, 0x76]) : r.byte();
  st[V.HeartPartial] = r.chance(0.5) ? pick(r, [0x80, 0xff, 0x7f]) : r.byte();
  st[V.TriggeredDoorCmd] = r.chance(0.7) ? 0 : r.byte();
  st[V.CurOpenedDoors] = r.chance(0.5) ? 0 : r.byte();
  st[V.RoomObjTemplateType] = r.chance(0.5) ? pick(r, [3, 0x0a, 0x0b, 0x12, 0x1b, 0x1c, 2]) : r.byte();
  st[V.ObjTimer + 12] = r.chance(0.5) ? 0 : r.byte(); // AnimateWorldFading delay
  st[V.FadeCycle] = r.chance(0.5) ? pick(r, [0xc0, 0xc1, 0xc2, 0xc3]) : r.byte();
  return { st, sr };
}

const A = (ret, o) => assert.equal(ret, o.a, 'register A');
const X = (ret, o) => assert.equal(ret, o.x, 'register X');
const none = () => ({});
const at = (x) => () => ({ x });
// A bomb/fire next to a bombable-wall hotspot (UW, minor state 3 about to become 4).
const nearHotspot = (st, sr, r, g) => {
  if (!r.chance(0.6)) return;
  const h = pick(r, [[0x78, 0x5d], [0x78, 0xbd], [0x20, 0x8d], [0xd0, 0x8d]]);
  st[V.ObjX + g.x] = (h[0] + r.int(0x30) - 0x18) & 0xff;
  st[V.ObjY + g.x] = (h[1] + r.int(0x30) - 0x18) & 0xff;
  if (r.chance(0.5)) { st[V.ObjState + g.x] = 0x13; st[V.ObjTimer + g.x] = 0; }
  if (r.chance(0.7)) {
    // UW room with bombable walls (door type 4 on every side), nothing opened or triggered yet.
    st[V.CurLevel] = 1 + r.int(9);
    st[V.GameMode] = r.chance(0.9) ? 5 : 9;
    if (r.chance(0.8)) st[V.TriggeredDoorCmd] = 0;
    if (r.chance(0.8)) st[V.CurOpenedDoors] = 0;
    if (r.chance(0.8)) {
      sr[V.LevelBlockAttrsA - 0x6000 + st[V.RoomId]] = 0x90 | r.int(4);
      sr[V.LevelBlockAttrsB - 0x6000 + st[V.RoomId]] = 0x90 | r.int(4);
    }
  }
};
// A boomerang reaching its thrower (states $40/$50 next to slot ObjRefId / Link).
const nearThrower = (st, sr, r, g) => {
  if (g.x < 0x0d) {
    st[V.ObjType + g.x] = pick(r, [0x5c, 0x5b]);
    st[V.ObjRefId + g.x] = 1 + r.int(0x0b);
  }
  if (r.chance(0.5)) {
    const t = g.x < 0x0d ? st[V.ObjRefId + g.x] : 0;
    st[V.ObjX + g.x] = (st[V.ObjX + t] + r.int(0x18) - 0x0c) & 0xff;
    st[V.ObjY + g.x] = (st[V.ObjY + t] + r.int(0x18) - 0x0c) & 0xff;
  }
};
const monsterSlot = (r) => ({ x: 1 + r.int(0x0c) });

// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const cases = [
  // Z_01 (WRAM)
  ['WieldBomb', 5, none, () => Bm.WieldBomb(), null],
  ['PlaceWeaponForPlayerStateAndAnimAndWeaponState', 5, (r) => ({ a: r.byte(), x: 0x0d + r.int(6) }),
    (g) => Wi.PlaceWeaponForPlayerStateAndAnimAndWeaponState(g.a, g.x), A],
  ['PlaceWeaponForPlayerStateAndAnim', 5, (r) => ({ x: 0x0d + r.int(6) }), (g) => Wi.PlaceWeaponForPlayerStateAndAnim(g.x), A],
  ['PlaceWeaponForPlayerState', 5, (r) => ({ x: 0x0d + r.int(6) }), (g) => Wi.PlaceWeaponForPlayerState(g.x), A],
  ['PlaceWeapon', 7, (r) => ({ a: r.byte(), x: 0x0d + r.int(6) }), (g) => Wi.PlaceWeapon(g.a, g.x), A],
  ['ChooseOffsetForDirectionH', 7, (r) => ({ a: r.byte() }), (g) => Wi.ChooseOffsetForDirectionH(g.a), A],
  ['WieldCandle', 5, none, () => Fi.WieldCandle(), X],
  ['UpdateBombFlashEffect', 7, (r) => ({ x: 0x10 + r.int(2) }), (g) => Bm.UpdateBombFlashEffect(g.x), null,
    (st, sr, r, g) => { if (r.chance(0.6)) st[V.ObjState + g.x] = 0x13; }],
  // Z_04
  ['UpdateCandle', 4, none, () => Fi.UpdateCandle(), null],
  ['UpdateCandle_Begin', 4, none, () => Fi.UpdateCandle_Begin(), null],
  ['UpdateCandle_Done', 4, none, () => Fi.UpdateCandle_Done(), null],
  ['UpdateCandle_Brightening', 4, none, () => Fi.UpdateCandle_Brightening(), null],
  ['IsDarkRoom_Bank4', 4, (r) => ({ y: r.int(0x80) }), (g) => Fi.IsDarkRoom_Bank4(g.y), A],
  // Z_05
  ['WieldSword', 5, none, () => Sw.WieldSword(), null],
  ['WieldItem', 5, none, () => Wi.WieldItem(), null],
  ['WieldBoomerang', 5, none, () => Bo.WieldBoomerang(), null],
  ['WieldArrow', 5, none, () => Ar.WieldArrow(), null],
  ['WieldWeapon', 5, (r) => ({ a: pick(r, [1, 0x10, 0x31, r.byte()]), x: 0x0d + r.int(6) }), (g) => Wi.WieldWeapon(g.a, g.x), null],
  ['WieldNothing', 5, none, () => Wi.WieldNothing(), null],
  ['WieldFood', 5, none, () => Bo.WieldFood(), null],
  ['WieldPotion', 5, none, () => Wi.WieldPotion(), null],
  ['WieldRod', 5, none, () => Ro.WieldRod(), null],
  // Z_07
  ['WieldFlute', 5, none, () => Fl.WieldFlute(), null],
  ['UpdateSwordShotOrMagicShot', 5, at(0x0e), (g) => Sh.UpdateSwordShotOrMagicShot(g.x), null],
  ['DrawSwordShotOrMagicShot', 4, (r) => (r.chance(0.5) ? { x: 0x0e } : monsterSlot(r)),
    (g) => Sh.DrawSwordShotOrMagicShot(g.x), X],
  ['HandleShotBlocked', 7, at(0x0e), (g) => Sh.HandleShotBlocked(g.x), null],
  ['DeactivateLinkShot', 7, none, () => Sh.DeactivateLinkShot(), A],
  ['SpreadShot', 5, at(0x0e), (g) => Sh.SpreadShot(g.x), null,
    (st, sr, r, g) => { st[V.ObjDir + g.x] = pick(r, [0xfe, 0xf0, 0xe9, r.byte()]); }],
  ['UpdateBoomerangOrFood', 5, at(0x0f), (g) => Bo.UpdateBoomerangOrFood(g.x), null, nearThrower],
  ['UpdateArrowOrBoomerang', 4, (r) => (r.chance(0.6) ? { x: pick(r, [0x0f, 0x12]) } : monsterSlot(r)),
    (g) => Ar.UpdateArrowOrBoomerang(g.x), null,
    (st, sr, r, g) => {
      nearThrower(st, sr, r, g);
      if (g.x < 0x0d) st[V.ObjState + g.x] = pick(r, [0x10, 0x20, 0x28, 0x30, 0x40, 0x50, 0x13, 0x46]);
    }],
  ['DrawArrow', 4, (r) => (r.chance(0.6) ? { x: 0x12 } : monsterSlot(r)), (g) => Ar.DrawArrow(g.x), X],
  ['SetAttrAndDrawArrow', 4, (r) => ({ a: r.chance(0.2) ? 0xfe : pick(r, [0, 0x80, r.byte()]), x: r.chance(0.5) ? 0x12 : 1 + r.int(0x0c), y: r.int(4) }),
    (g) => Ar.SetAttrAndDrawArrow(g.a, g.x, g.y), X],
  ['CheckState20', 4, (r) => ({ a: pick(r, [0x20, 0x30, 0x40, 0x50]), x: r.chance(0.6) ? pick(r, [0x0f, 0x12]) : 1 + r.int(0x0c) }),
    (g) => { ram[0x00] = 0; return Ar.CheckState20(g.a, g.x); }, null,
    (st, sr, r, g) => { st[0x00] = 0; nearThrower(st, sr, r, g); }],
  ['HandleArrowOrBoomerangBlocked', 4, (r) => (r.chance(0.6) ? { x: pick(r, [0x0f, 0x12]) } : monsterSlot(r)),
    (g) => Ar.HandleArrowOrBoomerangBlocked(g.x), X],
  ['AnimateBoomerangAndCheckCollision', 4, (r) => (r.chance(0.6) ? { x: 0x0f } : monsterSlot(r)),
    (g) => Ar.AnimateBoomerangAndCheckCollision(g.x), X],
  ['DrawBoomerangAndCheckCollision', 4, (r) => (r.chance(0.6) ? { x: 0x0f } : monsterSlot(r)),
    (g) => Ar.DrawBoomerangAndCheckCollision(g.x), X],
  ['OffsetAndDrawArrow', 4, (r) => ({ x: r.chance(0.5) ? 0x12 : 1 + r.int(0x0c), y: r.int(4) }),
    (g) => Ar.OffsetAndDrawArrow(g.x, g.y), X],
  ['L_DrawArrowOrBoomerang', 4, (r) => ({ x: pick(r, [0x0f, 0x12, 1 + r.int(0x0c)]), y: pick(r, [2, 0x1d]) }),
    (g) => Ar.L_DrawArrowOrBoomerang(g.x, g.y), X],
  ['UpdateRodOrArrow', 5, at(0x12), (g) => Ro.UpdateRodOrArrow(g.x), null],
  ['UpdateSwordOrRod', 5, (r) => ({ x: pick(r, [0x0d, 0x12]) }), (g) => Sw.UpdateSwordOrRod(g.x), null],
  ['ResetObjState', 4, (r) => ({ x: r.int(0x14) }), (g) => Sw.ResetObjState(g.x), A],
  ['UpdateFire', 5, (r) => ({ x: 0x10 + r.int(2) }), (g) => Fi.UpdateFire(g.x), null,
    (st, sr, r, g) => {
      st[V.ObjState + g.x] = pick(r, [0x21, 0x22]);
      if (r.chance(0.5)) { st[V.ObjX + g.x] = (st[V.ObjX] + r.int(0x20) - 0x10) & 0xff; st[V.ObjY + g.x] = (st[V.ObjY] + r.int(0x20) - 0x10) & 0xff; }
    }],
  ['GetWideObjectMiddle', 5, (r) => ({ x: r.int(0x14), y: pick(r, [0, 2]) }), (g) => Fi.GetWideObjectMiddle(g.x, g.y), A],
  ['UpdateBombOrFire', 5, (r) => ({ x: 0x10 + r.int(2) }), (g) => Bm.UpdateBombOrFire(g.x), null, nearHotspot],
  ['DrawBombOrCloudAt', 5, (r) => ({ x: 0x10 + r.int(2) }), (g) => Bm.DrawBombOrCloudAt(g.x), X],
  ['DrawBombOrCloudNoFlashing', 5, (r) => ({ x: 0x10 + r.int(2) }), (g) => Bm.DrawBombOrCloudNoFlashing(g.x), X],
  ['DrawCloud', 5, (r) => ({ a: 1 + r.int(4), x: 1 + r.int(0x11) }), (g) => Bm.DrawCloud(g.a, g.x), X],
  ['DrawOtherBombClouds', 5, (r) => ({ x: 0x10 + r.int(2) }), (g) => Bm.DrawOtherBombClouds(g.x), null],
];

test('P09 routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P09_ONLY && !process.env.P09_ONLY.split(',').includes(name)) continue;
    await t.test(name, async () => {
      const r = rng(0x09 + name.length * 7919 + name.charCodeAt(3) * 31);
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
        const ret = js(g);
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        if (d.length && process.env.P09_DUMP) (await import('node:fs')).writeFileSync(process.env.P09_DUMP, JSON.stringify({ st: [...st], sr: [...sr], g }));
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
      assert.ok(hung <= N / 4, `${name}: ${hung}/${N} random states hang the original`);
      if (hung) t.diagnostic(`${name}: ${hung}/${N} states skipped (the original does not return)`);
    });
  }
});
