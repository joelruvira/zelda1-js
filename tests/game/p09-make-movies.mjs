#!/usr/bin/env node
// Generator of the P09 (weapons) oracle scenarios. Run:  node tests/game/p09-make-movies.mjs [sram|kill|items|dark|all]
//
//  * p09-items.sav (tests/oracle/movies/): p08-items.sav (rebuilt by p08-make-movies#makeItemsSram if
//    missing; slot 1 with sword, ladder, magic shield, red ring, magic key, 16 full hearts) plus every
//    usable item: white sword, magic boomerang, 8 bombs, bow + silver arrows, red candle, recorder,
//    bait, 2 potions, rod, magic book, 255 rupees and the level 5 triforce piece (so the recorder
//    summons the whirlwind). File A's checksum is fixed. Player area $6000-$652F only, no ROM data.
//  * ow-sword-kill.zmv (p08-items.sav): walk $77 -> $78 and kill its monsters with the sword and the
//    sword shots (full hearts), then on to $68 hunting there too.
//  * items-all.zmv (p09-items.sav): in room $77, select each item in the submenu and use it: sword
//    shot (spreads at the edge), magic boomerang (straight and diagonal, caught back), two bombs,
//    arrows, red candle fires (Link walks into one and is hurt), the rod's magic shot (fire with the
//    book), bait, a potion (refills the hearts), and the recorder (the whirlwind comes).
//  * dark-room-candle.zmv (p09-items.sav): recorder -> whirlwind to level 5's entrance, enter level 5
//    ($76), go north to the dark room $66, brighten it with the candle (UpdateCandle), then bomb its
//    west bombable wall (Bomb_CheckState4 / TriggeredDoorCmd).
// The routes are found by a closed-loop controller that plays the ORIGINAL game in the oracle (BFS
// over Link's 8-pixel grid with the port's tile collision on the oracle's RAM/SRAM). Every movie is
// replayed from power-on to check it reaches the expected state.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { createMovie, serializeZmv } from '../../tools/oracle/lib/movie.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram } from '../../src/core/ram.js';
import {
  GameMode, RoomId, ObjX, ObjY, ObjDir, ObjGridOffset, ObjectFirstUnwalkableTile, CurLevel, ObjType,
  ObjShoveDir, IsUpdatingMode, ObjState, ObjMetastate, Items, InvBombs, InvArrow, Bow, InvCandle, InvFood,
  Potion, InvBook, InvRupees, InvBoomerang, InvMagicBoomerang, InvTriforce, SaveFileAItems0, FileAChecksums,
  MenuState, SelectedItemSlot, HeartValues, HeartPartial, CandleState, BrighteningRoom, TriggeredDoorCmd,
  RoomKillCount, WorldKillCycle, FluteTimer, CurOpenedDoors, Paused, World_IsFillingHearts,
} from '../../src/core/vars.js';

const MOVIES = join(import.meta.dirname, '..', 'oracle', 'movies');
const B = { A: 0x80, B: 0x40, S: 0x20, T: 0x10, U: 0x08, D: 0x04, L: 0x02, R: 0x01 };
const DIR_BTN = { 1: B.R, 2: B.L, 4: B.D, 8: B.U };
const DXY = { 1: [8, 0], 2: [-8, 0], 4: [0, 8], 8: [0, -8] };
const DOOR = { 8: [0x78, 0x5d], 4: [0x78, 0xbd], 2: [0x20, 0x8d], 1: [0xd0, 0x8d] };
const INV_FLUTE = Items + 5; // $65C (no name in Variables.inc)
const INV_ROD = Items + 8; // $65F
const hex = (v) => `$${v.toString(16).padStart(2, '0')}`;

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

// ------------------------------------------------------------------ SRAM

async function p08Sram() {
  const p8 = join(MOVIES, 'p08-items.sav');
  if (existsSync(p8)) return Uint8Array.from(readFileSync(p8));
  const { makeItemsSram } = await import('./p08-make-movies.mjs');
  const s = await makeItemsSram();
  writeFileSync(p8, s);
  return s;
}

