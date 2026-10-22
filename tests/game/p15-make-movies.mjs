#!/usr/bin/env node
// Generator of the P15 oracle scenarios (cave people). Run:
//   node tests/game/p15-make-movies.mjs [sram|shop|money|all]
//
//  * tests/oracle/movies/p15-items.sav: SRAM of a game registered in the oracle (slot 1, like
//    register-name) whose file A gets the wooden sword, 8 bombs and 200 rupees, checksum fixed. Only
//    the save files ($6000-$652F) are kept: no ROM data. Deterministic (same bytes on every run).
//  * Each movie continues that file (title -> Start -> Start: room $77) and plays one cave scenario.
//    The inputs are found by a closed-loop controller playing the ORIGINAL game in the oracle (BFS over
//    Link's 8-pixel grid with the port's tile collision, as tests/game/p16-make-movies.mjs), so the
//    movies are reproducible.
//      shop-buy    $77 -> $67 -> $66, enter the shop (type $78: 3 wares with prices, InitCave,
//                  WritePricesTransferBuf, textbox), buy the ware on the right (PostDebit, TakeItem,
//                  states 3 and 4: blank wares, the person flickers and leaves), leave the cave.
//      money-game  $77 -> $76, bomb the rock wall at ($60,$50), enter the money-making game (type $70:
//                  random permutation/amounts in InitCave), play it (state 5: amounts with signs,
//                  PostCredit/PostDebit), leave, enter again and play another ware.
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
export const SRAM_FILE = 'p15-items.sav';
const SRAM_PATH = join(MOVIES, SRAM_FILE);

const B = { A: 0x80, B: 0x40, S: 0x20, T: 0x10, U: 0x08, D: 0x04, L: 0x02, R: 0x01 };
const DIR_BTN = { 1: B.R, 2: B.L, 4: B.D, 8: B.U };
const DXY = { 1: [8, 0], 2: [-8, 0], 4: [0, 8], 8: [0, -8] };
const hex = (v) => `$${v.toString(16)}`;

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

let currentSim = null;

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
function planStep(sx, sy, goal, { blocked = new Set(), warps = false } = {}) {
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
      if (!warps && !goal(nx, ny) && isWarpTile(rawTileStill(nx, ny))) continue;
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
    if (t === 0 || t >= 0x5d) continue;
    if (Math.abs(r[V.ObjX + i] - x) < 0x20 && Math.abs(r[V.ObjY + i] - y) < 0x20) return true;
  }
  return false;
}

const PLAY_MODES = [0x05, 0x0b];
const playing = (r) => PLAY_MODES.includes(r[V.GameMode]) && r[V.IsUpdatingMode] !== 0;

/** Controller: walk Link to a grid point satisfying goal() (swinging the sword at nearby monsters). */
function walkController(goal, { sword = true } = {}) {
  const blocked = new Set();
  let last = null, still = 0, lastDir = 0;
  const ctl = (r, frame) => {
    ctl.arrived = false;
    if (!playing(r) || r[V.ObjShoveDir] !== 0) return 0;
    const x = r[V.ObjX], y = r[V.ObjY];
    const pos = `${x},${y}`;
    if (pos === last && lastDir) {
      if (++still > 24) { blocked.add(`${x},${y},${lastDir}`); still = 0; }
    } else { still = 0; }
    last = pos;
    if (sword && r[V.GameMode] === 5 && frame % 20 === 0 && monsterNear(r, x, y)) { lastDir = 0; return B.A; }
    if (r[V.ObjGridOffset] !== 0) { lastDir = r[V.ObjDir]; return DIR_BTN[r[V.ObjDir]] ?? 0; }
    ram.set(r);
    sram.set(currentSim.o.sram);
    const d = planStep(x, y, goal, { blocked, warps: r[V.GameMode] !== 5 || r[V.CurLevel] !== 0 }); // cave and UW floor is tile $24
    if (d === -1) { ctl.arrived = true; lastDir = 0; return 0; }
    lastDir = d;
    return d ? DIR_BTN[d] : 0;
  };
  return ctl;
}

