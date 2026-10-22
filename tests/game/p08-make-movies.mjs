#!/usr/bin/env node
// Generator of the P08 oracle scenarios. Run:  node tests/game/p08-make-movies.mjs [ladder|sword|uw|sram]
//
//  * p08-items.sav (tests/oracle/movies/, player area $6000-$652F only): SRAM of a game registered in the oracle (slot 1) whose
//    file A gets extra items (sword, ladder, magic shield, red ring, magic key, 16 hearts) with the checksum fixed.
//    Only the save files ($6000-$652F) are kept; the rest (code/data copied from the ROM at boot,
//    play area) is zeroed, so the file holds no ROM data. tests/game/p08-oracle.test.mjs rebuilds it.
//  * ladder-crossing.zmv: from that save, walk from room $77 to a room of LadderRoomsOW and cross
//    water with the ladder there and back. The route is found by a closed-loop controller that plays
//    the ORIGINAL game in the oracle: BFS over rooms; inside a room, BFS over Link's 8-pixel grid using
//    the port's tile collision (GetCollidingTileMoving) on the oracle's RAM/SRAM.
//  * ow-walk-sword.zmv: same save; walk around the first rooms swinging the sword (AnimateLinkObjState,
//    the magic shield tiles, the OW speed on mountain stairs if reached).
//  * uw-doorways.zmv: same save; walk to level 1, enter it and go through doorways.
// Every movie is replayed from power-on in the oracle to check it reaches the expected state.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { createMovie, serializeZmv, loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { loadSymbols, loadRom, table } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram } from '../../src/core/ram.js';
import { bus } from '../../src/core/bus.js';
import {
  GameMode, RoomId, ObjX, ObjY, ObjDir, ObjGridOffset, ObjectFirstUnwalkableTile, CurLevel, ObjType,
  Items, InvLadder, InvMagicShield, InvRing, InvMagicKey, HeartValues, HeartPartial, SaveFileAItems0, FileAChecksums,
  LadderSlot, ObjShoveDir, ObjState, IsUpdatingMode, DoorwayDir, ObjCollidedTile,
} from '../../src/core/vars.js';

export const MOVIES = join(import.meta.dirname, '..', 'oracle', 'movies');
export const SRAM_PATH = join(REPO_ROOT, 'tests', 'oracle', 'movies', 'p08-items.sav');

const B = { A: 0x80, B: 0x40, S: 0x20, T: 0x10, U: 0x08, D: 0x04, L: 0x02, R: 0x01 };
const DIR_BTN = { 1: B.R, 2: B.L, 4: B.D, 8: B.U };
const DXY = { 1: [8, 0], 2: [-8, 0], 4: [0, 8], 8: [0, -8] };
const OPP = { 1: 2, 2: 1, 4: 8, 8: 4 };

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

  /** Inputs actually consumed so far (one per completed frame). */
  used() { return this.inputs.slice(0, this.frame); }
}

// ------------------------------------------------------------------ grid planning (port collision)

function syncPort(r, s) {
  ram.set(r);
  sram.set(s);
}

/** Is the move from grid point (x, y) in direction d allowed by the tile check Link does there? */
function walkable(x, y, d) {
  ram[ObjX] = x;
  ram[ObjY] = y;
  ram[0x0f] = d;
  const t = GetCollidingTileMoving(0);
  return t < ram[ObjectFirstUnwalkableTile];
}

/** Raw tile under Link's feet at (x, y) (the one CheckWarps looks at). */
function rawTileStill(x, y) {
  const lvl = ram[CurLevel];
  ram[CurLevel] = 1; // UW path returns the raw tile
  ram[ObjX] = x;
  ram[ObjY] = y;
  const t = GetCollidableTileStill(0);
  ram[CurLevel] = lvl;
  return t;
}

const isWarpTile = (t) => t === 0x24 || t === 0x88 || (t >= 0x70 && t < 0x74);
const isWaterOW = (t) => t >= 0x8d && t < 0x99;

const X0 = 0x00, X1 = 0xf0, Y0 = 0x3d, Y1 = 0xdd;
const inside = (x, y) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;

