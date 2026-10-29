#!/usr/bin/env node
// Generator of the P22 oracle scenarios (bosses B, Ganon, Zelda and the ending). Run:
//   node tests/game/p22-make-movies.mjs [sram|all|check|<scenario>...]
//
// tests/oracle/movies/p22-items.sav = p20-items.sav (first quest: magical sword, bracelet, ladder,
// recorder, bow, bombs, red ring, magic shield, magic key, 16 full hearts, the 8 triforce pieces) plus
// every other item: SILVER arrow, red candle, magic rod and book, raft, both boomerangs, the level 9
// map and compass. Only the player area $6000-$652F, checksum fixed. Scenarios:
//  * boss-moldorm  level 2, room $3E: the two moldorm chains (sword).
//  * boss-gleeok   level 4 boss room $13: gleeok with 2 heads (sword on the heads; a severed head flies).
//  * boss-gleeok4  level 8 boss room $3C: gleeok with 4 heads.
//  * level 9 (recorder to level 5, Death Mountain, Spectacle Rock bombed): one long play whose prefixes
//    are the other movies:
//      boss-patra         rooms with Patra ($47, big orbit) and Patra ($48, small orbit) killed.
//      boss-ganon         Ganon's scene, the fight (sword while invisible, silver arrow when brown),
//                         his death and the triforce of power.
//      rescue-zelda       the guard fires killed, Zelda reached: mode $13.
//      ending-from-ganon  the whole ending, the credits and the start of the second quest (Start).
// The inputs come from closed-loop controllers playing the ORIGINAL game in the oracle (searches over
// oracle snapshots), so the movies are reproducible. Checkpoints in out/p22/ (P22_RESUME=<name>).
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as P from './p19-make-movies.mjs';
import * as Q from './p21-make-movies.mjs';
import * as V from '../../src/core/vars.js';
import { ram, sram } from '../../src/core/ram.js';

const { B, DIR_BTN, hex } = P;
export const SRAM_FILE = 'p22-items.sav';
export const P22_TYPES = {
  0x25: 'patra child (big orbit)', 0x26: 'patra child (small orbit)', 0x37: 'zelda', 0x3e: 'ganon',
  0x3f: 'guard fire', 0x41: 'moldorm', 0x42: 'gleeok (1 head)', 0x43: 'gleeok (2 heads)', 0x44: 'gleeok (3 heads)',
  0x45: 'gleeok (4 heads)', 0x46: 'gleeok flying head', 0x47: 'patra (big orbit)', 0x48: 'patra (small orbit)',
};
for (const t of Object.keys(P22_TYPES).map(Number)) P.FORBIDDEN.delete(t);

// The ladder: the planner may step onto underworld water ($F4) in any direction and keep going (the
// game lays the ladder over one tile; a wider band just blocks the walk, and the walk controller then
// marks that step as blocked). Replaces the stricter hooks of p20/p21-make-movies.
P.hooks.walkable = (x, y, d, t, ok) => {
  if (ram[V.CurLevel] === 0 || ram[V.InvLadder] === 0) return ok;
  return ok || t === 0xf4;
};

// Nested NMIs: when an NMI of the original lasts more than a video frame and re-enables the NMI inside
// the next vblank, a second NMI runs before its RTI: two RTIs in one emulated video frame. The oracle
// test tolerates exactly those frames (tests/game/p22-oracle.test.mjs); the runs log them as events.
const runUntil0 = P.Sim.prototype.runUntil;
P.Sim.prototype.runUntil = function (done, max) {
  return runUntil0.call(this, (r, f) => {
    if (this.lastFcFrame === f - 2 && ((r[V.FrameCounter] - this.lastFc) & 0xff) === 2) this.events.push(`nested NMI f${f - 1}`);
    this.lastFc = r[V.FrameCounter];
    this.lastFcFrame = f;
    return done(r, f);
  }, max);
};
const restore0 = P.Sim.prototype.restore;
P.Sim.prototype.restore = function (snap) {
  this.lastFcFrame = -10;
  return restore0.call(this, snap);
};
const nestedCount = (sim) => sim.events.filter((e) => e.startsWith('nested NMI')).length;

const CKPT = join(import.meta.dirname, '..', '..', 'out', 'p22');
const SLOT_ARROW = 2, SLOT_CANDLE = 4;
const hearts = (r) => ((r[V.HeartValues] & 0x0f) << 8) | r[V.HeartPartial];

// ------------------------------------------------------------------ SRAM

function setItem(s, v, value) {
  const i = V.SaveFileAItems0 - 0x6000 + (v - V.Items);
  const delta = value - s[i];
  s[i] = value;
  let sum = (s[V.FileAChecksums - 0x6000] << 8) | s[V.FileAChecksums - 0x6000 + 1];
  sum = (sum + delta) & 0xffff;
  s[V.FileAChecksums - 0x6000] = sum >> 8;
  s[V.FileAChecksums - 0x6000 + 1] = sum & 0xff;
}

