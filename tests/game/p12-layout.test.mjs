// P12 (room layout, tile map, door drawing) against the ORIGINAL 6502 routines, run on the same machine
// state by tests/game/p01-hybrid.mjs. For every OW/UW room of both quests (with varied room flags and
// opened doors), caves, cellars, row/column transfers and square changes: the JS port and the original
// must leave identical RAM, SRAM (minus the WRAM code copy), mapper bank and returned registers.
// Routines of later packages (P14 room flags/doors, P10 GetShortcutOrItemXY) run as original code.
// Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, hasRom } from '../core/helpers.mjs';

await import('./p01-hybrid-register.mjs'); // stub.js -> hybrid stubs for the imports below
const { canRunHybrid, runOriginal } = await import('./p01-hybrid.mjs');
const skip = !hasRom ? 'roms/zelda.nes not present' : !canRunHybrid ? 'jsnes not installed' : false;

let env;
async function setup() {
  if (env) return env;
  const { createGame } = await import('../../src/headless.js');
  const game = await createGame({ rom: readFileSync(join(ROOT, 'roms/zelda.nes')) });
  const { ram, sram, cpu } = await import('../../src/core/ram.js');
  const { bus } = await import('../../src/core/bus.js');
  const { switchBank } = await import('../../src/core/asm.js');
  const V = await import('../../src/core/vars.js');
  const boot = await import('../../src/game/boot.js');
  const m2 = await import('../../src/game/modes/mode2-load.js');
  const mods = {
    ...(await import('../../src/game/world/layout.js')),
    ...(await import('../../src/game/world/overworld.js')),
    ...(await import('../../src/game/world/underworld.js')),
    ...(await import('../../src/game/world/doors-draw.js')),
    ...(await import('../../src/game/world/tilemap.js')),
  };
  switchBank(1);
  boot.CopyCommonCodeToRam();
  switchBank(6);
  boot.CopyCommonDataToRam();
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) % n; };
  const loadLevel = (level, quest) => {
    ram[V.CurLevel] = level;
    ram[V.CurSaveSlot] = 0;
    ram[V.QuestNumbers] = quest;
    switchBank(6);
    m2.InitMode2_Sub0();
    m2.InitMode2_Sub1();
    m2.UpdateMode2Load_Full();
    ram[V.GameSubmode] = 0;
  };
  env = { game, ram, sram, cpu, bus, switchBank, V, mods, rnd, loadLevel };
  return env;
}

const ignoredRam = (i) => i >= 0x110 && i < 0x200;
const ignoredSram = (i) => i >= 0x0c90 && i < 0x1f00;

/** Run port fn and original routine from the same state; compare memory/bank and chosen outputs. */
function same(e, name, jsCall, regs = {}, outputs = () => null) {
  const { ram, sram, bus } = e;
  const r0 = ram.slice(), s0 = sram.slice(), b0 = bus.mapper.prgBank;
  const ret = jsCall();
  const r1 = ram.slice(), s1 = sram.slice(), b1 = bus.mapper.prgBank;
  ram.set(r0); sram.set(s0); bus.mapper.setPrgBank(b0);
  const o = runOriginal(name, regs);
  for (let i = 0; i < 0x800; i++) {
    if (!ignoredRam(i) && r1[i] !== ram[i]) assert.fail(`${name}: RAM $${i.toString(16)} port=${r1[i].toString(16)} orig=${ram[i].toString(16)}`);
  }
  for (let i = 0; i < 0x2000; i++) {
    if (!ignoredSram(i) && s1[i] !== sram[i]) assert.fail(`${name}: SRAM $${(0x6000 + i).toString(16)} port=${s1[i].toString(16)} orig=${sram[i].toString(16)}`);
  }
  assert.equal(b1, bus.mapper.prgBank, `${name}: PRG bank`);
  const exp = outputs(o);
  if (exp !== null) assert.deepEqual(exp.port(ret), exp.orig, `${name}: returned registers`);
  return ret;
}

