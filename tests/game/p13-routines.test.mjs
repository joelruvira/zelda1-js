// P13: every transition routine vs. the original 6502 code (jsnes CPU, real ROM) on random states.
// The routines P13 calls in other packages run as original code (p13-hybrid-register.mjs; P01 stays JS;
// P13_REAL=1 uses the real JS modules instead), so this isolates P13. Compares the whole RAM (stack
// page excepted), the SRAM and the output registers. Skipped without roms/zelda.nes or jsnes.
import './p13-hybrid-register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P13_N ?? 120);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const M3 = await imp('../../src/game/modes/mode3-unfurl.js');
const M46 = await imp('../../src/game/modes/mode4-6-enterleave.js');
const M7 = await imp('../../src/game/modes/mode7-scroll.js');
const M9 = await imp('../../src/game/modes/mode9-cellar.js');
const MA = await imp('../../src/game/modes/modeA-B-C-cave.js');
const M10 = await imp('../../src/game/modes/mode10-stairs.js');
const Nr = await imp('../../src/game/world/nextroom.js');
const Fd = await imp('../../src/game/ppu/fade.js');

const DIRS = [1, 2, 4, 8];
const pick = (r, arr) => arr[r.int(arr.length)];

// A random but plausible state between rooms: Link in slot 0, a level block in SRAM.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0x530; i < 0x7f0; i++) sr[i] = r.chance(0.6) ? r.int(0x80) : r.byte(); // PlayAreaTiles
  for (let i = 0x87e; i < 0xc90; i++) sr[i] = r.byte(); // level block (attributes, level info)
  for (let i = 0; i < 0x530; i++) sr[i] = r.byte(); // save files
  st[V.CurLevel] = r.chance(0.5) ? 0 : 1 + r.int(9);
  st[V.GameMode] = pick(r, [3, 4, 5, 6, 7, 9, 0x0a, 0x0b, 0x0c, 0x10]);
  st[V.GameSubmode] = r.int(4);
  for (let i = 0; i < 0x14; i++) st[V.ObjDir + i] = r.chance(0.9) ? pick(r, DIRS) : r.int(16);
  st[V.ObjInputDir] = r.chance(0.3) ? 0 : pick(r, DIRS);
  st[V.ObjState] = r.chance(0.6) ? 0 : pick(r, [0x10, 0x11, 0x20, 0x30, 0x40, r.byte()]);
  st[V.ObjShoveDir] = r.chance(0.8) ? 0 : r.byte();
  st[V.ObjGridOffset] = r.chance(0.4) ? 0 : pick(r, [8, 0xf8, 0x10, 0x28, 0xd8, 1, 0xff, r.byte()]);
  st[V.ObjX] = r.chance(0.5) ? pick(r, [0x50, 0x80, 0xb0, 0x78, 0x20, 0xd0, 0x00, 0xf0]) : r.byte();
  st[V.ObjY] = r.chance(0.5) ? pick(r, [0x9d, 0x3d, 0x5d, 0x8d, 0xdd, 0x41]) : r.byte();
  st[V.DoorwayDir] = r.chance(0.6) ? 0 : pick(r, DIRS);
  st[V.WhirlwindTeleportingState] = r.chance(0.9) ? 0 : r.byte();
  st[V.SecretColorCycle] = r.chance(0.9) ? 0 : r.byte();
  st[V.DynTileBufLen] = r.int(0x20);
  st[V.ObjTimer] = r.chance(0.5) ? 0 : r.byte();
  st[V.ObjTimer + 12] = r.chance(0.5) ? 0 : r.byte();
  st[V.FadeCycle] = (pick(r, [0x00, 0x20, 0x40, 0x80, 0xa0, 0xc0]) + r.int(4)) & 0xff;
  st[V.CurSaveSlot] = r.int(3);
  st[V.UndergroundExitType] = r.chance(0.5) ? 0 : r.int(3);
  st[V.UndergroundEntranceTile] = r.chance(0.5) ? 0x24 : r.byte();
  st[V.ObjCollidedTile] = r.chance(0.5) ? 0x24 : r.byte();
  st[V.CaveSourceRoomId] = r.chance(0.5) ? 0xff : r.byte();
  st[V.CurRow] = r.chance(0.3) ? 0xff : r.int(0x17);
  st[V.PrevRow] = r.chance(0.3) ? st[V.CurRow] : r.byte();
  st[V.CurColumn] = r.chance(0.7) ? r.int(0x22) : r.byte();
  st[V.CandleState] = r.chance(0.5) ? 0 : r.byte();
  st[V.WorldKillCycle] = r.int(10);
  // LadderSlot is 0 or an object slot in the game (zero-page arrays indexed past slot $13 wrap in
  // page 0 in the original; the ports do not emulate that impossible case).
  st[V.LadderSlot] = r.chance(0.7) ? 0 : r.int(0x14);
  // Keep the original subtrees inside the game's invariants: a valid selected item (WieldItem's
  // TableJump), a cellar array that contains the room (CheckWarps' and CheckSubroom's search loops),
  // rooms whose next room is valid.
  st[V.SelectedItemSlot] = r.chance(0.2) ? 0x0f : r.int(9);
  st[V.RoomId] = 0x11 + r.int(0x5e);
  st[V.NextRoomId] = r.chance(0.9) ? 0x11 + r.int(0x5e) : 0x80 + r.int(0x10);
  const cellar = V.LevelInfo_CellarRoomIdArray - 0x6000;
  for (let i = 0; i < 10; i++) sr[cellar + i] = r.byte();
  sr[cellar + r.int(4)] = st[V.RoomId];
  sr[V.LevelBlockAttrsA - 0x6000 + 0x05] = st[V.RoomId];
  // The world flags pointer of the level info points to the room flags in RAM ($067F, UW: $06FF).
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000] = st[V.CurLevel] ? 0xff : 0x7f;
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000 + 1] = 0x06;
  return { st, sr };
}

