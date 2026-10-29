#!/usr/bin/env node
// Generator of the P19 oracle scenario uw-enemies-a (underworld monsters A). Run:
//   node tests/game/p19-make-movies.mjs [sram|tour|check|all]
//
//  * tests/oracle/movies/p19-items.sav (first quest, slot 1 registered like register-name) and
//    p19-items-q2.sav (second quest: the ZELDA file of register-zelda-q2.zmv): file A gets the WOODEN
//    sword (zols and vires survive a hit and split), bombs, bow + arrows, recorder, red potion, 255
//    rupees, red ring, magic shield, magic key, 16 full hearts and all 8 triforce pieces (the recorder's
//    whirlwind visits the level entrances in turn), checksum fixed. Only the save files
//    ($6000-$652F) are kept: no ROM data. Deterministic.
//  * uw-enemies-a (Q1): recorder to levels 2, 3, 4, 5 and 1 (6, 7, 8 skipped); doorway walks and
//    excursions (from the level data) through rooms with goriyas, ropes, gels, zols (hit -> two gels),
//    darknuts, keeses, flashing bubbles, vires (hit -> two red keeses), like likes, pols voice (recorder,
//    then arrows), gibdos and stalfos, bombing walls and clearing shutters on the way.
//  * uw-enemies-a2 (Q2): level 4 (zol split, a like like eats the magic shield) and level 1 (stalfos
//    throwing sword shots). The Q2 black keese and red/blue bubbles live only in rooms with wizzrobes or
//    in levels whose Q2 entrances the whirlwind does not reach: not in these movies.
//    Rooms with monsters whose code belongs to later packages (wizzrobes, wallmasters, lamnolas,
//    bosses) are avoided: the controller backs out of them (oracle snapshots).
//    The inputs come from a closed-loop controller playing the ORIGINAL game in the oracle (BFS over
//    Link's 8-pixel grid with the port's tile collision), so the movies are reproducible. Checkpoints in
//    out/p19/ (P19_RESUME=n resumes after plan step n); P19_QUEST=0|1 picks one quest.
// The movie is replayed from power-on in the oracle to check it reaches the expected state.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { createMovie, serializeZmv, loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram } from '../../src/core/ram.js';
import * as V from '../../src/core/vars.js';

export const MOVIES = join(import.meta.dirname, '..', 'oracle', 'movies');
export const SRAM_FILE = 'p19-items.sav';
export const MOVIE = 'uw-enemies-a';

const B = { A: 0x80, B: 0x40, S: 0x20, T: 0x10, U: 0x08, D: 0x04, L: 0x02, R: 0x01 };
const DIR_BTN = { 1: B.R, 2: B.L, 4: B.D, 8: B.U };
const DXY = { 1: [8, 0], 2: [-8, 0], 4: [0, 8], 8: [0, -8] };
const OPP = { 1: 2, 2: 1, 4: 8, 8: 4 };
const DOOR = { 8: [0x78, 0x5d], 4: [0x78, 0xbd], 2: [0x20, 0x8d], 1: [0xd0, 0x8d] };
const hex = (v) => `$${v.toString(16).padStart(2, '0')}`;

// P19 monster types (ObjType).
export const P19_TYPES = {
  0x05: 'blue goriya', 0x06: 'red goriya', 0x0b: 'red darknut', 0x0c: 'blue darknut', 0x12: 'vire',
  0x13: 'zol', 0x14: 'gel (from a zol)', 0x15: 'gel', 0x16: 'pols voice', 0x17: 'like like',
  0x1b: 'blue keese', 0x1c: 'red keese', 0x1d: 'black keese', 0x28: 'rope', 0x2a: 'stalfos',
  0x2b: 'flashing bubble', 0x2c: 'blue bubble', 0x2d: 'red bubble', 0x30: 'gibdo',
};
// Types whose port is still a stub (P20, bosses): never stay in a room with them.
const FORBIDDEN = new Set([0x18, 0x23, 0x24, 0x25, 0x26, 0x27, 0x31, 0x32, 0x33, 0x34, 0x37, 0x38, 0x39,
  0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48]);

let rom = null;
let GetCollidingTileMoving = null;
let GetCollidableTileStill = null;
async function init() {
  if (rom) return;
  rom = loadRomFile();
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  ({ GetCollidingTileMoving, GetCollidableTileStill } = await import('../../src/game/movement/tiles.js'));
}

// ------------------------------------------------------------------ emulator with a controller

class Sim {
  constructor(sramInit, inputs = []) {
    this.inputs = [...inputs];
    this.sramInit = sramInit;
    this.controller = () => 0;
    this.seen = new Map(); // type -> first frame
    this.events = [];
  }

  async start() {
    this.o = await Oracle.create({ rom: rom.bytes, sram: this.sramInit, powerOnFill: 0 });
    this.o.handlers.nmi = (n) => {
      if (this.inputs.length < n) this.inputs.push(this.controller(this.o.ram, n) & 0xff);
      this.o.setButtons(this.inputs[n - 1], 0);
    };
    return this;
  }

  get ram() { return this.o.ram; }
  get frame() { return this.o.completedFrames; }

  /** Oracle state (jsnes components, counters, inputs) to come back to. */
  snapshot() {
    const n = this.o.nes;
    return {
      cpu: structuredClone(n.cpu.toJSON()), mmap: structuredClone(n.mmap.toJSON()),
      ppu: structuredClone(n.ppu.toJSON()), papu: structuredClone(n.papu.toJSON()),
      c: this.o.completedFrames, nmi: this.o.nmiCount, v: this.o.videoFrames, bank: this.o.prgBank,
      p1: this.o.p1, inputs: this.inputs.slice(0, this.o.nmiCount), seen: new Map(this.seen),
      events: [...this.events],
    };
  }

