#!/usr/bin/env node
// Generator of the P18 oracle scenario (overworld monsters). Run:
//   node tests/game/p18-make-movies.mjs [sram|tour|all]
//
//  * tests/oracle/movies/p18-items.sav: SRAM of a game registered in the oracle (slot 1, like
//    register-name) whose file A gets the white sword, recorder, bracelet, red ring, magic shield,
//    16 full heart containers and the triforce pieces of levels 6 and 7 (the whirlwind goes to $22),
//    checksum fixed. Only the save files ($6000-$652F) are kept: no ROM data. Deterministic.
//  * ow-enemies-tour: continues that file (title -> Start -> Start) and visits one room per kind of
//    overworld monster, fighting what comes near:
//      $78 red octoroks, $68 red octoroks, $58 red slow/fast octoroks, $59 peahats + zora,
//      $49 blue/red octoroks, $4A blue tektites, $3A leevers + peahats, $2A blue leevers,
//      $29 red leevers, $28 peahats, $27, $17 and $18 falling boulders + zora, recorder -> $22
//      (red lynel, an armos statue touched), $32, $31 ghini, $21 graveyard (gravestones touched: flying ghinis),
//      $20 $30 $40 ghinis, $50 red lynels, $60, $61 and $62 blue moblins, $52 blue/red moblins.
//    The inputs are found by a closed-loop controller playing the ORIGINAL game in the oracle (BFS over
//    Link's 8-pixel grid with the port's tile collision, as tests/game/p16-make-movies.mjs), so the
//    movie is reproducible: the same run always gives the same inputs.
// The movie is replayed from power-on in the oracle to check it reaches the expected state (rooms and
// every monster type), and its expectations are written to ow-enemies-tour.expect.json.
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
export const SRAM_FILE = 'p18-items.sav';
const SRAM_PATH = join(MOVIES, SRAM_FILE);

const B = { A: 0x80, B: 0x40, S: 0x20, T: 0x10, U: 0x08, D: 0x04, L: 0x02, R: 0x01 };
const DIR_BTN = { 1: B.R, 2: B.L, 4: B.D, 8: B.U };
const DXY = { 1: [8, 0], 2: [-8, 0], 4: [0, 8], 8: [0, -8] };

// The monster types the tour must show (ObjType): octoroks $07-$09 ($0A runs the same code as $08/$09),
// moblins $03/$04, red lynel $02, tektites $0D, leevers $0F/$10, zora $11, peahat $1A, armos $1E, boulder set $1F, boulder $20,
// ghini $21, flying ghini $22.
export const TOUR_TYPES = [0x02, 0x03, 0x04, 0x07, 0x08, 0x09, 0x0d, 0x0f, 0x10, 0x11, 0x1a, 0x1e, 0x1f, 0x20,
  0x21, 0x22];

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

/** Plays `inputs` from power-on, then asks `controller(ram, frame)` for each further NMI. */
class Sim {
  constructor(sramInit, inputs = []) {
    this.inputs = [...inputs];
    this.sramInit = sramInit;
    this.controller = () => 0;
    this.seen = new Set();
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

  /** Runs until `done(ram)` or `max` more frames. Returns true if done. */
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
      for (let i = 1; i < 0x0c; i++) this.seen.add(this.o.ram[V.ObjType + i]);
      if (this.o.ram[V.GameMode] === 0x11) throw new Error(`Link died in room $${this.o.ram[V.RoomId].toString(16)}`);
    }
    return done(this.o.ram, this.frame);
  }

  /** Plays fixed runs [[frames, buttons], ...]. */
  play(runs) {
    const inputs = expand(runs);
    const base = this.frame;
    this.controller = (r, n) => inputs[n - 1 - base] ?? 0;
    this.runUntil(() => false, inputs.length);
    this.controller = () => 0;
  }

  /** Inputs actually consumed so far (one per completed frame). */
  used() { return this.inputs.slice(0, this.frame); }
}

function expand(runs) {
  const out = [];
  for (const [n, b] of runs) for (let i = 0; i < n; i++) out.push(b);
  return out;
}

// ------------------------------------------------------------------ grid planning (port collision)

let currentSim = null;