const atEdge = (d) => (x, y) => (d === 2 ? x === X0 : d === 1 ? x === X1 : d === 8 ? y === Y0 : y === Y1);

function walkTo(sim, gx, gy, max = 900) {
  sim.controller = walkController((x, y) => x === gx && y === gy);
  const ok = sim.runUntil((r) => playing(r) && r[V.ObjX] === gx && r[V.ObjY] === gy && r[V.ObjGridOffset] === 0, max);
  sim.controller = () => 0;
  if (!ok && process.env.P15_DEBUG) {
    const r = sim.ram; ram.set(r); sram.set(sim.o.sram);
    console.log('first', hex(r[V.ObjectFirstUnwalkableTile]), 'grid', r[V.ObjGridOffset], 'mode', r[V.GameMode], [8, 4, 2, 1].map((d) => walkable(r[V.ObjX], r[V.ObjY], d)));
    for (let y = 0x7d; y <= 0xad; y += 8) console.log(hex(y), [0x70, 0x78, 0x80, 0x88, 0x90, 0xa0, 0xb0].map((x) => hex(rawTileStill(x, y))).join(' '));
  }
  if (!ok) throw new Error(`walkTo(${hex(gx)},${hex(gy)}) failed in room ${hex(sim.ram[V.RoomId])} at (${hex(sim.ram[V.ObjX])},${hex(sim.ram[V.ObjY])})`);
}

function exitRoom(sim, d, max = 1500) {
  const room = sim.ram[V.RoomId];
  const ctl = walkController(atEdge(d));
  sim.controller = (r, f) => {
    const b = ctl(r, f);
    return ctl.arrived ? DIR_BTN[d] : b;
  };
  const ok = sim.runUntil((r) => r[V.GameMode] === 5 && r[V.IsUpdatingMode] !== 0 && r[V.RoomId] !== room, max);
  sim.controller = () => 0;
  if (!ok) throw new Error(`exitRoom(${d}) from ${hex(room)} failed`);
  sim.runUntil(() => false, 4);
}

/** Walks onto the cave entrance of the room and waits until the cave (mode $B) is being played. */
function enterCave(sim, max = 1500) {
  const goal = (x, y) => isWarpTile(rawTileStill(x, y));
  const ctl = walkController(goal, { sword: false });
  let push = 0;
  sim.controller = (r, f) => {
    if (r[V.GameMode] !== 5) return 0;
    const b = ctl(r, f);
    if (ctl.arrived) return push || B.U;
    if (b & 0x0f) push = b;
    return b;
  };
  const ok = sim.runUntil((r) => r[V.GameMode] === 0x0b && r[V.IsUpdatingMode] !== 0, max);
  sim.controller = () => 0;
  if (!ok && process.env.P15_DEBUG) {
    const r = sim.ram;
    console.log('uet', r[V.UndergroundExitType], 'grid', r[V.ObjGridOffset], 'coll', hex(r[V.ObjCollidedTile]), 'dir', r[V.ObjDir], 'st', r[V.ObjState], 'inputs', sim.inputs.slice(-10).join(','));
  }
  if (!ok) throw new Error(`enterCave failed in room ${hex(sim.ram[V.RoomId])} at (${hex(sim.ram[V.ObjX])},${hex(sim.ram[V.ObjY])}) mode ${sim.ram[V.GameMode]}`);
}

/** Leaves the cave down through the entrance; waits until playing in the overworld again. */
function leaveCave(sim, max = 1200) {
  walkTo(sim, 0x70, 0xdd);
  sim.controller = (r) => (r[V.GameMode] === 0x0b ? B.D : 0);
  const ok = sim.runUntil((r) => r[V.GameMode] === 5 && r[V.IsUpdatingMode] !== 0, max);
  sim.controller = () => 0;
  if (!ok) throw new Error('leaveCave failed');
  sim.play([[30, 0], [24, B.D], [20, 0]]); // step off the entrance (UndergroundExitType back to 0)
}

