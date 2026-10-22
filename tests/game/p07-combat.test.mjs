// P07 combat: every ported routine vs. the original 6502 code (jsnes CPU, real ROM) on random
// RAM states biased towards collisions (weapons and Link next to the monster). Routines of other
// packages that are still stubs (HandleShotBlocked P09, Gohma_HandleWeaponCollision P21) run as
// original code through the stub.js -> p01-hybrid.mjs redirection.
// Compares RAM (stack page excepted, $010E/$010F included), SRAM below RAM_01_CODE and the output
// registers each routine documents. Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hasRom, realRom, ROOT } from '../core/helpers.mjs';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
});

const canRun = hasRom && existsSync(join(ROOT, 'tools/oracle/node_modules/jsnes/src/index.js'));
const skip = !canRun && 'needs roms/zelda.nes and tools/oracle jsnes';

let H, C, D, L, V, ram, sram, bus, rng;
if (canRun) {
  H = await import('./p01-hybrid.mjs');
  const { createGame } = await import('../../src/headless.js');
  await createGame({ rom: realRom() });
  (await import('../../src/core/asm.js')).switchBank(1);
  (await import('../../src/game/boot.js')).CopyCommonCodeToRam(); // RAM_01_CODE in SRAM
  C = await import('../../src/game/combat/collisions.js');
  D = await import('../../src/game/combat/damage.js');
  L = await import('../../src/game/combat/link-harm.js');
  V = await import('../../src/core/vars.js');
  ({ ram, sram } = await import('../../src/core/ram.js'));
  ({ bus } = await import('../../src/core/bus.js'));
  ({ rng } = await import('./p04-harness.mjs'));
}

const SRAM_CODE = 0x0c90;
const DIRS = [1, 2, 4, 8];
const TYPES = [0x01, 0x05, 0x06, 0x0b, 0x0c, 0x12, 0x13, 0x16, 0x17, 0x27, 0x2e, 0x33, 0x34,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x5a, 0x5b, 0x5c, 0x0f, 0x07, 0x40];
const pick = (r, arr) => arr[r.int(arr.length)];
const near = (r, v, d) => (v + r.int(2 * d + 1) - d) & 0xff;

