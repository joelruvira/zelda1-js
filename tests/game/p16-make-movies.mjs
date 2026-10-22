#!/usr/bin/env node
// Generator of the P16 oracle scenarios (world objects). Run:
//   node tests/game/p16-make-movies.mjs [sram|tree|rock|wall|warp|grave|fairy|raft|block|all]
//
//  * tests/oracle/movies/p16-items.sav: SRAM of a game registered in the oracle (slot 1, like
//    register-name) whose file A gets sword, 8 bombs, blue candle, recorder, raft, bracelet, red ring,
//    magic shield, 16 heart containers with 6 hearts filled and the triforce pieces of levels 6 and 7,
//    checksum fixed. Only the save files ($6000-$652F) are kept: no ROM data. Deterministic.
//  * Each movie continues that file (title -> Start -> Start) and plays one world-object scenario. The
//    inputs are found by a closed-loop controller playing the ORIGINAL game in the oracle (BFS over
//    Link's 8-pixel grid with the port's tile collision, as tests/game/p08-make-movies.mjs), so the
//    movies are reproducible: the same run always gives the same inputs.
//      ow-candle-tree   $77 -> $78, burn the tree at ($40,$A0) with the candle (UpdateTree, stairs).
//      ow-bracelet-rock $77 -> $78 -> $79, push the rock at ($80,$90) (UpdateRockOrGravestone).
//      ow-bomb-wall     $77 -> $76, bomb the rock wall at ($60,$50) (UpdateRockWall).
//      recorder-pond    recorder in $77: whirlwind to level 6 ($22), again to level 7 ($42), recorder in
//                       $42 (pond secret: UpdateFluteSecret, RevealPondStairs), leave the room (AnimatePond).
//      ow-graveyard     whirlwind to $22, walk into the graveyard $21, push a gravestone, touch others
//                       (CheckPassiveTileObjects: ghinis).
//      pond-fairy       walk to the fairy fountain $39 and stand at the pond (UpdatePondFairy, hearts).
//      raft-dock        walk to the dock in $55, ride the raft up to $45 and back down (UpdateDock).
//      uw-push-block    uw-level1-full (p08-items.sav) up to room $42 of level 1 cleared, push the block
//                       (UpdateBlock, BlockPushComplete).
// Every movie is replayed from power-on in the oracle to check it reaches the expected state, and its
// expectations are written to <movie>.expect.json.
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
export const SRAM_FILE = 'p16-items.sav';
const SRAM_PATH = join(MOVIES, SRAM_FILE);

const B = { A: 0x80, B: 0x40, S: 0x20, T: 0x10, U: 0x08, D: 0x04, L: 0x02, R: 0x01 };
const DIR_BTN = { 1: B.R, 2: B.L, 4: B.D, 8: B.U };
const DXY = { 1: [8, 0], 2: [-8, 0], 4: [0, 8], 8: [0, -8] };

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
    }
    return done(this.o.ram, this.frame);
  }

  /** Plays fixed runs [[frames, buttons], ...]. */
  play(runs) {
    this.controller = () => 0;
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
    if (t === 0 || t >= 0x5d || t === 0x2f || t === 0x2e) continue;
    if (Math.abs(r[V.ObjX + i] - x) < 0x20 && Math.abs(r[V.ObjY + i] - y) < 0x20) return true;
  }
  return false;
}

