#!/usr/bin/env node
// Generator of the P13 oracle scenario uw-level1-full. Run:  node tests/game/p13-make-movies.mjs
//
// From out/sram/p08-items.sav (slot 1 with sword, ladder, magic shield, red ring, magic key and 16
// hearts; built by tests/game/p08-make-movies.mjs, not versioned) it replays uw-doorways.zmv up to the
// entrance of level 1 and then explores the level with a closed-loop controller that plays the
// ORIGINAL game in the oracle: it walks through every doorway it can go through and back (open, locked
// with the magic key), goes back to the entrance room $73 and leaves the level through its bottom
// (CalculateNextRoomForDoor -> EndGameMode12 -> modes 2, 3, 4 out of the dungeon), enters the level
// again (modes $10, 2, 3) and finally goes through a one-way doorway (a shutter closes behind Link)
// and on to the rooms behind it. (Level 1 has no dark rooms: the fades are covered by
// tests/game/p13-routines.test.mjs.)
// Inside a room the route is a BFS over Link's 8-pixel grid using the port's tile collision
// (GetCollidingTileMoving) on the oracle's RAM/SRAM. The movie is replayed from power-on to check it
// reaches the expected states.
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { loadRomFile, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { createMovie, serializeZmv, loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram } from '../../src/core/ram.js';
import {
  GameMode, RoomId, ObjX, ObjY, ObjDir, ObjGridOffset, ObjectFirstUnwalkableTile, CurLevel, ObjType,
  ObjShoveDir, IsUpdatingMode, LevelBlockAttrsE,
} from '../../src/core/vars.js';
import { ensureItemsSram, MOVIES } from './p08-make-movies.mjs';

const B = { A: 0x80, B: 0x40, S: 0x20, T: 0x10, U: 0x08, D: 0x04, L: 0x02, R: 0x01 };
const DIR_BTN = { 1: B.R, 2: B.L, 4: B.D, 8: B.U };
const DXY = { 1: [8, 0], 2: [-8, 0], 4: [0, 8], 8: [0, -8] };
const OPP = { 1: 2, 2: 1, 4: 8, 8: 4 };
// Grid point in front of each doorway of an UW room (tests/game/p08-make-movies.mjs).
const DOOR = { 8: [0x78, 0x5d], 4: [0x78, 0xbd], 2: [0x20, 0x8d], 1: [0xd0, 0x8d] };
const ENTRANCE = 0x73;

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

  used() { return this.inputs.slice(0, this.frame); }
}

async function replay(sramInit, inputs) {
  const sim = await new Sim(sramInit, inputs).start();
  sim.runUntil(() => false, inputs.length);
  return sim;
}

// ------------------------------------------------------------------ in-room planning

function walkable(x, y, d) {
  ram[ObjX] = x;
  ram[ObjY] = y;
  ram[0x0f] = d;
  return GetCollidingTileMoving(0) < ram[ObjectFirstUnwalkableTile];
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

const X0 = 0x00, X1 = 0xf0, Y0 = 0x3d, Y1 = 0xdd;
const inside = (x, y) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;

function planStep(sx, sy, goal, blocked) {
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
      first.set(k, first.get(key(x, y)) || d);
      if (goal(nx, ny)) return first.get(k);
      q.push([nx, ny]);
    }
  }
  return 0;
}

function monsterNear(r, x, y) {
  for (let i = 1; i < 0x0c; i++) {
    if (r[ObjType + i] === 0 || r[ObjType + i] >= 0x5d) continue;
    if (Math.abs(r[ObjX + i] - x) < 0x28 && Math.abs(r[ObjY + i] - y) < 0x28) return true;
  }
  return false;
}

/** Walk to a grid point satisfying goal(), then keep pushing finalDir. Swings at nearby monsters. */
function walkController(sim, goal, finalDir) {
  const blocked = new Set();
  let last = null, still = 0, lastDir = 0, arrived = false;
  return (r, frame) => {
    if (r[GameMode] !== 5 || r[IsUpdatingMode] === 0) return 0;
    if (frame % 16 === 0 && monsterNear(r, r[ObjX], r[ObjY])) { lastDir = 0; return B.A; }
    if (arrived) return DIR_BTN[finalDir];
    if (r[ObjShoveDir] !== 0) return 0;
    const x = r[ObjX], y = r[ObjY];
    const pos = `${x},${y}`;
    if (pos === last && lastDir) {
      if (++still > 24) { blocked.add(`${x},${y},${lastDir}`); still = 0; }
    } else { still = 0; }
    last = pos;
    if (r[ObjGridOffset] !== 0) { lastDir = r[ObjDir]; return DIR_BTN[r[ObjDir]] ?? 0; }
    ram.set(r);
    sram.set(sim.o.sram);
    const d = planStep(x, y, goal, blocked);
    if (d === -1) { arrived = true; lastDir = finalDir; return DIR_BTN[finalDir]; }
    lastDir = d;
    return d ? DIR_BTN[d] : 0;
  };
}