  restore(s) {
    const n = this.o.nes;
    n.cpu.fromJSON(s.cpu);
    n.mmap.fromJSON(s.mmap);
    n.ppu.fromJSON(s.ppu);
    n.papu.fromJSON(s.papu);
    this.o.completedFrames = s.c;
    this.o.nmiCount = s.nmi;
    this.o.videoFrames = s.v;
    this.o.prgBank = s.bank;
    this.o.setButtons(s.p1 ?? 0, 0);
    this.inputs = s.inputs.slice();
    this.seen = new Map(s.seen);
    this.events = [...s.events];
  }

  runUntil(done, max) {
    const end = this.frame + max;
    while (this.frame < end) {
      if (done(this.o.ram, this.frame)) return true;
      const f = this.frame;
      let guard = 0;
      while (this.frame === f) {
        this.o.nes.frame();
        if (++guard > 20) throw new Error('emulator stuck');
      }
      const r = this.o.ram;
      for (let i = 1; i < 0x0c; i++) {
        const t = r[V.ObjType + i];
        if (t && !this.seen.has(t)) this.seen.set(t, this.frame);
      }
      if (r[V.GameMode] === 0x11) throw new Error(`Link died in room ${hex(r[V.RoomId])}`);
    }
    return done(this.o.ram, this.frame);
  }

  play(runs) {
    const inputs = expand(runs);
    const base = this.frame;
    this.controller = (r, n) => inputs[n - 1 - base] ?? 0;
    this.runUntil(() => false, inputs.length);
    this.controller = () => 0;
  }

  used() { return this.inputs.slice(0, this.frame); }
}

function expand(runs) {
  const out = [];
  for (const [n, b] of runs) for (let i = 0; i < n; i++) out.push(b);
  return out;
}

// ------------------------------------------------------------------ grid planning (port collision)

let cur = null;

// Optional override (tests/game/p20-make-movies.mjs: crossing one water tile with the ladder).
const hooks = { walkable: null };

function walkable(x, y, d) {
  ram[V.ObjX] = x;
  ram[V.ObjY] = y;
  ram[0x0f] = d;
  const t = GetCollidingTileMoving(0);
  const ok = t < ram[V.ObjectFirstUnwalkableTile];
  return hooks.walkable ? hooks.walkable(x, y, d, t, ok) : ok;
}

function rawTileStill(x, y) {
  const lvl = ram[V.CurLevel];
  ram[V.CurLevel] = 1;
  ram[V.ObjX] = x;
  ram[V.ObjY] = y;
  const t = GetCollidableTileStill(0);
  ram[V.CurLevel] = lvl;
  return t;
}

// $24/$88 are entrances only in the OW ($24 is also the floor of some UW rooms, e.g. level 9).
const isWarpTile = (t) => (ram[V.CurLevel] === 0 && (t === 0x24 || t === 0x88)) || (t >= 0x70 && t < 0x74);
const X0 = 0x00, X1 = 0xf0, Y0 = 0x3d, Y1 = 0xdd;
const inside = (x, y) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;

function planStep(sx, sy, goal, { blocked = new Set(), allowWarp = false } = {}) {
  const key = (x, y) => (x << 8) | y;
  if (goal(sx, sy)) return -1;
  const first = new Map([[key(sx, sy), 0]]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const d of [8, 4, 2, 1]) {
      const [dx, dy] = DXY[d];
      const nx = x + dx, ny = y + dy;
      if (!inside(nx, ny)) continue;
      const k = key(nx, ny);
      if (first.has(k) || blocked.has(`${x},${y},${d}`)) continue;
      if (!walkable(x, y, d)) continue;
      if (!allowWarp && !goal(nx, ny) && isWarpTile(rawTileStill(nx, ny))) continue;
      first.set(k, first.get(key(x, y)) || d);
      if (goal(nx, ny)) return first.get(k);
      q.push([nx, ny]);
    }
  }
  return 0;
}

const isMonster = (t) => t !== 0 && t < 0x53 && t !== 0x2e && t !== 0x2f && t !== 0x29 && !(t >= 0x49 && t <= 0x52);

function monsterNear(r, x, y, dist = 0x20) {
  for (let i = 1; i < 0x0c; i++) {
    if (!isMonster(r[V.ObjType + i]) || r[V.ObjMetastate + i] !== 0) continue;
    if (Math.abs(r[V.ObjX + i] - x) < dist && Math.abs(r[V.ObjY + i] - y) < dist) return true;
  }
  return false;
}

/** Walks to a grid point satisfying goal() (then holds finalDir), swinging the sword at monsters. */
function walkController(goal, { finalDir = 0, sword = true, allowWarp = false } = {}) {
  const blocked = new Set();
  let last = null, still = 0, lastDir = 0, arrived = false;
  const ctl = (r, frame) => {
    ctl.arrived = arrived;
    if (r[V.GameMode] !== 5 || r[V.IsUpdatingMode] === 0) return 0;
    if (sword && frame % 16 === 0 && monsterNear(r, r[V.ObjX], r[V.ObjY])) { lastDir = 0; return B.A; }
    if (arrived && finalDir) return DIR_BTN[finalDir];
    if (r[V.ObjShoveDir] !== 0) return 0;
    const x = r[V.ObjX], y = r[V.ObjY];
    const pos = `${x},${y}`;
    if (pos === last && lastDir) {
      if (++still > 24) { blocked.add(`${x},${y},${lastDir}`); still = 0; }
    } else { still = 0; }
    last = pos;
    if (r[V.ObjGridOffset] !== 0) {
      // Between squares: keep going, or turn back if stuck (e.g. pushed into a wall).
      lastDir = r[V.ObjDir];
      return DIR_BTN[still > 8 ? OPP[r[V.ObjDir]] : r[V.ObjDir]] ?? 0;
    }
    // Off the 8-pixel grid (e.g. moved while swallowed by a like like): step back onto it.
    if (((y - 5) & 7) !== 0) { lastDir = 0; return ((y - 5) & 7) < 4 ? B.U : B.D; }
    if ((x & 7) !== 0) { lastDir = 0; return (x & 7) < 4 ? B.L : B.R; }
    ram.set(r);
    sram.set(cur.o.sram);
    const d = planStep(x, y, goal, { blocked, allowWarp });
    if (d === -1) { arrived = true; ctl.arrived = true; lastDir = finalDir; return finalDir ? DIR_BTN[finalDir] : 0; }
    lastDir = d;
    return d ? DIR_BTN[d] : 0;
  };
  return ctl;
}