/** Is the move from grid point (x, y) in direction d allowed by the tile check Link does there? */
function walkable(x, y, d) {
  ram[V.ObjX] = x;
  ram[V.ObjY] = y;
  ram[0x0f] = d;
  return GetCollidingTileMoving(0) < ram[V.ObjectFirstUnwalkableTile];
}

/** Raw tile under Link's feet at (x, y). */
function rawTileStill(x, y) {
  const lvl = ram[V.CurLevel];
  ram[V.CurLevel] = 1; // UW path returns the raw tile
  ram[V.ObjX] = x;
  ram[V.ObjY] = y;
  const t = GetCollidableTileStill(0);
  ram[V.CurLevel] = lvl;
  return t;
}

const isWarpTile = (t) => t === 0x24 || t === 0x88 || (t >= 0x70 && t < 0x74);
const X0 = 0x00, X1 = 0xf0, Y0 = 0x3d, Y1 = 0xdd;
const inside = (x, y) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;

/** BFS over grid points from (sx, sy). Returns the first direction, 0 if unreachable, -1 at the goal. */
function planStep(sx, sy, goal, { blocked = new Set(), avoid = () => false } = {}) {
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
      if (!goal(nx, ny) && (isWarpTile(rawTileStill(nx, ny)) || avoid(nx, ny))) continue;
      first.set(k, first.get(key(x, y)) || d);
      if (goal(nx, ny)) return first.get(k);
      q.push([nx, ny]);
    }
  }
  return 0;
}

function monsterNear(r, x, y) {
  for (let i = 1; i < 0x0c; i++) {
    const t = r[V.ObjType + i];
    if (t === 0 || t >= 0x5d || t === 0x2f || t === 0x2e || t === 0x1f) continue;
    if (Math.abs(r[V.ObjX + i] - x) < 0x20 && Math.abs(r[V.ObjY + i] - y) < 0x20) return true;
  }
  return false;
}

/** The fairy fountain $39: keep away from the pond (the fairy would halt Link). */
const avoidPond = (r) => (x, y) => r[V.RoomId] === 0x39 && y >= 0x8d && y <= 0xcd && x >= 0x50 && x <= 0xa0;

/** Controller: walk Link to a grid point satisfying goal() (swinging the sword at nearby monsters). */
function walkController(goal, { sword = true } = {}) {
  const blocked = new Set();
  let last = null, still = 0, lastDir = 0;
  const ctl = (r, frame) => {
    ctl.arrived = false;
    if (r[V.GameMode] !== 5 || r[V.IsUpdatingMode] === 0) return 0;
    if (r[V.ObjShoveDir] !== 0) return 0;
    const x = r[V.ObjX], y = r[V.ObjY];
    const pos = `${x},${y}`;
    if (pos === last && lastDir) {
      if (++still > 24) { blocked.add(`${x},${y},${lastDir}`); still = 0; }
    } else { still = 0; }
    last = pos;
    if (sword && frame % 16 === 0 && monsterNear(r, x, y)) { lastDir = 0; return B.A; }
    if (r[V.ObjGridOffset] !== 0) { lastDir = r[V.ObjDir]; return DIR_BTN[r[V.ObjDir]] ?? 0; }
    ram.set(r);
    sram.set(currentSim.o.sram);
    const d = planStep(x, y, goal, { blocked, avoid: avoidPond(r) });
    if (d === -1) { ctl.arrived = true; lastDir = 0; return 0; }
    lastDir = d;
    return d ? DIR_BTN[d] : 0;
  };
  return ctl;
}

const playing = (r) => r[V.GameMode] === 5 && r[V.IsUpdatingMode] !== 0;
const atEdge = (d) => (x, y) => (d === 2 ? x === X0 : d === 1 ? x === X1 : d === 8 ? y === Y0 : y === Y1);

/** Walks to grid point (gx, gy) of the current room. */
function walkTo(sim, gx, gy, max = 900) {
  const ctl = walkController((x, y) => x === gx && y === gy);
  sim.controller = ctl;
  const ok = sim.runUntil((r) => playing(r) && r[V.ObjX] === gx && r[V.ObjY] === gy && r[V.ObjGridOffset] === 0, max);
  sim.controller = () => 0;
  if (!ok) throw new Error(`walkTo(${gx.toString(16)},${gy.toString(16)}) failed in room $${sim.ram[V.RoomId].toString(16)} at (${sim.ram[V.ObjX].toString(16)},${sim.ram[V.ObjY].toString(16)})`);
}