export function makeItemsSram() {
  const s = new Uint8Array(readFileSync(join(P.MOVIES, 'p20-items.sav')));
  setItem(s, V.InvArrow, 2); // silver arrow
  setItem(s, V.InvCandle, 2); // red candle
  setItem(s, V.Potion + 1, 1); // magic rod ($065F)
  setItem(s, V.InvBook, 1);
  setItem(s, V.InvRaft, 1);
  setItem(s, V.InvBoomerang, 1);
  setItem(s, V.InvMagicBoomerang, 1);
  setItem(s, V.InvCompass9, 1);
  setItem(s, V.InvMap9, 1);
  return s;
}

function ensureSram(force = false) {
  const path = join(P.MOVIES, SRAM_FILE);
  if (!force && existsSync(path)) return new Uint8Array(readFileSync(path));
  const s = makeItemsSram();
  writeFileSync(path, s);
  console.log(`wrote ${SRAM_FILE}`);
  return s;
}

// ------------------------------------------------------------------ checkpoints

function save(sim, name) {
  mkdirSync(CKPT, { recursive: true });
  writeFileSync(join(CKPT, `${name}.json`), JSON.stringify({ inputs: sim.used(), events: sim.events, seen: [...sim.seen] }));
  console.log(`checkpoint ${name} f${sim.frame}`);
}

async function resume(s, name) {
  const c = JSON.parse(readFileSync(join(CKPT, `${name}.json`), 'utf8'));
  const sim = await new P.Sim(s, c.inputs).start();
  P.setCur(sim);
  sim.runUntil(() => false, c.inputs.length);
  sim.events = c.events;
  sim.seen = new Map(c.seen);
  console.log(`resumed ${name} at f${sim.frame}`);
  return sim;
}

// ------------------------------------------------------------------ OW: Death Mountain to level 9
// (the same route as tests/game/p20-make-movies.mjs)

function owRoute(sim, route) {
  const L = { N: 8, S: 4, W: 2, E: 1 };
  for (const c of route) {
    if (!P.exitRoomOW(sim, L[c], 2400)) throw new Error(`OW: cannot leave ${hex(sim.ram[V.RoomId])} by ${c}`);
    sim.play([[20, 0]]);
    P.log(sim, `  ow ${c}`);
  }
}

function reachable(sim) {
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const sx = sim.ram[V.ObjX] & 0xf8, sy = (sim.ram[V.ObjY] & 0xf8) | 5;
  const seen = new Set([`${sx},${sy}`]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const d of [8, 4, 2, 1]) {
      const [dx, dy] = P.DXY[d];
      const nx = x + dx, ny = y + dy;
      if (!P.inside(nx, ny) || seen.has(`${nx},${ny}`) || !P.walkable(x, y, d)) continue;
      if (P.isWarpTile(P.rawTileStill(nx, ny))) continue;
      seen.add(`${nx},${ny}`);
      q.push([nx, ny]);
    }
  }
  return seen;
}

function edgeExits(sim, c) {
  const pts = [...reachable(sim)].map((k) => k.split(',').map(Number));
  const on = pts.filter(([x, y]) => (c === 'W' ? x === P.X0 : c === 'E' ? x === P.X1 : c === 'N' ? y === P.Y0 : y === P.Y1));
  const along = (p) => (c === 'W' || c === 'E' ? p[1] : p[0]);
  on.sort((a, b) => along(a) - along(b));
  const segs = [];
  for (const p of on) {
    const last = segs.at(-1);
    if (last && along(p) - along(last.at(-1)) === 8) last.push(p); else segs.push([p]);
  }
  return segs.map((s) => s[s.length >> 1]);
}

function owSearch(sim, target, allowed = () => true) {
  const L = { N: 8, S: 4, W: 2, E: 1 };
  const start = sim.ram[V.RoomId];
  const regionKey = () => `${sim.ram[V.RoomId]}:${[...reachable(sim)].sort()[0]}`;
  const k0 = regionKey();
  const seen = new Map([[k0, { snap: sim.snapshot(), path: '', room: start }]]);
  const q = [k0];
  while (q.length) {
    const key = q.shift();
    const node = seen.get(key);
    const room = node.room;
    sim.restore(node.snap);
    const exits = [];
    for (const c of 'WNSE') for (const p of edgeExits(sim, c)) exits.push([c, p]);
    for (const [c, [gx, gy]] of exits) {
      sim.restore(node.snap);
      sim.controller = P.walkController((x, y) => x === gx && y === gy, { finalDir: L[c] });
      const ok = sim.runUntil((r) => P.playing(r) && r[V.RoomId] !== room, 1500);
      sim.controller = () => 0;
      if (!ok) continue;
      sim.play([[20, 0]]);
      if (!P.playing(sim.ram) || sim.ram[V.CurLevel] !== 0) continue;
      const to = sim.ram[V.RoomId];
      if (!allowed(to)) continue;
      const k = regionKey();
      if (seen.has(k)) continue;
      console.log(`  ow ${hex(room)} -${c}-> ${hex(to)} (${node.path + c})`);
      seen.set(k, { snap: sim.snapshot(), path: node.path + c, room: to });
      if (to === target) return node.path + c;
      q.push(k);
    }
  }
  throw new Error(`OW: ${hex(target)} not reachable from ${hex(start)}`);
}

