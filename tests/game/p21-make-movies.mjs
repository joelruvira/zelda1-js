#!/usr/bin/env node
// Generator of the P21 oracle scenarios (bosses A). Run:
//   node tests/game/p21-make-movies.mjs [all|check|<movie>...]
//
// Every movie starts from tests/oracle/movies/p20-items.sav (first quest: magical sword, bracelet, ladder,
// recorder, bow and arrows, 8 bombs, red ring, magic shield, magic key, 16 full hearts, the 8 triforce
// pieces; only the player area $6000-$652F, checksum fixed), warps with the recorder's whirlwind to the
// level, walks the underworld rooms towards LevelInfo_BossRoomId (best-first search over rooms with
// oracle snapshots; bombable walls bombed, shutters opened by clearing the room or pushing its block,
// transport stairs through their cellar, the ladder over one-tile water) and fights the boss:
//  * boss-aquamentus  level 1: sword.
//  * boss-dodongo     level 2: bombs laid in front of the mouth (eaten: bloated), dust clouds (stunned).
//  * boss-manhandla   level 3: sword on the four hands (the base dies with the last one).
//  * boss-digdogger   level 5: the recorder splits it, then the sword on the little digdoggers.
//  * boss-gohma       level 6: arrows into the open eye (blue Gohma; the red one lives in levels 7-9 /
//                     the second quest, whose entrances the whirlwind does not reach).
// The fights are a search over short controllers (approach + attack) evaluated on oracle snapshots: the
// best one (boss damage, no death) is kept. Everything runs on the ORIGINAL game, so the movies are
// reproducible. Checkpoints in out/p21/ (P21_RESUME=entered|bossroom|<name> resumes from one).
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as P from './p19-make-movies.mjs';
// Its ladder hook (crossing one water tile in the underworld) and the P20 types allowed.
import './p20-make-movies.mjs';

// The ladder also crosses a one-tile water column sideways (level 6, $39): from land onto water in any
// direction; on water only straight on (the planner's step keeps the axis of the step that entered).
P.hooks.walkable = (x, y, d, t, ok) => {
  if (ram[V.CurLevel] === 0 || ram[V.InvLadder] === 0) return ok;
  const onWater = P.rawTileStill(x, y) === 0xf4;
  ram[V.ObjX] = x; ram[V.ObjY] = y; ram[0x0f] = d;
  if (onWater) return ok;
  return ok || t === 0xf4;
};
import * as V from '../../src/core/vars.js';
import { ram, sram } from '../../src/core/ram.js';

const { B, DIR_BTN, hex } = P;
const SRAM_FILE = 'p20-items.sav';
export const P21_TYPES = {
  0x18: 'little digdogger', 0x31: 'dodongo', 0x32: 'dodongos', 0x33: 'red gohma', 0x34: 'blue gohma',
  0x38: 'digdogger (3)', 0x39: 'digdogger (1)', 0x3c: 'manhandla', 0x3d: 'aquamentus',
};
for (const t of Object.keys(P21_TYPES).map(Number)) P.FORBIDDEN.delete(t);
// P20 monsters (wizzrobes, wallmasters, lamnolas) are ported too; P22's bosses stay forbidden.
for (const t of [0x23, 0x24, 0x27, 0x3a, 0x3b]) P.FORBIDDEN.delete(t);

/** Door type of direction d in the current UW room (0 open, 1 wall, 4 bombable, 5/6 locked, 7 shutter). */
function doorType(sim, d) {
  const room = sim.ram[V.RoomId];
  const a = sim.o.sram[V.LevelBlockAttrsA - 0x6000 + room], b = sim.o.sram[V.LevelBlockAttrsB - 0x6000 + room];
  return { 8: a >> 5, 4: (a >> 2) & 7, 2: b >> 5, 1: (b >> 2) & 7 }[d];
}
const isBoss = (t) => t in P21_TYPES;

const CKPT = join(import.meta.dirname, '..', '..', 'out', 'p21');
const OPP = { 1: 2, 2: 1, 4: 8, 8: 4 };
const SLOT_BOMB = 1, SLOT_ARROW = 2, SLOT_RECORDER = 5;

const bossSlots = (r, types) => P.slotsOf(r, (t) => types.includes(t));
/** No object of these types left (spawning, alive or dying). */
const allGone = (types) => (r) => {
  if (!P.playing(r)) return false;
  for (let i = 1; i < 0x0c; i++) if (types.includes(r[V.ObjType + i])) return false;
  return true;
};

