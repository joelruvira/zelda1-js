// P08: every Link routine vs. the original 6502 code (jsnes CPU, real ROM) on random RAM/SRAM states.
// The routines P08 calls in other packages run as original code too (p08-hybrid-register.mjs), so
// this isolates P08. Compares the whole RAM (stack page excepted), the SRAM and the output registers.
// Skipped without roms/zelda.nes or jsnes.
import './p08-hybrid-register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P08_N ?? 400);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const In = ok ? await import('../../src/game/link/input.js') : {};
const Mv = ok ? await import('../../src/game/link/move.js') : {};
const La = ok ? await import('../../src/game/link/ladder.js') : {};
const An = ok ? await import('../../src/game/link/anim.js') : {};

const DIRS = [1, 2, 4, 8];
const pick = (r, arr) => arr[r.int(arr.length)];

// A random but plausible play state: Link (slot 0) and some objects, the play area tiles in SRAM.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0x530; i < 0x7f0; i++) {
    // PlayAreaTiles: walkable, unwalkable, water ($8D-$98), UW water $F4, stairs $74/$75.
    sr[i] = r.chance(0.5) ? r.int(0x80) : pick(r, [0x8d, 0x90, 0x98, 0x99, 0xf4, 0x74, 0x75, 0x26, 0xc8, r.byte()]);
  }
  st[V.CurLevel] = r.chance(0.5) ? 0 : 1 + r.int(9);
  st[V.GameMode] = r.chance(0.6) ? 5 : pick(r, [4, 5, 6, 7, 9, 0x0b, 0x0c, 0x10, 0x11, 0x13, r.byte()]);
  for (let i = 0; i < 0x14; i++) {
    st[V.ObjDir + i] = r.chance(0.9) ? pick(r, DIRS) : r.int(16);
    st[V.ObjType + i] = r.chance(0.5) ? 0 : r.byte();
  }
  st[V.ObjInputDir] = r.chance(0.2) ? 0 : r.chance(0.5) ? pick(r, DIRS) : r.int(16);
  st[V.ObjState] = r.chance(0.5) ? 0 : pick(r, [0x10, 0x11, 0x12, 0x20, 0x21, 0x30, 0x31, 0x40, 0x41, 0x50, 0xc0, r.byte()]);
  st[V.ObjShoveDir] = r.chance(0.8) ? 0 : r.byte();
  st[V.ObjGridOffset] = r.chance(0.4) ? 0 : pick(r, [8, 0xf8, 0x10, 1, 2, 3, 4, 5, 7, 0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xf9, r.byte()]);
  st[V.ObjX] = r.chance(0.3) ? pick(r, [0x20, 0xd0, 0x78, 0x10, 0xe0, 0x07, 0xe9]) : r.byte();
  st[V.ObjY] = r.chance(0.3) ? pick(r, [0x85, 0x5d, 0x3d, 0x45, 0xd6, 0x55, 0xc6]) : r.byte();
  st[V.ObjX] &= r.chance(0.5) ? 0xf8 : 0xff;
  st[V.ObjY] = r.chance(0.5) ? (st[V.ObjY] & 0xf0) | 0x0d : st[V.ObjY];
  st[V.ObjectFirstUnwalkableTile] = r.chance(0.8) ? pick(r, [0x26, 0x78, 0x84, 0x89, 0x8d]) : r.byte();
  st[V.SwordBlocked] = r.chance(0.8) ? 0 : r.byte();
  st[V.SwordBlockedLongTimer] = r.chance(0.8) ? 0 : r.byte();
  st[V.DoorwayDir] = r.chance(0.6) ? 0 : pick(r, DIRS);
  st[V.Link_GoStraight] = r.chance(0.5) ? 0 : r.byte();
  st[V.Link_GoStraightWhenDiagInput] = r.chance(0.5) ? 0 : r.int(3);
  st[V.ButtonsPressed] = r.chance(0.5) ? 0 : r.byte();
  st[V.WhirlwindTeleportingState] = r.chance(0.9) ? 0 : r.byte();
  st[V.InvLadder] = r.chance(0.3) ? 0 : 1;
  st[V.InvMagicShield] = r.chance(0.5) ? 0 : 1;
  st[V.LadderSlot] = r.chance(0.5) ? 0 : 1 + r.int(0x0b);
  st[V.RoomId] = r.chance(0.5) ? pick(r, [0x17, 0x18, 0x19, 0x27, 0x4f, 0x5f]) : r.byte();
  st[V.UndergroundExitType] = r.chance(0.5) ? 0 : r.byte();
  st[V.ObjCollidedTile] = r.chance(0.3) ? pick(r, [0x74, 0x75]) : r.byte();
  st[V.ObjQSpeedFrac] = r.chance(0.3) ? 0x30 : r.byte();
  st[V.ObjAnimCounter] = r.chance(0.4) ? 1 : r.byte();
  st[V.ObjAnimFrame] = r.int(2);
  // A ladder close to Link (same column/row, distance around $10).
  const l = st[V.LadderSlot];
  if (l && r.chance(0.8)) {
    st[V.ObjState + l] = r.chance(0.15) ? 0 : 1 + r.int(2);
    const d = pick(r, [0, 1, 4, 8, 0x0f, 0x10, 0x11, -1, -8, -0x0f, -0x10, -0x11]);
    if (st[V.ObjDir + l] & 0x0c) {
      st[V.ObjX + l] = r.chance(0.9) ? st[V.ObjX] : r.byte();
      st[V.ObjY + l] = (st[V.ObjY] + 3 - d) & 0xff;
    } else {
      st[V.ObjY + l] = r.chance(0.9) ? (st[V.ObjY] + 3) & 0xff : r.byte();
      st[V.ObjX + l] = (st[V.ObjX] - d) & 0xff;
    }
    if (r.chance(0.5)) st[V.ObjDir] = st[V.ObjDir + l];
  }
  if (r.chance(0.5)) st[V.WhirlwindTeleportingState] = 0;
  // Keep the original subtrees inside the game's invariants: a valid selected item (WieldItem's
  // TableJump) and a cellar array that contains the room (CheckWarps' search loop).
  st[V.SelectedItemSlot] = r.chance(0.2) ? 0x0f : r.int(9);
  sr[V.LevelInfo_CellarRoomIdArray - 0x6000] = 0x05;
  sr[V.LevelBlockAttrsA - 0x6000 + 0x05] = st[V.RoomId];
  return { st, sr };
}

// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, output register compared, tweak]
const cases = [
  ['InitLinkSpeed', 5, () => ({}), () => Mv.InitLinkSpeed(), 'a'],
  ['Link_ModifyDirOnGridLine', 5, () => ({}), () => Mv.Link_ModifyDirOnGridLine(), null],
  ['SetObjDirAndInputDir', 5, (r) => ({ a: r.byte() }), (g) => Mv.SetObjDirAndInputDir(g.a), 'a'],
  ['SetLinkInputDir', 5, (r) => ({ a: r.byte() }), (g) => Mv.SetLinkInputDir(g.a), 'a'],
  ['Link_ModifyDirInDoorway', 5, () => ({}), () => In.Link_ModifyDirInDoorway(), null],
  ['MaskInputInBorder', 5, (r) => ({ a: pick(r, [0, 0x80, r.byte()]), y: r.int(12) }), (g) => In.MaskInputInBorder(g.a, g.y), null,
    (st, sr, r) => { st[0x00] = pick(r, DIRS); st[0x02] = r.byte(); }],
  ['Link_FilterInput', 5, () => ({}), () => In.Link_FilterInput(), null],
  ['Link_HandleInput', 5, () => ({}), () => In.Link_HandleInput(), null],
  ['CheckLadder', 5, () => ({}), () => La.CheckLadder(), 'x', (st, sr, r) => { st[0x0f] = r.chance(0.8) ? pick(r, DIRS) : 0; }],
  ['SetMovingDirAndSwitchToPlayerSlot', 5, (r) => ({ a: r.byte(), x: r.byte() }), (g) => La.SetMovingDirAndSwitchToPlayerSlot(g.a), 'x'],
  ['AnimateLinkObjState', 5, () => ({}), () => An.AnimateLinkObjState(), null],
  ['AnimateLinkBase', 5, () => ({}), () => An.AnimateLinkBase(0), 'y'],
  ['Link_EndMoveAndAnimate', 5, () => ({}), () => An.Link_EndMoveAndAnimate(), null, ladderTweak],
  ['Link_EndMoveAndAnimateBetweenRooms', 5, () => ({}), () => An.Link_EndMoveAndAnimateBetweenRooms(), null],
  ['Link_EndMoveAndDraw', 5, () => ({}), () => An.Link_EndMoveAndDraw(), null],
  ['Link_EndMoveAndAnimate_Bank4', 4, () => ({}), () => An.Link_EndMoveAndAnimate_Bank4(), null],
  ['Link_EndMoveAndDraw_Bank4', 4, () => ({}), () => An.Link_EndMoveAndDraw_Bank4(), null],
  ['Link_EndMoveAndAnimate_Bank1', 1, () => ({}), () => An.Link_EndMoveAndAnimate_Bank1(), null],
  ['Link_EndMoveAndDraw_Bank1', 1, () => ({}), () => An.Link_EndMoveAndDraw_Bank1(), null],
  ['DrawLinkBetweenRooms', 5, () => ({}), () => An.DrawLinkBetweenRooms(), null],
];