const mode = (m, n) => (st, sr, r) => { st[V.GameMode] = m; st[V.GameSubmode] = r.int(n); };

// InitMode_EnterRoom only runs in modes 4, 9, $B, $C: in mode 5 the OW cross-room tasks return into
// it with bank 1 mapped (CheckInitWhirlwindAndBeginUpdate), which never happens in the game.
// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const A = (ret, o) => assert.equal(ret, o.a, 'register A');
const AY = (ret, o) => { assert.equal(ret.a, o.a, 'register A'); assert.equal(ret.y, o.y, 'register Y'); };
const cases = [
  ['AnimateWorldFading', 5, () => ({}), () => Fd.AnimateWorldFading(), (ret, o) => assert.equal(ret === 0, o.a === 0, 'Z')],
  ['UpdateWorldCurtainEffect', 7, () => ({}), () => M3.UpdateWorldCurtainEffect(), null],
  ['UpdateWorldCurtainEffect_Bank2', 2, () => ({}), () => M3.UpdateWorldCurtainEffect_Bank2(), null],
  ['FillPlayAreaAttrs', 5, (r) => ({ a: r.byte() }), (g) => M7.FillPlayAreaAttrs(g.a), null],
  ['SetEnteringDoorwayAsCurOpenedDoors', 5, () => ({}), () => M7.SetEnteringDoorwayAsCurOpenedDoors(), A],
  ['WriteAndEnableSprite0', 5, () => ({}), () => M7.WriteAndEnableSprite0(), null],
  ['CopyPlayAreaAttrsHalfToDynTransferBuf', 5, (r) => ({ a: r.byte(), x: r.byte(), y: pick(r, [0x17, 0x2f, r.byte()]) }),
    (g) => M7.CopyPlayAreaAttrsHalfToDynTransferBuf(g.a, g.x, g.y), null],
  ['ChooseAttrSourceAndDestForSubmode', 5, () => ({}), () => M7.ChooseAttrSourceAndDestForSubmode(), AY],
  ['GetPlayAreaAttrsBottomHalfInfo', 5, (r) => ({ a: r.byte() }), (g) => M7.GetPlayAreaAttrsBottomHalfInfo(g.a), AY],
  ['CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0', 5, (r) => ({ a: r.byte(), y: pick(r, [0x17, 0x2f]) }),
    (g) => M7.CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0(g.a, g.y), null],
  ['CopyColumnOrRowToTileBuf', 5, () => ({}), () => M7.CopyColumnOrRowToTileBuf(), null],
  ['LayOutDoorsPrev', 5, () => ({}), () => M7.LayOutDoorsPrev(), null],
  ['InitMode7Submodes', 5, () => ({}), () => M7.InitMode7Submodes(), null, mode(7, 7)],
  ['UpdateMode7SubmodeAndDrawLink', 5, () => ({}), () => M7.UpdateMode7SubmodeAndDrawLink(), null, mode(7, 8)],
  ['Inc2Submodes', 5, () => ({}), () => M7.Inc2Submodes(), null],
  ['InitMode10', 5, () => ({}), () => M10.InitMode10(), null],
  ['UpdateMode10Stairs_Full', 5, () => ({}), () => M10.UpdateMode10Stairs_Full(), null],
  ['PutLinkBehindBackground', 5, () => ({}), () => M10.PutLinkBehindBackground(), null],
  ['InitMode4', 5, () => ({}), () => M46.InitMode4(), null, mode(4, 4)],
  ['SetFadeCycleAndAdvanceSubmode', 5, (r) => ({ a: r.byte() }), (g) => M46.SetFadeCycleAndAdvanceSubmode(g.a), null],
  ['InitMode_EnterRoom', 5, () => ({}), () => M46.InitMode_EnterRoom(), null, (st, sr, r) => { st[V.GameMode] = pick(r, [4, 9, 0x0b, 0x0c]); }],
  ['InitMode6', 5, () => ({}), () => M46.InitMode6(), null, mode(6, 1)],
  ['ResetInvObjState', 5, () => ({}), () => M46.ResetInvObjState(), A],
  ['GetPassedDoorType', 5, () => ({}), () => M46.GetPassedDoorType(), AY],
  ['UpdateMode4and6EnterLeave', 7, () => ({}), () => M46.UpdateMode4and6EnterLeave(), null],
  ['GoToNextModePlayLevelSong', 7, () => ({}), () => M46.GoToNextModePlayLevelSong(), null],
  ['GoToNextModeResetGridOffset', 7, () => ({}), () => M46.GoToNextModeResetGridOffset(), null],
  ['DrawSpritesBetweenRooms', 7, () => ({}), () => M46.DrawSpritesBetweenRooms(), null],
  ['ResetPlayerState', 7, () => ({}), () => M46.ResetPlayerState(), A],
  ['CheckSubroom', 5, () => ({}), () => Nr.CheckSubroom(), null, (st, sr, r) => { st[V.GameMode] = pick(r, [9, 0x0b, 0x0c]); }],
  ['GoToModeAFromCellar', 5, (r) => ({ a: r.byte() }), (g) => Nr.GoToModeAFromCellar(g.a), null],
  ['EndPrepareMode', 5, () => ({}), () => Nr.EndPrepareMode(), A],
  ['CalcNextRoomByDir', 5, (r) => ({ a: pick(r, DIRS) | (r.byte() & 0xf0) }), (g) => Nr.CalcNextRoomByDir(g.a), A],
  ['CalculateNextRoom', 5, () => ({}), () => Nr.CalculateNextRoom(), null, (st, sr, r) => { st[V.ObjDir] = pick(r, DIRS); }],
  ['CalculateNextRoomForDoor', 5, () => ({}), () => Nr.CalculateNextRoomForDoor(), null, (st, sr, r) => { st[0xe7] = pick(r, DIRS); }],
  ['CalculateNoNextRoom', 5, () => ({}), () => Nr.CalculateNoNextRoom(), A],
  ['InitMode3', 7, () => ({}), () => M3.InitMode3(), null, mode(3, 9)],
  ['PatchAndCueLevelPalettesTransferAndAdvanceSubmode', 7, () => ({}), () => M3.PatchAndCueLevelPalettesTransferAndAdvanceSubmode(), null],
  ['UpdateMode3Unfurl', 7, () => ({}), () => M3.UpdateMode3Unfurl(), null, (st, sr, r) => { st[V.ObjX + 12] = r.int(3); }],
  ['InitMode9', 5, () => ({}), () => M9.InitMode9(), null, mode(9, 10)],
  ['InitModeA', 5, () => ({}), () => MA.InitModeA(), null, mode(0x0a, 11)],
  ['InitModeB', 5, () => ({}), () => MA.InitModeB(), null, mode(0x0b, 9)],
  ['InitModeC', 5, () => ({}), () => MA.InitModeC(), null, mode(0x0c, 9)],
  ['InitModeB_EnterCave_Bank5', 5, () => ({}), () => MA.InitModeB_EnterCave_Bank5(), null,
    (st, sr, r) => { st[V.GameMode] = pick(r, [0x0b, 0x0c]); st[V.GameSubmode] = 7; }],
];

// Routines with big original subtrees (layout, objects, Link) get fewer cases.
const HEAVY = new Set(['InitMode7Submodes', 'InitMode_EnterRoom', 'InitMode6', 'InitMode3', 'InitModeA', 'InitModeB',
  'InitModeC', 'InitMode9', 'InitModeB_EnterCave_Bank5', 'InitMode4', 'UpdateMode7SubmodeAndDrawLink']);

test('P13 routines match the original 6502 code on random states', { skip, timeout: 1800000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P13_ONLY && !process.env.P13_ONLY.split(',').includes(name)) continue;
    await t.test(name, () => {
      const r = rng(0x13 + name.length * 7919 + name.charCodeAt(3) * 31);
      const n = HEAVY.has(name) ? Math.max(8, N >> 2) : N;
      let hung = 0;
      for (let i = 0; i < n; i++) {
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
        const ret = js(g);
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)} mode ${st[V.GameMode]} sub ${st[V.GameSubmode]}`);
        cmp?.(ret, orig);
      }
      assert.ok(hung <= n / 4, `${name}: ${hung}/${n} random states hang the original`);
      if (hung) t.diagnostic(`${name}: ${hung}/${n} states skipped (the original does not return)`);
    });
  }
});