/** Rooms of this level from the entrance to the boss room, best-first (oracle snapshots). */
function toBossRoom(sim, bossTypes, maxNodes = 60) {
  const target = sim.o.sram[V.LevelInfo_BossRoomId - 0x6000];
  const dist = (room) => Math.abs((room & 15) - (target & 15)) + Math.abs((room >> 4) - (target >> 4));
  console.log(`  boss room ${hex(target)}`);
  const start = sim.ram[V.RoomId];
  const nodes = new Map([[start, { snap: sim.snapshot(), depth: 0, path: '' }]]);
  const open = [start];
  const tried = new Set();
  for (let n = 0; open.length && n < maxNodes; n++) {
    open.sort((a, b) => (dist(a) + nodes.get(a).depth / 4) - (dist(b) + nodes.get(b).depth / 4));
    const room = open.shift();
    const node = nodes.get(room);
    const found = (to, path) => {
      if (bossSlots(sim.ram, bossTypes).length || to === target) {
        sim.play([[10, 0]]);
        P.log(sim, `  boss room reached (${path})`);
        return true;
      }
      if (nodes.has(to)) return false;
      console.log(`  ${hex(room)} -> ${hex(to)} (${path}) f${sim.frame}`);
      nodes.set(to, { snap: sim.snapshot(), depth: node.depth + 1, path });
      open.push(to);
      return false;
    };
    for (const d of [8, 2, 1, 4]) {
      if (room === start && d === 4) continue;
      if (tried.has(`${room}:${d}`)) continue;
      tried.add(`${room}:${d}`);
      sim.restore(node.snap);
      if (doorType(sim, d) === 1) continue; // wall
      let to;
      try { to = goRoom(sim, d); } catch (e) { if (!/died/.test(e.message)) throw e; to = 'died'; }
      if (typeof to !== 'number' || to < 0) { console.log(`  ${hex(room)} dir ${d}: ${to}`); continue; }
      if (found(to, node.path + 'NSWE'[[8, 4, 2, 1].indexOf(d)])) return node.path;
    }
    // Stairs to a transport cellar (revealed by clearing the room / pushing its block).
    sim.restore(node.snap);
    const cellar = enterStairs(sim);
    if (cellar) {
      for (const side of [0, 1]) {
        sim.restore(cellar);
        let to = null;
        try { to = leaveCellar(sim, side); } catch (e) { if (!/died/.test(e.message)) throw e; }
        if (to === null || to === room) continue;
        if (found(to, `${node.path}+${side ? 'B' : 'A'}`)) return node.path;
      }
    }
  }
  throw new Error(`boss room ${hex(target)} not reached`);
}

/** Squares of stairs (tiles $70-$73) in the current room. */
function stairsSquares(sim) {
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const set = new Set();
  for (let x = P.X0; x <= P.X1; x += 8) for (let y = P.Y0; y <= P.Y1; y += 8) if (P.isWarpTile(P.rawTileStill(x, y))) set.add(`${x},${y}`);
  return set;
}

/** Reveals the room's stairs if needed (clear the room, push the block), takes them: snapshot in the cellar or null. */
function enterStairs(sim) {
  let set = stairsSquares(sim);
  if (!set.size) {
    let hasBlock = false;
    for (let i = 1; i < 0x0c; i++) if (sim.ram[V.ObjType + i] === 0x68) hasBlock = true;
    if (!hasBlock) return null;
    clearRoom(sim, 120);
    pushBlock(sim);
    sim.play([[30, 0]]);
    set = stairsSquares(sim);
    if (!set.size) return null;
  }
  console.log(`  ${hex(sim.ram[V.RoomId])}: stairs ${[...set].slice(0, 2).join(' ')}`);
  sim.controller = P.walkController((x, y) => set.has(`${x},${y}`), { allowWarp: true, sword: false });
  let ok = false;
  try { ok = sim.runUntil((r) => r[V.GameMode] === 0x09 && r[V.IsUpdatingMode] !== 0, 1500); } catch (e) { if (!/died/.test(e.message)) throw e; }
  sim.controller = () => 0;
  if (!ok) return null;
  sim.play([[30, 0]]);
  return sim.snapshot();
}

