// P11 (HUD, submenu, maps, hearts/rupees): every routine of the package is diffed against the
// ORIGINAL 6502 code (jsnes CPU on the port's machine, tests/game/p01-hybrid.mjs) on many random
// and hand-made states. Routines of other packages that P11 calls and that are still stubs run as
// original code too (src/game/stub.js is redirected to the hybrid tool before anything loads).
// Skips without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
});

const H = await import('./p01-hybrid.mjs');
const { hasRom, ROM_PATH } = await import('../core/helpers.mjs');
const skip = !H.canRunHybrid || !hasRom ? 'needs roms/zelda.nes and tools/oracle jsnes' : false;

const { ram, sram } = await import('../../src/core/ram.js');
const { bus } = await import('../../src/core/bus.js');
const V = await import('../../src/core/vars.js');
const { switchBank } = await import('../../src/core/asm.js');
const { label } = await import('../../src/core/rom.js');
const fmt = await import('../../src/game/text/format.js');
const meters = await import('../../src/game/hud/meters.js');
const sb = await import('../../src/game/hud/statusbar.js');
const map = await import('../../src/game/hud/map.js');
const sub = await import('../../src/game/hud/submenu.js');

let ready = false;
async function setup() {
  if (ready) return;
  const { loadSymbols, loadRom } = await import('../../src/core/rom.js');
  const { createMachine } = await import('../../src/core/machine.js');
  const boot = await import('../../src/game/boot.js');
  await loadSymbols();
  createMachine(loadRom(readFileSync(ROM_PATH)));
  switchBank(1);
  boot.CopyCommonCodeToRam(); // like InitializeGameOrMode
  switchBank(6);
  boot.CopyCommonDataToRam();
  ready = true;
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return { byte: () => next() & 0xff, int: (n) => next() % n, chance: (p) => next() / 0x100000000 < p };
}

const CODE_LO = 0x6c90 - 0x6000, CODE_HI = 0x7f00 - 0x6000;
let baseSram = null;

/** Random state: all RAM random except the stack page; level block region of SRAM random. */
function randomState(r, fix) {
  baseSram ??= Uint8Array.from(sram);
  sram.set(baseSram);
  for (let i = 0; i < 0x800; i++) ram[i] = (i >= 0x100 && i < 0x200) ? 0 : r.byte();
  for (let i = 0x687e - 0x6000; i < CODE_LO; i++) sram[i] = r.byte();
  // Sane pointers / indices that the game always keeps valid.
  const flags = r.chance(0.5) ? V.WorldFlags : 0x06ff;
  sram[V.LevelInfo_WorldFlagsAddr - 0x6000] = flags & 0xff;
  sram[V.LevelInfo_WorldFlagsAddr + 1 - 0x6000] = flags >> 8;
  ram[V.CurLevel] = r.int(10);
  ram[V.TileBufSelector] = 0;
  if (fix) fix(r);
}

function snapshot() {
  return { ram: Uint8Array.from(ram), sram: Uint8Array.from(sram), bank: bus.mapper.prgBank };
}

function diff(a, b) {
  const out = [];
  for (let i = 0; i < 0x800 && out.length < 8; i++) {
    if (i >= 0x100 && i < 0x200) continue;
    if (a.ram[i] !== b.ram[i]) out.push(`$${i.toString(16)}: port ${a.ram[i].toString(16)} != orig ${b.ram[i].toString(16)}`);
  }
  for (let i = 0; i < 0x2000 && out.length < 8; i++) {
    if (i >= CODE_LO && i < CODE_HI) continue;
    if (a.sram[i] !== b.sram[i]) out.push(`$${(i + 0x6000).toString(16)}: port ${a.sram[i].toString(16)} != orig ${b.sram[i].toString(16)}`);
  }
  if (a.bank !== b.bank) out.push(`bank port ${a.bank} != orig ${b.bank}`);
  return out;
}

/**
 * Run the original routine `name` and the JS `fn(regs)` from the same state, compare RAM, SRAM, bank
 * and optionally registers. `regs` = input registers; `bank` = bank mapped at the call.
 */
function check(name, fn, { seed = 1, n = 300, fix, regs = () => ({}), bank = 5, cmpA, cmpY } = {}) {
  const r = rng(seed);
  for (let k = 0; k < n; k++) {
    randomState(r, fix);
    const rg = regs(r);
    switchBank(bank);
    const start = snapshot();
    const o = H.runOriginal(name, rg);
    const orig = snapshot();
    ram.set(start.ram);
    sram.set(start.sram);
    switchBank(start.bank);
    const ret = fn(rg);
    const port = snapshot();
    const d = diff(port, orig);
    assert.deepEqual(d, [], `${name} case ${k}: ${d.join(', ')}`);
    if (cmpA) assert.equal(typeof ret === 'object' ? ret.a : ret, o.a, `${name} case ${k}: A`);
    if (cmpY) assert.equal(typeof ret === 'object' ? ret.y : ret, o.y, `${name} case ${k}: Y`);
  }
}