/** A random state with Link's weapons and Link close to monster `x`. */
function randomState(r, x) {
  for (let i = 0; i < 0x800; i++) ram[i] = r.byte();
  for (let i = 0; i < SRAM_CODE; i++) sram[i] = r.byte();
  const mx = ram[V.ObjX + x];
  const my = ram[V.ObjY + x];
  for (const s of [0, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12]) {
    if (s === x) continue;
    if (r.chance(0.8)) ram[V.ObjX + s] = near(r, mx, 0x14);
    if (r.chance(0.8)) ram[V.ObjY + s] = near(r, my, 0x14);
    if (r.chance(0.8)) ram[V.ObjDir + s] = pick(r, DIRS);
  }
  if (r.chance(0.8)) ram[V.ObjDir + x] = r.chance(0.8) ? pick(r, DIRS) : pick(r, [5, 6, 9, 0x0a]);
  if (r.chance(0.7)) ram[V.ObjType + x] = pick(r, TYPES);
  if (r.chance(0.6)) ram[V.ObjAttr + x] &= ~0x20;
  if (r.chance(0.6)) ram[V.ObjInvincibilityTimer + x] = 0;
  if (r.chance(0.6)) ram[V.ObjInvincibilityTimer] = 0;
  if (r.chance(0.5)) ram[V.ObjInvincibilityMask + x] = r.chance(0.5) ? 0 : pick(r, [1, 2, 4, 8, 0x10, 0x20]);
  if (r.chance(0.6)) ram[V.ObjMetastate + x] = 0;
  if (r.chance(0.5)) ram[V.ObjHP + x] = pick(r, [0x00, 0x10, 0x20, 0x30, 0x40, 0x80]);
  if (r.chance(0.7)) ram[V.InvClock] = 0;
  if (r.chance(0.7)) ram[V.ObjStunTimer] = 0;
  if (r.chance(0.7)) ram[V.ObjStunTimer + x] = 0;
  if (r.chance(0.7)) ram[V.LinkParalyzed] = 0;
  if (r.chance(0.6)) ram[V.ObjState] = pick(r, [0, 0x10, 0x20, 0x40, 0x11]);
  if (r.chance(0.6)) ram[V.ObjState + x] = pick(r, [0, 0x10, 0x11, 0x80, 0x20]);
  if (r.chance(0.6)) ram[V.ObjGridOffset] = 0;
  if (r.chance(0.7)) ram[V.Items] = 1 + r.int(3);
  if (r.chance(0.7)) ram[V.InvArrow] = 1 + r.int(2);
  if (r.chance(0.7)) ram[V.InvRing] = r.int(3);
  if (r.chance(0.5)) ram[V.InvMagicShield] = r.int(2);
  if (r.chance(0.7)) ram[V.HeartValues] = (r.int(16) << 4) | r.int(16);
  if (r.chance(0.5)) ram[V.HelpDropCount] = pick(r, [8, 9, 0x0a, 0]);
  if (r.chance(0.5)) ram[V.ObjRefId + x] = r.int(0x14);
  if (r.chance(0.6)) ram[0x0f] = pick(r, [0, 1, 2, 3, 4]);
  if (r.chance(0.6)) ram[V.Gohma_ObjEyeState + x] = r.int(4);
  if (r.chance(0.5)) ram[0x0b] = r.int(8);
  // Weapon states
  if (r.chance(0.8)) ram[V.ObjState + 0x0d] = pick(r, [0, 1, 2, 3]);
  if (r.chance(0.8)) ram[V.ObjState + 0x0e] = pick(r, [0, 0x10, 0x11, 0x80, 0x81, 0x90]);
  if (r.chance(0.8)) ram[V.ObjState + 0x0f] = pick(r, [0, 0x10, 0x20, 0x50, 0x80]);
  for (const s of [0x10, 0x11]) if (r.chance(0.8)) ram[V.ObjState + s] = pick(r, [0, 0x12, 0x13, 0x20, 0x21, 0x22]);
  if (r.chance(0.8)) ram[V.ObjState + 0x12] = pick(r, [0, 0x10, 0x20, 0x30, 0x31]);
  if (r.chance(0.4)) {
    // Nothing keeps the monster from touching Link.
    ram[V.ObjInvincibilityTimer] = 0;
    ram[V.InvClock] = 0;
    ram[V.ObjStunTimer] = 0;
    ram[V.ObjStunTimer + x] = 0;
    ram[V.LinkParalyzed] = 0;
    if (ram[V.ObjState] === 0x40) ram[V.ObjState] = 0;
    ram[V.ObjX] = near(r, mx, 6);
    ram[V.ObjY] = near(r, my, 6);
  }
  // Shot blocked: plausible magic book / candle state (HandleShotBlocked runs as original).
  bus.mapper.setPrgBank(4); // monsters' update code (and Gohma) run in bank 4
}

function snapshot() {
  return { ram: Uint8Array.from(ram), sram: Uint8Array.from(sram.subarray(0, SRAM_CODE)) };
}
function restore(s) {
  ram.set(s.ram);
  sram.set(s.sram);
  bus.mapper.setPrgBank(4);
}
function diffs(a, b) {
  const out = [];
  for (let i = 0; i < 0x800 && out.length < 8; i++) {
    if (i >= 0x100 && i < 0x200 && i !== 0x10e && i !== 0x10f) continue;
    if (a.ram[i] !== b.ram[i]) out.push(`$${i.toString(16).padStart(4, '0')}: port ${a.ram[i].toString(16)} orig ${b.ram[i].toString(16)}`);
  }
  for (let i = 0; i < SRAM_CODE && out.length < 8; i++) {
    if (a.sram[i] !== b.sram[i]) out.push(`$${(0x6000 + i).toString(16)}: port ${a.sram[i].toString(16)} orig ${b.sram[i].toString(16)}`);
  }
  return out;
}