/** Like walkTo, but gives up quietly after `max` frames (used to roam a room for a while). */
function roam(sim, gx, gy, max = 400) {
  const ctl = walkController((x, y) => x === gx && y === gy);
  sim.controller = ctl;
  sim.runUntil((r) => playing(r) && r[V.ObjX] === gx && r[V.ObjY] === gy && r[V.ObjGridOffset] === 0, max);
  sim.controller = () => 0;
}

/** Walks out of the room through edge d; waits until playing in the next room. */
function exitRoom(sim, d, max = 1800) {
  const room = sim.ram[V.RoomId];
  const ctl = walkController(atEdge(d));
  sim.controller = (r, f) => {
    const b = ctl(r, f);
    return ctl.arrived ? DIR_BTN[d] : b;
  };
  const ok = sim.runUntil((r) => playing(r) && r[V.RoomId] !== room, max);
  sim.controller = () => 0;
  if (!ok) {
    dbg(sim, 'exitRoom failed');
    throw new Error(`exitRoom(${d}) from $${room.toString(16)} failed`);
  }
  sim.runUntil(() => false, 4);
  dbg(sim, `room $${sim.ram[V.RoomId].toString(16)}`);
}

/** Opens the submenu, moves the cursor right until SelectedItemSlot = slot, closes it. */
function selectItem(sim, slot) {
  if (sim.ram[V.SelectedItemSlot] === slot) return;
  sim.play([[2, B.T], [90, 0]]);
  for (let i = 0; i < 10 && sim.ram[V.SelectedItemSlot] !== slot; i++) sim.play([[2, B.R], [12, 0]]);
  if (sim.ram[V.SelectedItemSlot] !== slot) throw new Error(`selectItem(${slot}) failed`);
  sim.play([[2, B.T], [90, 0]]);
  if (!playing(sim.ram)) throw new Error('selectItem: not back in mode 5');
}

/** Plays the recorder and waits for the whirlwind to drop Link in the destination room. */
function warp(sim, dest) {
  sim.play([[2, B.B], [2, 0]]);
  const ok = sim.runUntil((r) => playing(r) && r[V.RoomId] === dest && r[V.WhirlwindTeleportingState] === 0
    && r[V.ObjState] === 0, 1500);
  if (!ok) throw new Error(`warp to $${dest.toString(16)} failed (room $${sim.ram[V.RoomId].toString(16)})`);
  sim.play([[30, 0]]);
}

function dbg(sim, tag) {
  if (!process.env.P18_DEBUG) return;
  const r = sim.ram;
  const h = (v) => v.toString(16);
  const objs = [];
  for (let i = 1; i < 0x0c; i++) if (r[V.ObjType + i]) objs.push(h(r[V.ObjType + i]));
  console.log(`${tag} f${sim.frame}: link (${h(r[V.ObjX])},${h(r[V.ObjY])}) hearts ${h(r[V.HeartValues])}/${h(r[V.HeartPartial])} objs ${objs.join(',')}`);
}

const MOVES = { R: 1, L: 2, D: 4, U: 8 };
function walkRooms(sim, path) {
  for (const c of path) exitRoom(sim, MOVES[c]);
}

// ------------------------------------------------------------------ SRAM with items

const prefixMenu = () => [[120, 0], [2, B.T], [90, 0]];

/** Register "AAAAA" in slot 1 (like register-name), back in the menu. */
function registerRuns() {
  const r = [...prefixMenu(), [2, B.T], [90, 0]];
  for (let i = 0; i < 5; i++) r.push([2, B.A], [6, 0]);
  for (let i = 0; i < 3; i++) r.push([2, B.S], [8, 0]);
  r.push([2, B.T], [90, 0]);
  return r;
}

