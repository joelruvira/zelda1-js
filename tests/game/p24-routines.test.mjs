// P24: every ported routine vs. the original 6502 code (jsnes CPU on the port's machine, see
// p01-hybrid.mjs) from the same random RAM/SRAM/PPU states. Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canRunHybrid, runOriginal } from './p01-hybrid.mjs';
import { loadSymbols, loadRom, label } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram, cpu } from '../../src/core/ram.js';
import { bus } from '../../src/core/bus.js';
import { switchBank } from '../../src/core/asm.js';
import { ROM_PATH } from '../core/helpers.mjs';
import {
  CurSaveSlot, GameMode, GameSubmode, ButtonsPressed, ButtonsDown, IsSaveSlotActive,
  IsSaveFileBCommitted, SaveFileOpenMarkers, SaveFileCloseMarkers, ObjX, ObjY, StillHoldingButton,
  ButtonRepeatTimer, HeldButton, CharBoardIndex, InitializedNameField, NameCharOffset, NameInputCharBuf,
  QuestNumbers, SaveRamBegin, SaveRamEnd,
} from '../../src/core/vars.js';
import * as files from '../../src/game/save/files.js';
import * as m1 from '../../src/game/modes/mode1-fileselect.js';
import * as mE from '../../src/game/modes/modeE-register.js';
import * as mF from '../../src/game/modes/modeF-eliminate.js';
import * as mD from '../../src/game/modes/modeD-save.js';
import * as fmt from '../../src/game/text/format.js';
import { ResetRoomTileObjInfo } from '../../src/game/worldobj/tileobjects.js';

const skip = !canRunHybrid && 'needs roms/zelda.nes and tools/oracle jsnes';
let machine;
if (canRunHybrid) {
  await loadSymbols();
  machine = createMachine(loadRom(readFileSync(ROM_PATH)));
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return { byte: () => next() & 0xff, int: (n) => next() % n };
}

/** CopyCommonCodeToRam and CopyCommonDataToRam, as InitializeGameOrMode leaves WRAM. */
function copyCommon() {
  for (let i = 0; i < 0x1270; i++) sram[0x0c90 + i] = bus.rom.prgByte(1, 0xa500 + i);
  const d = label('MenuPalettesTransferBuf');
  for (let i = 0; i < 0x8e; i++) sram[d.addr - 0x6000 + i] = bus.rom.prgByte(6, d.load + i);
}

const PPU_FIELDS = ['ctrl', 'mask', 'status', 'oamAddr', 'v', 't', 'x', 'w', 'readBuffer', 'mirroring'];
function snapshot() {
  const p = machine.ppu;
  const m = machine.mapper;
  return {
    ram: Uint8Array.from(ram), sram: Uint8Array.from(sram),
    vram: Uint8Array.from(p.vram), pal: Uint8Array.from(p.palette),
    regs: PPU_FIELDS.map((f) => p[f]), mapper: [m.shift, m.control, m.chrBank0, m.chrBank1, m.prgBank],
  };
}
function restore(s) {
  const p = machine.ppu;
  const m = machine.mapper;
  ram.set(s.ram); sram.set(s.sram);
  p.vram.set(s.vram); p.palette.set(s.pal);
  PPU_FIELDS.forEach((f, i) => { p[f] = s.regs[i]; });
  [m.shift, m.control, m.chrBank0, m.chrBank1, m.prgBank] = s.mapper;
}
function firstDiff(a, b, base = 0, skipStack = false) {
  for (let i = 0; i < a.length; i++) {
    if (skipStack && i >= 0x100 && i < 0x200) continue;
    if (a[i] !== b[i]) return `$${(base + i).toString(16)}: port ${a[i].toString(16)} != orig ${b[i].toString(16)}`;
  }
  return null;
}
function assertSame(port, orig, what) {
  assert.equal(firstDiff(port.ram, orig.ram, 0, true), null, `${what}: RAM`);
  assert.equal(firstDiff(port.sram, orig.sram, 0x6000), null, `${what}: SRAM`);
  assert.equal(firstDiff(port.vram, orig.vram, 0x2000), null, `${what}: VRAM`);
  assert.equal(firstDiff(port.pal, orig.pal, 0x3f00), null, `${what}: palette`);
  assert.deepEqual(port.regs, orig.regs, `${what}: PPU registers ${PPU_FIELDS}`);
  assert.deepEqual(port.mapper, orig.mapper, `${what}: MMC1`);
}

