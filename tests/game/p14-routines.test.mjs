// P14 (doors, shutters, secrets, room flags, warps, mazes): every routine of the package vs. the
// original 6502 code (jsnes CPU, real ROM) on random RAM/SRAM states biased towards the interesting
// paths. Whole RAM (stack page excepted), SRAM and the returned registers/flags are compared.
// Skipped without roms/zelda.nes or jsnes. P14_N = cases per routine (default 400).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P14_N ?? 400);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const { NotImplementedError } = await import('../../src/game/stub.js');
const imp = async (p) => (ok ? import(p) : {});
const RF = await imp('../../src/game/world/roomflags.js');
const D = await imp('../../src/game/world/doors.js');
const S = await imp('../../src/game/world/secrets.js');
const W = await imp('../../src/game/world/warps.js');

const pick = (r, arr) => arr[r.int(arr.length)];
const dirs = [0x01, 0x02, 0x04, 0x08];

function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0; i < 0xc90; i++) sr[i] = r.byte();
  st[V.CurLevel] = r.chance(0.5) ? 0 : 1 + r.int(9);
  st[V.RoomId] = r.byte() & 0x7f;
  st[V.DynTileBufLen] = r.int(0x20);
  st[V.ObjTimer] = pick(r, [0, 0, 1, r.byte()]);
  // The world flags pointer points to the room flags in RAM ($067F, UW: $06FF) or to SRAM.
  const p = pick(r, [0x067f, 0x06ff, 0x6530 + r.int(0x100)]);
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000] = p & 0xff;
  sr[V.LevelInfo_WorldFlagsAddr - 0x6000 + 1] = p >> 8;
  return { st, sr };
}

// Link around the doorways (required coordinate and the bounds of tests/doorway tables).
function linkNearDoorways(r, st) {
  const near = (v) => (v + r.int(5) - 2) & 0xff;
  const xs = [0x78, near(0x3d), near(0x5c), near(0xbd), near(0xde), near(0x00), near(0x1f), near(0xcf), near(0xf1)];
  const ys = [0x8d, near(0x3d), near(0x5e), near(0xbf), near(0xde), near(0x00), near(0x21), near(0xd2), near(0xf1)];
  st[V.ObjX] = r.chance(0.8) ? pick(r, xs) : r.byte();
  st[V.ObjY] = r.chance(0.8) ? pick(r, ys) : r.byte();
  st[V.DoorwayDir] = pick(r, [0, 0, ...dirs, r.byte()]);
  st[V.ObjDir] = pick(r, [...dirs, r.byte()]);
  st[V.ObjInputDir] = pick(r, [...dirs, ...dirs, 0, r.byte()]);
  st[V.TriggeredDoorCmd] = pick(r, [0, 0, r.byte()]);
  st[V.InvMagicKey] = pick(r, [0, 0, 1]);
  st[V.InvKeys] = pick(r, [0, 1, r.byte()]);
}

function doorCommand(r, st) {
  st[V.GameMode] = pick(r, [0x05, 0x05, 0x05, 0x12]);
  st[V.DoorTimer] = pick(r, [0, 0, 0, r.byte()]);
  st[V.TriggeredDoorCmd] = pick(r, [0, 2, 3, 6, 7, 2, 3, 6, 7, r.byte()]);
  st[V.TriggeredDoorDir] = pick(r, [...dirs, r.byte() & 0x0f]);
}

function warpState(r, st, sr) {
  st[V.UndergroundExitType] = pick(r, [0, 0, 0, r.byte()]);
  st[V.ObjGridOffset] = pick(r, [0, 0, 0, r.byte()]);
  if (r.chance(0.2)) st[V.RoomId] = 0x22;
  st[V.ObjX] = r.chance(0.8) ? (r.byte() & (r.chance(0.5) ? 0xf0 : 0xf8)) : r.byte();
  st[V.ObjY] = r.chance(0.8) ? ((r.byte() & 0xf0) | 0x0d) : r.byte();
  // Bias the play area map towards caves ($24, $88) and stairs ($70-$74).
  for (let i = 0x530; i < 0x7f0; i++) if (r.chance(0.6)) sr[i] = pick(r, [0x24, 0x88, 0x70, 0x71, 0x72, 0x73, 0x74]);
  // Make sure the cellar search finds a room (the original loops forever otherwise).
  const k = r.int(10);
  const cellar = sr[V.LevelInfo_CellarRoomIdArray - 0x6000 + k];
  sr[(r.chance(0.5) ? V.LevelBlockAttrsA : V.LevelBlockAttrsB) - 0x6000 + cellar] = st[V.RoomId];
}