/**
 * BFS over grid points from (sx, sy). goal(x, y) -> true. Avoids warp tiles (caves, stairs) unless
 * allowWarp. Returns the first direction to take, or 0 if unreachable, or -1 if already at the goal.
 */
function planStep(sx, sy, goal, { blocked = new Set(), allowWarp = false } = {}) {
  const key = (x, y) => (x << 8) | y;
  const start = key(sx, sy);
  if (goal(sx, sy)) return -1;
  const first = new Map([[start, 0]]);
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

/**
 * Controller: walk Link to a grid point satisfying goal(), then hold `finalDir` (or stop).
 * Swings the sword now and then when a monster is near (keeps Link alive), if `sword`.
 */
function walkController(goal, { finalDir = 0, sword = true, allowWarp = false, onArrive = null } = {}) {
  const blocked = new Set();
  let last = null, still = 0, lastDir = 0, arrived = false;
  return (r, frame) => {
    if (r[GameMode] !== 5 || r[IsUpdatingMode] === 0) return 0;
    if (arrived) return finalDir ? DIR_BTN[finalDir] : 0; // once there, keep pushing finalDir
    if (r[ObjShoveDir] !== 0) return 0;
    const x = r[ObjX], y = r[ObjY];
    // Stuck detection: same position while pushing -> block that edge.
    const pos = `${x},${y}`;
    if (pos === last && lastDir) {
      if (++still > 24) { blocked.add(`${x},${y},${lastDir}`); still = 0; }
    } else { still = 0; }
    last = pos;
    if (sword && frame % 20 === 0 && monsterNear(r, x, y)) { lastDir = 0; return B.A; }
    if (r[ObjGridOffset] !== 0) { lastDir = r[ObjDir]; return DIR_BTN[r[ObjDir]] ?? 0; }
    syncPort(r, sramOf(r));
    const d = planStep(x, y, goal, { blocked, allowWarp });
    if (d === -1) {
      onArrive?.(r, frame);
      arrived = true;
      lastDir = finalDir;
      return finalDir ? DIR_BTN[finalDir] : 0;
    }
    lastDir = d;
    return d ? DIR_BTN[d] : 0;
  };
}

let currentSim = null;
const sramOf = () => currentSim.o.sram;

function monsterNear(r, x, y) {
  for (let i = 1; i < 0x0c; i++) {
    if (r[ObjType + i] === 0 || r[ObjType + i] >= 0x5d) continue;
    if (Math.abs(r[ObjX + i] - x) < 0x20 && Math.abs(r[ObjY + i] - y) < 0x20) return true;
  }
  return false;
}

const atEdge = (d) => (x, y) => (d === 2 ? x === X0 : d === 1 ? x === X1 : d === 8 ? y === Y0 : y === Y1);

// ------------------------------------------------------------------ SRAM with items

const prefixMenu = () => [[120, 0], [2, B.T], [90, 0]];
function expand(runs) {
  const out = [];
  for (const [n, b] of runs) for (let i = 0; i < n; i++) out.push(b);
  return out;
}

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
  // Items of file A, slot 0.
  const set = (v, value) => {
    const i = SaveFileAItems0 - 0x6000 + (v - Items);
    const delta = value - s[i];
    s[i] = value;
    let sum = (s[FileAChecksums - 0x6000] << 8) | s[FileAChecksums - 0x6000 + 1];
    sum = (sum + delta) & 0xffff;
    s[FileAChecksums - 0x6000] = sum >> 8;
    s[FileAChecksums - 0x6000 + 1] = sum & 0xff;
  };
  set(Items, 1); // wooden sword
  set(InvLadder, 1);
  set(InvMagicShield, 1);
  set(InvRing, 2); // red ring: 1/4 damage
  set(InvMagicKey, 1); // opens the locked doors of the levels
  set(HeartValues, 0xff); // 16 heart containers, full
  set(HeartPartial, 0xff);
  return s;
}

/** Writes tests/oracle/movies/p08-items.sav (player area only) (if missing or `force`). */
export async function ensureItemsSram(force = false) {
  if (!force && existsSync(SRAM_PATH)) return readFileSync(SRAM_PATH);
  const s = await makeItemsSram();
  mkdirSync(dirname(SRAM_PATH), { recursive: true });
  writeFileSync(SRAM_PATH, s);
  return s;
}