/** Random state -> run the original and the port from it -> compare everything. */
function check(name, fn, { seeds = 12, prepare = () => {}, regs = () => ({}), cmpRet } = {}) {
  for (let seed = 1; seed <= seeds; seed++) {
    const r = rng(seed * 7919 + name.length * 31);
    for (let i = 0; i < 0x800; i++) ram[i] = r.byte();
    for (let i = 0; i < 0x2000; i++) sram[i] = r.byte();
    machine.ppu.reset();
    machine.mapper.powerOn();
    copyCommon();
    ram[CurSaveSlot] = r.int(3);
    const reg = regs(r);
    const { bank, addr } = label(name);
    switchBank(addr >= 0x8000 && addr < 0xc000 ? bank : 2);
    prepare(r, reg);
    const start = snapshot();
    const o = runOriginal(name, reg);
    const orig = snapshot();
    restore(start);
    cpu.c = reg.c ?? 0;
    const ret = fn(reg);
    const port = snapshot();
    assertSame(port, orig, `${name} seed ${seed}`);
    if (cmpRet) cmpRet(ret, o, `${name} seed ${seed}`);
  }
}
const retA = (ret, o, what) => assert.equal(ret & 0xff, o.a, `${what}: A`);

// Make file A/B of every slot consistent (markers, checksums) or not, to reach both branches.
function randomFiles(r) {
  for (let s = 0; s < 3; s++) {
    ram[CurSaveSlot] = s;
    if (r.int(2)) { files.FetchFileAAddressSet(); files.FormatFileA(); }
    if (r.int(2)) {
      files.FetchFileBAddressSet();
      files.CalculateAndStoreFileBChecksumUncommitted();
      if (r.int(3) === 0) sram[0x0d9c + s * 2] ^= 1; // invalid file B checksum
    }
    sram[IsSaveFileBCommitted - 0x6000 + s] = r.int(3) ? sram[IsSaveFileBCommitted - 0x6000 + s] : 0;
    if (r.int(4) === 0) sram[SaveFileOpenMarkers - 0x6000 + s] = 0x5a;
    if (r.int(4) === 0) sram[SaveFileCloseMarkers - 0x6000 + s] = 0xa5;
  }
  ram[CurSaveSlot] = r.int(3);
}

test('P24 save files: address sets, checksums, format, commit', { skip }, () => {
  check('FetchFileAAddressSet', () => files.FetchFileAAddressSet(), { cmpRet: retA });
  check('FetchFileBAddressSet', () => files.FetchFileBAddressSet(), { cmpRet: retA });
  check('AddATo0F0E', (g) => files.AddATo0F0E(g.a), { regs: (r) => ({ a: r.byte() }), cmpRet: retA });
  check('AddAToCFCE', (g) => files.AddAToCFCE(g.a), { regs: (r) => ({ a: r.byte() }), cmpRet: retA });
  check('CalculateFileAChecksum', () => files.CalculateFileAChecksum(), { prepare: () => files.FetchFileAAddressSet(), cmpRet: retA });
  check('CalculateFileBChecksum', () => files.CalculateFileBChecksum(), { prepare: () => files.FetchFileBAddressSet(), cmpRet: retA });
  check('CalculateAndStoreFileBChecksumUncommitted', () => files.CalculateAndStoreFileBChecksumUncommitted(), {
    prepare: () => files.FetchFileBAddressSet(), cmpRet: retA,
  });
  check('FormatFileA', () => files.FormatFileA(), { prepare: () => files.FetchFileAAddressSet(), cmpRet: retA });
  check('FormatFileB', () => files.FormatFileB(), { prepare: () => files.FetchFileBAddressSet(), cmpRet: retA });
  check('CopyFileBToFileA', () => files.CopyFileBToFileA(), { cmpRet: retA });
  check('FetchProfileNameAddress', () => files.FetchProfileNameAddress(), { cmpRet: retA });
  check('StoreSaveSlotHearts', () => files.StoreSaveSlotHearts(), { cmpRet: retA });
  check('SwitchProfileToSecondQuest', () => files.SwitchProfileToSecondQuest(), { cmpRet: retA });
});