// Item inventory biased towards "have it / don't have it" values like the real game.
function items(r) {
  for (let i = 0; i < 0x28; i++) ram[V.Items + i] = r.chance(0.5) ? 0 : r.chance(0.5) ? 1 : r.byte();
  if (ram[V.Items + 2] !== 0 && ram[V.Bow] === 0 && r.chance(0.5)) ram[V.Bow] = 1;
}

const t = (name, fn) => test(name, { skip }, async () => { await setup(); fn(); });

// ------------------------------------------------------------------ text/format.js

t('FormatDecimalByte / FormatDecimalCountByte / FormatCharDoublet / DivideBy10', () => {
  check('FormatDecimalByte', (g) => fmt.FormatDecimalByte(g.a), { regs: (r) => ({ a: r.byte() }), cmpA: true, cmpY: true });
  check('FormatDecimalCountByte', (g) => fmt.FormatDecimalCountByte(g.a), { regs: (r) => ({ a: r.byte() }), cmpA: true });
  check('FormatCharDoublet', (g) => fmt.FormatCharDoublet(g.a), { regs: (r) => ({ a: r.byte() }), cmpA: true, n: 20 });
  check('DivideBy10', (g) => fmt.DivideBy10(g.a), { regs: (r) => ({ a: r.byte() }), cmpA: true, cmpY: true });
});

t('FormatDecimalCountByteInTextBuf / CopyTripletToTextBuf', () => {
  check('FormatDecimalCountByteInTextBuf', (g) => fmt.FormatDecimalCountByteInTextBuf(g.a, g.y),
    { regs: (r) => ({ a: r.byte(), y: 2 + r.int(0x30) }) });
  check('CopyTripletToTextBuf', () => fmt.CopyTripletToTextBuf(), { fix: (r) => { ram[0] = 2 + r.int(0x30); } });
});

t('FormatHeartsInTextBuf', () => {
  check('FormatHeartsInTextBuf', (g) => fmt.FormatHeartsInTextBuf(g.y), {
    regs: (r) => ({ y: r.int(0x20) }),
    fix: (r) => { if (r.chance(0.3)) ram[0x0f] = r.chance(0.5) ? 0 : 0x80; },
  });
});

t('FormatStatusBarText', () => {
  check('FormatStatusBarText', () => fmt.FormatStatusBarText(), {
    fix: (r) => { if (r.chance(0.5)) ram[V.InvMagicKey] = 0; },
  });
});

// ------------------------------------------------------------------ hud/meters.js

t('World_ChangeRupees', () => {
  check('World_ChangeRupees', () => meters.World_ChangeRupees(), {
    n: 500,
    fix: (r) => {
      if (r.chance(0.7)) ram[V.TileBufSelector] = 0;
      else ram[V.TileBufSelector] = r.byte();
      if (r.chance(0.7)) ram[V.DynTileBuf] = 0xff;
      if (r.chance(0.3)) ram[V.InvRupees] = r.chance(0.5) ? 0 : 0xff;
      if (r.chance(0.3)) ram[V.RupeesToAdd] = 0;
      if (r.chance(0.3)) ram[V.RupeesToSubtract] = 0;
      if (r.chance(0.5)) ram[V.InvMagicKey] = 0;
    },
  });
});

t('World_FillHearts', () => {
  check('World_FillHearts', () => meters.World_FillHearts(), {
    n: 500,
    fix: (r) => {
      if (r.chance(0.2)) ram[V.World_IsFillingHearts] = 0;
      if (r.chance(0.5)) ram[V.HeartPartial] = 0xf8 + r.int(8);
      if (r.chance(0.5)) ram[V.HeartValues] = (r.int(16) << 4) | r.int(16);
      if (r.chance(0.3)) ram[V.HeartValues] = (ram[V.HeartValues] & 0xf0) | (ram[V.HeartValues] >> 4);
    },
  });
});

// ------------------------------------------------------------------ hud/statusbar.js

t('UpdatePlayerPositionMarker / UpdatePositionMarker / UpdateTriforcePositionMarker', () => {
  const fix = (r) => {
    if (r.chance(0.6)) ram[V.GameMode] = 5;
    if (r.chance(0.6)) ram[V.WhirlwindTeleportingState] = 0;
    items(r);
  };
  check('UpdatePlayerPositionMarker', () => sb.UpdatePlayerPositionMarker(), { fix, bank: 1 });
  check('UpdatePositionMarker', (g) => sb.UpdatePositionMarker(g.a, g.x),
    { fix: (r) => { fix(r); ram[V.CurLevel] = 1 + r.int(9); }, regs: (r) => ({ a: r.byte(), x: r.chance(0.5) ? 0 : 4 }) });
  check('UpdateTriforcePositionMarker', () => sb.UpdateTriforcePositionMarker(), { fix, bank: 7 });
});

