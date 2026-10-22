#!/usr/bin/env node
// Generator of the P05 oracle scenarios (objects: spawn, death, drops, kill counts, room history).
// Run:  node tests/game/p05-make-movies.mjs [enemies|revisit|all]
//
// Both start from out/sram/p08-items.sav (slot 1 with sword, ladder, magic shield, red ring and 16
// hearts; built by tests/game/p08-make-movies.mjs, not versioned) and are found by a closed-loop
// controller that plays the ORIGINAL game in the oracle (Link's 8-pixel grid BFS uses the port's
// tile collision on the oracle's RAM/SRAM, like p08-make-movies).
//  * ow-enemies-spawn.zmv: $77 -> $78 (monsters from the edges), hunt and kill its monsters with the
//    sword (death sparkle, dropped items, WorldKillCycle, RoomKillCount), then $68 and kill there too.
//  * room-revisit.zmv: the same, then leave $68 and come back (in RoomHistory: the kill count is
//    subtracted), and walk through 6 more rooms before going back to $78 (no longer in the history:
//    the count comes from the room flags), killing again.
// Every movie is replayed from power-on in the oracle to check it reaches the expected state.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { createMovie, serializeZmv, loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram } from '../../src/core/ram.js';
import {
  GameMode, RoomId, ObjX, ObjY, ObjDir, ObjGridOffset, ObjectFirstUnwalkableTile, CurLevel, ObjType,
  ObjMetastate, ObjShoveDir, IsUpdatingMode, RoomKillCount, WorldKillCycle, ObjState,
} from '../../src/core/vars.js';
import { ensureItemsSram } from './p08-make-movies.mjs';

export const MOVIES = join(import.meta.dirname, '..', 'oracle', 'movies');
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

// ------------------------------------------------------------------ grid planning (port collision)

let sim = null;
function syncPort() {
  ram.set(sim.o.ram);
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
      if (isWarpTile(rawTileStill(nx, ny)) && !goal(nx, ny)) continue;
      first.set(k, first.get(key(x, y)) || d);
      if (goal(nx, ny)) return first.get(k);
      q.push([nx, ny]);
    }
  }
  return 0;
}

const isMonster = (r, i) => r[ObjType + i] >= 0x01 && r[ObjType + i] < 0x53 && r[ObjMetastate + i] === 0;
const monsters = (r) => [...Array(11).keys()].map((i) => i + 1).filter((i) => isMonster(r, i));
const playing = (r) => r[GameMode] === 5 && r[IsUpdatingMode] !== 0;

/** Facing direction to hit monster i from Link's position, or 0 if it's not in sword range. */
function strikeDir(r, i) {
  const dx = r[ObjX + i] - r[ObjX], dy = r[ObjY + i] - r[ObjY];
  if (Math.abs(dx) < 10 && Math.abs(dy) < 26) return dy < 0 ? 8 : 4;
  if (Math.abs(dy) < 10 && Math.abs(dx) < 26) return dx < 0 ? 2 : 1;
  return 0;
}

/** Hunt the room's monsters: walk to a grid point lined up with the nearest one and swing. */
function huntController() {
  const blocked = new Set();
  let last = null, still = 0, lastDir = 0, swing = 0;
  return (r, frame) => {
    if (!playing(r) || r[ObjShoveDir] !== 0) return 0;
    if (swing > 0) { swing--; return 0; }
    const list = monsters(r);
    for (const i of list) {
      const d = strikeDir(r, i);
      if (!d) continue;
      if (r[ObjDir] === d && r[ObjState] === 0) { swing = 6; return B.A; }
      if (r[ObjGridOffset] === 0 || ((d === 1 || d === 2) === (r[ObjDir] === 1 || r[ObjDir] === 2))) return DIR_BTN[d];
    }
    if (!list.length) return 0;
    const x = r[ObjX], y = r[ObjY];
    const pos = `${x},${y}`;
    if (pos === last && lastDir) {
      if (++still > 24) { blocked.add(`${x},${y},${lastDir}`); still = 0; }
    } else { still = 0; }
    last = pos;
    if (r[ObjGridOffset] !== 0) { lastDir = r[ObjDir]; return DIR_BTN[r[ObjDir]] ?? 0; }
    list.sort((a, b) => (Math.abs(r[ObjX + a] - x) + Math.abs(r[ObjY + a] - y))
      - (Math.abs(r[ObjX + b] - x) + Math.abs(r[ObjY + b] - y)));
    const m = list[0];
    const mx = r[ObjX + m], my = r[ObjY + m];
    syncPort();
    const goal = (gx, gy) => (Math.abs(gx - mx) < 8 && Math.abs(gy - my) < 22 && Math.abs(gy - my) > 6)
      || (Math.abs(gy - my) < 8 && Math.abs(gx - mx) < 22 && Math.abs(gx - mx) > 6);
    let d = planStep(x, y, goal, blocked);
    if (d === -1) d = 0;
    if (d === 0 && frame % 30 < 15) d = [1, 2, 4, 8][(frame >> 5) & 3]; // wander a bit
    lastDir = d;
    return d ? DIR_BTN[d] : 0;
  };
}