test('P24 mode 1: file validation, menu init submodes, menu update', { skip }, () => {
  check('UpdateMode0Demo_Sub1', () => m1.UpdateMode0Demo_Sub1(), { seeds: 20, prepare: randomFiles });
  check('InitMode1_Sub1', () => m1.InitMode1_Sub1(), {
    prepare: (r) => { files.FetchFileAAddressSet(); for (let s = 0; s < 3; s++) sram[0x1a + 0x0b + s * 0x28] = r.int(3); },
    cmpRet: retA,
  });
  check('InitMode1_Sub2', () => m1.InitMode1_Sub2());
  check('InitMode1_FillAndTransferSlotTiles', () => m1.InitMode1_FillAndTransferSlotTiles());
  check('InitMode1_Sub6', () => m1.InitMode1_Sub6(), {
    seeds: 20,
    prepare: (r) => {
      for (let s = 0; s < 3; s++) {
        ram[0x0630 + s] = [0, 7, 42, 100, 255, r.byte()][r.int(6)];
        ram[IsSaveSlotActive + s] = r.int(2);
      }
      ram[IsSaveSlotActive + 3] = 1;
    },
  });
  check('InitMode1_Full', () => m1.InitMode1_Full(), {
    seeds: 21, prepare: (r) => { ram[GameSubmode] = r.int(7); ram[IsSaveSlotActive + 3] = 1; randomFiles(r); },
  });
  check('Mode1_WriteLinkSprites', () => m1.Mode1_WriteLinkSprites(), {
    prepare: (r) => { for (let s = 0; s < 3; s++) ram[QuestNumbers + s] = r.int(2); },
  });
  check('UpdateMode1Menu_Sub0', () => m1.UpdateMode1Menu_Sub0(), {
    seeds: 20,
    prepare: (r) => {
      ram[ButtonsPressed] = [0x00, 0x10, 0x20, 0x30, r.byte()][r.int(5)];
      ram[CurSaveSlot] = r.int(5);
      for (let s = 0; s < 5; s++) ram[IsSaveSlotActive + s] = r.int(2);
      ram[IsSaveSlotActive + 3] = 1;
    },
  });
  check('UpdateMode1Menu_Sub1', () => m1.UpdateMode1Menu_Sub1(), {
    seeds: 10, prepare: (r) => { ram[CurSaveSlot] = r.int(5); }, cmpRet: retA,
  });
  check('UpdateMode1Menu', () => m1.UpdateMode1Menu(), {
    seeds: 10,
    prepare: (r) => { ram[GameSubmode] = r.int(2); ram[CurSaveSlot] = r.int(5); ram[IsSaveSlotActive + 3] = 1; },
  });
});

const eRegs = (r) => {
  ram[GameMode] = r.int(2) ? 0x0e : 0x0f;
  ram[ButtonsPressed] = [0x00, 0x10, 0x20, 0x40, 0x80, 0xc0, r.byte()][r.int(7)];
  ram[ButtonsDown] = [0x00, 0x01, 0x02, 0x04, 0x08, 0x03, r.byte()][r.int(7)];
  ram[CurSaveSlot] = r.int(4);
  ram[ObjY] = [0x2f, 0x47, 0x5f, 0x77][r.int(4)];
  ram[ObjX] = 0x70 + 8 * r.int(8);
  ram[ObjX + 1] = 0x30 + 0x10 * r.int(11);
  ram[ObjY + 1] = 0x87 + 0x10 * r.int(4);
  ram[CharBoardIndex] = r.int(44);
  ram[InitializedNameField] = r.int(2);
  ram[NameCharOffset] = r.int(24);
  ram[NameInputCharBuf + 1] = (r.byte() & 0xf0) | [0x0e, 0x05, 0x06, 0x00][r.int(4)];
  ram[StillHoldingButton] = r.int(2);
  ram[HeldButton] = [0x01, 0x02, 0x04, 0x08][r.int(4)];
  ram[ButtonRepeatTimer] = r.int(3) ? 0 : r.int(16);
  return {};
};