const A = (ret, o) => assert.equal(ret & 0xff, o.a, 'register A');
const X = (ret, o) => assert.equal(ret & 0xff, o.x, 'register X');
const Y = (ret, o) => assert.equal(ret & 0xff, o.y, 'register Y');
const C = (ret, o) => assert.equal(ret ? 1 : 0, o.c, 'carry');

const cases = [
  // name, bank mapped by the caller, registers, state tweak, JS call, result check
  ['GetRoomFlags', 7, () => ({}), null, () => RF.GetRoomFlags(), A],
  ['GetUniqueRoomId', 7, () => ({}), null, () => RF.GetUniqueRoomId(), A],
  ['MarkRoomVisited', 7, () => ({}), null, () => RF.MarkRoomVisited(), null],
  ['SaveKillCount', 5, () => ({}), null, () => RF.SaveKillCount(), null],
  ['SetDoorFlag', 5, (r) => ({ x: r.int(4) }), null, (g) => D.SetDoorFlag(g.x), Y],
  ['ResetDoorFlag', 5, (r) => ({ x: r.int(4) }), null, (g) => D.ResetDoorFlag(g.x), Y],
  ['CalcOpenDoorwayMask', 5, (r) => ({ a: r.int(9), x: r.int(4) }), null, (g) => D.CalcOpenDoorwayMask(g.a, g.x), A],
  ['AddDoorFlagsToCurOpenedDoors', 5, () => ({}), null, () => D.AddDoorFlagsToCurOpenedDoors(), null],
  ['FindDoorTypeByDoorBit', 5, () => ({}), (r, st) => { st[0x02] = pick(r, [...dirs, 0, r.byte()]); },
    () => D.FindDoorTypeByDoorBit(), A],
  ['CheckShutters', 5, () => ({}), (r, st) => {
    st[V.ShutterTrigger] = pick(r, [0, 1, 1, r.byte()]);
    st[V.TriggeredDoorCmd] = pick(r, [0, 0, r.byte()]);
  }, () => D.CheckShutters(), null],
  ['TriggerOpenDoor', 5, (r) => ({ a: r.byte() }), null, (g) => D.TriggerOpenDoor(g.a), null],
  ['GetPlayerCoordsForDirection', 5, (r) => ({ a: r.byte() }), null, (g) => D.GetPlayerCoordsForDirection(g.a), null],
  ['CheckDoorway', 5, () => ({}), (r, st) => linkNearDoorways(r, st), () => D.CheckDoorway(), null],
  ['TouchDoor', 5, (r) => ({ a: r.byte() }), (r, st) => {
    linkNearDoorways(r, st);
    st[0x0c] = pick(r, [...dirs, r.byte()]);
  }, (g) => D.TouchDoor(g.a), null],
  ['UpdateDoors', 5, () => ({}), (r, st) => doorCommand(r, st), () => D.UpdateDoors(), null],
  ['PrepareWriteHorizontalDoorTransferRecords', 5, () => ({}), (r, st) => {
    doorCommand(r, st);
    st[0x08] = pick(r, [0, 2, r.byte()]);
  }, () => D.PrepareWriteHorizontalDoorTransferRecords(), X],
  ['L_SetOpenedDoorMaskAndResetCmdAndLayOutDoors', 5, (r) => ({ a: r.byte() & 0x0f }), null,
    (g) => D.L_SetOpenedDoorMaskAndResetCmdAndLayOutDoors(g.a), null],
  ['L_ResetDoorCmdAndLayOutDoors', 5, () => ({}), null, () => D.L_ResetDoorCmdAndLayOutDoors(), null],
  ['CheckUnderworldSecrets', 5, () => ({}), (r, st) => secretState(r, st), () => S.CheckUnderworldSecrets(), null],
  ['CheckSecretTrigger', 5, (r) => ({ a: 1 + r.int(7), c: r.int(2) }), (r, st) => secretState(r, st),
    (g) => S.CheckSecretTrigger(g.a), C],
  ['CheckHasLivingMonsters', 5, () => ({}), (r, st) => secretState(r, st), () => S.CheckHasLivingMonsters(), null],
  ...['TouchDoorWall', 'TouchDoorOpen', 'TouchDoorFalse', 'TouchDoorBombable', 'TouchDoorShutter', 'TouchDoorKey']
    .map((n) => [n, 5, () => ({}), (r, st) => { linkNearDoorways(r, st); st[0x0c] = pick(r, [...dirs, r.byte()]); }, () => D[n](), null]),
  ...['CheckSecretTriggerAllDead', 'CheckSecretTriggerRingleader', 'CheckSecretTriggerLastBoss', 'CheckSecretTriggerBlockDoor',
    'CheckSecretTriggerBlockStairs', 'CheckSecretTriggerMoneyOrLife']
    .map((n) => [n, 5, () => ({}), (r, st) => secretState(r, st), () => S[n](), C]),
  ['HandleWarpOW', 5, (r) => ({ a: pick(r, [0x24, 0x88, 0x70, 0x71, 0x72, 0x73, 0x74, r.byte()]) }), (r, st, sr) => warpState(r, st, sr),
    (g) => W.HandleWarpOW(g.a), null],
  ['PlaySecretFoundTune', 4, () => ({}), null, () => S.PlaySecretFoundTune(), A],
  ['CheckWarps', 5, () => ({}), (r, st, sr) => warpState(r, st, sr), () => W.CheckWarps(), null],
  ['SetTargetMode', 5, (r) => ({ a: pick(r, [0x02, 0x09, 0x0b, 0x0c, r.byte()]) }), null, (g) => W.SetTargetMode(g.a), null],
  ['CheckMazes', 5, () => ({}), (r, st) => {
    st[V.RoomId] = pick(r, [0x61, 0x61, 0x1b, 0x1b, r.byte() & 0x7f]);
    st[V.MazeStep] = r.int(4);
    st[V.ObjDir] = pick(r, dirs);
  }, () => W.CheckMazes(), null],
];