/** Room flags of the current level, randomized (secret found, shortcut seen, door bits...). */
function randomizeRoomFlags(e, mask) {
  const { sram, ram, V, rnd } = e;
  const flags = sram[V.LevelInfo_WorldFlagsAddr - 0x6000] | (sram[V.LevelInfo_WorldFlagsAddr + 1 - 0x6000] << 8);
  const v = rnd(256) & mask;
  if (flags + ram[V.RoomId] < 0x800) ram[flags + ram[V.RoomId]] = v; // room flags live in RAM ($067F+)
  else if (flags >= 0x6000 && flags < 0x8000) sram[flags - 0x6000 + ram[V.RoomId]] = v;
  else assert.fail(`unexpected world flags address $${flags.toString(16)}`);
}

test('LayOutRoom: every OW room of both quests, with and without secrets/shortcuts', { skip }, async () => {
  const e = await setup();
  const { ram, V, mods, switchBank, rnd } = e;
  for (const quest of [0, 1]) {
    e.loadLevel(0, quest);
    for (let room = 0; room < 0x80; room++) {
      for (const mask of [0x00, 0x20, 0xa0, 0xff]) {
        ram[V.RoomId] = room;
        randomizeRoomFlags(e, mask);
        ram[V.RoomTileObjType] = rnd(2) ? 0x62 : 0;
        switchBank(5);
        same(e, 'LayOutRoom', () => mods.LayOutRoom());
      }
    }
  }
});

test('LayOutRoom: every UW room of levels 1-9, both quests, with random opened doors', { skip }, async () => {
  const e = await setup();
  const { ram, V, mods, switchBank, rnd } = e;
  for (const quest of [0, 1]) {
    for (let level = 1; level <= 9; level++) {
      e.loadLevel(level, quest);
      for (let room = 0; room < 0x80; room++) {
        for (let k = 0; k < 3; k++) {
          ram[V.RoomId] = room;
          randomizeRoomFlags(e, 0xff);
          ram[V.CurOpenedDoors] = rnd(16);
          ram[V.OpenDoorwayMask] = rnd(256);
          switchBank(5);
          same(e, 'LayOutRoom', () => mods.LayOutRoom());
        }
      }
    }
  }
});

test('caves, shortcut caves and cellars; LayoutRoom_SubmodeTask; LayoutRoomOW', { skip }, async () => {
  const e = await setup();
  const { ram, V, mods, switchBank, rnd } = e;
  e.loadLevel(0, 0);
  for (let room = 0; room < 0x80; room += 3) {
    ram[V.RoomId] = room;
    randomizeRoomFlags(e, 0xff);
    ram[V.GameSubmode] = rnd(5);
    switchBank(5);
    mods.PatchColumnDirectoryForCellar();
    same(e, 'LayoutCaveAndAvanceSubmode', () => mods.LayoutCaveAndAvanceSubmode());
    same(e, 'LayoutShortcutAndAdvanceSubmode', () => mods.LayoutShortcutAndAdvanceSubmode());
    same(e, 'LayoutRoom_SubmodeTask', () => mods.LayoutRoom_SubmodeTask());
    same(e, 'LayoutRoomOW', () => mods.LayoutRoomOW());
  }
  for (let level = 1; level <= 9; level++) {
    e.loadLevel(level, level & 1);
    for (let room = 0; room < 0x80; room += 5) {
      ram[V.RoomId] = room;
      randomizeRoomFlags(e, 0xff);
      switchBank(5);
      mods.PatchColumnDirectoryForCellar();
      same(e, 'LayoutCellarAndAdvanceSubmode', () => mods.LayoutCellarAndAdvanceSubmode());
      same(e, 'LayoutRoom_SubmodeTask', () => mods.LayoutRoom_SubmodeTask());
    }
  }
});