test('P24 modes $E/$F: init, register, eliminate, cursors', { skip }, () => {
  check('InitModeEandF_Full', () => mE.InitModeEandF_Full(), {
    seeds: 20, prepare: (r) => { eRegs(r); ram[GameSubmode] = r.int(5); },
  });
  check('UpdateModeERegister', () => mE.UpdateModeERegister(), {
    seeds: 40,
    prepare: (r) => {
      eRegs(r);
      if (r.int(2)) { ram[ButtonsPressed] = 0x10; ram[CurSaveSlot] = 3; }
      if (r.int(2)) { // a ZELDA name in a random slot
        const s = r.int(3);
        [0x23, 0x0e, 0x15, 0x0d, 0x0a].forEach((c, i) => { ram[0x0638 + s * 8 + i] = c; });
        ram[IsSaveSlotActive + s] = 0;
      }
      for (let i = 0; i < 24; i++) if (r.int(3) === 0) ram[0x0638 + i] = 0x24;
    },
  });
  check('ModeE_ResetVariables', (g) => mE.ModeE_ResetVariables(g.a), { regs: () => ({ a: 0 }), cmpRet: retA });
  check('ModeE_HandleDirections', () => mE.ModeE_HandleDirections(), { seeds: 30, prepare: eRegs });
  check('ResetButtonRepeatState', (g) => mE.ResetButtonRepeatState(g.a), { regs: (r) => ({ a: r.byte() }), cmpRet: retA });
  check('ModeE_HandleDirectionButton', (g) => mE.ModeE_HandleDirectionButton(g.a), {
    seeds: 40, prepare: eRegs, regs: (r) => ({ a: [1, 2, 4, 8, 3][r.int(5)] }),
  });
  check('CycleCharBoardCursorY', (g) => mE.CycleCharBoardCursorY(g.x), {
    seeds: 20, prepare: eRegs, regs: (r) => ({ x: r.int(2) ? 0 : 3 }),
  });
  check('ModeE_HandleAOrB', () => mE.ModeE_HandleAOrB(), { seeds: 40, prepare: eRegs });
  check('ModeEandF_SetUpCursorSprites', () => mE.ModeEandF_SetUpCursorSprites(), { prepare: eRegs });
  check('ModeEandF_WriteNameCursorSpritePosition', () => mE.ModeEandF_WriteNameCursorSpritePosition(), { prepare: eRegs });
  check('ModeE_SetNameCursorSpriteX', () => mE.ModeE_SetNameCursorSpriteX(), { prepare: eRegs, cmpRet: retA });
  check('ModeEandF_WriteCharBoardCursorSpritePosition', () => mE.ModeEandF_WriteCharBoardCursorSpritePosition(), { prepare: eRegs });
  check('ModifyFlashingCursorY', (g) => mE.ModifyFlashingCursorY(g.a), {
    regs: (r) => ({ a: r.byte() }), cmpRet: (ret, o, w) => assert.equal(ret, o.y, `${w}: Y`),
  });
  check('UpdateModeEandF_Idle', () => mE.UpdateModeEandF_Idle(), { seeds: 30, prepare: eRegs });
  check('UpdateModeFElimination', () => mF.UpdateModeFElimination(), {
    seeds: 30, prepare: (r) => { eRegs(r); if (r.int(2)) ram[ButtonsPressed] = 0x10; },
  });
  check('DeleteSlot', () => mF.DeleteSlot(), { cmpRet: retA });
});

test('P24 mode $D: save', { skip }, () => {
  check('InitModeD', () => mD.InitModeD(), {
    seeds: 4, prepare: () => { sram[SaveRamBegin - 0x6000] = 0x5a; sram[SaveRamEnd - 0x6000] = 0xa5; }, cmpRet: retA,
  });
  check('UpdateModeDSave_Sub0', () => mD.UpdateModeDSave_Sub0());
  check('UpdateModeDSave_Sub1', () => mD.UpdateModeDSave_Sub1(), { seeds: 20, prepare: randomFiles });
  check('UpdateModeDSave_Sub2', () => mD.UpdateModeDSave_Sub2(), { cmpRet: retA });
  check('UpdateModeDSave', () => mD.UpdateModeDSave(), { seeds: 12, prepare: (r) => { randomFiles(r); ram[GameSubmode] = r.int(3); } });
});

test('P24 early ports of P11/P16 helpers', { skip }, () => {
  const both = (ret, o, w) => { assert.equal(ret.a, o.a, `${w}: A`); assert.equal(ret.y, o.y, `${w}: Y`); };
  check('DivideBy10', (g) => fmt.DivideBy10(g.a), { seeds: 30, regs: (r) => ({ a: r.byte() }), cmpRet: both });
  check('FormatDecimalByte', (g) => fmt.FormatDecimalByte(g.a), {
    seeds: 30, regs: (r) => ({ a: [0, 5, 10, 99, 100, 109, 255][r.int(7)] }), cmpRet: both,
  });
  check('FormatHeartsInTextBuf', (g) => fmt.FormatHeartsInTextBuf(g.y), {
    seeds: 40,
    regs: (r) => ({ y: 0x0c }),
    prepare: (r) => {
      const c = r.int(16);
      ram[0x0e] = r.int(5) === 0 ? 0 : (c << 4) | r.int(c + 1);
      ram[0x0f] = [0, 0x40, 0x7f, 0x80, 0xff][r.int(5)];
    },
    cmpRet: retA,
  });
  check('ResetRoomTileObjInfo', () => ResetRoomTileObjInfo(), { seeds: 2, cmpRet: retA });
});