/** In a transport cellar: climb out on side 0 (X < $80, room A) or 1 (room B). @returns the room or null */
function leaveCellar(sim, side) {
  const cellar = sim.ram[V.RoomId];
  const goal = (x, y) => (side ? x >= 0x90 : x < 0x70) && y <= 0x5d;
  sim.controller = (r) => {
    if (r[V.GameMode] !== 0x09 || r[V.IsUpdatingMode] === 0) return 0;
    if (r[V.ObjGridOffset] !== 0) return DIR_BTN[r[V.ObjDir]] ?? 0;
    const x = r[V.ObjX], y = r[V.ObjY];
    if (goal(x, y)) return B.U;
    // BFS over the 8-pixel grid (port collision on the oracle's state) to the top of that side.
    ram.set(r);
    sram.set(sim.o.sram);
    const first = new Map([[`${x},${y}`, 0]]);
    const q = [[x, y]];
    while (q.length) {
      const [cx, cy] = q.shift();
      for (const d of [8, 4, 2, 1]) {
        const [dx, dy] = P.DXY[d];
        const nx = cx + dx, ny = cy + dy, k = `${nx},${ny}`;
        if (!P.inside(nx, ny) || first.has(k) || !P.walkable(cx, cy, d)) continue;
        first.set(k, first.get(`${cx},${cy}`) || d);
        if (goal(nx, ny)) return DIR_BTN[first.get(k)];
        q.push([nx, ny]);
      }
    }
    return 0;
  };
  const ok = sim.runUntil((r) => P.playing(r) && r[V.RoomId] !== cellar, 1500);
  sim.controller = () => 0;
  if (!ok) return null;
  sim.play([[20, 0]]);
  return sim.ram[V.RoomId];
}

// ------------------------------------------------------------------ fights

const hearts = (r) => ((r[V.HeartValues] & 0x0f) << 8) | r[V.HeartPartial];

/**
 * Search: from a snapshot run every plan (a controller) for `horizon` frames and keep the one with the
 * best score (deaths excluded); when none improves the score, run `idle` for a while. Until done().
 */
function searchFight(sim, { done, score, plans, horizon = 90, idle, maxSteps = 120, name, patience = 60 }) {
  let stall = 0;
  for (let step = 0; step < maxSteps && stall < patience; step++) {
    if (done(sim.ram)) return true;
    P.heal(sim);
    if (done(sim.ram)) return true;
    const snap = sim.snapshot();
    const base = score(sim.ram);
    const h0 = hearts(sim.ram);
    let best = null;
    const list = plans(sim.ram);
    for (const plan of list) {
      sim.restore(snap);
      sim.controller = plan.ctl;
      let s;
      try {
        sim.runUntil((r) => done(r), plan.horizon ?? horizon);
        s = score(sim.ram) - Math.max(0, h0 - hearts(sim.ram)) / 64;
      } catch (e) {
        if (!/died/.test(e.message)) throw e;
        s = -Infinity;
      }
      sim.controller = () => 0;
      if (s > base && (!best || s > best.s)) best = { s, snap: sim.snapshot(), tag: plan.tag };
      if (best && done(sim.ram)) break;
    }
    if (best) {
      sim.restore(best.snap);
      console.log(`  ${name} step ${step}: ${best.tag} score ${base} -> ${best.s} f${sim.frame}`);
      stall = 0;
      continue;
    }
    stall++;
    sim.restore(snap);
    sim.controller = idle;
    try { sim.runUntil(done, 24); } catch (e) { if (!/died/.test(e.message)) throw e; sim.restore(snap); sim.controller = () => 0; sim.play([[8, 0]]); }
    sim.controller = () => 0;
  }
  return done(sim.ram);
}

const aligned = (x, y) => [x & 0xf8, (y & 0xf8) | 5];

/** Walk to (gx, gy) (8-pixel grid), face dir and run then() every frame after arriving. */
function goAndDo(gx, gy, dir, then) {
  const walk = P.walkController((x, y) => x === gx && y === gy, { sword: false });
  let arrived = false, t = 0;
  return (r, f) => {
    if (!P.playing(r)) return 0;
    if (!arrived) {
      const b = walk(r, f);
      if (walk.arrived && r[V.ObjGridOffset] === 0) arrived = true;
      else return b;
    }
    if (r[V.ObjDir] !== dir && r[V.ObjGridOffset] === 0 && t === 0) return DIR_BTN[dir];
    return then(r, f, t++);
  };
}