test('row/column transfers, FillTileMap, ChangeTileObjTiles, ChangePlayMapSquareOW', { skip }, async () => {
  const e = await setup();
  const { ram, V, mods, switchBank, rnd, cpu } = e;
  e.loadLevel(0, 0);
  ram[V.RoomId] = 0x77;
  switchBank(5);
  mods.LayOutRoom();
  for (let col = 0; col <= 0x20; col++) {
    ram[V.CurColumn] = col;
    ram[V.DynTileBufLen] = rnd(0x20);
    same(e, 'CopyColumnToTileBuf', () => mods.CopyColumnToTileBuf());
  }
  for (let row = 0; row < 0x18; row++) {
    ram[V.CurRow] = row;
    same(e, 'CopyRowToTileBuf', () => mods.CopyRowToTileBuf());
    same(e, 'CopyNextRowToTransferBuf', () => mods.CopyNextRowToTransferBuf(), {}, (o) => ({ orig: o.c, port: (r) => r }));
    same(e, 'CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone', () => mods.CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone(),
      {}, (o) => ({ orig: o.c, port: () => cpu.c }));
  }
  ram[0x0a] = rnd(256);
  same(e, 'FillTileMap', () => mods.FillTileMap());
  same(e, 'FetchTileMapAddr', () => mods.FetchTileMapAddr());
  for (let i = 0; i < 400; i++) {
    const x = 1 + rnd(0x13);
    ram[V.ObjX + x] = rnd(256);
    ram[V.ObjY + x] = 0x40 + rnd(0xb0);
    ram[V.DynTileBufLen] = rnd(0x30);
    ram[V.ReturnToBank4] = rnd(2);
    const tile = [0x24, 0x26, 0x70, 0xc8, 0xbc, 0xc4, 0xd8, 0x46, 0x45, 0xf3, 0xf2, 0x00, rnd(256)][rnd(13)];
    switchBank([4, 5][rnd(2)]);
    same(e, 'ChangeTileObjTiles', () => mods.ChangeTileObjTiles(tile, x), { a: tile, x });
    ram[0x05] = tile;
    switchBank(5);
    same(e, 'ChangePlayMapSquareOW', () => mods.ChangePlayMapSquareOW(x), { x }, (o) => ({ orig: o.x, port: (r) => r }));
    ram[0x02] = rnd(256);
    ram[0x03] = rnd(256);
    same(e, 'MapScreenPosToPpuAddr', () => mods.MapScreenPosToPpuAddr());
  }
});

test('square writers, tile objects, door faces, dark rooms', { skip }, async () => {
  const e = await setup();
  const { ram, V, mods, switchBank, rnd, cpu } = e;
  e.loadLevel(3, 0);
  switchBank(5);
  for (let i = 0; i < 300; i++) {
    ram[0x00] = 0x30 + rnd(0x80);
    ram[0x01] = 0x65 + rnd(2);
    ram[0x0d] = rnd(0x40);
    const a = rnd(256), y = rnd(0x14);
    same(e, 'WriteSquareOW', () => mods.WriteSquareOW(a, y), { a, y });
    same(e, 'WriteSquareUW', () => mods.WriteSquareUW(a, y), { a, y });
    ram[0x06] = rnd(0x10);
    ram[0x07] = rnd(0x0b);
    const p = [0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xe4, 0xeb, a][rnd(9)];
    same(e, 'CheckTileObject', () => mods.CheckTileObject(p), { a: p }, (o) => ({ orig: o.a, port: (r) => r }));
    const dir = rnd(4), face = 1 + rnd(5);
    same(e, 'FetchDoorAddrsFaceTilesSrcAndPlayAreaDst', () => mods.FetchDoorAddrsFaceTilesSrcAndPlayAreaDst(dir, face),
      { a: dir, y: face }, (o) => ({ orig: o.x, port: (r) => r }));
    ram[0x09] = dir;
    ram[0x07] = rnd(4);
    ram[0x04] = rnd(4);
    const x = rnd(0x30);
    same(e, 'WriteDoorFaceTileHorizontally', () => mods.WriteDoorFaceTileHorizontally(x), { x },
      (o) => ({ orig: o.x, port: (r) => r }));
    assert.equal(cpu.z, ram[0x04] === 0 ? 1 : 0);
    const room = rnd(0x80);
    ram[V.CurLevel] = rnd(2) ? 0 : 3;
    same(e, 'IsDarkRoom_Bank5', () => mods.IsDarkRoom_Bank5(room), { y: room }, (o) => ({ orig: o.a, port: (r) => r }));
    ram[V.CurLevel] = 3;
  }
  for (let k = 0; k < 50; k++) {
    ram[V.RoomId] = rnd(0x80);
    ram[V.CurOpenedDoors] = rnd(16);
    randomizeRoomFlags(e, 0xff);
    same(e, 'LayOutDoors', () => mods.LayOutDoors());
    const x = rnd(4);
    same(e, 'L_LayOutDoors_LoopDoors', () => mods.L_LayOutDoors_LoopDoors(x), { x });
    same(e, 'FillWalls', () => mods.FillWalls());
    same(e, 'LayoutUWFloor', () => mods.LayoutUWFloor());
  }
});