t('DrawItemInInventory / DrawItemBySlot / DrawItemInInventoryWithX', () => {
  const regs = (r) => { const s = r.int(0x22); return { x: s, y: s }; };
  check('DrawItemInInventory', (g) => sb.DrawItemInInventory(g.x, g.y), { regs, fix: items, bank: 7 });
  check('DrawItemBySlot', (g) => sb.DrawItemBySlot(g.x, g.y), {
    regs, bank: 7, fix: (r) => { if (r.chance(0.3)) ram[0x04] = r.int(3); },
  });
  check('DrawItemInInventoryWithX', (g) => sb.DrawItemInInventoryWithX(g.x), { regs, fix: items });
});

t('DrawStatusBarItemsAndEnsureItemSelected / EnsureSelectedItem / DrawStatusBarSword', () => {
  const fix = (r) => {
    items(r);
    ram[V.SelectedItemSlot] = r.chance(0.9) ? r.int(9) : 0x0f;
    if (r.chance(0.3)) ram[V.SelectedItemSlot] = 7;
    if (r.chance(0.5)) ram[V.Potion] = 0;
  };
  check('DrawStatusBarItemsAndEnsureItemSelected', () => sb.DrawStatusBarItemsAndEnsureItemSelected(), { fix, bank: 7, n: 800 });
  check('EnsureSelectedItem', (g) => sb.EnsureSelectedItem(g.x), { fix, bank: 7, regs: (r) => ({ x: r.int(9) }) });
  check('DrawStatusBarSword', () => sb.DrawStatusBarSword(), { fix, bank: 7 });
});

// ------------------------------------------------------------------ hud/map.js

t('HasCompass / HasMap', () => {
  check('HasCompass', () => map.HasCompass(), { fix: items, cmpA: true, n: 100 });
  check('HasMap', () => map.HasMap(), { fix: items, cmpA: true, n: 100 });
});

t('Submenu_CueTransferRowUW / OW, SelectTransferBufAndDecCounter, DecSubmenuScroll', () => {
  const fix = (r) => {
    ram[V.SubmenuScrollProgress] = r.chance(0.1) ? 0x80 | r.byte() : r.int(0x2c);
    ram[V.CurScanRoomId] = r.byte() & 0x7f;
    sram[V.LevelInfo_SubmenuMapRotation - 0x6000] = r.int(16);
  };
  check('Submenu_CueTransferRowUW', () => map.Submenu_CueTransferRowUW(), { fix, n: 400 });
  check('Submenu_CueTransferRowOW', () => map.Submenu_CueTransferRowOW(), { fix, n: 400 });
  check('SelectTransferBufAndDecCounter', (g) => map.SelectTransferBufAndDecCounter(g.a), { regs: (r) => ({ a: r.byte() }), n: 20 });
  check('DecSubmenuScroll', () => map.DecSubmenuScroll(), { n: 20 });
});

t('Submenu_WriteSheetMapRowTransferRecord / Submenu_WriteScanningMapRoomMark', () => {
  const fix = (r) => {
    ram[V.SubmenuScrollProgress] = 0x1a + 2 * r.int(8);
    ram[V.CurScanRoomId] = r.byte() & 0x7f;
    sram[V.LevelInfo_SubmenuMapRotation - 0x6000] = r.int(16);
  };
  check('Submenu_WriteSheetMapRowTransferRecord', () => map.Submenu_WriteSheetMapRowTransferRecord(), { fix, n: 60 });
  check('Submenu_WriteScanningMapRoomMark', (g) => map.Submenu_WriteScanningMapRoomMark(g.y),
    { fix, regs: (r) => ({ y: 1 + r.int(0x10) }), n: 200 });
});

// ------------------------------------------------------------------ hud/submenu.js

const menuFix = (r) => {
  items(r);
  ram[V.SelectedItemSlot] = r.chance(0.9) ? r.int(9) : 0x0f;
  if (r.chance(0.5)) ram[V.Potion] = 0;
  if (r.chance(0.8)) ram[V.ButtonsDown + 1] = 0;
  if (r.chance(0.5)) ram[V.ObjInputDir] = [0, 1, 2, 4, 8][r.int(5)];
  if (r.chance(0.5)) ram[0xef] = r.int(3);
  ram[V.SubmenuScrollProgress] = r.int(0x2c);
  ram[V.CurScanRoomId] = r.byte() & 0x7f;
  sram[V.LevelInfo_SubmenuMapRotation - 0x6000] = r.int(16);
  if (r.chance(0.5)) ram[V.CurVScroll] = [0x44, 0x41 + 3, 0xed, 0xef, 0xf0][r.int(5)];
  if (r.chance(0.5)) ram[V.Sprites + 84] = 0xf8;
  if (r.chance(0.7)) ram[V.GameMode] = 5;
  // Never the arrow slot without the bow with no search direction: the original loops forever.
  if (ram[V.Bow] === 0) ram[V.Items + 2] = 0;
};