/** Stay away from slot i: walk to the room square farthest from it. */
function idleAway(types) {
  let inner = null, gk = '';
  return (r, f) => {
    if (!P.playing(r)) return 0;
    const s = bossSlots(r, types);
    const i = s[0];
    const bx = i ? r[V.ObjX + i] : 0x78, by = i ? r[V.ObjY + i] : 0x8d;
    const cands = [[0x28, 0x65], [0xc8, 0x65], [0x28, 0xb5], [0xc8, 0xb5], [0x78, 0xb5], [0x78, 0x65]];
    cands.sort((a, b) => (Math.abs(b[0] - bx) + Math.abs(b[1] - by)) - (Math.abs(a[0] - bx) + Math.abs(a[1] - by)));
    const [gx, gy] = cands[0];
    const key = `${gx},${gy}`;
    if (key !== gk) { gk = key; inner = P.walkController((x, y) => x === gx && y === gy, { sword: false }); }
    return inner(r, f);
  };
}

/**
 * Chases slot i, keeping to side `dir` of it (Link faces dir) at distance off: re-plans when the target
 * square changes; swings when close and facing it.
 */
function chase(i, dir, off, s) {
  let inner = null, gk = '';
  return (r, f) => {
    if (!P.playing(r)) return 0;
    if (r[V.ObjType + i] === 0 || r[V.ObjMetastate + i] !== 0) return 0;
    const bx = r[V.ObjX + i], by = r[V.ObjY + i];
    const dx = bx - r[V.ObjX], dy = by - r[V.ObjY];
    const near = Math.abs(dx) < 0x14 && Math.abs(dy) < 0x14;
    // In line with it: the sword beam (full hearts) or the sword.
    const inLine = r[V.ObjGridOffset] === 0 && (Math.abs(dx) < 6 || Math.abs(dy) < 6) && Math.abs(dx) + Math.abs(dy) < 0x90;
    if (near || inLine) {
      const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 2) : (dy > 0 ? 4 : 8);
      if (r[V.ObjDir] !== d && r[V.ObjGridOffset] === 0) return DIR_BTN[d];
      return f % 8 === 0 ? B.A : 0;
    }
    const [ox, oy] = { 1: [-off, s], 2: [off, s], 4: [s, -off], 8: [s, off] }[dir];
    let [gx, gy] = aligned(bx + ox, by + oy);
    gx = Math.min(0xd0, Math.max(0x20, gx));
    gy = Math.min(0xbd, Math.max(0x5d, gy));
    const key = `${gx},${gy}`;
    if (key !== gk) { gk = key; inner = P.walkController((x, y) => Math.abs(x - gx) <= 8 && Math.abs(y - gy) <= 8, { sword: false }); }
    return inner(r, f);
  };
}

/** Sword plans: chase each live boss slot from each side (a few offsets) and swing. */
function swordPlans(types, { maxSlots = 3, offsets = [0x10, 0x18], spread = [0, -8, 8] } = {}) {
  return (r) => {
    const plans = [];
    for (const i of bossSlots(r, types).slice(0, maxSlots)) {
      for (const off of offsets) {
        for (const s of spread) {
          for (const dir of [1, 2, 4, 8]) plans.push({ tag: `sword ${hex(i)} ${dir}/${hex(off)}/${s}`, ctl: chase(i, dir, off, s) });
        }
      }
    }
    return plans;
  };
}

/** Score: minus the remaining HP of the live boss parts (and 256 per live part). */
const hpScore = (types) => (r) => {
  let s = 0;
  for (let i = 1; i < 0x0c; i++) {
    if (!types.includes(r[V.ObjType + i]) || r[V.ObjMetastate + i] !== 0) continue;
    s -= 256 + r[V.ObjHP + i];
  }
  return s;
};

function fightSword(sim, types, name, extra = {}) {
  const done = allGone(types);
  const ok = searchFight(sim, { name, done, score: hpScore(types), plans: swordPlans(types, extra), idle: idleAway(types), ...extra });
  if (!ok) throw new Error(`${name}: not killed`);
  sim.events.push(`${name} killed f${sim.frame}`);
  sim.play([[90, 0]]);
  P.log(sim, `  ${name} killed`);
}