const playing = (r) => r[GameMode] === 5 && r[IsUpdatingMode] !== 0;

/** Through the doorway `d` of the current room. Returns the new room or null (sim is then stale). */
function goThrough(sim, d, max = 900) {
  const room = sim.ram[RoomId];
  const level = sim.ram[CurLevel];
  const [gx, gy] = DOOR[d];
  sim.controller = walkController(sim, (x, y) => x === gx && y === gy, d);
  const ok = sim.runUntil((r) => playing(r) && (r[RoomId] !== room || r[CurLevel] !== level), max);
  sim.controller = () => 0;
  if (!ok) return null;
  return sim.ram[CurLevel] === level ? sim.ram[RoomId] : -1;
}

const hex = (v) => `$${v.toString(16).padStart(2, '0')}`;

// ------------------------------------------------------------------ scenario

export async function makeUwLevel1Full() {
  await init();
  const s = await ensureItemsSram();
  // Prefix: uw-doorways.zmv up to the first frame playing in level 1.
  const doorways = loadMovie(join(MOVIES, 'uw-doorways.zmv'));
  let sim = await new Sim(s, [...doorways.p1]).start();
  if (!sim.runUntil((r) => r[CurLevel] === 1 && playing(r), doorways.p1.length)) throw new Error('uw-doorways does not enter level 1');
  let inputs = sim.used();
  sim = await replay(s, inputs);
  const dark = (room) => (sim.o.sram[LevelBlockAttrsE - 0x6000 + room] & 0x80) !== 0;

  const graph = new Map(); // room -> {d: dest | null}
  const edges = (room) => graph.get(room) ?? graph.set(room, {}).get(room);
  const visited = new Set([sim.ram[RoomId]]);
  const darkSeen = new Set();
  let transitions = 0;
  const MAX_FRAMES = 26000;

  const pathTo = (from, want) => {
    // BFS over known edges: first room satisfying want(room) -> list of directions.
    const prev = new Map([[from, null]]);
    const q = [from];
    while (q.length) {
      const r = q.shift();
      if (want(r)) {
        const dirs = [];
        for (let c = r; prev.get(c); c = prev.get(c).from) dirs.unshift(prev.get(c).d);
        return dirs;
      }
      for (const [d, to] of Object.entries(edges(r))) {
        if (to === null || to < 0 || prev.has(to)) continue;
        prev.set(to, { from: r, d: Number(d) });
        q.push(to);
      }
    }
    return null;
  };

  /** Through doorway d along a known edge (or a new one); on failure replay to before the attempt. */
  const step = async (d) => {
    const room = sim.ram[RoomId];
    const save = sim.used();
    const to = goThrough(sim, d);
    if (to === null || to < 0) {
      edges(room)[d] = to === -1 ? -1 : null;
      sim = await replay(s, save);
      console.log(`  ${hex(room)} dir ${d}: ${to === -1 ? 'leaves the level' : 'blocked'}`);
      return null;
    }
    transitions++;
    if (dark(to)) darkSeen.add(to);
    return to;
  };

  /** A new doorway: go through and back (a two-way edge), else forget the attempt. */
  const explore = async (d) => {
    const room = sim.ram[RoomId];
    const save = sim.used();
    const to = await step(d);
    if (to === null) return;
    const isNew = !visited.has(to);
    const back = await step(OPP[d]);
    if (back !== room) {
      console.log(`  ${hex(room)} -${d}-> ${hex(to)}: one way`);
      edges(room)[d] = null;
      sim = await replay(s, save);
      transitions -= back === null ? 1 : 2;
      return;
    }
    edges(room)[d] = to;
    edges(to)[OPP[d]] = room;
    visited.add(to);
    console.log(`  ${hex(room)} <-${d}-> ${hex(to)}${dark(to) ? ' (dark)' : ''}${isNew ? ' new' : ''} frame ${sim.frame}`);
  };

  const untried = (r) => [8, 2, 1, 4].filter((d) => !(d in edges(r)) && !(r === ENTRANCE && d === 4));
  // Phase 1 is cached in out/sram/ (it takes minutes): inputs up to the exit, the graph, the rooms.
  const cachePath = join(REPO_ROOT, 'out', 'sram', 'p13-uw-phase1.json');
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : null;
  if (cache) {
    for (const [r, es] of cache.graph) graph.set(r, es);
    for (const r of cache.visited) visited.add(r);
    transitions = cache.transitions;
    sim = await replay(s, cache.inputs);
  }
  for (;;) {
    if (cache || sim.frame > MAX_FRAMES) break;
    const room = sim.ram[RoomId];
    const u = untried(room);
    if (u.length) {
      await explore(u[0]);
      continue;
    }
    const path = pathTo(room, (r) => untried(r).length > 0);
    if (!path || !path.length) break;
    // Walk there along known two-way edges, then explore from it.
    for (const d of path) if ((await step(d)) === null) throw new Error('a known edge failed');
  }
  console.log(`explored ${visited.size} rooms (${[...visited].map(hex).join(' ')}), dark: ${[...darkSeen].map(hex).join(' ')}, ${transitions} transitions, frame ${sim.frame}`);

  if (!cache) {
    // Back to the entrance and out through its bottom: the next room is invalid -> reload the OW.
    const back = pathTo(sim.ram[RoomId], (r) => r === ENTRANCE) ?? [];
    for (const d of back) if ((await step(d)) === null) throw new Error('cannot go back to the entrance');
    const out = goThrough(sim, 4, 1500);
    if (out !== -1) throw new Error(`leaving level 1: ${out}`);
    sim.runUntil(() => false, 120);
    mkdirSync(join(REPO_ROOT, 'out', 'sram'), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ inputs: sim.used(), graph: [...graph], visited: [...visited], transitions }));
  }
  console.log(`out of level 1 in OW ${hex(sim.ram[RoomId])} frame ${sim.frame}`);

  // Enter level 1 again (modes $10, 2, 3): step down off the entrance Link came out of, then back up.
  const down = sim.frame + 24;
  sim.controller = (r, f) => (playing(r) ? (f < down ? B.D : B.U) : 0);
  if (!sim.runUntil((r) => r[CurLevel] === 1 && playing(r), 1500)) throw new Error('did not enter level 1 again');
  sim.controller = () => 0;
  console.log(`level 1 again, frame ${sim.frame}`);

  // The rooms behind the one-way doorways (shutters that close behind Link): go there and explore
  // greedily, without coming back.
  const oneWay = [];
  for (const [r, es] of graph) for (const [d, to] of Object.entries(es)) if (to === null && !untried(r).length) oneWay.push([r, Number(d)]);
  for (const [r, d] of oneWay) {
    const path = pathTo(sim.ram[RoomId], (x) => x === r);
    if (!path) continue;
    const save = sim.used();
    let okPath = true;
    for (const dd of path) if ((await step(dd)) === null) { okPath = false; break; }
    const to = okPath ? goThrough(sim, d) : null;
    if (to === null || to < 0 || visited.has(to)) {
      sim = await replay(s, save);
      continue;
    }
    console.log(`  ${hex(r)} -${d}-> ${hex(to)} (one way) frame ${sim.frame}`);
    visited.add(to);
    transitions++;
    // Greedy: any untried doorway to a new room.
    const tried = new Set();
    while (sim.frame < MAX_FRAMES + 8000) {
      const room = sim.ram[RoomId];
      const ds = [8, 2, 1, 4].filter((x) => !tried.has(`${room},${x}`));
      if (!ds.length) break;
      const dd = ds[0];
      tried.add(`${room},${dd}`);
      const save2 = sim.used();
      const to2 = goThrough(sim, dd);
      if (to2 === null || to2 < 0 || (visited.has(to2) && ds.length > 1)) {
        sim = await replay(s, save2);
        continue;
      }
      transitions++;
      if (dark(to2)) darkSeen.add(to2);
      console.log(`  ${hex(room)} -${dd}-> ${hex(to2)}${visited.has(to2) ? '' : ' new'} frame ${sim.frame}`);
      visited.add(to2);
    }
    break;
  }
  sim.runUntil(() => false, 60);
  inputs = sim.used();

  const m = createMovie(Uint8Array.from(inputs), null, { name: 'uw-level1-full' });
  const comment = [
    'P13: from out/sram/p08-items.sav (built by tests/game/p08-make-movies.mjs), replay uw-doorways up to',
    'level 1, explore it through every two-way doorway (modes 6, 7, 4), leave the level by the bottom of',
    'the entrance (EndGameMode12, modes 2, 3, 4), enter it again (modes $10, 2, 3) and go through the',
    'one-way doorways. Generated by tests/game/p13-make-movies.mjs. Run with --sram out/sram/p08-items.sav.',
  ];
  writeFileSync(join(MOVIES, 'uw-level1-full.zmv'),
    serializeZmv(m).replace(/^zmv 1\n/, `zmv 1\n${comment.map((c) => `# ${c}`).join('\n')}\n`));
  writeFileSync(join(MOVIES, 'uw-level1-full.expect.json'), `${JSON.stringify({
    comment: `Level 1: ${visited.size} rooms through doorways (dark: ${[...darkSeen].map(hex).join(', ') || 'none'}), out to the OW and back in.`,
    sram: 'out/sram/p08-items.sav',
    reaches: { CurLevel: [1, 0], GameMode: [2, 3, 4, 5, 6, 7, 16], RoomId: [...visited] },
  }, null, 2)}\n`);

  // Check from power-on.
  const check = await replay(s, inputs);
  if (check.ram[CurLevel] !== 1 || !playing(check.ram)) throw new Error('replay does not end playing in level 1');
  console.log(`uw-level1-full: ${inputs.length} frames`);
}

if (import.meta.main) {
  await makeUwLevel1Full();
}