function walkController(goal, finalDir) {
  const blocked = new Set();
  let last = null, still = 0, lastDir = 0, arrived = false;
  return (r, frame) => {
    if (!playing(r)) return 0;
    if (arrived) return finalDir ? DIR_BTN[finalDir] : 0;
    if (r[ObjShoveDir] !== 0) return 0;
    const x = r[ObjX], y = r[ObjY];
    const pos = `${x},${y}`;
    if (pos === last && lastDir) {
      if (++still > 24) { blocked.add(`${x},${y},${lastDir}`); still = 0; }
    } else { still = 0; }
    last = pos;
    // Keep Link alive: swing at monsters in range.
    if (frame % 12 === 0 && monsters(r).some((i) => strikeDir(r, i) === r[ObjDir])) { lastDir = 0; return B.A; }
    if (r[ObjGridOffset] !== 0) { lastDir = r[ObjDir]; return DIR_BTN[r[ObjDir]] ?? 0; }
    syncPort();
    const d = planStep(x, y, goal, blocked);
    if (d === -1) { arrived = true; lastDir = finalDir; return finalDir ? DIR_BTN[finalDir] : 0; }
    lastDir = d;
    return d ? DIR_BTN[d] : 0;
  };
}

const atEdge = (d) => (x, y) => (d === 2 ? x === X0 : d === 1 ? x === X1 : d === 8 ? y === Y0 : y === Y1);

function expand(runs) {
  const out = [];
  for (const [n, b] of runs) for (let i = 0; i < n; i++) out.push(b);
  return out;
}
const startRuns = () => [[120, 0], [2, B.T], [90, 0], [2, B.T], [240, 0]];

async function startGame(s) {
  sim = await new Sim(s, expand(startRuns())).start();
  sim.runUntil(() => false, sim.inputs.length);
  if (sim.ram[GameMode] !== 5 || sim.ram[RoomId] !== 0x77) throw new Error('start failed');
  return sim;
}

/** Walk out through edge d; returns the new room or throws. */
function exitRoom(d, max = 1200) {
  const room = sim.ram[RoomId];
  sim.controller = walkController(atEdge(d), d);
  if (!sim.runUntil((r) => playing(r) && r[RoomId] !== room && r[CurLevel] === 0, max)) {
    throw new Error(`could not leave $${room.toString(16)} towards ${d}`);
  }
  sim.controller = () => 0;
  sim.runUntil(() => false, 2);
  console.log(`  -> room $${sim.ram[RoomId].toString(16)} at frame ${sim.frame}`);
  return sim.ram[RoomId];
}

/** Hunt until `kills` more kills in this room (or the room is empty), max frames. */
function hunt(kills, max) {
  const start = sim.ram[RoomKillCount];
  sim.controller = huntController();
  sim.runUntil((r) => r[RoomKillCount] - start >= kills
    || (monsters(r).length === 0 && r[RoomKillCount] > start && sim.frame % 64 === 0), max);
  // Let the death sparkles and drops play out.
  sim.controller = () => 0;
  sim.runUntil(() => false, 90);
  console.log(`  room $${sim.ram[RoomId].toString(16)}: RoomKillCount ${sim.ram[RoomKillCount]}, WorldKillCycle ${sim.ram[WorldKillCycle]} (frame ${sim.frame})`);
}