const reg = (k) => (ret, o) => ((typeof ret === 'object' ? ret[k] : ret) === o[k] ? null : `${k}: port ${typeof ret === 'object' ? ret[k] : ret} orig ${o[k]}`);
const none = () => null;
const monster = (r) => ({ x: 1 + r.int(0x0b) });
const withY = (y) => (r) => ({ x: 1 + r.int(0x0b), y });
const setW = (r, g) => { ram[0x00] = g.y ?? pick(r, [0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12]); };
const mids = (r, g) => {
  // [02]/[03] = monster middle, [04]/[05] near it, thresholds, damage.
  ram[0x02] = (ram[V.ObjX + g.x] + 8) & 0xff;
  ram[0x03] = (ram[V.ObjY + g.x] + 8) & 0xff;
  ram[0x04] = near(r, ram[0x02], 0x12);
  ram[0x05] = near(r, ram[0x03], 0x12);
  ram[0x0d] = pick(r, [0x09, 0x0a, 0x0b, 0x0c, 0x10, 0x18]);
  ram[0x0e] = pick(r, [0x09, 0x0a, 0x0b, 0x0c, 0x10, 0x18]);
  ram[0x07] = pick(r, [0, 0x10, 0x20, 0x40]);
  ram[0x09] = pick(r, [1, 2, 4, 8, 0x10, 0x20]);
};

const cases = [
  ['GetObjectMiddle', (r) => ({ x: r.int(0x14) }), (g) => C.GetObjectMiddle(g.x), reg('a')],
  ['CheckMonsterCollisions', monster, (g) => C.CheckMonsterCollisions(g.x), none],
  ['CheckLinkCollision', (r) => ({ x: 1 + r.int(0x0b) }), (g) => C.CheckLinkCollision(g.x), none],
  ['CheckLinkCollisionPreinit', monster, (g) => C.CheckLinkCollisionPreinit(g.x), none,
    (r, g) => { mids(r, g); ram[0x00] = 0; }],
  ['HarmLink', monster, (g) => L.HarmLink(g.x), none, (r) => { ram[0x00] = 0; }],
  ['Link_BeHarmed', (r) => ({ x: r.int(0x14) }), (g) => L.Link_BeHarmed(g.x), none,
    (r) => { ram[0x0d] = r.int(5); ram[0x0e] = pick(r, [0, 0x40, 0x80, 0xc0, 0xf0]); }],
  ['CheckMonsterBoomerangOrFoodCollision', withY(0x0f), (g) => C.CheckMonsterBoomerangOrFoodCollision(g.x, g.y), none, mids],
  ['CheckMonsterWeaponCollision', (r) => ({ x: 1 + r.int(0x0b), a: r.byte() }), (g) => C.CheckMonsterWeaponCollision(g.a, g.x), reg('y'),
    (r, g) => { mids(r, g); setW(r, g); g.a = near(r, ram[0x03], 0x10); }],
  ['HandleMonsterWeaponCollision', (r) => ({ x: 1 + r.int(0x0b), y: pick(r, [0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12]) }),
    (g) => D.HandleMonsterWeaponCollision(g.x, g.y), none, mids],
  ['DealDamage', monster, (g) => D.DealDamage(g.x), none, mids],
  ['HandleMonsterDied', monster, (g) => D.HandleMonsterDied(g.x), none, mids],
  ['L_PlayParrySoundForDamageType', monster, () => D.L_PlayParrySoundForDamageType(), none, mids],
  ['ResetShoveInfoAndInvincibilityTimer', (r) => ({ a: r.chance(0.5) ? 0 : r.byte(), x: r.int(0x14) }),
    (g) => D.ResetShoveInfoAndInvincibilityTimer(g.a, g.x), reg('a')],
  ['CheckMonsterSwordShotOrMagicShotCollision', withY(0x0e), (g) => C.CheckMonsterSwordShotOrMagicShotCollision(g.x, g.y), none, mids],
  ['CheckMonsterBombOrFireCollision', (r) => ({ x: 1 + r.int(0x0b), y: 0x10 + r.int(2) }),
    (g) => C.CheckMonsterBombOrFireCollision(g.x, g.y), none, mids],
  ['CheckMonsterSwordCollision', withY(0x0d), (g) => C.CheckMonsterSwordCollision(g.x, g.y), none, mids],
  ['CheckMonsterStabbingCollision', (r) => ({ x: 1 + r.int(0x0b), a: pick(r, [0x10, 0x20, 0x40]) }),
    (g) => C.CheckMonsterStabbingCollision(g.a, g.x), none, (r, g) => { mids(r, g); setW(r, {}); }],
  ['CheckMonsterArrowOrRodCollision', withY(0x12), (g) => C.CheckMonsterArrowOrRodCollision(g.x, g.y), none, mids],
  ['CheckMonsterShotCollision', (r) => ({ x: 1 + r.int(0x0b), a: pick(r, [0x10, 0x20, 0x40]) }),
    (g) => C.CheckMonsterShotCollision(g.a, g.x), none, (r, g) => { mids(r, g); setW(r, {}); }],
  ['ParryOrShove', (r) => ({ x: 1 + r.int(0x0b), y: pick(r, [0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12]) }),
    (g) => D.ParryOrShove(g.x, g.y), none, (r, g) => { mids(r, g); ram[0x00] = g.y; }],
  ['PlayParryTune', () => ({}), () => D.PlayParryTune(), reg('a')],
  ['CheckMonsterSlenderWeaponCollision', (r) => ({ x: 1 + r.int(0x0b), a: r.byte() }),
    (g) => C.CheckMonsterSlenderWeaponCollision(g.a, g.x), reg('y'), (r, g) => { mids(r, g); setW(r, {}); }],
  ['CheckMonsterSlenderWeaponCollision2', monster, (g) => C.CheckMonsterSlenderWeaponCollision2(g.x), reg('y'),
    (r, g) => { mids(r, g); setW(r, {}); }],
  ['DoObjectsCollide', (r) => ({ a: r.byte() }), (g) => C.DoObjectsCollide(g.a), reg('a'),
    (r, g) => { mids(r, { x: 1 }); g.a = pick(r, [0x09, 0x0e, 0x10, 0x18, r.byte()]); }],
  ['DoObjectsCollideWithThresholds', () => ({}), () => C.DoObjectsCollideWithThresholds(), reg('a'),
    (r) => mids(r, { x: 1 })],
  ['BeginShove', (r) => ({ x: r.chance(0.8) ? 1 + r.int(0x0b) : 0x10 + r.int(2) }), (g) => L.BeginShove(g.x), none,
    (r) => { ram[0x00] = r.chance(0.5) ? 0 : pick(r, [0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12]); if (r.chance(0.5)) ram[0x09] = pick(r, [0, 1, 2, 4, 8, 0x10, 0x20]); }],
];