function pushRockAndTakeShortcut(sim, target) {
  const r = sim.ram;
  let slot = 0;
  for (let i = 1; i < 0x0c; i++) if (r[V.ObjType + i] === 0x62) slot = i;
  if (!slot) throw new Error(`no rock in ${hex(r[V.RoomId])}`);
  const rx = r[V.ObjX + slot], ry = r[V.ObjY + slot];
  if (!P.walkTo(sim, rx, ((ry + 0x10) & 0xf8) | 5, 2400)) throw new Error('cannot stand below the rock');
  let tune = false;
  sim.controller = (rr) => { if (rr[V.Tune1Request] === 0x04) tune = true; return B.U; };
  sim.runUntil(() => false, 120);
  sim.controller = () => 0;
  sim.play([[30, 0]]);
  if (!tune) throw new Error('the rock did not move');
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const set = new Set();
  for (let x = P.X0; x <= P.X1; x += 8) for (let y = P.Y0; y <= P.Y1; y += 8) if (P.isWarpTile(P.rawTileStill(x, y))) set.add(`${x},${y}`);
  sim.controller = P.walkController((x, y) => set.has(`${x},${y}`), { finalDir: 8, allowWarp: true, sword: false });
  if (!sim.runUntil((rr) => rr[V.GameMode] === 0x0c, 900)) throw new Error('no shortcut cave');
  sim.controller = () => 0;
  sim.runUntil((rr) => rr[V.GameMode] === 0x0c && rr[V.IsUpdatingMode] !== 0, 600);
  sim.play([[120, 0]]);
  const snap = sim.snapshot();
  for (const sx of [0x50, 0x80, 0xb0]) {
    sim.restore(snap);
    sim.controller = (rr) => {
      if (rr[V.ObjGridOffset] !== 0) return P.DIR_BTN[rr[V.ObjDir]];
      if (rr[V.ObjY] > 0x9d) return B.U;
      if (rr[V.ObjX] < sx) return B.R;
      if (rr[V.ObjX] > sx) return B.L;
      return B.U;
    };
    const ok = sim.runUntil((rr) => P.playing(rr) && rr[V.RoomId] !== 0x1d, 1500);
    sim.controller = () => 0;
    if (!ok) continue;
    sim.play([[30, 0]]);
    P.log(sim, `  stairs ${hex(sx)} ->`);
    if (sim.ram[V.RoomId] === target) return;
  }
  throw new Error(`no stairs to ${hex(target)}`);
}

function bombRockWallAndEnter(sim) {
  const r = sim.ram;
  let slot = 0;
  for (let i = 1; i < 0x0c; i++) if (r[V.ObjType + i] === 0x63) slot = i;
  if (!slot) throw new Error(`no rock wall object in ${hex(r[V.RoomId])}`);
  const wx = r[V.ObjX + slot], wy = r[V.ObjY + slot];
  P.selectItem(sim, 1);
  const hasWall = () => P.slotsOf(sim.ram, (t) => t === 0x63).length > 0;
  for (let attempt = 0; attempt < 4 && hasWall(); attempt++) {
    let ok = false;
    for (let dy = 0x10; dy <= 0x18 && !ok; dy += 8) ok = P.walkTo(sim, wx, ((wy + dy) & 0xf8) | 5, 1500);
    if (!ok) throw new Error('cannot stand below the rock wall');
    sim.play([[3, B.U], [6, 0], [2, B.B], [10, 0], [24, B.D], [200, 0]]);
  }
  if (!P.walkTo(sim, wx, ((wy + 0x10) & 0xf8) | 5, 900)) throw new Error('cannot go back below the opening');
  sim.controller = (rr) => (P.playing(rr) && rr[V.CurLevel] === 0 ? B.U : 0);
  const inLevel = sim.runUntil((rr) => rr[V.CurLevel] !== 0 && P.playing(rr), 1500);
  sim.controller = () => 0;
  if (!inLevel) throw new Error('no level entrance after bombing');
  sim.play([[20, 0]]);
  P.log(sim, 'entered');
  return sim.ram[V.CurLevel];
}

// ------------------------------------------------------------------ UW: to a room

/** Link just came out of a cellar onto the stairs: step off them so that the walk back can take them. */
function stepOffStairs(sim) {
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const x = sim.ram[V.ObjX], y = sim.ram[V.ObjY];
  if (!P.isWarpTile(P.rawTileStill(x, y))) return;
  for (const [dx, dy] of [[0, 0x18], [-0x18, 0], [0x18, 0], [0, -0x18]]) {
    const [gx, gy] = aligned(x + dx, y + dy);
    const snap = sim.snapshot();
    if (P.walkTo(sim, gx, gy, 300)) return;
    sim.restore(snap);
  }
}

/** Visible stairs: walk onto each stairs square in turn (lowest first) until mode 9. @returns snapshot or null */
function takeStairs(sim) {
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const sq = [];
  for (let x = P.X0; x <= P.X1; x += 8) for (let y = P.Y0; y <= P.Y1; y += 8) if (P.isWarpTile(P.rawTileStill(x, y))) sq.push([x, y]);
  sq.sort((a, b) => b[1] - a[1]);
  const snap = sim.snapshot();
  for (const [gx, gy] of sq) {
    sim.restore(snap);
    sim.controller = P.walkController((x, y) => x === gx && y === gy, { allowWarp: true, sword: false, finalDir: 8 });
    let ok = false;
    try { ok = sim.runUntil((r) => r[V.GameMode] === 0x09 && r[V.IsUpdatingMode] !== 0, 900); } catch (e) { if (!/died/.test(e.message)) throw e; }
    sim.controller = () => 0;
    if (ok) { sim.play([[30, 0]]); console.log(`  ${hex(sim.ram[V.RoomId])}: cellar via (${hex(gx)},${hex(gy)})`); return sim.snapshot(); }
  }
  sim.restore(snap);
  return null;
}