/** Controller: walk Link to a grid point satisfying goal() (swinging the sword at nearby monsters). */
function walkController(goal, { sword = true, avoid } = {}) {
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
    if (sword && frame % 20 === 0 && monsterNear(r, x, y)) { lastDir = 0; return B.A; }
    if (r[V.ObjGridOffset] !== 0) { lastDir = r[V.ObjDir]; return DIR_BTN[r[V.ObjDir]] ?? 0; }
    ram.set(r);
    sram.set(currentSim.o.sram);
    const d = planStep(x, y, goal, { blocked, avoid });
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

/** Walks out of the room through edge d; waits until playing in the next room. */
function exitRoom(sim, d, max = 1500) {
  const room = sim.ram[V.RoomId];
  const ctl = walkController(atEdge(d));
  sim.controller = (r, f) => {
    const b = ctl(r, f);
    return ctl.arrived ? DIR_BTN[d] : b;
  };
  const ok = sim.runUntil((r) => playing(r) && r[V.RoomId] !== room, max);
  sim.controller = () => 0;
  if (!ok) throw new Error(`exitRoom(${d}) from $${room.toString(16)} failed`);
  sim.runUntil(() => false, 4);
}

/** Opens the submenu, moves the cursor right until SelectedItemSlot = slot, closes it. */
function selectItem(sim, slot) {
  if (sim.ram[V.SelectedItemSlot] === slot) return;
  sim.play([[2, B.T], [90, 0]]);
  for (let i = 0; i < 10 && sim.ram[V.SelectedItemSlot] !== slot; i++) {
    sim.play([[2, B.R], [12, 0]]);
    if (process.env.P16_DEBUG) console.log(`menu ${sim.ram[V.MenuState]} sel ${sim.ram[V.SelectedItemSlot]} mode ${sim.ram[V.GameMode]}`);
  }
  if (sim.ram[V.SelectedItemSlot] !== slot) throw new Error(`selectItem(${slot}) failed`);
  sim.play([[2, B.T], [90, 0]]);
  if (!playing(sim.ram)) throw new Error('selectItem: not back in mode 5');
}

/** Turns Link to face d (one short press; blocked by the object he faces). */
function face(sim, d) {
  sim.play([[2, DIR_BTN[d]], [2, 0]]);
}

function dbg(sim, tag) {
  if (!process.env.P16_DEBUG) return;
  const r = sim.ram;
  const h = (v) => v.toString(16);
  console.log(`${tag}: room ${h(r[V.RoomId])} link (${h(r[V.ObjX])},${h(r[V.ObjY])}) dir ${r[V.ObjDir]} sel ${r[V.SelectedItemSlot]} `
    + `s10 t${h(r[V.ObjType + 0x10])} st${h(r[V.ObjState + 0x10])} (${h(r[V.ObjX + 0x10])},${h(r[V.ObjY + 0x10])}) tm${r[V.ObjTimer + 0x10]} `
    + `s11 st${h(r[V.ObjState + 0x11])} (${h(r[V.ObjX + 0x11])},${h(r[V.ObjY + 0x11])}) obj11 t${h(r[V.ObjType + 11])} (${h(r[V.ObjX + 11])},${h(r[V.ObjY + 11])}) st${r[V.ObjState + 11]}`);
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
  set(V.Items, 1); // wooden sword
  set(V.InvBombs, 8);
  set(V.MaxBombs, 8);
  set(V.InvCandle, 1); // blue candle
  set(V.InvCandle + 1, 1); // recorder ($065C)
  set(V.InvRaft, 1);
  set(V.InvBracelet, 1);
  set(V.InvRing, 2); // red ring: 1/4 damage
  set(V.InvMagicShield, 1);
  set(V.HeartValues, 0xf5); // 16 heart containers, 6 hearts filled (the fairy has work to do)
  set(V.HeartPartial, 0xff);
  set(V.InvTriforce, 0x60); // levels 6 and 7: the whirlwind goes to $22, then $42
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
  if (r[V.InvRaft] !== 1) throw new Error('start: the raft is not in the inventory (SRAM edit rejected?)');
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

/** Replays a written movie in a fresh oracle and checks its expectations. */
async function check(name) {
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  const s = new Uint8Array(readFileSync(join(MOVIES, expect.sram)));
  const o = await Oracle.create({ rom: rom.bytes, sram: s, powerOnFill: 0 });
  const seen = {};
  for (const k of Object.keys(expect.reaches)) seen[k] = new Set();
  o.run(loadMovie(join(MOVIES, `${name}.zmv`)), {
    write(rec) { for (const k of Object.keys(expect.reaches)) seen[k].add(rec.ram[V[k.replace(/\+.*/, '')] + Number(k.split('+')[1] ?? 0)]); },
  });
  for (const [k, vals] of Object.entries(expect.reaches)) {
    for (const v of [].concat(vals)) if (!seen[k].has(v)) throw new Error(`${name}: ${k} never reaches ${v}`);
  }
  console.log(`${name}: expectations OK`);
}

const COMMON = (what) => [
  `P16: continue the prepared file (tests/oracle/movies/${SRAM_FILE}: bombs, candle, recorder, raft, bracelet,`,
  'red ring, 16 containers with 6 hearts, triforce pieces 6 and 7), then ' + what,
  'Generated by tests/game/p16-make-movies.mjs (closed-loop on the original game).',
  `Run the oracle with --sram tests/oracle/movies/${SRAM_FILE}.`,
];

// ------------------------------------------------------------------ scenarios

const SLOT_BOMB = 1, SLOT_CANDLE = 4, SLOT_RECORDER = 5; // SelectedItemSlot n = Items + n

async function makeCandleTree(s) {
  const sim = await startGame(s);
  selectItem(sim, SLOT_CANDLE);
  exitRoom(sim, 1); // $78
  walkTo(sim, 0x60, 0x9d); // the fire stops $20 px away: on the tree at ($40,$A0)
  face(sim, 2);
  dbg(sim, 'before B');
  sim.play([[2, B.B]]);
  for (let i = 0; i < 20; i++) { sim.play([[10, 0]]); dbg(sim, `+${i * 10}`); }
  if (sim.ram[V.ObjType + 11] !== 0) throw new Error('ow-candle-tree: the tree was not burnt');
  sim.play([[60, 0]]);
  writeMovie('ow-candle-tree', COMMON('walk to $78 and burn the tree at ($40,$A0) with the blue candle: stairs.'),
    sim.used(), { comment: 'Tree burnt in room $78 (UpdateTree -> RevealAndFlagSecretStairsObj).', sram: SRAM_FILE,
      reaches: { RoomId: [0x78], Tune1Request: [4] } });
}

async function makeBraceletRock(s) {
  const sim = await startGame(s);
  exitRoom(sim, 1); // $78
  exitRoom(sim, 1); // $79
  walkTo(sim, 0x80, 0x9d); // below the rock at ($80,$90)
  sim.play([[40, B.U], [10, 0]]);
  if (sim.ram[V.ObjType + 11] !== 0) throw new Error('ow-bracelet-rock: the rock did not move');
  sim.play([[60, 0]]);
  writeMovie('ow-bracelet-rock', COMMON('walk to $79 and push the rock at ($80,$90) up with the bracelet.'),
    sim.used(), { comment: 'Rock pushed in room $79 (UpdateRockOrGravestone states 0 and 1, stairs revealed).', sram: SRAM_FILE,
      reaches: { RoomId: [0x79], 'ObjState+11': [1], Tune1Request: [4] } });
}

async function makeBombWall(s) {
  const sim = await startGame(s);
  selectItem(sim, SLOT_BOMB);
  exitRoom(sim, 2); // $76
  walkTo(sim, 0x60, 0x5d); // below the rock wall at ($60,$50)
  face(sim, 8);
  sim.play([[2, B.B], [120, 0]]);
  if (sim.ram[V.ObjType + 11] !== 0) throw new Error('ow-bomb-wall: the wall was not opened');
  sim.play([[60, 0]]);
  writeMovie('ow-bomb-wall', COMMON('walk to $76 and bomb the rock wall at ($60,$50): cave opened.'),
    sim.used(), { comment: 'Rock wall bombed in room $76 (UpdateRockWall -> RevealAndFlagSecretTileObj).', sram: SRAM_FILE,
      reaches: { RoomId: [0x76], Tune1Request: [4] } });
}

/** Plays the recorder and waits for the whirlwind to drop Link in the destination room. */
function warp(sim, dest) {
  sim.play([[2, B.B], [2, 0]]);
  const ok = sim.runUntil((r) => playing(r) && r[V.RoomId] === dest && r[V.WhirlwindTeleportingState] === 0
    && r[V.ObjState] === 0, 1500);
  if (!ok) throw new Error(`warp to $${dest.toString(16)} failed (room $${sim.ram[V.RoomId].toString(16)})`);
  sim.play([[30, 0]]);
}

async function makeRecorderWarp(s) {
  const sim = await startGame(s);
  selectItem(sim, SLOT_RECORDER);
  face(sim, 1);
  warp(sim, 0x22); // level 6
  warp(sim, 0x42); // level 7
  sim.play([[2, B.B], [2, 0]]);
  const ok = sim.runUntil((r) => r[V.SecretColorCycle] >= 0x0c, 600);
  if (!ok) throw new Error('recorder-pond: the pond was not drained');
  sim.play([[60, 0]]);
  exitRoom(sim, 4); // leave the room: InitMode7_Sub0 -> AnimatePond
  sim.play([[60, 0]]);
  writeMovie('recorder-pond', COMMON('play the recorder in $77 (whirlwind to level 6, $22), again (level 7, $42), '
    + 'then in $42 (pond drained, stairs) and leave the room south (pond colors reversed).'),
    sim.used(), { comment: 'Whirlwind warps and the pond secret of level 7.', sram: SRAM_FILE,
      reaches: { RoomId: [0x22, 0x42], WhirlwindTeleportingState: [1, 2], SecretColorCycle: [0x0b, 0x0c] } });
}

async function makeGraveyard(s) {
  const sim = await startGame(s);
  selectItem(sim, SLOT_RECORDER);
  face(sim, 1);
  warp(sim, 0x22);
  // Walk into an armos statue (tiles $C0-$C3 at ($30,$80)): CheckPassiveTileObjects makes an armos.
  walkTo(sim, 0x20, 0x7d);
  sim.play([[20, B.R], [10, 0]]);
  if (![...Array(11).keys()].some((i) => sim.ram[V.ObjType + 1 + i] === 0x1e)) throw new Error('ow-graveyard: no armos');
  await walkRooms(sim, 'DLU'); // $32 $31 $21 (graveyard)
  if (sim.ram[V.RoomId] !== 0x21) throw new Error(`ow-graveyard: room $${sim.ram[V.RoomId].toString(16)}`);
  walkTo(sim, 0x90, 0x9d); // below the gravestone at ($90,$90)
  sim.play([[40, B.U], [10, 0]]); // pushed $10 px, then Link walks on: a ghini from the gravestone tile
  // Walk into other gravestones: flying ghinis appear (CheckPassiveTileObjects).
  sim.play([[30, B.L], [10, 0], [30, B.U], [10, 0], [30, B.R], [60, 0]]);
  writeMovie('ow-graveyard', COMMON('whirlwind to $22, walk into an armos statue there, go to the graveyard $21 '
    + '($32, $31), push the gravestone at ($90,$90) up and walk into other gravestones (ghinis).'),
    sim.used(), { comment: 'Armos from a statue in $22; gravestone pushed in $21; ghinis from gravestones.', sram: SRAM_FILE,
      reaches: { RoomId: [0x22, 0x21], 'ObjState+11': [1] } });
}

const MOVES = { R: 1, L: 2, D: 4, U: 8 };
async function walkRooms(sim, path) {
  for (const c of path) exitRoom(sim, MOVES[c]);
}

async function makePondFairy(s, path) {
  const sim = await startGame(s);
  await walkRooms(sim, path);
  if (sim.ram[V.RoomId] !== 0x39) throw new Error(`pond-fairy: room $${sim.ram[V.RoomId].toString(16)}`);
  // Walk to the edge of the pond: the fairy halts Link as soon as he is there (Y = $AD, X in $70-$80).
  sim.controller = walkController((x, y) => x === 0x78 && y === 0xad);
  if (!sim.runUntil((r) => r[V.ObjState + 1] !== 0, 900)) throw new Error('pond-fairy: Link did not reach the pond');
  sim.controller = () => 0;
  const ok = sim.runUntil((r) => r[V.ObjState + 1] === 3, 2000);
  if (!ok) throw new Error('pond-fairy: the fairy did not finish');
  sim.play([[60, 0], [40, B.D], [30, 0]]);
  writeMovie('pond-fairy', COMMON('walk to the fairy fountain $39 and stand at the pond: hearts filled.'),
    sim.used(), { comment: 'Pond fairy in $39: states 0 to 3, hearts orbiting.', sram: SRAM_FILE,
      reaches: { RoomId: [0x39], 'ObjState+1': [1, 2, 3], World_IsFillingHearts: [0x40] } });
}

async function makeRaftDock(s, path) {
  const sim = await startGame(s);
  await walkRooms(sim, path);
  if (sim.ram[V.RoomId] !== 0x55) throw new Error(`raft-dock: room $${sim.ram[V.RoomId].toString(16)}`);
  walkTo(sim, 0x80, 0x7d); // the dock
  sim.play([[4, B.U]]);
  const up = sim.runUntil((r) => playing(r) && r[V.RoomId] === 0x45 && r[V.ObjState] === 0, 1200);
  if (!up) throw new Error('raft-dock: did not ride up to $45');
  sim.play([[30, 0]]);
  // Back down: walk to the bottom edge at X = $80.
  walkTo(sim, 0x80, Y1);
  sim.play([[8, B.D]]);
  const down = sim.runUntil((r) => playing(r) && r[V.RoomId] === 0x55 && r[V.ObjState] === 0, 1200);
  if (!down) throw new Error('raft-dock: did not ride down to $55');
  sim.play([[60, 0]]);
  writeMovie('raft-dock', COMMON('walk to the dock in $55, ride the raft up to $45 and back down.'),
    sim.used(), { comment: 'Raft from the dock of $55 to $45 and back (UpdateDock states 0, 1, 2).', sram: SRAM_FILE,
      reaches: { RoomId: [0x55, 0x45], 'ObjState+11': [1, 2] } });
}

async function makePushBlock() {
  // uw-level1-full (p08-items.sav) up to frame 10250: room $42 of level 1, its monsters killed.
  const src = loadMovie(join(MOVIES, 'uw-level1-full.zmv'));
  const s = new Uint8Array(readFileSync(join(MOVIES, 'p08-items.sav')));
  const sim = await new Sim(s, Array.from(src.p1.subarray(0, 10250))).start();
  currentSim = sim;
  sim.runUntil(() => false, 10250);
  const r = sim.ram;
  if (r[V.RoomId] !== 0x42 || r[V.ObjType + 11] !== 0x68 || !r[V.RoomAllDead]) throw new Error('uw-push-block: not in $42 cleared');
  // Block at ($70,$90): walk left along Y = $8D (Link's Y + 3 = block Y) and keep pushing.
  sim.play([[90, B.L], [30, 0]]);
  if (!sim.ram[V.BlockPushComplete]) throw new Error('uw-push-block: block not pushed');
  sim.play([[40, B.R], [60, 0]]);
  writeMovie('uw-push-block', [
    'P16: uw-level1-full (tests/oracle/movies/p08-items.sav) up to frame 10250 (room $42 of level 1, monsters',
    'killed), then push the block at ($70,$90) left (UpdateBlock states 0, 1, 2; BlockPushComplete).',
    'Generated by tests/game/p16-make-movies.mjs. Run the oracle with --sram tests/oracle/movies/p08-items.sav.',
  ], sim.used(), { comment: 'Push block in room $42 of level 1.', sram: 'p08-items.sav',
    reaches: { RoomId: [0x42], BlockPushComplete: [1], 'ObjState+11': [1, 2] } });
}

async function main() {
  await init();
  const what = process.argv[2] ?? 'all';
  const s = await ensureItemsSram(what === 'sram');
  const jobs = {
    tree: () => makeCandleTree(s), rock: () => makeBraceletRock(s), wall: () => makeBombWall(s),
    warp: () => makeRecorderWarp(s), grave: () => makeGraveyard(s), fairy: () => makePondFairy(s, process.argv[3] ?? 'RUURUU'), // $77 $78 $68 $58 $59 $49 $39
    raft: () => makeRaftDock(s, process.argv[3] ?? 'LULU') /* $76 $66 $65 $55 */, block: () => makePushBlock(),
  };
  const names = {
    tree: 'ow-candle-tree', rock: 'ow-bracelet-rock', wall: 'ow-bomb-wall', warp: 'recorder-pond',
    grave: 'ow-graveyard', fairy: 'pond-fairy', raft: 'raft-dock', block: 'uw-push-block',
  };
  const run = what === 'all' ? Object.keys(jobs) : what === 'sram' ? [] : [what];
  for (const k of run) {
    await jobs[k]();
    await check(names[k]);
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