/** Dodongo: bombs in its path (eaten) or exploding next to it (stunned, then the sword). */
function fightDodongo(sim) {
  const types = [0x31, 0x32];
  P.selectItem(sim, SLOT_BOMB);
  const score = (r) => {
    let s = 0;
    for (let i = 1; i < 0x0c; i++) {
      if (!types.includes(r[V.ObjType + i]) || r[V.ObjMetastate + i] !== 0) continue;
      s -= 1024;
      s += 64 * r[V.Dodongo_ObjBombHits + i] + (r[V.ObjState + i] === 1 ? 32 : 0) + (r[V.ObjState + i] === 2 ? 8 : 0);
    }
    return s;
  };
  const plans = (r) => {
    const out = [];
    for (const i of bossSlots(r, types).slice(0, 2)) {
      const bx = r[V.ObjX + i], by = r[V.ObjY + i];
      // The sword only once a bomb was eaten (bloated state covered first).
      if (r[V.ObjState + i] === 2 && r[V.Dodongo_ObjBombHits + i] > 0) {
        // Stunned: only the sword hurts it.
        out.push(...swordPlans([r[V.ObjType + i]], { maxSlots: 1, offsets: [0x10, 0x18, 0x20], spread: [0, 8] })(r));
        continue;
      }
      // Bomb laid ahead of it (Link faces it): left of it, right of it (it is 32 wide), above, below.
      for (const dist of [0x18, 0x20, 0x28, 0x30, 0x38]) {
        for (const [dir, gx0, gy0] of [[1, bx - dist, by], [2, bx + 0x10 + dist, by], [4, bx + 8, by - dist], [8, bx + 8, by + dist]]) {
          const [gx, gy] = aligned(gx0, gy0);
          if (gy < 0x45 || gy > 0xd5 || gx < 0x18 || gx > 0xd8) continue;
          const flee = dir === 1 || dir === 2 ? (gy < 0x8d ? B.D : B.U) : (gx < 0x78 ? B.R : B.L);
          out.push({
            tag: `bomb ${hex(i)} ${dir}@${hex(gx)},${hex(gy)}`, horizon: 160,
            ctl: goAndDo(gx, gy, dir, (rr, f, t) => (t === 1 ? B.B : t > 4 && t < 30 ? flee : 0)),
          });
        }
      }
    }
    return out;
  };
  const done = allGone(types);
  const ok = searchFight(sim, { name: 'dodongo', done, score, plans, idle: idleAway(types), maxSteps: 200 });
  if (!ok) throw new Error('dodongo: not killed');
  sim.events.push(`dodongo killed f${sim.frame}`);
  sim.play([[90, 0]]);
  P.log(sim, '  dodongo killed');
}

/** Gohma: arrows up into the open eye from below. */
function fightGohma(sim, types) {
  P.selectItem(sim, SLOT_ARROW);
  const plans = (r) => {
    const out = [];
    for (const i of bossSlots(r, types).slice(0, 1)) {
      const bx = r[V.ObjX + i], by = r[V.ObjY + i];
      for (const dx of [-0x10, -0x08, 0, 0x08]) {
        for (const dy of [0x20, 0x30, 0x40]) {
          const [gx, gy] = aligned(bx + dx, by + dy);
          if (gy > 0xd5 || gx < 0x18 || gx > 0xd8) continue;
          out.push({
            tag: `arrow ${dx}/${dy}`, horizon: 150,
            ctl: goAndDo(gx, gy, 8, (rr, f, t) => (rr[V.Gohma_ObjEyeState + i] === 3 && t % 6 === 0 ? B.B : 0)),
          });
        }
      }
    }
    return out;
  };
  const done = allGone(types);
  const ok = searchFight(sim, { name: 'gohma', done, score: hpScore(types), plans, idle: idleAway(types), maxSteps: 200 });
  if (!ok) throw new Error('gohma: not killed');
  sim.events.push(`gohma killed f${sim.frame}`);
  sim.play([[90, 0]]);
  P.log(sim, '  gohma killed');
}

/** Digdogger: the recorder splits it; the sword kills the little ones. */
function fightDigdogger(sim) {
  P.selectItem(sim, SLOT_RECORDER);
  // Out of the doorway (no items there), then play until the recorder sounds.
  const [gx, gy] = sim.ram[V.ObjX] >= 0x80 ? [0xb0, 0x8d] : [0x40, 0x8d];
  if (!P.walkTo(sim, gx, gy, 600)) throw new Error('digdogger: cannot leave the doorway');
  for (let k = 0; k < 10 && sim.ram[V.FluteTimer] === 0; k++) sim.play([[2, B.B], [6, 0]]);
  if (sim.ram[V.FluteTimer] === 0) throw new Error('the recorder did not play');
  if (!sim.runUntil((r) => P.playing(r) && P.slotsOf(r, (t) => t === 0x18).length > 0, 600)) throw new Error('digdogger did not split');
  sim.events.push(`digdogger split f${sim.frame}`);
  P.log(sim, '  digdogger split');
  fightSword(sim, [0x18, 0x38, 0x39], 'digdoggers', { maxSlots: 3 });
}