/** Title -> Start -> menu (slot 1 selected) -> Start: game. */
const startRuns = () => [...prefixMenu(), [2, B.T], [240, 0]];

async function startGame(sramInit) {
  const sim = await new Sim(sramInit, expand(startRuns())).start();
  currentSim = sim;
  sim.runUntil(() => false, sim.inputs.length);
  const r = sim.ram;
  if (r[GameMode] !== 5 || r[RoomId] !== 0x77) throw new Error(`start: mode ${r[GameMode]} room ${r[RoomId]}`);
  if (r[InvLadder] !== 1) throw new Error('start: the ladder is not in the inventory (SRAM edit rejected?)');
  return sim;
}

/** Replay `inputs` (fresh emulator) and return the sim positioned at the end. */
async function replay(sramInit, inputs) {
  const sim = await new Sim(sramInit, inputs).start();
  currentSim = sim;
  sim.runUntil(() => false, inputs.length);
  return sim;
}

/** Walk from the current room through edge `d`; returns the inputs or null. */
async function tryExit(sramInit, inputs, d) {
  const sim = await replay(sramInit, inputs);
  const room = sim.ram[RoomId];
  sim.controller = walkController(atEdge(d), { finalDir: d });
  const ok = sim.runUntil((r) => r[GameMode] === 5 && r[IsUpdatingMode] && r[RoomId] !== room, 900);
  const r = sim.ram;
  if (!ok || r[CurLevel] !== 0) return null;
  sim.controller = () => 0;
  sim.runUntil(() => false, 4);
  return { inputs: sim.used(), room: r[RoomId] };
}

/** BFS over OW rooms from the start until `want(room)`. Returns inputs. */
async function findRoute(sramInit, startInputs, want, maxRooms = 60) {
  const seen = new Set([0x77]);
  const q = [{ inputs: startInputs, room: 0x77 }];
  while (q.length && seen.size < maxRooms) {
    const cur = q.shift();
    for (const d of [8, 1, 2, 4]) {
      const next = await tryExit(sramInit, cur.inputs, d);
      if (!next || seen.has(next.room)) continue;
      seen.add(next.room);
      console.log(`room $${cur.room.toString(16)} -${'RLDU'['1248'.indexOf(String(d)) === -1 ? 0 : [1, 2, 4, 8].indexOf(d)]}-> $${next.room.toString(16)} (frame ${next.inputs.length})`);
      if (want(next.room)) return next;
      q.push(next);
    }
  }
  return null;
}

// ------------------------------------------------------------------ scenarios