export async function makeItemsSram() {
  await init();
  const sim = await new Sim(null, expand(registerRuns())).start();
  sim.runUntil(() => false, sim.inputs.length);
  const s = Uint8Array.from(sim.o.sram);
  s.fill(0, 0x530); // keep only the save files: no ROM-derived bytes
  const set = (v, value) => {
    const i = V.SaveFileAItems0 - 0x6000 + (v - V.Items);
    const delta = value - s[i];
    s[i] = value;
    let sum = (s[V.FileAChecksums - 0x6000] << 8) | s[V.FileAChecksums - 0x6000 + 1];
    sum = (sum + delta) & 0xffff;
    s[V.FileAChecksums - 0x6000] = sum >> 8;
    s[V.FileAChecksums - 0x6000 + 1] = sum & 0xff;
  };
  set(V.Items, 2); // white sword
  set(V.InvCandle + 1, 1); // recorder ($065C)
  set(V.InvBracelet, 1);
  set(V.InvRing, 2); // red ring: 1/4 damage
  set(V.InvMagicShield, 1);
  set(V.HeartValues, 0xff); // 16 heart containers, all filled
  set(V.HeartPartial, 0xff);
  set(V.InvTriforce, 0x60); // levels 6 and 7: the whirlwind goes to $22 first
  return s;
}

async function ensureItemsSram(force = false) {
  if (!force && existsSync(SRAM_PATH)) return new Uint8Array(readFileSync(SRAM_PATH));
  const s = await makeItemsSram();
  writeFileSync(SRAM_PATH, s);
  console.log(`wrote ${SRAM_FILE}`);
  return s;
}

/** Title -> Start -> menu (slot 1 selected) -> Start: game in room $77. */
async function startGame(sramInit) {
  const sim = await new Sim(sramInit, expand([...prefixMenu(), [2, B.T], [240, 0]])).start();
  currentSim = sim;
  sim.runUntil(() => false, sim.inputs.length);
  const r = sim.ram;
  if (r[V.GameMode] !== 5 || r[V.RoomId] !== 0x77) throw new Error(`start: mode ${r[V.GameMode]} room ${r[V.RoomId]}`);
  if (r[V.Items] !== 2) throw new Error('start: no white sword (SRAM edit rejected?)');
  return sim;
}

// ------------------------------------------------------------------ output