const ROOM_DIRS = { 8: -16, 4: 16, 2: -1, 1: 1 };

/**
 * Best-first search over the level's rooms (doorways, bombable walls, shutters, transport stairs) with
 * oracle snapshots, towards room `target` (Manhattan distance). Stops when Link is in `target`.
 */
function toRoom(sim, target, maxNodes = 80, avoid = () => false) {
  const dist = (room) => Math.abs((room & 15) - (target & 15)) + Math.abs((room >> 4) - (target >> 4));
  const start = sim.ram[V.RoomId];
  if (start === target) return '';
  const nodes = new Map([[start, { snap: sim.snapshot(), depth: 0, path: '' }]]);
  const open = [start];
  const tried = new Set();
  for (let n = 0; open.length && n < maxNodes; n++) {
    open.sort((a, b) => (dist(a) + nodes.get(a).depth / 4) - (dist(b) + nodes.get(b).depth / 4));
    const room = open.shift();
    const node = nodes.get(room);
    const found = (to, path) => {
      if (to === target) {
        sim.play([[10, 0]]);
        P.log(sim, `  room ${hex(target)} reached (${path})`);
        return true;
      }
      if (nodes.has(to) || avoid(to)) return false;
      console.log(`  ${hex(room)} -> ${hex(to)} (${path}) f${sim.frame}`);
      nodes.set(to, { snap: sim.snapshot(), depth: node.depth + 1, path });
      open.push(to);
      return false;
    };
    for (const d of [8, 2, 1, 4]) {
      if (room === start && d === 4 && sim.ram[V.CurLevel] !== 0 && nodes.size === 1 && room === sim.o.sram[V.LevelInfo_StartRoomId - 0x6000]) continue;
      if (tried.has(`${room}:${d}`)) continue;
      tried.add(`${room}:${d}`);
      sim.restore(node.snap);
      if (Q.doorType(sim, d) === 1) continue;
      if (avoid(room + ROOM_DIRS[d])) continue;
      let to;
      try { to = Q.goRoom(sim, d); } catch (e) { if (!/died/.test(e.message)) throw e; to = 'died'; }
      if (typeof to !== 'number' || to < 0) { console.log(`  ${hex(room)} dir ${d}: ${to}`); continue; }
      if (found(to, node.path + 'NSWE'[[8, 4, 2, 1].indexOf(d)])) return node.path;
    }
    sim.restore(node.snap);
    stepOffStairs(sim);
    let cellar = null;
    try { cellar = Q.enterStairs(sim); } catch (e) { if (!/died/.test(e.message)) throw e; }
    if (!cellar) { sim.restore(node.snap); stepOffStairs(sim); cellar = takeStairs(sim); }
    if (!cellar) sim.restore(node.snap);
    const hasBlock = () => { for (let i = 1; i < 0x0c; i++) if (sim.ram[V.ObjType + i] === 0x68) return true; return false; };
    if (!cellar && hasBlock()) {
      // Visible stairs walled in by the push block: clear the room, push the block, try again.
      try {
        sim.play([[60, 0]]);
        Q.clearRoom(sim, 150);
        if (Q.pushBlock(sim)) cellar = Q.enterStairs(sim);
        console.log(`  ${hex(room)}: block pushed, cellar ${!!cellar}`);
      } catch (e) { if (!/died/.test(e.message)) throw e; }
    }
    if (cellar) {
      for (const side of [0, 1]) {
        sim.restore(cellar);
        let to = null;
        try { to = Q.leaveCellar(sim, side); } catch (e) { if (!/died/.test(e.message)) throw e; }
        if (to === null || to === room) continue;
        if (found(to, `${node.path}+${side ? 'B' : 'A'}`)) return node.path;
      }
    }
  }
  throw new Error(`room ${hex(target)} not reached`);
}

// ------------------------------------------------------------------ fights

const live = (types) => (r) => P.slotsOf(r, (t) => types.includes(t));
const allGone = (types) => (r) => {
  if (!P.playing(r)) return false;
  for (let i = 1; i < 0x0c; i++) if (types.includes(r[V.ObjType + i])) return false;
  return true;
};

const aligned = (x, y) => [x & 0xf8, (y & 0xf8) | 5];
const clampX = (x) => Math.min(0xd0, Math.max(0x20, x));
const clampY = (y) => Math.min(0xbd, Math.max(0x5d, y));

/**
 * Chases the point pos(r) (or slot i), keeping to side `dir` of it at distance off: swings (A, or B
 * with useB) when close or in line and facing it.
 */