// Bias toward the ladder set-up: ladder owned and free, Link at a grid point facing his input.
function ladderTweak(st, sr, r) {
  if (!r.chance(0.5)) return;
  st[V.InvLadder] = 1;
  st[V.DoorwayDir] = 0;
  st[V.LadderSlot] = 0;
  st[V.GameMode] = 5;
  st[V.ObjGridOffset] = 0;
  st[V.ObjState] &= 0x3f;
  st[V.ObjInputDir] = st[V.ObjDir];
  for (let i = 1; i < 0x0c; i++) if (r.chance(0.3)) st[V.ObjType + i] = 0;
}

// Path coverage counters (reported as diagnostics): original outcome predicates.
const COVER = {
  Link_EndMoveAndAnimate: {
    ladderSetUp: (st, o) => st[V.LadderSlot] === 0 && o.ram[V.LadderSlot] !== 0,
    magicShieldTile: (st, o) => st[V.InvMagicShield] && [0x80, 0x54, 0x60].includes(o.ram[V.Sprites + 73]),
    shieldDown: (st, o) => !st[V.InvMagicShield] && [0x58, 0x5a].includes(o.ram[V.Sprites + 73]),
  },
  Link_HandleInput: {
    diagStraight1: (st, o) => st[V.ObjGridOffset] === 0 && o.ram[V.Link_GoStraightWhenDiagInput] === 1,
    diagStraight2: (st, o) => st[V.ObjGridOffset] === 0 && o.ram[V.Link_GoStraightWhenDiagInput] === 2,
    goStraight: (st, o) => o.ram[V.Link_GoStraight] !== 0 && st[V.ObjGridOffset] === 0,
    reversed: (st, o) => st[V.ObjGridOffset] !== 0 && o.ram[V.ObjGridOffset] !== st[V.ObjGridOffset],
  },
  CheckLadder: {
    stash: (st, o) => st[V.LadderSlot] !== 0 && o.ram[V.LadderSlot] === 0,
    state2: (st, o) => st[V.LadderSlot] !== 0 && o.ram[V.ObjState + st[V.LadderSlot]] === 2 && st[V.ObjState + st[V.LadderSlot]] !== 2,
    upOnLadder: (st, o) => st[V.LadderSlot] !== 0 && o.ram[V.LadderSlot] !== 0 && o.ram[0x0f] === 8 && st[0x0f] !== 8,
  },
};

// Routines that call WieldSword/WieldItem/CheckWarps (big original subtrees) get fewer cases.
const HEAVY = new Set(['Link_HandleInput']);

test('P08 routines match the original 6502 code on random states', { skip }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, out, tweak] of cases) {
    if (process.env.P08_ONLY && !process.env.P08_ONLY.split(',').includes(name)) continue;
    await t.test(name, () => {
      const r = rng(0x08 + name.length * 7919 + name.charCodeAt(3) * 31);
      const n = HEAVY.has(name) ? N >> 1 : N;
      const cov = {};
      for (let i = 0; i < n; i++) {
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
        if (out) assert.equal(ret, orig[out], `${name} case ${i}: register ${out}`);
        for (const [k, f] of Object.entries(COVER[name] ?? {})) if (f(st, orig, ret)) cov[k] = (cov[k] ?? 0) + 1;
      }
      if (Object.keys(COVER[name] ?? {}).length) t.diagnostic(`${name} paths: ${JSON.stringify(cov)}`);
    });
  }
});