const playing = (r) => r[V.GameMode] === 5 && r[V.IsUpdatingMode] !== 0;

function walkTo(sim, gx, gy, max = 900) {
  sim.controller = walkController((x, y) => x === gx && y === gy);
  const ok = sim.runUntil((r) => playing(r) && r[V.ObjX] === gx && r[V.ObjY] === gy && r[V.ObjGridOffset] === 0, max);
  sim.controller = () => 0;
  return ok;
}

function selectItem(sim, slot) {
  if (sim.ram[V.SelectedItemSlot] === slot) return;
  sim.play([[2, B.T], [90, 0]]);
  for (let i = 0; i < 10 && sim.ram[V.SelectedItemSlot] !== slot; i++) sim.play([[2, B.R], [12, 0]]);
  if (sim.ram[V.SelectedItemSlot] !== slot) throw new Error(`selectItem(${slot}) failed`);
  sim.play([[2, B.T], [90, 0]]);
  if (!playing(sim.ram)) throw new Error('selectItem: not back in mode 5');
}

const SLOT_BOMB = 1, SLOT_ARROW = 2, SLOT_RECORDER = 5, SLOT_POTION = 7;

/** Drinks the potion when Link has fewer than 5 full hearts. */
function heal(sim) {
  const r = sim.ram;
  if (!playing(r) || (r[V.HeartValues] & 0x0f) >= 4 || r[V.Potion] === 0) return;
  selectItem(sim, SLOT_POTION);
  sim.play([[2, B.B], [4, 0]]);
  sim.runUntil((rr) => playing(rr) && (rr[V.HeartValues] & 0x0f) === (rr[V.HeartValues] >> 4), 900);
  sim.play([[20, 0]]);
  sim.events.push(`potion f${sim.frame}`);
  log(sim, '  healed');
}

// ------------------------------------------------------------------ SRAM with items

const prefixMenu = () => [[120, 0], [2, B.T], [90, 0]];

function registerRuns() {
  const r = [...prefixMenu(), [2, B.T], [90, 0]];
  for (let i = 0; i < 5; i++) r.push([2, B.A], [6, 0]);
  for (let i = 0; i < 3; i++) r.push([2, B.S], [8, 0]);
  r.push([2, B.T], [90, 0]);
  return r;
}

export const SRAM_FILE2 = 'p19-items-q2.sav';

/** Inputs that leave a registered file in slot 1 and the menu open: "AAAAA" (Q1) or "ZELDA" (Q2). */
function registerInputs(quest) {
  if (!quest) return expand(registerRuns());
  // register-zelda-q2.zmv up to the frame it is back in the menu (mode 1 after mode $E).
  const m = loadMovie(join(MOVIES, 'register-zelda-q2.zmv'));
  return [...m.p1];
}

export async function makeItemsSram(quest = 0) {
  await init();
  const inputs = registerInputs(quest);
  const sim = await new Sim(null, inputs).start();
  let wasE = false;
  sim.runUntil((r) => {
    if (r[V.GameMode] === 0x0e) wasE = true;
    return wasE && r[V.GameMode] === 1 && r[V.IsUpdatingMode] !== 0;
  }, inputs.length);
  sim.runUntil(() => false, 30);
  const s = Uint8Array.from(sim.o.sram);
  s.fill(0, 0x530); // keep only the save files: no ROM-derived bytes
  if (s[V.SaveFileAQuestNumber0 - 0x6000] !== quest) throw new Error(`SRAM: quest ${s[V.SaveFileAQuestNumber0 - 0x6000]}`);
  const set = (v, value) => {
    const i = V.SaveFileAItems0 - 0x6000 + (v - V.Items);
    const delta = value - s[i];
    s[i] = value;
    let sum = (s[V.FileAChecksums - 0x6000] << 8) | s[V.FileAChecksums - 0x6000 + 1];
    sum = (sum + delta) & 0xffff;
    s[V.FileAChecksums - 0x6000] = sum >> 8;
    s[V.FileAChecksums - 0x6000 + 1] = sum & 0xff;
  };
  set(V.Items, 1); // wooden sword: zols ($20 HP) and vires ($40) survive a hit and split
  set(V.InvBombs, 8);
  set(V.MaxBombs, 8);
  set(V.InvArrow, 1);
  set(V.Bow, 1);
  set(V.InvCandle + 1, 1); // recorder ($065C)
  set(V.InvRing, 2); // red ring
  set(V.InvMagicKey, 1);
  set(V.InvMagicShield, 1);
  set(V.InvRupees, 0xff);
  set(V.HeartValues, 0xff); // 16 heart containers, all filled
  set(V.HeartPartial, 0xff);
  set(V.InvTriforce, 0xff); // the whirlwind visits every level
  set(V.Potion, 2); // red potion: two refills
  return s;
}

async function ensureItemsSram(quest, force = false) {
  const file = quest ? SRAM_FILE2 : SRAM_FILE;
  const path = join(MOVIES, file);
  if (!force && existsSync(path)) return new Uint8Array(readFileSync(path));
  const s = await makeItemsSram(quest);
  writeFileSync(path, s);
  console.log(`wrote ${file}`);
  return s;
}