function zmv(name, comment, inputs) {
  const m = createMovie(Uint8Array.from(inputs), null, { name });
  const text = serializeZmv(m).replace(/^zmv 1\n/, `zmv 1\n${comment.map((c) => `# ${c}`).join('\n')}\n`);
  writeFileSync(join(MOVIES, `${name}.zmv`), text);
}

export async function makeLadderCrossing() {
  const s = await ensureItemsSram();
  const start = await startGame(s);
  const ladderRooms = [...table(bus.rom, 'LadderRoomsOW').bytes()];
  const cache = join(REPO_ROOT, 'out', 'sram', 'p08-ladder-route.json');
  let route = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : null;
  if (!route) {
    route = await findRoute(s, start.used(), (room) => ladderRooms.includes(room));
    if (!route) throw new Error('no route to a ladder room');
    writeFileSync(cache, JSON.stringify(route));
  }
  // In the ladder room: find a grid point next to water with land 16 px beyond, walk there, cross.
  const sim = await replay(s, route.inputs);
  syncPort(sim.ram, sim.o.sram);
  const candidates = [];
  for (let x = X0; x <= X1; x += 8) {
    for (let y = Y0; y <= Y1; y += 8) {
      for (const d of [1, 2, 4, 8]) {
        ram[ObjX] = x; ram[ObjY] = y; ram[0x0f] = d;
        const t = GetCollidingTileMoving(0);
        if (!isWaterOW(t)) continue;
        const [dx, dy] = DXY[d];
        const fx = x + dx * 3, fy = y + dy * 3; // 24 px: the far bank
        if (!inside(fx, fy)) continue;
        if (!walkable(fx, fy, d) && !walkable(fx, fy, OPP[d])) continue;
        if (rawTileStill(fx, fy) >= ram[ObjectFirstUnwalkableTile]) continue;
        candidates.push({ x, y, d });
      }
    }
  }
  const room = sim.ram[RoomId];
  for (const c of candidates) {
    const t = await replay(s, route.inputs);
    t.controller = walkController((x, y) => x === c.x && y === c.y, { finalDir: c.d, sword: true });
    let usedLadder = 0;
    const crossed = t.runUntil((r) => {
      if (r[LadderSlot]) usedLadder = r[LadderSlot];
      const [dx, dy] = DXY[c.d];
      const far = dx ? (r[ObjX] - c.x) * Math.sign(dx) >= 24 : (r[ObjY] - c.y) * Math.sign(dy) >= 24;
      return usedLadder && far && r[LadderSlot] === 0 && r[RoomId] === room && r[GameMode] === 5;
    }, 900);
    if (!crossed) continue;
    // And back over the water.
    const back = { x: t.ram[ObjX] & 0xf8, y: t.ram[ObjY] };
    t.controller = walkController((x, y) => x === c.x && y === c.y, { sword: false });
    // Simple: hold the opposite direction for a while (the ladder appears again).
    t.controller = (r) => (r[GameMode] === 5 ? DIR_BTN[OPP[c.d]] : 0);
    let again = false;
    t.runUntil((r) => { if (r[LadderSlot]) again = true; return again && r[LadderSlot] === 0; }, 240);
    t.controller = () => 0;
    t.runUntil(() => false, 30);
    console.log(`ladder room $${room.toString(16)}: crossed at (${c.x},${c.y}) dir ${c.d}; back from (${back.x},${back.y}): ${again}`);
    zmv('ladder-crossing', [
      'P08: from tests/oracle/movies/p08-items.sav (slot 1 with sword, ladder, magic shield, red ring, 16 hearts;',
      'built by tests/game/p08-make-movies.mjs), walk from room $77 to a ladder room (LadderRoomsOW),',
      `cross the water with the ladder there (room $${room.toString(16)}) and back. Generated by p08-make-movies.mjs.`,
      'Run the oracle with --sram tests/oracle/movies/p08-items.sav.',
    ], t.used());
    writeFileSync(join(MOVIES, 'ladder-crossing.expect.json'), `${JSON.stringify({
      comment: 'Reaches a ladder room and deploys the ladder (LadderSlot != 0) in mode 5.',
      sram: 'p08-items.sav',
      reaches: { RoomId: [room], LadderSlot: [usedLadder] },
    }, null, 2)}\n`);
    return;
  }
  throw new Error(`no ladder crossing found in room $${room.toString(16)} (${candidates.length} candidates)`);
}

export async function makeSwordWalk() {
  const s = await ensureItemsSram();
  const sim = await startGame(s);
  // Swing the sword facing each direction, walk around room $77 and into $78 and back.
  const swings = [];
  for (const d of [8, 2, 4, 1]) swings.push([12, DIR_BTN[d]], [2, 0], [2, B.A], [20, 0], [2, B.A], [4, 0], [3, B.A], [30, 0]);
  sim.inputs.push(...expand(swings));
  sim.runUntil(() => false, sim.inputs.length - sim.frame);
  // Walk with the sword: hold A while walking (repeat presses), then exit right and come back.
  sim.controller = walkController(atEdge(1), { finalDir: 1, sword: true });
  sim.runUntil((r) => r[GameMode] === 5 && r[IsUpdatingMode] && r[RoomId] === 0x78, 900);
  sim.controller = walkController(atEdge(2), { finalDir: 2, sword: true });
  sim.runUntil((r) => r[GameMode] === 5 && r[IsUpdatingMode] && r[RoomId] === 0x77, 900);
  sim.controller = (r, f) => (f % 8 < 2 ? B.A : 0);
  sim.runUntil(() => false, 60);
  zmv('ow-walk-sword', [
    'P08: from tests/oracle/movies/p08-items.sav, swing the sword facing each direction in room $77 (attack',
    'states $10/$20/$30 in AnimateLinkObjState, magic shield tiles), walk to $78 and back attacking',
    'nearby monsters. Generated by tests/game/p08-make-movies.mjs. Run with --sram tests/oracle/movies/p08-items.sav.',
  ], sim.used());
  writeFileSync(join(MOVIES, 'ow-walk-sword.expect.json'), `${JSON.stringify({
    comment: 'Sword swings (Link states $11, $31) and walking $77 -> $78 -> $77.',
    sram: 'p08-items.sav',
    reaches: { ObjState: [0x11, 0x31], RoomId: [0x77, 0x78] },
  }, null, 2)}\n`);
}

export async function makeUwDoorways() {
  const s = await ensureItemsSram();
  const start = await startGame(s);
  // BFS from $77 to the level 1 entrance room ($37), then onto its entrance.
  const cache = join(REPO_ROOT, 'out', 'sram', 'p08-uw-route.json');
  let route = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) : null;
  if (!route) {
    route = await findRoute(s, start.used(), (room) => room === 0x37);
    if (!route) throw new Error('uw: no route to room $37');
    writeFileSync(cache, JSON.stringify(route));
  }
  const inputs = route.inputs;
  let sim = await replay(s, inputs);
  syncPort(sim.ram, sim.o.sram);
  let target = null;
  for (let x = X0; x <= X1 && !target; x += 8) {
    for (let y = Y0; y <= Y1; y += 8) if (isWarpTile(rawTileStill(x, y))) { target = { x, y }; break; }
  }
  if (!target) throw new Error('uw: no entrance tile in room $37');
  sim.controller = walkController((x, y) => x === target.x && y === target.y, { finalDir: 8, allowWarp: true });
  if (!sim.runUntil((r) => r[CurLevel] === 1 && r[GameMode] === 5 && r[IsUpdatingMode], 1500)) throw new Error('uw: did not enter level 1');
  // In level 1: go through the doorways. A doorway is entered from the grid point in front of it
  // (top door x=$78 y=$5D, bottom y=$BD, side doors y=$8D at x=$20/$D0), then holding the direction.
  const DOOR = { 8: [0x78, 0x5d], 4: [0x78, 0xbd], 2: [0x20, 0x8d], 1: [0xd0, 0x8d] };
  const plan = [8, 2, 1, 1, 2, 4, 2, 1, 1];
  for (const d of plan) {
    const room = sim.ram[RoomId];
    const [gx, gy] = DOOR[d];
    const save = sim.used();
    sim.controller = walkController((x, y) => x === gx && y === gy, { finalDir: d });
    const ok = sim.runUntil((r) => r[GameMode] === 5 && r[IsUpdatingMode] && r[RoomId] !== room, 600);
    console.log(`uw: room $${room.toString(16)} dir ${d}: ${ok ? `-> $${sim.ram[RoomId].toString(16)}` : 'blocked'} at (${sim.ram[ObjX].toString(16)},${sim.ram[ObjY].toString(16)}) mode ${sim.ram[GameMode]}`);
    if (!ok) sim = await replay(s, save); // drop the failed attempt
  }
  sim.controller = () => 0;
  sim.runUntil(() => false, 30);
  writeFileSync(join(MOVIES, 'uw-doorways.expect.json'), `${JSON.stringify({
    comment: 'Enters level 1 and goes through doorways between its rooms.',
    sram: 'p08-items.sav',
    reaches: { CurLevel: [1], RoomId: [0x73, 0x63, 0x72, 0x74] },
  }, null, 2)}\n`);
  zmv('uw-doorways', [
    'P08: from tests/oracle/movies/p08-items.sav, walk to level 1 ($37), enter it and walk through the doorways',
    '(Link_ModifyDirInDoorway, two-direction input in UW). Generated by tests/game/p08-make-movies.mjs.',
    'Run with --sram tests/oracle/movies/p08-items.sav.',
  ], sim.used());
}

if (import.meta.main) {
  await init();
  const what = process.argv[2] ?? 'all';
  if (what === 'sram' || what === 'all') await ensureItemsSram(true);
  if (what === 'ladder' || what === 'all') await makeLadderCrossing();
  if (what === 'sword' || what === 'all') await makeSwordWalk();
  if (what === 'uw' || what === 'all') await makeUwDoorways();
}