/** p09-items.sav: p08-items.sav with every usable item (see the header). */
export async function makeP09Sram() {
  const s = await p08Sram();
  const set = (v, value) => {
    const i = SaveFileAItems0 - 0x6000 + (v - Items);
    const delta = value - s[i];
    s[i] = value;
    const c = FileAChecksums - 0x6000;
    const sum = ((((s[c] << 8) | s[c + 1]) + delta) & 0xffff);
    s[c] = sum >> 8;
    s[c + 1] = sum & 0xff;
  };
  set(Items, 2); // white sword
  set(InvBombs, 8);
  set(InvArrow, 2); // silver arrows
  set(Bow, 1);
  set(InvCandle, 2); // red candle
  set(INV_FLUTE, 1);
  set(InvFood, 1);
  set(Potion, 2); // red potion
  set(INV_ROD, 1);
  set(InvBook, 1);
  set(InvRupees, 0xff);
  set(InvBoomerang, 1);
  set(InvMagicBoomerang, 1);
  set(InvTriforce, 0x10); // level 5: the whirlwind goes there
  return s;
}

async function loadSram(name, make) {
  const p = join(MOVIES, name);
  if (existsSync(p)) return Uint8Array.from(readFileSync(p));
  const s = await make();
  writeFileSync(p, s);
  console.log(`wrote ${name}`);
  return s;
}

// ------------------------------------------------------------------ emulator with a controller

class Sim {
  constructor(sramInit, inputs = []) {
    this.sramInit = sramInit;
    this.inputs = [...inputs];
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

  /** Plays fixed inputs: [[n, buttons], ...]. */
  play(runs) {
    const q = [];
    for (const [n, b] of runs) for (let i = 0; i < n; i++) q.push(b);
    const total = q.length;
    this.controller = () => q.shift() ?? 0;
    this.runUntil(() => false, total);
    this.controller = () => 0;
  }

  used() { return this.inputs.slice(0, this.frame); }
}

const playing = (r) => r[GameMode] === 5 && r[IsUpdatingMode] !== 0;

/** Title -> Start -> menu (slot 1) -> Start: game in $77. */
async function startGame(sramInit) {
  const sim = await new Sim(sramInit).start();
  sim.play([[120, 0], [2, B.T], [90, 0], [2, B.T], [240, 0]]);
  if (!playing(sim.ram) || sim.ram[RoomId] !== 0x77) throw new Error('start: not playing in $77');
  return sim;
}

// ------------------------------------------------------------------ grid planning (port collision)

function syncPort(sim) {
  ram.set(sim.ram);
  sram.set(sim.o.sram);
}

function walkable(x, y, d) {
  ram[ObjX] = x;
  ram[ObjY] = y;
  ram[0x0f] = d;
  return GetCollidingTileMoving(0) < ram[ObjectFirstUnwalkableTile];
}

function rawTileStill(x, y) {
  const lvl = ram[CurLevel];
  ram[CurLevel] = 1;
  ram[ObjX] = x;
  ram[ObjY] = y;
  const t = GetCollidableTileStill(0);
  ram[CurLevel] = lvl;
  return t;
}

const isWarpTile = (t) => t === 0x24 || t === 0x88 || (t >= 0x70 && t < 0x74);
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
      if (!allowWarp && isWarpTile(rawTileStill(nx, ny)) && !goal(nx, ny)) continue;
      first.set(k, first.get(key(x, y)) || d);
      if (goal(nx, ny)) return first.get(k);
      q.push([nx, ny]);
    }
  }
  return 0;
}

const isMonster = (r, i) => r[ObjType + i] !== 0 && r[ObjType + i] < 0x53 && r[ObjMetastate + i] === 0;