function selectItem(sim, slot) {
  if (sim.ram[V.SelectedItemSlot] === slot) return;
  sim.play([[2, B.T], [90, 0]]);
  for (let i = 0; i < 10 && sim.ram[V.SelectedItemSlot] !== slot; i++) sim.play([[2, B.R], [12, 0]]);
  if (sim.ram[V.SelectedItemSlot] !== slot) throw new Error(`selectItem(${slot}) failed`);
  sim.play([[2, B.T], [90, 0]]);
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

export async function makeP15Sram() {
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
  set(V.InvRupees, 200);
  return s;
}

async function ensureSram(force = false) {
  if (!force && existsSync(SRAM_PATH)) return new Uint8Array(readFileSync(SRAM_PATH));
  const s = await makeP15Sram();
  writeFileSync(SRAM_PATH, s);
  console.log(`wrote ${SRAM_FILE}`);
  return s;
}

async function startGame(sramInit) {
  const sim = await new Sim(sramInit, expand([...prefixMenu(), [2, B.T], [240, 0]])).start();
  currentSim = sim;
  sim.runUntil(() => false, sim.inputs.length);
  const r = sim.ram;
  if (r[V.GameMode] !== 5 || r[V.RoomId] !== 0x77) throw new Error(`start: mode ${r[V.GameMode]} room ${r[V.RoomId]}`);
  if (r[V.InvRupees] !== 200) throw new Error('start: rupees not set (SRAM edit rejected?)');
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

async function check(name) {
  const expect = JSON.parse(readFileSync(join(MOVIES, `${name}.expect.json`), 'utf8'));
  const s = new Uint8Array(readFileSync(join(MOVIES, expect.sram)));
  const o = await Oracle.create({ rom: rom.bytes, sram: s, powerOnFill: 0 });
  const seen = {};
  const addr = (k) => V[k.replace(/\+.*/, '')] + Number(k.split('+')[1] ?? 0);
  for (const k of Object.keys(expect.reaches)) seen[k] = new Set();
  o.run(loadMovie(join(MOVIES, `${name}.zmv`)), {
    write(rec) { for (const k of Object.keys(expect.reaches)) seen[k].add(rec.ram[addr(k)]); },
  });
  for (const [k, vals] of Object.entries(expect.reaches)) {
    for (const v of [].concat(vals)) if (!seen[k].has(v)) throw new Error(`${name}: ${k} never reaches ${v}`);
  }
  console.log(`${name}: expectations OK`);
}

const COMMON = (what) => [
  `P15: continue the prepared file (tests/oracle/movies/${SRAM_FILE}: wooden sword, 8 bombs, 200 rupees), then`,
  what,
  'Generated by tests/game/p15-make-movies.mjs (closed-loop on the original game).',
  `Run the oracle with --sram tests/oracle/movies/${SRAM_FILE}.`,
];

// ------------------------------------------------------------------ scenarios

const SLOT_BOMB = 1;

/** In the cave, after the text: walk onto the ware at index i (X $58/$78/$98, Y $9D). */
function pickWare(sim, i, doneState) {
  if (!sim.runUntil((r) => r[V.ObjState + 1] === 2, 900)) throw new Error(`cave person never reached state 2 (${sim.ram[V.ObjState + 1]})`);
  const wx = [0x58, 0x78, 0x98][i];
  walkTo(sim, wx, 0xad); // below the ware first: never walk over another ware
  sim.controller = walkController((x, y) => x === wx && y === 0x9d, { sword: false });
  const ok = sim.runUntil((r) => doneState(r[V.ObjState + 1]), 900);
  sim.controller = () => 0;
  if (!ok && process.env.P15_DEBUG) {
    const r = sim.ram;
    ram.set(r); sram.set(sim.o.sram);
    for (const d of [8, 4, 2, 1]) console.log('dir', d, walkable(r[V.ObjX], r[V.ObjY], d), 'mode', r[V.GameMode], 'upd', r[V.IsUpdatingMode], 'state0', r[V.ObjState], 'grid', r[V.ObjGridOffset], 'first', r[V.ObjectFirstUnwalkableTile].toString(16));
  }
  if (!ok) throw new Error(`pickWare(${i}) failed: state ${sim.ram[V.ObjState + 1]} at (${hex(sim.ram[V.ObjX])},${hex(sim.ram[V.ObjY])})`);
}

async function makeShopBuy(s) {
  const sim = await startGame(s);
  exitRoom(sim, 8); // $67
  exitRoom(sim, 2); // $66
  enterCave(sim);
  if (sim.ram[V.ObjType + 1] !== 0x78) throw new Error(`shop-buy: cave type ${hex(sim.ram[V.ObjType + 1])}`);
  pickWare(sim, 2, (st) => st >= 3); // the ware on the right: 60 rupees
  // Item lifted, rupees counted down, the shopkeeper flickers (state 4) and leaves.
  if (!sim.runUntil((r) => r[V.ObjType + 1] === 0 && r[V.RupeesToSubtract] === 0 && r[V.ObjState] === 0, 900)) {
    throw new Error('shop-buy: the shopkeeper did not leave');
  }
  sim.play([[30, 0]]);
  leaveCave(sim);
  writeMovie('shop-buy', COMMON('walk $77 -> $67 -> $66, enter the shop (type $78), buy the ware on the right '
    + '(60 rupees) and leave.'), sim.used(), {
    comment: 'Shop in $66: prices, textbox, purchase (PostDebit, TakeItem), states 3-4, shopkeeper gone.',
    sram: SRAM_FILE,
    reaches: { RoomId: [0x67, 0x66], GameMode: [0x0b, 0x0a], 'ObjType+1': [0x78], 'ObjState+1': [0, 1, 2, 3, 4], InvRupees: [140] },
  });
}

async function makeMoneyGame(s) {
  const sim = await startGame(s);
  selectItem(sim, SLOT_BOMB);
  exitRoom(sim, 2); // $76
  walkTo(sim, 0x60, 0x5d); // below the rock wall at ($60,$50)
  sim.play([[2, B.U], [2, 0], [2, B.B], [150, 0]]);
  if (sim.ram[V.ObjType + 11] !== 0) throw new Error('money-game: the wall was not opened');
  if (process.env.P15_DEBUG) {
    ram.set(sim.ram); sram.set(sim.o.sram);
    for (let y = 0x3d; y <= 0x6d; y += 8) console.log(hex(y), [0x50, 0x58, 0x60, 0x68, 0x70].map((x) => hex(rawTileStill(x, y))).join(' '));
  }
  for (const ware of [0, 2]) {
    enterCave(sim);
    if (sim.ram[V.ObjType + 1] !== 0x70) throw new Error(`money-game: cave type ${hex(sim.ram[V.ObjType + 1])}`);
    pickWare(sim, ware, (st) => st === 8);
    if (process.env.P15_DEBUG) console.log('ware', ware, 'chosen', sim.ram[V.CaveChosenIndex], 'rupees', sim.ram[V.InvRupees], 'frame', sim.frame, 'amounts', [0, 1, 2].map((i) => sim.ram[V.MoneyGameAmounts + i]));
    sim.runUntil((r) => r[V.RupeesToSubtract] === 0 && r[V.RupeesToAdd] === 0, 600);
    sim.play([[60, 0]]);
    leaveCave(sim);
  }
  writeMovie('money-game', COMMON('walk to $76, bomb the rock wall at ($60,$50), play the money-making game '
    + '(type $70) on the left ware, leave, enter again and play the right ware.'), sim.used(), {
    comment: 'Money-making game in $76: InitCave permutation/amounts, state 5 (signs, PostCredit/PostDebit), twice.',
    sram: SRAM_FILE,
    reaches: { RoomId: [0x76], GameMode: [0x0b, 0x0a], 'ObjType+1': [0x70], 'ObjState+1': [0, 1, 2, 5, 8], CaveChosenIndex: [0, 2] },
  });
}

/**
 * uw-level1-full (p08-items.sav) up to frame 10250 (room $42 of level 1, its monsters killed, as
 * tests/game/p16-make-movies.mjs#makePushBlock), push the block (west shutter), then west into $41: the old man ($4C, level 1 uses
 * UpdateUnderworldPersonComplex) tells his hint; Link hits him with the sword (Person_CheckCollisions:
 * PersonFireballsEnabled, the bonfires shoot) and leaves east.
 */
async function makeOldManHint() {
  const src = loadMovie(join(MOVIES, 'uw-level1-full.zmv'));
  const s = new Uint8Array(readFileSync(join(MOVIES, 'p08-items.sav')));
  const sim = await new Sim(s, Array.from(src.p1.subarray(0, 10250))).start();
  currentSim = sim;
  sim.runUntil(() => false, 10250);
  if (sim.ram[V.RoomId] !== 0x42 || sim.ram[V.CurLevel] !== 1) throw new Error('uw-old-man-hint: not in $42 of level 1');
  // The west door is a shutter opened by the push block at ($70,$90) (as p16's uw-push-block).
  sim.play([[90, B.L], [30, 0]]);
  if (!sim.ram[V.BlockPushComplete]) throw new Error('uw-old-man-hint: block not pushed');
  sim.play([[60, 0]]);
  walkTo(sim, 0x20, 0x8d);
  sim.controller = (r) => (r[V.RoomId] === 0x42 ? B.L : 0);
  if (!sim.runUntil((r) => r[V.RoomId] === 0x41 && r[V.GameMode] === 5 && r[V.IsUpdatingMode] !== 0, 600)) {
    throw new Error(`uw-old-man-hint: did not reach $41 (room ${hex(sim.ram[V.RoomId])})`);
  }
  sim.controller = () => 0;
  if (sim.ram[V.ObjType + 1] !== 0x4c) throw new Error(`uw-old-man-hint: person type ${hex(sim.ram[V.ObjType + 1])}`);
  if (!sim.runUntil((r) => r[V.ObjState + 1] === 2, 1200)) throw new Error('uw-old-man-hint: text did not end');
  // Walk up to the old man and hit him.
  sim.play([[32, B.L], [4, 0]]); // out of the doorway
  walkTo(sim, 0x78, 0x9d);
  sim.play([[2, B.U], [4, 0]]);
  for (let i = 0; i < 4 && !sim.ram[V.PersonFireballsEnabled]; i++) sim.play([[2, B.A], [16, 0]]);
  const fireballs = sim.ram[V.PersonFireballsEnabled]; // the metastate of the "dying" old man
  if (!fireballs) throw new Error('uw-old-man-hint: the old man was not hit');
  sim.play([[120, 0]]);
  // Leave east.
  walkTo(sim, 0xc0, 0x8d);
  sim.controller = (r) => (r[V.RoomId] === 0x41 ? B.R : 0);
  if (!sim.runUntil((r) => r[V.RoomId] === 0x42 && r[V.GameMode] === 5 && r[V.IsUpdatingMode] !== 0, 600)) {
    throw new Error('uw-old-man-hint: did not leave east');
  }
  sim.controller = () => 0;
  sim.play([[60, 0]]);
  writeMovie('uw-old-man-hint', [
    'P15: uw-level1-full (tests/oracle/movies/p08-items.sav) up to frame 10250 (room $42 of level 1, monsters',
    'killed), push the block (the west shutter opens), then west into $41: the old man ($4C) shows his hint (UpdateUnderworldPersonComplex, textbox),',
    'Link hits him (PersonFireballsEnabled: the bonfires shoot) and leaves east.',
    'Generated by tests/game/p15-make-movies.mjs. Run the oracle with --sram tests/oracle/movies/p08-items.sav.',
  ], sim.used(), {
    comment: 'Old man with a hint in room $41 of level 1; hit with the sword.', sram: 'p08-items.sav',
    reaches: { RoomId: [0x41], 'ObjType+1': [0x4c], 'ObjState+1': [0, 1, 2], PersonFireballsEnabled: [fireballs] },
  });
}

async function main() {
  await init();
  const what = process.argv[2] ?? 'all';
  const s = await ensureSram(what === 'sram');
  const jobs = { shop: () => makeShopBuy(s), money: () => makeMoneyGame(s), hint: () => makeOldManHint() };
  const names = { shop: 'shop-buy', money: 'money-game', hint: 'uw-old-man-hint' };
  const run = what === 'all' ? Object.keys(jobs) : what === 'sram' ? [] : [what];
  for (const k of run) {
    await jobs[k]();
    await check(names[k]);
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
