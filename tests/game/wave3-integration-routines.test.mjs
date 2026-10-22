// Wave-3 integrator: early ports of small routines of later packages that every room transition
// needs (P14 room flags, P16 SetupTileObjectOW, P25 attribute cues / fade / EndGameMode12), vs. the
// original 6502 code (jsnes CPU, real ROM) on random RAM/SRAM states. Whole RAM (stack page
// excepted), SRAM and the returned A are compared. Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.W3_N ?? 300);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const RF = await imp('../../src/game/world/roomflags.js');
const M11 = await imp('../../src/game/modes/mode11-death.js');
const M12 = await imp('../../src/game/modes/mode12-endlevel.js');
const TO = await imp('../../src/game/worldobj/tileobjects.js');

const pick = (r, arr) => arr[r.int(arr.length)];

function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0; i < 0xc90; i++) sr[i] = r.byte();
  st[V.CurLevel] = r.chance(0.5) ? 0 : 1 + r.int(9);
  st[V.RoomId] = r.chance(0.2) ? pick(r, [0x3f, 0x55]) : r.byte() & 0x7f;
  st[V.ObjTimer + 12] = r.chance(0.5) ? 0 : r.byte();
  st[V.FadeCycle] = (pick(r, [0x00, 0x20, 0x40, 0x80, 0xa0, 0xc0]) + r.int(4)) & 0xff;
  st[V.DynTileBufLen] = r.int(0x20);
  // The world flags pointer points to the room flags in RAM ($067F, UW: $06FF) or to SRAM.
  const p = pick(r, [0x067f, 0x06ff, 0x6530 + r.int(0x100)]);
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000] = p & 0xff;
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000 + 1] = p >> 8;
  return { st, sr };
}

const A = (ret, o) => assert.equal(ret, o.a, 'register A');
const cases = [
  ['GetRoomFlags', 7, () => ({}), () => RF.GetRoomFlags(), A],
  ['GetUniqueRoomId', 7, () => ({}), () => RF.GetUniqueRoomId(), A],
  ['MarkRoomVisited', 7, () => ({}), () => RF.MarkRoomVisited(), null],
  ['SaveKillCount', 5, () => ({}), () => RF.SaveKillCount(), null],
  ['SetupTileObjectOW', 5, () => ({}), () => TO.SetupTileObjectOW(), null],
  ['CueTransferPlayAreaAttrsHalfAndAdvanceSubmode', 5, (r) => ({ a: r.byte(), x: r.byte(), y: pick(r, [0x17, 0x2f, r.byte()]) }),
    (g) => M11.CueTransferPlayAreaAttrsHalfAndAdvanceSubmode(g.a, g.x, g.y), null],
  ['CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2', 5, (r) => ({ a: r.byte(), x: r.byte(), y: pick(r, [0x17, 0x2f, r.byte()]) }),
    (g) => M11.CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2(g.a, g.x, g.y), null],
  ['UpdateMode11Death_Sub8_AnimateFade', 5, () => ({}), () => M11.UpdateMode11Death_Sub8_AnimateFade(), null],
  ['EndGameMode12', 5, () => ({}), () => M12.EndGameMode12(), null],
];

test('wave-3 early ports match the original 6502 code on random states', { skip }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp] of cases) {
    await t.test(name, () => {
      const r = rng(0x33 + name.length * 7919 + name.charCodeAt(3) * 31);
      for (let i = 0; i < N; i++) {
        const g = { a: 0, x: 0, y: 0, ...regs(r) };
        const { st, sr } = randomState(r, o);
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