async function startGame(sramInit, quest) {
  const sim = await new Sim(sramInit, expand([...prefixMenu(), [2, B.T], [240, 0]])).start();
  cur = sim;
  sim.runUntil(() => false, sim.inputs.length);
  const r = sim.ram;
  if (r[V.GameMode] !== 5 || r[V.RoomId] !== 0x77) throw new Error(`start: mode ${r[V.GameMode]} room ${r[V.RoomId]}`);
  if (r[V.InvTriforce] !== 0xff) throw new Error('start: SRAM edit rejected?');
  if (r[V.QuestNumbers] !== quest) throw new Error(`start: quest ${r[V.QuestNumbers]}`);
  return sim;
}

// ------------------------------------------------------------------ tour steps

function log(sim, tag) {
  const r = sim.ram;
  const objs = [];
  for (let i = 1; i < 0x0c; i++) if (r[V.ObjType + i]) objs.push(r[V.ObjType + i].toString(16));
  console.log(`${tag} f${sim.frame}: L${r[V.CurLevel]} room ${hex(r[V.RoomId])} link (${hex(r[V.ObjX])},${hex(r[V.ObjY])}) hp ${hex(r[V.HeartValues])}/${hex(r[V.HeartPartial])} objs ${objs.join(',')}`);
}

/** Walks out of the current OW room through edge d (BFS to the edge, then holds d). */
function exitRoomOW(sim, d, max = 1500) {
  const room = sim.ram[V.RoomId];
  const atEdge = (x, y) => (d === 2 ? x === X0 : d === 1 ? x === X1 : d === 8 ? y === Y0 : y === Y1);
  sim.controller = walkController(atEdge, { finalDir: d });
  const ok = sim.runUntil((r) => playing(r) && r[V.RoomId] !== room, max);
  sim.controller = () => 0;
  return ok;
}

/** Recorder: wait until the whirlwind drops Link in the next level's entrance room. */
function warp(sim) {
  for (let attempt = 0; attempt < 4; attempt++) {
    selectItem(sim, SLOT_RECORDER);
    // AdvanceTeleportingLevelIndex goes to the next level only facing right or up.
    if (!(sim.ram[V.ObjDir] & 0x09)) sim.play([[3, B.R], [10, 0]]);
    if (!(sim.ram[V.ObjDir] & 0x09)) sim.play([[3, B.U], [10, 0]]);
    const room = sim.ram[V.RoomId];
    const snap = sim.snapshot();
    sim.play([[2, B.B], [2, 0]]);
    const ok = sim.runUntil((r) => playing(r) && r[V.RoomId] !== room && r[V.WhirlwindTeleportingState] === 0
      && r[V.ObjState] === 0, 1500);
    if (ok) {
      sim.play([[30, 0]]);
      log(sim, 'warped');
      return;
    }
    // A recorder-secret room (no whirlwind there): go to a neighbouring room first.
    sim.restore(snap);
    console.log(`  no whirlwind in ${hex(room)}: leaving the room`);
    if (![4, 2, 1, 8].some((d) => { const sn = sim.snapshot(); if (exitRoomOW(sim, d)) return true; sim.restore(sn); return false; })) {
      throw new Error(`warp from ${hex(room)} failed`);
    }
    sim.play([[20, 0]]);
  }
  throw new Error('warp failed');
}

/** Walk onto the level entrance of this OW room and wait until playing in the level. */
function enterLevel(sim) {
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const targets = [];
  for (let x = X0; x <= X1; x += 8) for (let y = Y0; y <= Y1; y += 8) if (isWarpTile(rawTileStill(x, y))) targets.push([x, y]);
  if (!targets.length) return null; // hidden entrance (second quest): the caller skips this level
  const set = new Set(targets.map(([x, y]) => `${x},${y}`));
  const snap = sim.snapshot();
  sim.controller = walkController((x, y) => set.has(`${x},${y}`), { finalDir: 8, allowWarp: true, sword: false });
  const ok = sim.runUntil((r) => r[V.CurLevel] !== 0 && playing(r), 2400);
  sim.controller = () => 0;
  if (!ok) {
    log(sim, '  entry failed');
    sim.restore(snap);
    return null;
  }
  sim.play([[20, 0]]);
  log(sim, 'entered');
  return sim.ram[V.CurLevel];
}

const roomHasForbidden = (r) => {
  for (let i = 1; i < 0x0c; i++) if (FORBIDDEN.has(r[V.ObjType + i])) return true;
  return false;
};

/** Through doorway d; null if blocked/forbidden (state restored), -1 if it left the level. */
function goThrough(sim, d, max = 900) {
  const snap = sim.snapshot();
  const room = sim.ram[V.RoomId];
  const level = sim.ram[V.CurLevel];
  const [gx, gy] = DOOR[d];
  sim.controller = walkController((x, y) => x === gx && y === gy, { finalDir: d });
  const ok = sim.runUntil((r) => playing(r) && (r[V.RoomId] !== room || r[V.CurLevel] !== level), max);
  sim.controller = () => 0;
  if (!ok) { sim.restore(snap); return null; }
  if (sim.ram[V.CurLevel] !== level) return -1;
  // Let the monsters appear (their types are set when the room is entered).
  if (roomHasForbidden(sim.ram)) { sim.restore(snap); return 'forbidden'; }
  return sim.ram[V.RoomId];
}