const N = Number(process.env.P07_N ?? 600);
for (const [name, regsOf, port, cmp, tweak] of cases) {
  test(`P07 ${name} matches the original`, { skip }, () => {
    const r = rng(0x7070 + name.length * 977 + name.charCodeAt(0) * 31);
    for (let i = 0; i < N; i++) {
      const g = regsOf(r);
      randomState(r, g.x ?? 1);
      tweak?.(r, g);
      const start = snapshot();
      const before = { ...H.calls };
      const ret = port(g);
      const stubbed = Object.keys(H.calls).filter((k) => H.calls[k] !== before[k]);
      const p = snapshot();
      restore(start);
      const o = H.runOriginal(name, { a: g.a ?? 0, x: g.x ?? 0, y: g.y ?? 0 });
      const d = diffs(p, snapshot());
      const m = cmp(ret, o);
      if (m) d.push(m);
      if (d.length) d.push(`stubs run as original: ${stubbed.join(',') || 'none'}`);
      assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
    }
  });
}

test('P07 CheckMonsterCollisions collides often enough to be meaningful', { skip }, () => {
  const r = rng(0x7777);
  let hits = 0, kills = 0, harms = 0;
  for (let i = 0; i < 400; i++) {
    const x = 1 + r.int(0x0b);
    randomState(r, x);
    const hp = ram[V.HeartPartial], hv = ram[V.HeartValues], ms = ram[V.ObjMetastate + x];
    C.CheckMonsterCollisions(x);
    if (ram[0x06]) hits++;
    if (ram[V.ObjMetastate + x] === 0x10 && ms !== 0x10) kills++;
    if (ram[V.HeartPartial] !== hp || ram[V.HeartValues] !== hv) harms++;
  }
  assert.ok(hits > 20 && kills > 5 && harms > 5, `hits ${hits} kills ${kills} harms ${harms}`);
});