function writeMovie(name, comment, inputs, expect) {
  const m = createMovie(Uint8Array.from(inputs), null, { name });
  const text = serializeZmv(m).replace(/^zmv 1\n/, `zmv 1\n${comment.map((c) => `# ${c}`).join('\n')}\n`);
  writeFileSync(join(MOVIES, `${name}.zmv`), text);
  writeFileSync(join(MOVIES, `${name}.expect.json`), `${JSON.stringify(expect, null, 2)}\n`);
  console.log(`wrote ${name}.zmv (${inputs.length} frames)`);
}

/** Replays a written movie in a fresh oracle and checks its expectations (+ the monster types). */
export async function check(name) {
  await init();
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  const s = new Uint8Array(readFileSync(join(MOVIES, expect.sram)));
  const o = await Oracle.create({ rom: rom.bytes, sram: s, powerOnFill: 0 });
  const seen = {};
  for (const k of Object.keys(expect.reaches)) seen[k] = new Set();
  const types = new Set();
  o.run(loadMovie(join(MOVIES, `${name}.zmv`)), {
    write(rec) {
      for (const k of Object.keys(expect.reaches)) seen[k].add(rec.ram[V[k.replace(/\+.*/, '')] + Number(k.split('+')[1] ?? 0)]);
      for (let i = 1; i < 0x0c; i++) types.add(rec.ram[V.ObjType + i]);
    },
  });
  for (const [k, vals] of Object.entries(expect.reaches)) {
    for (const v of [].concat(vals)) if (!seen[k].has(v)) throw new Error(`${name}: ${k} never reaches ${v}`);
  }
  for (const t of expect.monsterTypes ?? []) if (!types.has(t)) throw new Error(`${name}: no monster of type $${t.toString(16)}`);
  console.log(`${name}: expectations OK`);
}

// ------------------------------------------------------------------ scenario

const SLOT_RECORDER = 5; // SelectedItemSlot n = Items + n

async function makeTour(s) {
  const sim = await startGame(s);
  const rooms = [];
  const enter = (path) => {
    for (const c of path) {
      exitRoom(sim, MOVES[c]);
      rooms.push(sim.ram[V.RoomId]);
    }
  };
  enter('R'); // $78 red octoroks
  roam(sim, 0x70, 0x8d);
  enter('UU'); // $68, $58
  roam(sim, 0x80, 0x9d);
  enter('R'); // $59 peahats + zora
  roam(sim, 0x70, 0x8d, 500);
  enter('U'); // $49
  enter('R'); // $4A blue tektites
  roam(sim, 0x70, 0x9d, 500);
  enter('U'); // $3A blue/red leevers, peahats
  roam(sim, 0x70, 0x9d, 400);
  enter('U'); // $2A blue leevers
  roam(sim, 0x70, 0x9d, 500);
  enter('L'); // $29 red leevers
  roam(sim, 0x70, 0x9d, 500);
  enter('L'); // $28 peahats + zora
  roam(sim, 0x70, 0x9d, 300);
  enter('LU'); // $27, $17 falling boulders + zora
  roam(sim, 0x80, 0x9d, 600);
  enter('R'); // $18 falling boulders + zora
  roam(sim, 0x80, 0x9d, 600);
  // The recorder: the whirlwind takes Link to $22 (level 6 entrance), red lynel and armos statues.
  selectItem(sim, SLOT_RECORDER);
  warp(sim, 0x22);
  rooms.push(0x22);
  // Walk into the armos statue at ($30,$80): CheckPassiveTileObjects makes an armos.
  walkTo(sim, 0x20, 0x7d);
  sim.play([[20, B.R], [10, 0]]);
  if (![...Array(11).keys()].some((i) => sim.ram[V.ObjType + 1 + i] === 0x1e)) throw new Error('ow-enemies-tour: no armos');
  roam(sim, 0x50, 0xad, 400);
  enter('DLU'); // $32, $31, $21 (graveyard)
  if (sim.ram[V.RoomId] !== 0x21) throw new Error(`ow-enemies-tour: room $${sim.ram[V.RoomId].toString(16)}`);
  // Touch gravestones ($BD squares at X $30/$60/$90/$C0) from the side with short presses (no push,
  // so no stairs): CheckPassiveTileObjects releases flying ghinis.
  for (const [gx, gy, d] of [[0x20, 0xad, 1], [0x50, 0xad, 1], [0x50, 0x6d, 1], [0x20, 0x8d, 1]]) {
    walkTo(sim, gx, gy);
    sim.play([[8, DIR_BTN[d]], [20, 0]]);
  }
  dbg(sim, 'graves touched');
  roam(sim, 0x90, 0xcd, 600);
  dbg(sim, 'roamed');
  enter('LDDDDR'); // $20 $30 $40 ghinis, $50 red lynels, $60, $61 blue moblins
  roam(sim, 0x70, 0x8d, 300);
  enter('RU'); // $62 blue moblins, $52 blue/red moblins
  roam(sim, 0x70, 0x8d, 500);
  sim.play([[30, 0]]);
  const missing = TOUR_TYPES.filter((t) => !sim.seen.has(t));
  if (missing.length) throw new Error(`ow-enemies-tour: monster types never seen: ${missing.map((t) => `$${t.toString(16)}`).join(' ')}`);
  writeMovie('ow-enemies-tour', [
    `P18: continue the prepared file (tests/oracle/movies/${SRAM_FILE}: white sword, recorder, bracelet, red ring,`,
    'magic shield, 16 full hearts, triforce pieces 6 and 7), then one room per kind of overworld monster:',
    '$78 $68 $58 octoroks, $59 peahats + zora, $49, $4A blue tektites, $3A leevers + peahats, $2A blue leevers,',
    '$29 red leevers, $28 peahats, $27, $17 and $18 falling boulders + zora, recorder -> $22 (red lynel,',
    'an armos statue), $32, $31, $21 graveyard (gravestones touched: flying ghinis), $20 $30 $40 ghinis,',
    '$50 red lynels, $60, $61 $62 $52 moblins.',
    'Generated by tests/game/p18-make-movies.mjs (closed-loop on the original game).',
    `Run the oracle with --sram tests/oracle/movies/${SRAM_FILE}.`,
  ], sim.used(), {
    comment: 'One room per overworld monster type (P18).', sram: SRAM_FILE,
    reaches: { RoomId: [...new Set(rooms)] },
    monsterTypes: TOUR_TYPES,
  });
}

async function main() {
  await init();
  const what = process.argv[2] ?? 'all';
  const s = await ensureItemsSram(what === 'sram');
  if (what === 'tour' || what === 'all') {
    await makeTour(s);
    await check('ow-enemies-tour');
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