t('UpdateMenu (every MenuState, OW and UW) and UpdateMenuAndMeters', () => {
  check('UpdateMenu', () => sub.UpdateMenu(), {
    n: 1500, fix: (r) => { menuFix(r); ram[V.MenuState] = r.int(ram[V.CurLevel] ? 9 : 10); },
  });
  check('UpdateMenuAndMeters', () => sub.UpdateMenuAndMeters(), {
    n: 400, fix: (r) => { menuFix(r); ram[V.MenuState] = r.int(ram[V.CurLevel] ? 9 : 10); },
  });
});

t('Menu states as separate entries', () => {
  const entries = ['UpdateMenuCommon1', 'UpdateMenu_Return', 'UpdateMenuCommon2', 'UpdateMenuCommon3',
    'UpdateMenuCommon4', 'UpdateMenu5UW', 'UpdateMenu5OW', 'UpdateMenuScrollDownOW', 'UpdateMenuScrollDownUW',
    'UpdateMenuActive', 'UpdateMenuScrollUp', 'UpdateMenuStartOW'];
  for (const e of entries) check(e, () => sub[e](), { fix: menuFix, n: 150 });
  check('MovePositionMarkers', (g) => sub.MovePositionMarkers(g.a), { fix: menuFix, regs: (r) => ({ a: r.byte() }) });
});

t('DrawSubmenuItems / UpdateSubmenuSelection', () => {
  check('DrawSubmenuItems', () => sub.DrawSubmenuItems(), { fix: menuFix, n: 400 });
  check('UpdateSubmenuSelection', () => sub.UpdateSubmenuSelection(), { fix: menuFix, n: 1500 });
});

t('FindAndSelectOccupiedItemSlot / CheckNextItem / FoundSlot / Cycle9InDirection', () => {
  const fix = (r) => { menuFix(r); ram[0xef] = 1 + r.int(2); };
  check('FindAndSelectOccupiedItemSlot', (g) => sub.FindAndSelectOccupiedItemSlot(g.a, g.y),
    { fix, regs: (r) => ({ a: 1 + r.int(2), y: r.int(9) }), cmpY: true, n: 1000 });
  check('CheckNextItem', (g) => sub.CheckNextItem(g.x, g.y), { fix, regs: (r) => ({ x: r.int(10), y: r.int(9) }), cmpY: true });
  check('FoundSlot', (g) => sub.FoundSlot(g.x, g.y), { fix, regs: (r) => ({ x: r.int(10), y: r.int(9) }), cmpY: true });
  check('Cycle9InDirection', (g) => sub.Cycle9InDirection(g.y), { regs: (r) => ({ y: r.int(9) }), cmpY: true, n: 100 });
});

t('ScrollWorld / ResetVScrollLo / IncSubmode / SwitchToNT1', () => {
  const fix = (r) => {
    ram[V.ObjDir] = [1, 2, 4, 8][r.int(4)];
    ram[V.VScrollStartFrame] = r.int(4);
    if (r.chance(0.5)) ram[V.VScrollAddrLo] = [0x00, 0xe0, 0xa0, 0x20][r.int(4)];
    if (r.chance(0.5)) ram[V.VScrollAddrHi] = [0x20, 0x21, 0x23, 0x27, 0x28][r.int(4)];
    if (r.chance(0.5)) ram[V.CurHScroll] = [0x00, 0x02, 0x04, 0xfc, 0xfe, 0xfa][r.int(6)];
  };
  check('ScrollWorld', () => sub.ScrollWorld(), { fix, n: 2000 });
  check('ResetVScrollLo', () => sub.ResetVScrollLo(), { n: 10 });
  check('IncSubmode', () => sub.IncSubmode(), { n: 10 });
  check('SwitchToNT1', () => sub.SwitchToNT1(), { n: 10 });
});

test('P11 labels exist in the symbol table', { skip }, async () => {
  await setup();
  for (const n of ['StatusBarTransferBufTemplate', 'UpdateMenuUW_JumpTable', 'UpdateMenuOW_JumpTable',
    'TriforceRow0TransferBuf', 'ItemSlotToPaletteOffsetsOrValues', 'LevelMasks']) assert.ok(label(n));
});