/** Walk the level's rooms through two-way doorways, greedily towards new rooms. */
function exploreLevel(sim, { maxRooms = 14, maxFrames = 9000, want = () => false, onRoom = () => {}, stay = false } = {}) {
  const start = sim.ram[V.RoomId];
  const t0 = sim.frame;
  const edges = new Map();
  const ed = (r) => edges.get(r) ?? edges.set(r, {}).get(r);
  const visited = new Set([start]);
  onRoom(sim);
  const untried = (r) => [8, 2, 1, 4].filter((d) => !(d in ed(r)) && !(r === start && d === 4));
  const pathTo = (from, ok) => {
    const prev = new Map([[from, null]]);
    const q = [from];
    while (q.length) {
      const r = q.shift();
      if (ok(r)) {
        const dirs = [];
        for (let c = r; prev.get(c); c = prev.get(c).from) dirs.unshift(prev.get(c).d);
        return dirs;
      }
      for (const [d, to] of Object.entries(ed(r))) {
        if (typeof to !== 'number' || to < 0 || prev.has(to)) continue;
        prev.set(to, { from: r, d: Number(d) });
        q.push(to);
      }
    }
    return null;
  };
  // Walks along known edges to the first room satisfying ok(); retries a doorway, else reroutes.
  const walkTo = (ok) => {
    for (let guard = 0; guard < 40; guard++) {
      const room = sim.ram[V.RoomId];
      if (ok(room)) return true;
      const p = pathTo(room, ok);
      if (!p || !p.length) return false;
      const d = p[0];
      let to = null;
      for (let k = 0; k < 3 && (typeof to !== 'number' || to < 0); k++) to = goThrough(sim, d, 1500);
      if (typeof to !== 'number' || to < 0) {
        console.log(`  known edge ${hex(room)} dir ${d} failed: ${to}`);
        ed(room)[d] = 'broken';
      }
    }
    return false;
  };
  const walk = (dirs) => {
    const room = sim.ram[V.RoomId];
    let r = room;
    for (const d of dirs) r = ed(r)[d];
    if (!walkTo((x) => x === r)) throw new Error(`cannot walk from ${hex(room)} to ${hex(r)}`);
  };
  while (visited.size < maxRooms && sim.frame - t0 < maxFrames && !want()) {
    const room = sim.ram[V.RoomId];
    const u = untried(room);
    if (!u.length) {
      if (!walkTo((r) => untried(r).length > 0)) break;
      continue;
    }
    const d = u[0];
    const snap = sim.snapshot();
    const to = goThrough(sim, d);
    if (typeof to !== 'number' || to < 0) {
      ed(room)[d] = to;
      if (to === -1) sim.restore(snap);
      console.log(`  ${hex(room)} dir ${d}: ${to === -1 ? 'leaves' : to ?? 'blocked'}`);
      continue;
    }
    const isNew = !visited.has(to);
    if (isNew) onRoom(sim);
    const back = goThrough(sim, OPP[d]);
    if (back !== room) {
      console.log(`  ${hex(room)} -${d}-> ${hex(to)}: one way`);
      sim.restore(snap);
      ed(room)[d] = 'oneway';
      continue;
    }
    ed(room)[d] = to;
    ed(to)[OPP[d]] = room;
    visited.add(to);
    console.log(`  ${hex(room)} <-${d}-> ${hex(to)}${isNew ? ' new' : ''} f${sim.frame}`);
    // Continue from the new room: go there again.
    if (isNew) walk([d]);
  }
  // Back to the entrance and out of the level.
  if (!walkTo((r) => r === start)) throw new Error('no way back to the entrance');
  if (!stay) leaveLevel(sim);
  return visited;
}

// ------------------------------------------------------------------ special interactions

const slotsOf = (r, pred) => {
  const s = [];
  for (let i = 1; i < 0x0c; i++) if (pred(r[V.ObjType + i]) && r[V.ObjMetastate + i] === 0) s.push(i);
  return s;
};

/** Chases the first live monster of `types`, swinging the sword next to it, until done() or max. */
function hunt(sim, types, done, max = 900) {
  let target = null;
  let inner = null;
  let gk = '';
  sim.controller = (r, f) => {
    if (!playing(r)) return 0;
    const s = slotsOf(r, (t) => types.includes(t));
    if (!s.length) return 0;
    target = s[0];
    const tx = (r[V.ObjX + target] + 4) & 0xf8, ty = ((r[V.ObjY + target] & 0xf8) | 0x05);
    if (Math.abs(r[V.ObjX + target] - r[V.ObjX]) < 0x14 && Math.abs(r[V.ObjY + target] - r[V.ObjY]) < 0x14) {
      // Face it and swing.
      const dx = r[V.ObjX + target] - r[V.ObjX], dy = r[V.ObjY + target] - r[V.ObjY];
      const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 2) : (dy > 0 ? 4 : 8);
      if (r[V.ObjDir] !== d && r[V.ObjGridOffset] === 0) return DIR_BTN[d];
      return f % 8 === 0 ? B.A : 0;
    }
    const key = `${tx},${ty}`;
    if (key !== gk) {
      gk = key;
      inner = walkController((x, y) => Math.abs(x - tx) <= 8 && Math.abs(y - ty) <= 8, { sword: false });
    }
    return inner(r, f);
  };
  const ok = sim.runUntil(done, max);
  sim.controller = () => 0;
  return ok;
}

/** Fires arrows at a pols voice when aligned with it. */
function shootPols(sim, max = 1500) {
  selectItem(sim, SLOT_ARROW);
  let inner = null, gk = '';
  sim.controller = (r, f) => {
    if (!playing(r)) return 0;
    const s = slotsOf(r, (t) => t === 0x16);
    if (!s.length) return 0;
    const i = s[0];
    const dx = r[V.ObjX + i] - r[V.ObjX], dy = r[V.ObjY + i] - r[V.ObjY];
    if (r[V.ObjGridOffset] === 0 && (Math.abs(dx) < 6 || Math.abs(dy) < 6)) {
      const d = Math.abs(dx) < 6 ? (dy > 0 ? 4 : 8) : (dx > 0 ? 1 : 2);
      if (r[V.ObjDir] !== d) return DIR_BTN[d];
      return f % 12 === 0 ? B.B : 0;
    }
    // Walk to the pols voice's column.
    const tx = (r[V.ObjX + i] + 4) & 0xf0;
    const key = `${tx}`;
    if (key !== gk) { gk = key; inner = walkController((x) => x === tx, { sword: true }); }
    return inner(r, f);
  };
  const ok = sim.runUntil((r) => slotsOf(r, (t) => t === 0x16).length === 0, max);
  sim.controller = () => 0;
  return ok;
}