function zmv(name, comment, inputs) {
  const m = createMovie(Uint8Array.from(inputs), null, { name });
  const text = serializeZmv(m).replace(/^zmv 1\n/, `zmv 1\n${comment.map((c) => `# ${c}`).join('\n')}\n`);
  writeFileSync(join(MOVIES, `${name}.zmv`), text);
}

async function enemiesPart() {
  const s = await ensureItemsSram();
  await startGame(s);
  exitRoom(1); // $78: monsters come in from the edges
  hunt(4, 2400);
  exitRoom(8); // $68
  hunt(3, 2400);
  return s;
}

export async function makeEnemies() {
  await init();
  await enemiesPart();
  zmv('ow-enemies-spawn', [
    'P05: from out/sram/p08-items.sav (built by tests/game/p08-make-movies.mjs), walk $77 -> $78',
    '(monsters from the edges of the screen), hunt and kill monsters with the sword (spawning cloud,',
    'death sparkle, drops, WorldKillCycle, RoomKillCount), then $68 and kill there too.',
    'Generated by tests/game/p05-make-movies.mjs. Run the oracle with --sram out/sram/p08-items.sav.',
  ], sim.used());
  writeFileSync(join(MOVIES, 'ow-enemies-spawn.expect.json'), `${JSON.stringify({
    comment: 'Kills in rooms $78 and $68 (RoomKillCount >= 2, death sparkle metastate $14).',
    sram: 'out/sram/p08-items.sav',
    reaches: { RoomId: [0x78, 0x68], RoomKillCount: [1, 2], WorldKillCycle: [1, 2, 3]},
  }, null, 2)}\n`);
}

export async function makeRevisit() {
  await init();
  await enemiesPart();
  // Leave $68 and come back at once: the room is in RoomHistory.
  exitRoom(2); // $67
  exitRoom(1); // $68 again
  hunt(1, 900);
  // Six new rooms ($58 $57 $56 $46 $47 $48) push $78/$68 out of the 6-entry history; then $58 (in
  // the history), $68 and $78 (not in it: kill counts from the room flags), killing again.
  for (const d of [8, 2, 2, 8, 1, 1, 4, 4]) exitRoom(d);
  hunt(1, 900);
  exitRoom(4);
  hunt(2, 1500);
  sim.controller = () => 0;
  sim.runUntil(() => false, 120);
  zmv('room-revisit', [
    'P05: ow-enemies-spawn, then leave $68 and come back (RoomHistory hit: kill count subtracted),',
    'walk through 6 new rooms so that the history cycles, and back to $68 and $78 (kill counts from',
    'the room flags), killing again.',
    'Generated by tests/game/p05-make-movies.mjs. Run the oracle with --sram out/sram/p08-items.sav.',
  ], sim.used());
  writeFileSync(join(MOVIES, 'room-revisit.expect.json'), `${JSON.stringify({
    comment: 'Kills in $78/$68, back into $68 (in history), 6 new rooms and back to $68 and $78 (out of history).',
    sram: 'out/sram/p08-items.sav',
    reaches: { RoomId: [0x78, 0x68, 0x67, 0x58, 0x57, 0x56, 0x46, 0x47, 0x48], RoomKillCount: [1, 2] },
  }, null, 2)}\n`);
}

/** Replays a generated movie in the oracle and returns the RAM frames (for checks). */
export async function replayCheck(name) {
  await init();
  const s = await ensureItemsSram();
  const movie = loadMovie(join(MOVIES, `${name}.zmv`));
  const o = await Oracle.create({ rom: rom.bytes, sram: s, powerOnFill: 0 });
  const seen = { rooms: new Set(), maxKill: 0, spark14: 0, drops: 0 };
  const write = (rec) => {
    const r = rec.ram;
    seen.rooms.add(r[RoomId]);
    seen.maxKill = Math.max(seen.maxKill, r[RoomKillCount]);
    for (let i = 1; i < 12; i++) {
      if (r[ObjMetastate + i] === 0x14) seen.spark14++;
      if (r[ObjType + i] === 0x60) seen.drops++;
    }
  };
  o.run(movie, { write });
  return seen;
}

if (import.meta.main) {
  const what = process.argv[2] ?? 'all';
  if (what === 'enemies' || what === 'all') await makeEnemies();
  if (what === 'revisit' || what === 'all') await makeRevisit();
  for (const n of what === 'all' ? ['ow-enemies-spawn', 'room-revisit'] : [what === 'enemies' ? 'ow-enemies-spawn' : 'room-revisit']) {
    const r = await replayCheck(n);
    console.log(n, { rooms: [...r.rooms].map((x) => x.toString(16)), maxKill: r.maxKill, spark14: r.spark14, drops: r.drops });
  }
}