function chasePoint(pos, dir, off, s, { useB = false, every = 8 } = {}) {
  let inner = null, gk = '';
  return (r, f) => {
    if (!P.playing(r)) return 0;
    const p = pos(r);
    if (!p) return 0;
    const [bx, by] = p;
    const dx = bx - r[V.ObjX], dy = by - r[V.ObjY];
    const near = Math.abs(dx) < 0x14 && Math.abs(dy) < 0x14;
    const inLine = r[V.ObjGridOffset] === 0 && (Math.abs(dx) < 6 || Math.abs(dy) < 6) && Math.abs(dx) + Math.abs(dy) < 0x90;
    if (near || inLine) {
      const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 2) : (dy > 0 ? 4 : 8);
      if (r[V.ObjDir] !== d && r[V.ObjGridOffset] === 0) return DIR_BTN[d];
      return f % every === 0 ? (useB ? B.B : B.A) : 0;
    }
    const [ox, oy] = { 1: [-off, s], 2: [off, s], 4: [s, -off], 8: [s, off] }[dir];
    const [gx, gy] = aligned(clampX(bx + ox), clampY(by + oy));
    const key = `${gx},${gy}`;
    if (key !== gk) { gk = key; inner = P.walkController((x, y) => Math.abs(x - gx) <= 8 && Math.abs(y - gy) <= 8, { sword: false }); }
    return inner(r, f);
  };
}

const slotPos = (i) => (r) => (r[V.ObjType + i] === 0 || r[V.ObjMetastate + i] !== 0 ? null : [r[V.ObjX + i], r[V.ObjY + i]]);

function swordPlans(types, { maxSlots = 3, offsets = [0x10, 0x18], spread = [0, -8, 8] } = {}) {
  return (r) => {
    const plans = [];
    for (const i of live(types)(r).slice(0, maxSlots)) {
      for (const off of offsets) for (const s of spread) for (const dir of [1, 2, 4, 8]) {
        plans.push({ tag: `sword ${hex(i)} ${dir}/${hex(off)}/${s}`, ctl: chasePoint(slotPos(i), dir, off, s) });
      }
    }
    return plans;
  };
}

function idleAway(pos) {
  let inner = null, gk = '';
  return (r, f) => {
    if (!P.playing(r)) return 0;
    const [bx, by] = pos(r) ?? [0x78, 0x8d];
    const cands = [[0x28, 0x65], [0xc8, 0x65], [0x28, 0xb5], [0xc8, 0xb5], [0x78, 0xb5], [0x78, 0x65]];
    cands.sort((a, b) => (Math.abs(b[0] - bx) + Math.abs(b[1] - by)) - (Math.abs(a[0] - bx) + Math.abs(a[1] - by)));
    const [gx, gy] = cands[0];
    const key = `${gx},${gy}`;
    if (key !== gk) { gk = key; inner = P.walkController((x, y) => x === gx && y === gy, { sword: false }); }
    return inner(r, f);
  };
}

const hpScore = (types) => (r) => {
  let s = 0;
  for (let i = 1; i < 0x0c; i++) {
    if (!types.includes(r[V.ObjType + i]) || r[V.ObjMetastate + i] !== 0) continue;
    s -= 256 + r[V.ObjHP + i];
  }
  return s;
};