/** Lets a like like swallow Link until the magic shield is gone, then kills it. */
function feedLikeLike(sim, max = 2400) {
  let inner = null, gk = '';
  sim.controller = (r, f) => {
    if (!playing(r)) return 0;
    const s = slotsOf(r, (t) => t === 0x17);
    if (!s.length) return 0;
    const i = s[0];
    if (r[V.ObjCaptureTimer + i] !== 0) return r[V.InvMagicShield] === 0 && f % 8 === 0 ? B.A : 0;
    const tx = (r[V.ObjX + i] + 4) & 0xf8, ty = (r[V.ObjY + i] & 0xf8) | 0x05;
    const key = `${tx},${ty}`;
    if (key !== gk) { gk = key; inner = walkController((x, y) => Math.abs(x - tx) <= 8 && Math.abs(y - ty) <= 8, { sword: false }); }
    const b = inner(r, f);
    if (inner.arrived) return DIR_BTN[Math.abs(r[V.ObjX + i] - r[V.ObjX]) > Math.abs(r[V.ObjY + i] - r[V.ObjY])
      ? (r[V.ObjX + i] > r[V.ObjX] ? 1 : 2) : (r[V.ObjY + i] > r[V.ObjY] ? 4 : 8)];
    return b;
  };
  const ok = sim.runUntil((r) => r[V.InvMagicShield] === 0 && slotsOf(r, (t) => t === 0x17).length === 0
    && r[V.LinkParalyzed] === 0, max);
  sim.controller = () => 0;
  return ok;
}

/** In-room actions when entering a new room. */
function makeOnRoom(state) {
  return (sim) => {
    sim.play([[40, 0]]);
    heal(sim);
    const r = sim.ram;
    log(sim, '  room');
    const has = (t) => slotsOf(r, (x) => x === t).length > 0;
    const snap = sim.snapshot();
    try {
      if (!state.zolSplit && has(0x13)) {
        if (hunt(sim, [0x13], (rr) => slotsOf(rr, (t) => t === 0x14).length > 0, 1200)) {
          state.zolSplit = sim.frame;
          sim.events.push(`zol split f${sim.frame}`);
          console.log(`  zol split at f${sim.frame}`);
          hunt(sim, [0x14, 0x15], (rr) => slotsOf(rr, (t) => t === 0x14 || t === 0x15).length === 0, 600);
        } else sim.restore(snap);
      } else if (!state.vireSplit && has(0x12)) {
        if (hunt(sim, [0x12], (rr) => sim.seen.has(0x1c) && slotsOf(rr, (t) => t === 0x1c).length > 0, 1500)) {
          state.vireSplit = sim.frame;
          sim.events.push(`vire split f${sim.frame}`);
          console.log(`  vire split at f${sim.frame}`);
          sim.play([[120, 0]]);
        } else sim.restore(snap);
      } else if (!state.likeLike && has(0x17)) {
        if (feedLikeLike(sim)) {
          state.likeLike = sim.frame;
          sim.events.push(`like like ate the shield f${sim.frame}`);
          console.log(`  like like ate the shield at f${sim.frame}`);
        } else sim.restore(snap);
      } else if (state.quest && !state.stalfosShot && has(0x2a)) {
        // Second quest: stalfos stop and throw sword shots ($57).
        const shot = (rr) => { for (let i = 1; i < 0x0c; i++) if (rr[V.ObjType + i] === 0x57) return true; return false; };
        sim.controller = walkController((x, y) => x === 0x78 && y === 0x8d);
        if (sim.runUntil(shot, 1500)) {
          state.stalfosShot = sim.frame;
          sim.events.push(`stalfos sword shot f${sim.frame}`);
          console.log(`  stalfos shot at f${sim.frame}`);
          sim.runUntil(() => false, 200);
        }
        sim.controller = () => 0;
      } else if (!state.pols && has(0x16)) {
        // The recorder in the room (UsedFlute), then arrows.
        selectItem(sim, SLOT_RECORDER);
        sim.play([[2, B.B], [200, 0]]);
        if (shootPols(sim)) {
          state.pols = sim.frame;
          sim.events.push(`pols voice shot f${sim.frame}`);
          console.log(`  pols voice killed with arrows at f${sim.frame}`);
        } else sim.restore(snap);
      } else {
        // Stay a little: the monsters walk, shoot (goriyas) and fight.
        sim.controller = walkController((x, y) => x === 0x78 && y === 0x8d);
        sim.runUntil(() => false, 240);
        sim.controller = () => 0;
      }
    } catch (e) {
      if (!/died/.test(e.message)) throw e;
      sim.restore(snap);
    }
    if (!playing(sim.ram)) sim.runUntil(playing, 300);
  };
}

// ------------------------------------------------------------------ output