function nearest(list, x, y) {
  let best = null, bd = 1e9;
  for (const p of list) {
    const d = Math.abs(p.x - x) + Math.abs(p.y - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/**
 * Controller: hunts monsters with the sword while hunt() says so (lines up with the nearest one at
 * 8..24 pixels and swings), else walks to goal() (allowWarp: onto a cave/stairs tile) and then holds
 * finalDir.
 */
function controller(sim, { goal = null, finalDir = 0, hunt = () => false, allowWarp = false, past = null } = {}) {
  const blocked = new Set();
  let last = null, still = 0, lastDir = 0, phase = 0;
  return (r) => {
    if (!playing(r) || r[ObjShoveDir] !== 0) return 0;
    const x = r[ObjX], y = r[ObjY];
    const pos = `${x},${y}`;
    if (pos === last && lastDir) {
      if (++still > 24) { blocked.add(`${x},${y},${lastDir}`); still = 0; }
    } else { still = 0; }
    last = pos;
    phase++;
    if (r[ObjGridOffset] !== 0) { lastDir = r[ObjDir]; return DIR_BTN[r[ObjDir]] ?? 0; }
    syncPort(sim);
    const monsters = [];
    for (let i = 1; i < 0x0c; i++) if (isMonster(r, i)) monsters.push({ x: r[ObjX + i], y: r[ObjY + i] });
    let g = goal, faceTo = 0;
    if (monsters.length && hunt(r)) {
      const m = nearest(monsters, x, y);
      g = (gx, gy) => {
        const dx = m.x - gx, dy = m.y - gy;
        return (Math.abs(dy) < 8 && Math.abs(dx) >= 8 && Math.abs(dx) <= 24)
          || (Math.abs(dx) < 8 && Math.abs(dy) >= 8 && Math.abs(dy) <= 24);
      };
      const dx = m.x - x, dy = m.y - y;
      faceTo = Math.abs(dy) < 8 ? (dx > 0 ? 1 : 2) : (dy > 0 ? 4 : 8);
    }
    if (!g) return 0;
    if (past?.(x, y)) { lastDir = finalDir; return DIR_BTN[finalDir]; } // in the doorway: keep pushing
    const d = planStep(x, y, g, { blocked, allowWarp });
    if (d === -1) {
      if (faceTo) {
        lastDir = 0;
        if (r[ObjDir] !== faceTo) return DIR_BTN[faceTo];
        return phase % 4 === 0 ? B.A : 0;
      }
      lastDir = finalDir;
      return finalDir ? DIR_BTN[finalDir] : 0;
    }
    if (d === 0) { lastDir = 0; return phase % 8 === 0 ? B.A : 0; }
    lastDir = d;
    return DIR_BTN[d];
  };
}

/** Walks through doorway/edge `d` of the current room (DOOR grid point, then hold d). */
function goThrough(sim, d, max = 2000) {
  const room = sim.ram[RoomId];
  let goal, past = null;
  if (sim.ram[CurLevel] !== 0) {
    const [gx, gy] = DOOR[d];
    goal = (x, y) => x === gx && y === gy;
    past = (x, y) => (d === 8 ? y < gy && x === gx : d === 4 ? y > gy && x === gx : d === 2 ? x < gx && y === gy : x > gx && y === gy);
  } else {
    goal = (x, y) => (d === 2 ? x === X0 : d === 1 ? x === X1 : d === 8 ? y === Y0 : y === Y1);
  }
  sim.controller = controller(sim, { goal, finalDir: d, past });
  const ok = sim.runUntil((r) => playing(r) && r[RoomId] !== room, max);
  sim.controller = () => 0;
  if (!ok) {
    const r = sim.ram;
    if (process.env.P09_DEBUG_MOVIE) writeFileSync(process.env.P09_DEBUG_MOVIE, serializeZmv(createMovie(Uint8Array.from(sim.used()), null, { name: 'debug' })));
    throw new Error(`cannot leave ${hex(room)} by ${d} (frame ${sim.frame}, Link ${hex(r[ObjX])},${hex(r[ObjY])} mode ${r[GameMode]} hearts ${hex(r[HeartValues])})`);
  }
}

/** Walks Link to grid point (gx, gy) of the current room. */
function walkTo(sim, gx, gy, max = 1500) {
  sim.controller = controller(sim, { goal: (x, y) => x === gx && y === gy });
  const ok = sim.runUntil((r) => playing(r) && r[ObjX] === gx && r[ObjY] === gy && r[ObjGridOffset] === 0, max);
  sim.controller = () => 0;
  if (!ok) throw new Error(`cannot walk to ${hex(gx)},${hex(gy)} in ${hex(sim.ram[RoomId])} (frame ${sim.frame})`);
}

/** Opens the submenu, moves the cursor to item slot `slot`, closes it. */
function selectItem(sim, slot) {
  const active = () => (sim.ram[CurLevel] === 0 ? 8 : 7);
  let opened = false;
  sim.controller = (r, n) => {
    if (r[MenuState] === 0) return !opened && playing(r) && n % 2 === 0 ? B.T : 0;
    opened = true;
    if (r[MenuState] !== active()) return 0;
    if (n % 2) return 0;
    return r[SelectedItemSlot] === slot ? B.T : B.R;
  };
  const ok = sim.runUntil((r) => opened && r[MenuState] === 0 && playing(r), 900);
  sim.controller = () => 0;
  if (!ok || sim.ram[SelectedItemSlot] !== slot) throw new Error(`cannot select item ${slot} (frame ${sim.frame})`);
}

/** Faces direction d (1 frame), then presses `btn` (2 frames) and waits `wait` frames. */
function use(sim, d, btn, wait) {
  sim.play([[1, DIR_BTN[d] ?? d], [1, 0], [2, btn], [wait, 0]]);
}

function writeMovie(name, comment, inputs) {
  const m = createMovie(Uint8Array.from(inputs), null, { name });
  writeFileSync(join(MOVIES, `${name}.zmv`),
    serializeZmv(m).replace(/^zmv 1\n/, `zmv 1\n${comment.map((c) => `# ${c}`).join('\n')}\n`));
}

function writeExpect(name, obj) {
  writeFileSync(join(MOVIES, `${name}.expect.json`), `${JSON.stringify(obj, null, 2)}\n`);
}

/** Replays `inputs` from power-on and records the values each watched variable takes. */
async function replayWatch(sramInit, inputs, vars) {
  const sim = await new Sim(sramInit, inputs).start();
  const seen = Object.fromEntries(Object.keys(vars).map((k) => [k, new Set()]));
  sim.runUntil((r) => {
    for (const [k, addr] of Object.entries(vars)) seen[k].add(r[addr]);
    return false;
  }, inputs.length);
  return seen;
}

function checkReaches(name, seen, reaches) {
  for (const [k, values] of Object.entries(reaches)) {
    for (const v of values) {
      if (!seen[k].has(v)) throw new Error(`${name}: ${k} never reaches ${hex(v)} (seen ${[...seen[k]].map(hex).join(' ')})`);
    }
  }
}

// ------------------------------------------------------------------ scenarios

export async function makeSwordKill() {
  const s = await p08Sram();
  const sim = await startGame(s);
  // $77 -> $78, hunt there (sword and sword shots), then $68 and hunt.
  goThrough(sim, 1);
  for (const room of [0x78, 0x68]) {
    if (sim.ram[RoomId] !== room) throw new Error(`expected ${hex(room)}, in ${hex(sim.ram[RoomId])}`);
    const start = sim.frame;
    const k0 = sim.ram[WorldKillCycle];
    sim.controller = controller(sim, { hunt: () => true });
    sim.runUntil((r) => {
      let n = 0;
      for (let i = 1; i < 0x0c; i++) if (isMonster(r, i)) n++;
      return (n === 0 && sim.frame - start > 120) || sim.frame - start > 2400;
    }, 2500);
    sim.controller = () => 0;
    console.log(`ow-sword-kill: ${hex(room)} kills ${(sim.ram[WorldKillCycle] - k0) & 0xff} frame ${sim.frame}`);
    if (room === 0x78) goThrough(sim, 8);
  }
  sim.play([[30, 0]]);
  const inputs = sim.used();
  const reaches = { RoomId: [0x77, 0x78, 0x68], 'ObjState+14': [0x10, 0x11], 'ObjMetastate+1': [0x10, 0x11] };
  const seen = await replayWatch(s, inputs, {
    RoomId, 'ObjState+14': ObjState + 0x0e, 'ObjMetastate+1': ObjMetastate + 1, RoomKillCount,
  });
  checkReaches('ow-sword-kill', seen, reaches);
  writeExpect('ow-sword-kill', {
    comment: 'Kill monsters with the sword and the sword shot (full hearts) in $78 and $68.',
    sram: 'p08-items.sav',
    reaches,
  });
  writeMovie('ow-sword-kill', [
    'P09: from tests/oracle/movies/p08-items.sav (wooden sword, 16 full hearts), walk $77 -> $78 and',
    'hunt its monsters with the sword (sword shots fly while the hearts are full), then $68 and hunt.',
    'Generated by tests/game/p09-make-movies.mjs. Run with --sram tests/oracle/movies/p08-items.sav.',
  ], inputs);
  console.log(`ow-sword-kill: ${inputs.length} frames`);
}

export async function makeItemsAll() {
  const s = await loadSram('p09-items.sav', makeP09Sram);
  const sim = await startGame(s);
  // Sword shot to the right (spreads at the edge), and up.
  use(sim, 1, B.A, 50);
  use(sim, 8, B.A, 50);
  // Magic boomerang (slot 0): right, then diagonal up-left; it comes back and is caught.
  selectItem(sim, 0);
  use(sim, 1, B.B, 90);
  sim.play([[1, B.U | B.L], [2, B.U | B.L | B.B], [90, 0]]);
  // A bomb; a second one is refused while the first has not blasted; one more right after the blast
  // (slots $10 and $11), then wait for both blasts and clouds.
  selectItem(sim, 1);
  use(sim, 4, B.B, 4);
  use(sim, 2, B.B, 4);
  sim.runUntil((r) => r[ObjState + 0x10] === 0x13, 120);
  use(sim, 8, B.B, 120);
  // Silver arrows (bow): right, up, left.
  selectItem(sim, 2);
  use(sim, 1, B.B, 40);
  use(sim, 8, B.B, 40);
  use(sim, 2, B.B, 40);
  // Red candle: two fires; then walk into a standing fire (Link is shoved and hurt).
  selectItem(sim, 4);
  use(sim, 1, B.B, 10);
  use(sim, 4, B.B, 30);
  sim.play([[24, B.R], [60, 0]]);
  // Rod: magic shot left and right (blocked at the edge: a fire with the book).
  selectItem(sim, 8);
  use(sim, 2, B.B, 70);
  use(sim, 1, B.B, 70);
  // Bomb with a fire in the other slot.
  selectItem(sim, 4);
  use(sim, 8, B.B, 4);
  selectItem(sim, 1);
  use(sim, 4, B.B, 110);
  // Bait (lasts a long time; slot $0F).
  selectItem(sim, 6);
  use(sim, 2, B.B, 60);
  // Potion: refill the hearts (the fire hurt Link).
  selectItem(sim, 7);
  use(sim, 1, B.B, 10);
  sim.runUntil((r) => r[World_IsFillingHearts] === 0 && r[Paused] === 0, 600);
  sim.play([[20, 0]]);
  // Recorder: the tune, then the whirlwind (level 5 triforce) takes Link away.
  selectItem(sim, 5);
  use(sim, 4, B.B, 10);
  if (!sim.runUntil((r) => playing(r) && r[RoomId] !== 0x77, 1500)) throw new Error('items-all: no whirlwind');
  sim.play([[60, 0]]);
  const inputs = sim.used();
  const vars = {
    SelectedItemSlot, 'ObjState+13': ObjState + 0x0d, 'ObjState+14': ObjState + 0x0e, 'ObjState+15': ObjState + 0x0f,
    'ObjState+16': ObjState + 0x10, 'ObjState+17': ObjState + 0x11, 'ObjState+18': ObjState + 0x12,
    Potion, InvBombs, FluteTimer, RoomId, HeartPartial, World_IsFillingHearts,
  };
  const seen = await replayWatch(s, inputs, vars);
  const reaches = {
    SelectedItemSlot: [0, 1, 2, 4, 5, 6, 7, 8],
    'ObjState+14': [0x10, 0x11, 0x80], // sword shot, spreading, magic shot
    'ObjState+15': [0x10, 0x20, 0x28, 0x50, 0x80, 0x81], // boomerang: fly, spark, return; bait
    'ObjState+16': [0x12, 0x13, 0x14, 0x21, 0x22],
    'ObjState+17': [0x12, 0x13, 0x14, 0x21, 0x22],
    'ObjState+18': [0x10, 0x20, 0x31, 0x33],
    Potion: [1],
    World_IsFillingHearts: [1],
    FluteTimer: [0x98],
  };
  checkReaches('items-all', seen, reaches);
  writeExpect('items-all', {
    comment: 'Every usable item in room $77: sword shot, magic boomerang, bombs, arrows, candle, rod + book, bait, potion, recorder (whirlwind).',
    sram: 'p09-items.sav',
    reaches,
  });
  writeMovie('items-all', [
    'P09: from tests/oracle/movies/p09-items.sav (every usable item), in room $77 select each item in the',
    'submenu and use it: sword shot, magic boomerang (straight, diagonal), two bombs, silver arrows, red',
    'candle (Link walks into a fire), rod + book (fire where the magic shot is blocked), bomb next to a',
    'fire, bait, potion (refills the hearts) and the recorder (the whirlwind takes Link to level 5).',
    'Generated by tests/game/p09-make-movies.mjs. Run with --sram tests/oracle/movies/p09-items.sav.',
  ], inputs);
  console.log(`items-all: ${inputs.length} frames, ended in ${hex(sim.ram[RoomId])}`);
}

export async function makeDarkRoomCandle() {
  const s = await loadSram('p09-items.sav', makeP09Sram);
  const sim = await startGame(s);
  // Recorder -> whirlwind to level 5's entrance room.
  selectItem(sim, 5);
  use(sim, 4, B.B, 10);
  if (!sim.runUntil((r) => playing(r) && r[RoomId] !== 0x77, 1500)) throw new Error('dark: no whirlwind');
  sim.play([[30, 0]]);
  console.log(`dark-room-candle: whirlwind to ${hex(sim.ram[RoomId])} frame ${sim.frame}`);
  // Onto the level entrance.
  syncPort(sim);
  let target = null;
  for (let x = X0; x <= X1 && !target; x += 8) {
    for (let y = Y0; y <= Y1; y += 8) if (isWarpTile(rawTileStill(x, y))) { target = { x, y }; break; }
  }
  if (!target) throw new Error('dark: no entrance tile');
  sim.controller = controller(sim, { goal: (x, y) => x === target.x && y === target.y, finalDir: 8, allowWarp: true });
  if (!sim.runUntil((r) => r[CurLevel] !== 0 && playing(r), 2500)) throw new Error('dark: did not enter the level');
  sim.controller = () => 0;
  console.log(`dark-room-candle: level ${sim.ram[CurLevel]} room ${hex(sim.ram[RoomId])} frame ${sim.frame}`);
  if (sim.ram[RoomId] !== 0x76) throw new Error('dark: not in $76');
  goThrough(sim, 8);
  if (sim.ram[RoomId] !== 0x66) throw new Error('dark: not in $66');
  sim.play([[30, 0]]);
  walkTo(sim, 0x78, 0x9d);
  // Candle: brighten the room.
  selectItem(sim, 4);
  use(sim, 8, B.B, 10);
  if (!sim.runUntil((r) => r[CandleState] === 2 && r[BrighteningRoom] === 0, 600)) {
    if (process.env.P09_DEBUG_MOVIE) writeFileSync(process.env.P09_DEBUG_MOVIE, serializeZmv(createMovie(Uint8Array.from(sim.used()), null, { name: 'debug' })));
    throw new Error('dark: room not brightened');
  }
  sim.play([[20, 0]]);
  // Bomb the west bombable wall.
  walkTo(sim, 0x30, 0x8d);
  selectItem(sim, 1);
  use(sim, 2, B.B, 150);
  const inputs = sim.used();
  if (process.env.P09_DEBUG_MOVIE) writeFileSync(process.env.P09_DEBUG_MOVIE, serializeZmv(createMovie(Uint8Array.from(inputs), null, { name: 'debug' })));
  const seen = await replayWatch(s, inputs, { RoomId, CurLevel, CandleState, BrighteningRoom, TriggeredDoorCmd, CurOpenedDoors });
  const reaches = { CurLevel: [0, 5], RoomId: [0x77, 0x76, 0x66], CandleState: [1, 2], BrighteningRoom: [1], TriggeredDoorCmd: [7], CurOpenedDoors: [2] };
  checkReaches('dark-room-candle', seen, reaches);
  writeExpect('dark-room-candle', {
    comment: 'Whirlwind to level 5, dark room $66 brightened by the candle, its bombable west wall blown open.',
    sram: 'p09-items.sav',
    reaches,
  });
  writeMovie('dark-room-candle', [
    'P09: from tests/oracle/movies/p09-items.sav, play the recorder (the whirlwind takes Link to level',
    "5's entrance), enter level 5 ($76), go north to the dark room $66 and brighten it with the candle",
    '(UpdateFire -> UpdateCandle), then bomb its west bombable wall (Bomb_CheckState4).',
    'Generated by tests/game/p09-make-movies.mjs. Run with --sram tests/oracle/movies/p09-items.sav.',
  ], inputs);
  console.log(`dark-room-candle: ${inputs.length} frames`);
}

if (import.meta.main) {
  await init();
  const what = process.argv[2] ?? 'all';
  if (what === 'sram') writeFileSync(join(MOVIES, 'p09-items.sav'), await makeP09Sram());
  if (what === 'kill' || what === 'all') await makeSwordKill();
  if (what === 'items' || what === 'all') await makeItemsAll();
  if (what === 'dark' || what === 'all') await makeDarkRoomCandle();
}