/**
 * Search (as tests/game/p21-make-movies.mjs searchFight): from a snapshot run every plan for `horizon`
 * frames and keep the best score; deaths and nested NMIs exclude a plan. When none improves, idle.
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
    for (const plan of plans(sim.ram)) {
      sim.restore(snap);
      sim.controller = plan.ctl;
      let sc;
      try {
        sim.runUntil((r) => done(r), plan.horizon ?? horizon);
        sc = score(sim.ram) - Math.max(0, h0 - hearts(sim.ram)) / 64;
      } catch (e) {
        if (!/died/.test(e.message)) throw e;
        sc = -Infinity;
      }
      sim.controller = () => 0;
      if (sc > base && (!best || sc > best.s)) best = { s: sc, snap: sim.snapshot(), tag: plan.tag };
      if (best && done(sim.ram) && sc > -Infinity) break;
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
    let bad = false;
    try { sim.runUntil(done, 24); } catch (e) { if (!/died/.test(e.message)) throw e; bad = true; }
    if (bad) { sim.restore(snap); sim.controller = () => 0; sim.play([[8 + (step % 5), 0]]); }
    sim.controller = () => 0;
  }
  return done(sim.ram);
}

function fight(sim, name, { done, score, plans, idle, maxSteps = 200, horizon = 90, patience = 60 }) {
  const ok = searchFight(sim, { name, done, score, plans, idle, maxSteps, horizon, patience });
  if (!ok) throw new Error(`${name}: not finished`);
  sim.events.push(`${name} f${sim.frame}`);
  P.log(sim, `  ${name}`);
}

function fightTypes(sim, types, name, extra = {}) {
  fight(sim, name, {
    done: allGone(types), score: hpScore(types), plans: swordPlans(types, extra),
    idle: idleAway((r) => { const s = live(types)(r)[0]; return s ? [r[V.ObjX + s], r[V.ObjY + s]] : null; }), ...extra,
  });
  sim.play([[90, 0]]);
}

// Gleeok: the heads (segment 5 of each live neck, in the per-neck arrays) are the targets.
const NECK_X = () => [V.Gleeok_NeckXs0, V.Gleeok_NeckXs1, V.Gleeok_NeckXs2, V.Gleeok_NeckXs3];
const NECK_Y = () => [V.Gleeok_NeckYs0, V.Gleeok_NeckYs1, V.Gleeok_NeckYs2, V.Gleeok_NeckYs3];
const gleeokNecks = (r) => {
  const t = r[V.ObjType + 1];
  if (t < 0x42 || t > 0x45) return [];
  const out = [];
  for (let n = 0; n <= t - 0x42; n++) if (!(r[V.GleeokDeadNeckMask] & (1 << n))) out.push(n);
  return out;
};
const GLEEOK = [0x42, 0x43, 0x44, 0x45, 0x46];
function fightGleeok(sim) {
  const headPos = (n) => (r) => (gleeokNecks(r).includes(n) ? [r[NECK_X()[n] + 5], r[NECK_Y()[n] + 5]] : null);
  const score = (r) => -256 * gleeokNecks(r).length - (gleeokNecks(r).length ? r[V.ObjHP + 5] : 0) - (allGone(GLEEOK)(r) ? 0 : 1);
  const plans = (r) => {
    const out = [];
    for (const n of gleeokNecks(r)) for (const dir of [4, 1, 2]) for (const s of [0, -8, 8]) {
      out.push({ tag: `head ${n} ${dir}/${s}`, ctl: chasePoint(headPos(n), dir, 0x10, s) });
    }
    return out;
  };
  fight(sim, 'gleeok killed', { done: allGone(GLEEOK), score, plans, idle: idleAway(() => [0x78, 0x70]), maxSteps: 300 });
  sim.play([[90, 0]]);
}

// Patra: the children first (they protect it), then Patra.
function fightPatra(sim) {
  const types = [0x25, 0x26, 0x47, 0x48];
  fightTypes(sim, types, 'patra killed', { maxSlots: 4, offsets: [0x10, 0x18], spread: [0, 8], maxSteps: 300 });
}

// Ganon: the sword while blue (invisible), the silver arrow when brown (state <> 0).
function fightGanon(sim) {
  P.selectItem(sim, SLOT_ARROW);
  const slot = () => P.slotsOf(sim.ram, (t) => t === 0x3e)[0];
  const g = slot();
  if (!g) throw new Error('no ganon');
  sim.runUntil((r) => r[V.Ganon_ScenePhase] === 2 && P.playing(r), 900);
  P.log(sim, '  ganon fight begins');
  const pos = (r) => (r[V.ObjType + g] === 0x3e ? [r[V.ObjX + g] + 8, r[V.ObjY + g] + 8] : null);
  const done = (r) => r[V.Ganon_ObjPhase + g] !== 0;
  const score = (r) => (done(r) ? 10000 : 0) + (r[V.ObjState + g] !== 0 ? 1000 : 0) - r[V.ObjHP + g];
  const plans = (r) => {
    const out = [];
    const brown = r[V.ObjState + g] !== 0;
    for (const dir of [1, 2, 4, 8]) for (const s of [0, 8, -8]) {
      out.push({ tag: `${brown ? 'arrow' : 'sword'} ${dir}/${s}`, horizon: brown ? 120 : 90, ctl: chasePoint(pos, dir, brown ? 0x30 : 0x10, s, { useB: brown, every: brown ? 12 : 8 }) });
    }
    return out;
  };
  fight(sim, 'ganon shot with the silver arrow', { done, score, plans, idle: idleAway(pos), maxSteps: 300 });
  sim.runUntil((r) => r[V.Ganon_ObjPhase + g] === 0xff, 600);
  sim.play([[30, 0]]);
  P.log(sim, '  ganon dead');
}

/** Walks onto the room item (the triforce of power) and waits for the fanfare to end. */
function takeRoomItem(sim) {
  const r = sim.ram;
  const [gx, gy] = aligned(r[V.ObjX + 19], r[V.ObjY + 19]);
  sim.controller = P.walkController((x, y) => Math.abs(x - gx) <= 8 && Math.abs(y - gy) <= 8, { sword: false });
  const ok = sim.runUntil((rr) => rr[V.TriforceFanfareActive] !== 0 || rr[V.ObjState + 19] === 0xff && rr[V.InvTriforce] !== sim.ram[V.InvTriforce], 1500);
  sim.controller = () => 0;
  if (!ok) throw new Error('triforce of power not taken');
  sim.runUntil((rr) => rr[V.TriforceFanfareActive] === 0 && P.playing(rr) && rr[V.ObjState] === 0, 1500);
  sim.events.push(`triforce of power f${sim.frame}`);
  sim.play([[30, 0]]);
  P.log(sim, '  triforce of power taken');
}

/** Zelda's room: kill the guard fires, stand in front of Zelda: mode $13. */
function rescueZelda(sim) {
  fightTypes(sim, [0x3f], 'guard fires killed', { maxSlots: 4, offsets: [0x10], spread: [0, 8], maxSteps: 200 });
  sim.controller = P.walkController((x, y) => x === 0x78 && y === 0x95, { sword: false });
  const ok = sim.runUntil((r) => r[V.GameMode] === 0x13, 2400);
  sim.controller = () => 0;
  if (!ok) throw new Error('mode $13 not reached');
  sim.events.push(`zelda rescued (mode $13) f${sim.frame}`);
  P.log(sim, '  zelda rescued');
}