function writeMovie(name, comment, inputs, expect) {
  const m = createMovie(Uint8Array.from(inputs), null, { name });
  const text = serializeZmv(m).replace(/^zmv 1\n/, `zmv 1\n${comment.map((c) => `# ${c}`).join('\n')}\n`);
  writeFileSync(join(MOVIES, `${name}.zmv`), text);
  writeFileSync(join(MOVIES, `${name}.expect.json`), `${JSON.stringify(expect, null, 2)}\n`);
  console.log(`wrote ${name}.zmv (${inputs.length} frames)`);
}

export async function check(name = MOVIE) {
  await init();
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  const s = new Uint8Array(readFileSync(join(MOVIES, expect.sram)));
  const o = await Oracle.create({ rom: rom.bytes, sram: s, powerOnFill: 0 });
  const seen = {};
  for (const k of Object.keys(expect.reaches)) seen[k] = new Set();
  const types = new Set();
  o.run(loadMovie(join(MOVIES, `${name}.zmv`)), {
    write(rec) {
      for (const k of Object.keys(expect.reaches)) seen[k].add(rec.ram[V[k]]);
      for (let i = 1; i < 0x0c; i++) types.add(rec.ram[V.ObjType + i]);
    },
  });
  for (const [k, vals] of Object.entries(expect.reaches)) {
    for (const v of [].concat(vals)) if (!seen[k].has(v)) throw new Error(`${name}: ${k} never reaches ${v}`);
  }
  for (const t of expect.monsterTypes ?? []) if (!types.has(t)) throw new Error(`${name}: no monster of type $${t.toString(16)}`);
  for (const t of types) if (FORBIDDEN.has(t)) throw new Error(`${name}: forbidden type $${t.toString(16)}`);
  console.log(`${name}: expectations OK`);
}

// ------------------------------------------------------------------ smart doorways and excursions

/** Door type of direction d in the current UW room (0 open, 1 wall, 4 bombable, 5/6 locked, 7 shutter). */
function doorType(sim, d) {
  const room = sim.ram[V.RoomId];
  const A = sim.o.sram[V.LevelBlockAttrsA - 0x6000 + room], Bb = sim.o.sram[V.LevelBlockAttrsB - 0x6000 + room];
  return { 8: A >> 5, 4: (A >> 2) & 7, 2: Bb >> 5, 1: (Bb >> 2) & 7 }[d];
}

// Shutters open when the room is cleared; bubbles (invincible, they block the sword) are left alone.
const allMonsters = (r) => slotsOf(r, (t) => isMonster(t) && !(t >= 0x2b && t <= 0x2d));

/** Through doorway d, bombing a bombable wall or clearing the room for a shutter when needed. */
function goSmart(sim, d) {
  for (let attempt = 0; attempt < 4; attempt++) {
    heal(sim);
    const to = goThrough(sim, d, 1500);
    if (typeof to === 'number' && to >= 0) return to;
    if (to === 'forbidden' || to === -1) return to;
    const t = doorType(sim, d);
    console.log(`  ${hex(sim.ram[V.RoomId])} dir ${d} (door type ${t}) blocked, attempt ${attempt}: paralyzed ${sim.ram[V.LinkParalyzed]} shove ${hex(sim.ram[V.ObjShoveDir])}/${hex(sim.ram[V.ObjShoveDistance])} grid ${hex(sim.ram[V.ObjGridOffset])} dir ${sim.ram[V.ObjDir]} input ${hex(sim.inputs[sim.frame - 1] ?? 0)} state ${hex(sim.ram[V.ObjState])} mode ${sim.ram[V.GameMode]}`);
    log(sim, '   ');
    if (t === 4) {
      const [gx, gy] = DOOR[d];
      if (!walkTo(sim, gx, gy, 1500)) continue;
      selectItem(sim, SLOT_BOMB);
      sim.play([[2, DIR_BTN[d]], [4, 0], [2, B.B], [4, 0]]);
      // Step back out of the blast and wait for it.
      walkTo(sim, 0x78, 0x8d, 600);
      sim.runUntil(() => false, 120);
    } else if (t === 7 || t === 0) {
      hunt(sim, [...new Set(allMonsters(sim.ram).map((i) => sim.ram[V.ObjType + i]))],
        (r) => allMonsters(r).length === 0, 3000);
      sim.runUntil(() => false, 90);
    }
  }
  return null;
}

/** Follows `route` (N/S/E/W letters) from the current room with in-room actions, then comes back. */
function excursion(sim, route, onRoom) {
  const L = { N: 8, S: 4, W: 2, E: 1 };
  const done = [];
  for (const c of route) {
    const to = goSmart(sim, L[c]);
    if (typeof to !== 'number' || to < 0) { console.log(`  excursion ${route}: stopped at ${c} (${to})`); break; }
    done.push(L[c]);
    console.log(`  -> ${hex(to)} f${sim.frame}`);
    onRoom(sim);
  }
  for (const d of done.reverse()) {
    const to = goSmart(sim, OPP[d]);
    if (typeof to !== 'number' || to < 0) throw new Error(`excursion ${route}: cannot come back (${to})`);
  }
}

/** Leaves the level by the bottom of its entrance room (the current room). */
function leaveLevel(sim) {
  const out = goThrough(sim, 4, 1500);
  if (out !== -1) throw new Error(`leaving the level: ${out}`);
  sim.runUntil((r) => playing(r) && r[V.CurLevel] === 0, 600);
  sim.play([[30, 0]]);
  log(sim, 'out');
}

// ------------------------------------------------------------------ scenario

// Plans per quest, in whirlwind order (L2, L3, ...). explore: greedy doorway walk; routes: excursions
// from the entrance (from the level data: the rooms of the monsters still missing).
const PLANS = {
  0: [
    { level: 2, explore: true },
    { level: 3, explore: true },
    { level: 4, explore: true, maxRooms: 8, routes: ['NNWNNEE'] }, // vire; $32 like like
    { level: 5, routes: ['E', 'NWW'] }, // $77 pols voice; $66 gibdo, $64 blue darknut
    { level: 6, skip: true },
    { level: 7, skip: true },
    { level: 8, skip: true },
    { level: 1, routes: ['N'] }, // $63 stalfos
  ],
  // Second quest: the whirlwind still lands in the first quest's entrance rooms; the level entered
  // there is read from CurLevel and its routes are taken from ROUTES_Q2 (none: leave at once).
  1: Array.from({ length: Number(process.env.P19_Q2_WARPS ?? 8) }, () => ({ level: null, byLevel: true })),
};

const ROUTES_Q2 = {
  1: ['NN'], // $57: stalfos that throw sword shots (second quest only)
  4: ['NW'], // $62 zol (split), $61 like likes
  // (The black keese and the red/blue bubbles of the second quest are only in rooms with wizzrobes or
  // in levels whose entrances are hidden in the second quest: not reachable by this tour.)
};

const CKPT = join(import.meta.dirname, '..', '..', 'out', 'p19');

async function makeTour(quest) {
  const s = await ensureItemsSram(quest);
  let sim = await startGame(s, quest);
  let state = { quest };
  let levels = [];
  let first = 0;
  const resume = process.env.P19_RESUME;
  if (resume !== undefined) {
    const c = JSON.parse(readFileSync(join(CKPT, `q${quest}-step${resume}.json`), 'utf8'));
    sim = await new Sim(s, c.inputs).start();
    cur = sim;
    sim.runUntil(() => false, c.inputs.length);
    sim.events = c.events;
    state = c.state;
    levels = c.levels;
    first = Number(resume) + 1;
    console.log(`resumed after step ${resume} at f${sim.frame}`);
  }
  const onRoom = makeOnRoom(state);
  if (process.env.P19_SCAN) {
    for (let i = 0; i < 8; i++) {
      warp(sim);
      ram.set(sim.ram);
      sram.set(sim.o.sram);
      const t = [];
      for (let x = X0; x <= X1; x += 8) for (let y = Y0; y <= Y1; y += 8) if (isWarpTile(rawTileStill(x, y))) t.push(`${hex(x)},${hex(y)}`);
      console.log(`warp ${i}: room ${hex(sim.ram[V.RoomId])} index ${sim.ram[V.TeleportingLevelIndex]} entrances ${t.join(' ')}`);
    }
    return null;
  }
  const { mkdirSync } = await import('node:fs');
  for (let si = first; si < PLANS[quest].length; si++) {
    const step = PLANS[quest][si];
    if (si > first) {
      mkdirSync(CKPT, { recursive: true });
      writeFileSync(join(CKPT, `q${quest}-step${si - 1}.json`), JSON.stringify({ inputs: sim.used(), events: sim.events, state, levels }));
    }
    warp(sim);
    if (step.skip) continue;
    step.before?.(sim);
    const lvl = enterLevel(sim);
    if (lvl === null && step.byLevel) { console.log(`  no visible entrance in ${hex(sim.ram[V.RoomId])}`); continue; }
    if (lvl === null) throw new Error(`no entrance in ${hex(sim.ram[V.RoomId])}`);
    if (step.level !== null && lvl !== step.level) throw new Error(`entered level ${lvl}, expected ${step.level}`);
    if (step.byLevel) {
      step.routes = ROUTES_Q2[lvl] ?? [];
      if (!step.routes.length) { leaveLevel(sim); continue; }
    }
    levels.push(lvl);
    if (step.explore) {
      // exploreLevel leaves the level at the end unless there are routes left to do.
      exploreLevel(sim, { maxRooms: step.maxRooms ?? 12, maxFrames: 9000, onRoom, stay: !!step.routes });
    }
    for (const route of step.routes ?? []) excursion(sim, route, onRoom);
    if (step.routes) leaveLevel(sim);
    const got = Object.keys(P19_TYPES).map(Number).filter((t) => sim.seen.has(t));
    console.log(`after level ${lvl}: types ${got.map(hex).join(' ')}; ${JSON.stringify(state)}`);
  }
  sim.play([[30, 0]]);
  const seenTypes = Object.keys(P19_TYPES).map(Number).filter((t) => sim.seen.has(t));
  const missing = Object.keys(P19_TYPES).map(Number).filter((t) => !sim.seen.has(t));
  console.log(`missing: ${missing.map((t) => P19_TYPES[t]).join(', ') || 'none'}`);
  const name = quest ? `${MOVIE}2` : MOVIE;
  const file = quest ? SRAM_FILE2 : SRAM_FILE;
  writeMovie(name, [
    `P19${quest ? ' (second quest)' : ''}: continue the prepared file (tests/oracle/movies/${file}: wooden sword,`,
    'recorder, bow and arrows, bombs, red ring, magic shield, magic key, 16 full hearts, the 8 triforce',
    `pieces), then warp with the recorder to levels ${levels.join(', ')} and walk their rooms (doorways,`,
    'bombed walls, cleared shutters), avoiding rooms with monsters of later packages.',
    `Events: ${sim.events.join('; ') || 'none'}.`,
    `P19 monsters seen: ${seenTypes.map((t) => P19_TYPES[t]).join(', ')}.`,
    'Generated by tests/game/p19-make-movies.mjs (closed-loop on the original game).',
    `Run the oracle with --sram tests/oracle/movies/${file}.`,
  ], sim.used(), {
    comment: `Underworld monsters A (P19)${quest ? ', second quest' : ''}.`,
    sram: file,
    reaches: { CurLevel: [0, ...new Set(levels)], ...(state.likeLike ? { InvMagicShield: [1, 0] } : {}) },
    monsterTypes: seenTypes,
    events: sim.events,
  });
  return name;
}

async function main() {
  await init();
  const what = process.argv[2] ?? 'all';
  const quests = process.env.P19_QUEST ? [Number(process.env.P19_QUEST)] : [0, 1];
  for (const q of quests) {
    if (what === 'sram') { await ensureItemsSram(q, true); continue; }
    if (what === 'tour' || what === 'all') await makeTour(q);
    if (what === 'check' || what === 'tour' || what === 'all') await check(q ? `${MOVIE}2` : MOVIE);
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });

// Shared with tests/game/p20-make-movies.mjs (uw-enemies-b).
export {
  init, Sim, expand, startGame, warp, enterLevel, exploreLevel, excursion, goSmart, goThrough, leaveLevel, makeOnRoom,
  writeMovie, exitRoomOW, walkTo, walkController, selectItem, heal, log, hunt, slotsOf, playing, ensureItemsSram,
  FORBIDDEN, B, DIR_BTN, hex, rawTileStill, isWarpTile, X0, X1, Y0, Y1, walkable, inside, DXY, hooks,
};
export function setCur(sim) { cur = sim; }