function secretState(r, st) {
  st[V.LevelBlockAttrsByteF] = r.byte();
  st[V.CurObjIndex] = pick(r, [0x0b, 0x0b, r.int(0x0d), r.byte()]);
  for (let i = 1; i <= 0x0c; i++) {
    st[V.ObjType + i] = pick(r, [0, 0, 0x2b, 0x2c, 0x2d, 0x2e, 0x48, 0x49, 0x52, 0x53, 0x60, r.byte()]);
    st[V.ObjMetastate + i] = pick(r, [0, 0, r.byte()]);
  }
  st[V.RoomAllDead] = pick(r, [0, r.byte()]);
  st[V.BlockPushComplete] = pick(r, [0, 1, 2, r.byte()]);
  st[V.LastBossDefeated] = pick(r, [0, r.byte()]);
  // ChangeTileObjTiles would return to bank 4 (garbage under bank-5 code): never set from bank 5.
  st[V.ReturnToBank4] = 0;
  // The room item is active (0) in most cases: GetRoomFlagUWItemState (P10) is not reached then.
  st[V.ObjState + 19] = r.chance(0.8) ? 0 : r.byte();
}

test('P14 routines match the original 6502 code on random states', { skip }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, tweak, js, cmp] of cases) {
    await t.test(name, () => {
      const r = rng(0x1414 + name.length * 7919 + name.charCodeAt(3) * 31);
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