/** The ending and the credits; Start until the second quest begins (a new game in mode 2/3/5). */
function ending(sim) {
  const q0 = sim.o.sram[V.SaveFileAQuestNumber0 - 0x6000];
  // Start every 32 frames (ignored until the credits are over): mode $D saves the second quest, then
  // the title (mode 0) and the file menu (mode 1), where Start picks the file: a new game.
  sim.controller = (r, f) => ([0x13, 0x00, 0x01].includes(r[V.GameMode]) && f % 32 === 0 ? B.T : 0);
  let saved = false;
  const ok = sim.runUntil((r) => {
    if (r[V.GameMode] === 0x0d && !saved) { saved = true; sim.events.push(`credits over, mode $0D f${sim.frame}`); }
    return saved && P.playing(r);
  }, 40000);
  sim.controller = () => 0;
  if (!ok) throw new Error('the ending did not finish');
  P.log(sim, '  after the credits');
  sim.play([[120, 0]]);
  const q1 = sim.o.sram[V.SaveFileAQuestNumber0 - 0x6000];
  sim.events.push(`second quest started (quest ${q0} -> ${q1}, QuestNumbers ${sim.ram[V.QuestNumbers]}) f${sim.frame}`);
  P.log(sim, `  second quest: quest ${q0} -> ${q1}`);
}

// ------------------------------------------------------------------ scenarios

function writeOut(sim, name, comment, expect) {
  const seen = [...sim.seen.keys()].filter((t) => t < 0x53).sort((a, b) => a - b);
  const bosses = seen.filter((t) => t in P22_TYPES);
  P.writeMovie(name, [
    ...comment,
    `Events: ${sim.events.join('; ')}.`,
    `P22 types seen: ${bosses.map((t) => P22_TYPES[t]).join(', ')}.`,
    'Generated by tests/game/p22-make-movies.mjs (closed-loop search on the original game).',
    `Run the oracle with --sram tests/oracle/movies/${SRAM_FILE}.`,
  ], sim.used(), { sram: SRAM_FILE, monsterTypes: seen, bossTypes: bosses, events: sim.events, ...expect });
}

const ITEMS = `tests/oracle/movies/${SRAM_FILE} (every item: silver arrow, red candle, rod, book, raft,`
  + ' boomerangs, magical sword, 16 hearts, the 8 triforce pieces), first quest';

/** Burns the tree object ($64) of this OW room with the candle (fire stops $20 px away), from each side. */
function burnTree(sim) {
  const slot = P.slotsOf(sim.ram, (t) => t === 0x64)[0];
  if (!slot) return false;
  const tx = sim.ram[V.ObjX + slot], ty = sim.ram[V.ObjY + slot];
  P.selectItem(sim, SLOT_CANDLE);
  const snap = sim.snapshot();
  for (const [dir, dx, dy] of [[2, 0x20, 0], [1, -0x20, 0], [8, 0, 0x20], [4, 0, -0x20]]) {
    sim.restore(snap);
    const [gx, gy] = aligned(tx + dx, ty + dy);
    P.walkTo(sim, gx, gy, 600); // even when the walk fails, the fire may reach the tree
    sim.play([[2, DIR_BTN[dir]], [6, 0], [2, B.B], [200, 0]]);
    if (sim.ram[V.ObjType + slot] !== 0x64) { sim.events.push(`tree burnt in ${hex(sim.ram[V.RoomId])} f${sim.frame}`); P.log(sim, '  tree burnt'); return true; }
  }
  sim.restore(snap);
  return false;
}

async function startAt(s, warps, level, name) {
  const sim = await P.startGame(s, 0);
  for (let i = 0; i < warps; i++) P.warp(sim);
  let l = P.enterLevel(sim);
  if (l === null && burnTree(sim)) l = P.enterLevel(sim);
  if (l !== level) throw new Error(`${name}: entered level ${l}`);
  return sim;
}

const SIMPLE = {
  'boss-moldorm': { warps: 1, level: 2, room: 0x3e, types: [0x41], fight: (sim) => fightTypes(sim, [0x41], 'moldorm killed', { maxSlots: 4, offsets: [0x10], spread: [0, 8], maxSteps: 300 }) },
  'boss-gleeok': { warps: 3, level: 4, room: 0x13, types: GLEEOK, fight: fightGleeok },
  'boss-gleeok3': { warps: 5, level: 6, room: 0x18, types: GLEEOK, fight: fightGleeok },
  'boss-gleeok4': { warps: 7, level: 8, room: 0x3c, types: GLEEOK, fight: fightGleeok },
};

async function makeSimple(name) {
  await P.init();
  const sc = SIMPLE[name];
  const s = ensureSram();
  const from = process.env.P22_RESUME;
  let sim;
  if (from) sim = await resume(s, `${name}-${from}`);
  else {
    sim = await startAt(s, sc.warps, sc.level, name);
    save(sim, `${name}-entered`);
  }
  if (from !== 'room') {
    const path = toRoom(sim, sc.room);
    sim.events.push(`room ${hex(sc.room)} via ${path} f${sim.frame}`);
    save(sim, `${name}-room`);
  }
  sim.play([[30, 0]]);
  sc.fight(sim);
  sim.play([[120, 0]]);
  writeOut(sim, name, [`P22: from ${ITEMS}: recorder to level ${sc.level}, rooms to ${hex(sc.room)}, the fight.`],
    { comment: `Boss fight (P22): level ${sc.level}, room ${hex(sc.room)}.`, reaches: { CurLevel: [0, sc.level], RoomId: [sc.room], GameMode: [5] } });
}