// ------------------------------------------------------------------ doorways

const DOOR = { 8: [0x78, 0x5d], 4: [0x78, 0xbd], 2: [0x20, 0x8d], 1: [0xd0, 0x8d] };
// Monsters that keep shutters closed (bubbles are invincible and do not count).
const isMonster = (t) => t !== 0 && t < 0x53 && t !== 0x2e && t !== 0x2f && t !== 0x29
  && !(t >= 0x49 && t <= 0x52) && !(t >= 0x2b && t <= 0x2d);

/** Kills every monster of the room (search over sword plans). */
function clearRoom(sim, maxSteps = 250) {
  const live = (r) => { const s = []; for (let i = 1; i < 0x0c; i++) if (isMonster(r[V.ObjType + i]) && r[V.ObjMetastate + i] < 0x10) s.push(i); return s; };
  if (P.slotsOf(sim.ram, (t) => t === 0x31 || t === 0x32).length) {
    try { fightDodongo(sim); } catch (e) { console.log(`  ${e.message}`); }
  }
  const done = (r) => P.playing(r) && live(r).length === 0;
  const score = (r) => { let s = 0; for (const i of live(r)) s -= 256 + r[V.ObjHP + i]; return s; };
  const plans = (r) => swordPlans([...new Set(live(r).map((i) => r[V.ObjType + i]))], { maxSlots: 3, offsets: [0x10], spread: [0, 8] })(r);
  const ok = searchFight(sim, { name: 'clear', done, score, plans, horizon: 90, idle: idleAway([]), maxSteps, patience: 25 });
  if (!ok) console.log(`  clear failed: left ${live(sim.ram).map((i) => `${hex(i)}:${hex(sim.ram[V.ObjType + i])} hp ${hex(sim.ram[V.ObjHP + i])} (${hex(sim.ram[V.ObjX + i])},${hex(sim.ram[V.ObjY + i])})`).join(' ')}`);
  sim.play([[30, 0]]);
  return ok;
}

/** Pushes the room's block (object $68) from each side until it moves. */
function pushBlock(sim) {
  const slot = P.slotsOf(sim.ram, (t) => t === 0x68)[0];
  if (!slot) return false;
  const bx = sim.ram[V.ObjX + slot], by = sim.ram[V.ObjY + slot];
  const snap = sim.snapshot();
  for (const [dir, dx, dy] of [[8, 0, 0x10], [4, 0, -0x10], [2, 0x10, 0], [1, -0x10, 0]]) {
    sim.restore(snap);
    const [gx, gy] = aligned(bx + dx, by + dy);
    sim.controller = goAndDo(gx, gy, dir, () => DIR_BTN[dir]);
    let moved = false;
    try {
      moved = sim.runUntil((r) => r[V.ObjType + slot] !== 0x68 || r[V.ObjX + slot] !== bx || r[V.ObjY + slot] !== by, 400);
    } catch (e) { if (!/died/.test(e.message)) throw e; }
    sim.controller = () => 0;
    if (moved) { sim.play([[60, 0]]); console.log(`  block pushed ${dir}`); return true; }
  }
  sim.restore(snap);
  return false;
}

/** Through doorway d: bomb a bombable wall, clear the room / push the block for a shutter. */
function goRoom(sim, d) {
  for (let attempt = 0; attempt < 3; attempt++) {
    P.heal(sim);
    const to = P.goThrough(sim, d, 1500);
    if (typeof to === 'number' || to === 'forbidden' || to === -1) return to;
    const t = doorType(sim, d);
    if (t === 1) return null;
    console.log(`  ${hex(sim.ram[V.RoomId])} dir ${d} (door type ${t}) blocked, attempt ${attempt}`);
    if (t === 4) {
      const [gx, gy] = DOOR[d];
      if (!P.walkTo(sim, gx, gy, 1500)) continue;
      P.selectItem(sim, SLOT_BOMB);
      sim.play([[2, DIR_BTN[d]], [4, 0], [2, B.B], [4, 0]]);
      P.walkTo(sim, 0x78, 0x8d, 600);
      sim.runUntil(() => false, 120);
    } else {
      clearRoom(sim);
      if (attempt > 0) pushBlock(sim);
    }
  }
  return null;
}

// ------------------------------------------------------------------ scenarios

const SCENARIOS = {
  'boss-aquamentus': { warps: 8, level: 1, types: [0x3d], fight: (sim) => fightSword(sim, [0x3d], 'aquamentus', { offsets: [0x10, 0x18], spread: [0, -8, 8, 0x10] }) },
  'boss-dodongo': { warps: 1, level: 2, types: [0x31, 0x32], fight: fightDodongo },
  'boss-manhandla': { warps: 2, level: 3, types: [0x3c], fight: (sim) => fightSword(sim, [0x3c], 'manhandla', { maxSlots: 4, offsets: [0x10], spread: [0, 8] }) },
  'boss-digdogger': { warps: 4, level: 5, types: [0x38, 0x39, 0x18], fight: fightDigdogger },
  'boss-gohma': { warps: 5, level: 6, types: [0x33, 0x34], fight: (sim) => fightGohma(sim, [0x33, 0x34]) },
};

function save(sim, name) {
  mkdirSync(CKPT, { recursive: true });
  writeFileSync(join(CKPT, `${name}.json`), JSON.stringify({ inputs: sim.used(), events: sim.events }));
  console.log(`checkpoint ${name} f${sim.frame}`);
}

async function resume(s, name) {
  const c = JSON.parse(readFileSync(join(CKPT, `${name}.json`), 'utf8'));
  const sim = await new P.Sim(s, c.inputs).start();
  P.setCur(sim);
  sim.runUntil(() => false, c.inputs.length);
  sim.events = c.events;
  console.log(`resumed ${name} at f${sim.frame}`);
  return sim;
}

async function make(name) {
  await P.init();
  const sc = SCENARIOS[name];
  const s = new Uint8Array(readFileSync(join(P.MOVIES, SRAM_FILE)));
  const from = process.env.P21_RESUME;
  let sim;
  if (from) sim = await resume(s, `${name}-${from}`);
  else {
    sim = await P.startGame(s, 0);
    for (let i = 0; i < sc.warps; i++) P.warp(sim);
    const l = P.enterLevel(sim);
    if (l !== sc.level) throw new Error(`${name}: entered level ${l}`);
    save(sim, `${name}-entered`);
  }
  if (from !== 'bossroom') {
    const path = toBossRoom(sim, sc.types);
    sim.events.push(`boss room via ${path} f${sim.frame}`);
    save(sim, `${name}-bossroom`);
  }
  sc.fight(sim);
  sim.play([[120, 0]]);
  const seen = [...sim.seen.keys()].filter((t) => t < 0x53).sort((a, b) => a - b);
  const bosses = seen.filter(isBoss);
  P.writeMovie(name, [
    `P21: from tests/oracle/movies/${SRAM_FILE} (magical sword, recorder, bow and arrows, bombs, red ring,`,
    'magic shield, magic key, 16 full hearts, the 8 triforce pieces), first quest: recorder to level',
    `${sc.level}, rooms towards the boss room, then the boss fight.`,
    `Events: ${sim.events.join('; ')}.`,
    `Bosses seen: ${bosses.map((t) => P21_TYPES[t]).join(', ')}.`,
    'Generated by tests/game/p21-make-movies.mjs (closed-loop search on the original game).',
    `Run the oracle with --sram tests/oracle/movies/${SRAM_FILE}.`,
  ], sim.used(), {
    comment: `Boss fight (P21): level ${sc.level}, ${bosses.map((t) => P21_TYPES[t]).join(', ')}.`,
    sram: SRAM_FILE,
    reaches: { CurLevel: [0, sc.level], GameMode: [5] },
    monsterTypes: seen,
    bossTypes: bosses,
    events: sim.events,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const names = !args.length || args[0] === 'all' || args[0] === 'check' ? Object.keys(SCENARIOS) : args;
  for (const n of names) {
    if (args[0] !== 'check') await make(n);
    await P.check(n);
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });

void OPP;

// For debugging scripts.
export { goRoom, clearRoom, pushBlock, enterStairs, leaveCellar, doorType, searchFight, resume, save };