// Level 9. The common part: recorder to level 5, Death Mountain, Spectacle Rock bombed, level 9, Patra with
// the big orbit ($52). Then two branches from that checkpoint: 'patra' (Patra with the small orbit, $27)
// and 'ganon' (Ganon right north of $52, the triforce of power, Zelda, the ending and the second quest).
const avoidGanon = (r) => r === 0x42 || r === 0x32;
const L9_COMMON = [
  ['to-l5', (sim) => { for (let i = 0; i < 4; i++) P.warp(sim); }],
  ['to-1d', (sim) => { owRoute(sim, 'SWWWWSEEEEENE'); sim.play([[10, 0]]); }],
  ['shortcut', (sim) => pushRockAndTakeShortcut(sim, 0x23)],
  ['to-05', (sim) => { console.log(`route to $05: ${owSearch(sim, 0x05, (r) => r < 0x50 && (r & 15) < 9)}`); }],
  ['enter-l9', (sim) => { const l = bombRockWallAndEnter(sim); if (l !== 9) throw new Error(`entered level ${l}`); }],
  ['patra-a', (sim) => { toRoom(sim, 0x52, 120, avoidGanon); sim.play([[60, 0]]); fightPatra(sim); }],
];
const L9_BRANCHES = {
  patra: [
    ['patra-b', (sim) => { toRoom(sim, 0x27, 160, avoidGanon); sim.play([[60, 0]]); fightPatra(sim); }],
  ],
  ganon: [
    ['ganon-room', (sim) => { toRoom(sim, 0x42, 10); }],
    ['ganon', (sim) => { fightGanon(sim); }],
    ['triforce', (sim) => { sim.runUntil((r) => r[V.ObjState + 19] !== 0xff && r[V.ObjState + 19] !== 0x80, 600); takeRoomItem(sim); }],
    ['zelda-room', (sim) => { toRoom(sim, 0x32, 20); sim.play([[40, 0]]); }],
    ['zelda', (sim) => rescueZelda(sim)],
    ['ending', (sim) => ending(sim)],
  ],
};

// Movie name -> branch and the step after which it ends.
const L9_MOVIES = {
  'boss-patra': { branch: 'patra', after: 'patra-b', comment: 'level 9: Patra rooms $52 (big orbit) and $27 (small orbit), both killed.', reaches: { CurLevel: [0, 9], GameMode: [5] } },
  'boss-ganon': { branch: 'ganon', after: 'triforce', comment: 'level 9: Patra ($52), Ganon (sword while invisible, silver arrow when brown), the triforce of power.', reaches: { CurLevel: [9], GameMode: [5] } },
  'rescue-zelda': { branch: 'ganon', after: 'zelda', comment: 'level 9: Patra, Ganon, the triforce, the guard fires killed, Zelda: mode $13.', reaches: { CurLevel: [9], GameMode: [5, 0x13] } },
  'ending-from-ganon': { branch: 'ganon', after: 'ending', comment: 'level 9: Patra, Ganon, Zelda, the ending, the credits and the start of the second quest.', reaches: { GameMode: [0x13, 0x0d, 2, 3, 5] } },
};

async function makeL9(branch) {
  await P.init();
  const s = ensureSram();
  const from = process.env.P22_RESUME; // a step name: l9-<step> (common) or l9<b>-<step> (branch)
  const steps = [...L9_COMMON.map(([n, f]) => [n, f, 'l9a']), ...L9_BRANCHES[branch].map(([n, f]) => [n, f, `l9${branch[0]}`])];
  let sim;
  if (from) sim = await resume(s, `${steps.find(([n]) => n === from)[2]}-${from}`);
  else sim = await P.startGame(s, 0);
  let started = !from;
  for (const [name, fn, prefix] of steps) {
    if (!started) { if (name === from) started = true; continue; }
    console.log(`== ${name}`);
    fn(sim);
    save(sim, `${prefix}-${name}`);
    for (const [movie, m] of Object.entries(L9_MOVIES)) {
      if (m.branch !== branch || m.after !== name) continue;
      const snap = sim.snapshot();
      sim.play([[60, 0]]);
      writeOut(sim, movie, [`P22: from ${ITEMS}: recorder to level 5, Death Mountain, Spectacle Rock bombed,`, m.comment],
        { comment: `P22 ${movie}.`, reaches: m.reaches });
      sim.restore(snap);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const what = args[0] ?? 'all';
  if (what === 'sram') { await P.init(); ensureSram(true); return; }
  const all = [...Object.keys(SIMPLE), 'l9-patra', 'l9-ganon'];
  const names = what === 'all' || what === 'check' ? all : args;
  for (const n of names) {
    if (what !== 'check') {
      if (n.startsWith('l9-')) await makeL9(n.slice(3)); else await makeSimple(n);
    }
    const ms = n.startsWith('l9-') ? Object.keys(L9_MOVIES).filter((m) => L9_MOVIES[m].branch === n.slice(3)) : [n];
    for (const m of ms) if (existsSync(join(P.MOVIES, `${m}.zmv`))) await P.check(m);
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });

export { burnTree, toRoom, fightGleeok, fightPatra, fightGanon, takeRoomItem, rescueZelda, ending, resume, save };
void hearts;
