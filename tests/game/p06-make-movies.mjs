// P06: generates the movement oracle movies by playing the original game in the oracle (jsnes) with a
// closed-loop controller (path finding on the room's tile map, using the game's own walkability test:
// the port of GetCollidingTileMoving on a copy of the state). The result is a plain .zmv.
//   tests/oracle/movies/p06-ow-cave-walls.zmv  register + start, sword cave (mode $B, old man,
//       CheckSubroom/CheckPersonBlocking), walls and screen edges in $77/$78/$68, octoroks walking
//       (Walker_Move), sword hits (monster shove) and Link hit (knockback, Obj_Shove).
//   tests/oracle/movies/p06-to-level1.zmv      the same start, then the overworld walk to level 1 ($37)
//       and the first rooms of the dungeon (UW bounds, doorways).
// Usage: node tests/game/p06-make-movies.mjs [name]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { parseZmv, serializeZmv, createMovie } from '../../tools/oracle/lib/movie.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram } from '../../src/core/ram.js';
import * as V from '../../src/core/vars.js';
import { GetCollidingTileMoving } from '../../src/game/movement/tiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MOVIES = join(ROOT, 'tests/oracle/movies');
const romBytes = readFileSync(join(ROOT, 'roms/zelda.nes'));
await loadSymbols();
createMachine(loadRom(romBytes));

const U = 0x08, D = 0x04, L = 0x02, R = 0x01, A = 0x80;
const DIRV = { [U]: [0, -8], [D]: [0, 8], [L]: [-8, 0], [R]: [8, 0] };

/** Can Link step 8 px from grid node (x, y) in `dir`? The game's own test (tile < first unwalkable). */
function canStep(st, x, y, dir) {
  ram.set(st.ram);
  sram.set(st.sram);
  ram[V.ObjX] = x;
  ram[V.ObjY] = y;
  ram[0x0f] = dir;
  return GetCollidingTileMoving(0) < st.ram[V.ObjectFirstUnwalkableTile];
}
function rawTileAhead(st, x, y, dir) {
  ram.set(st.ram);
  sram.set(st.sram);
  ram[V.ObjX] = x;
  ram[V.ObjY] = y;
  ram[0x0f] = dir;
  ram[V.CurLevel] = 1; // skip the OW walkable-tile substitution: raw tile
  return GetCollidingTileMoving(0);
}

const onGrid = (x, y) => (x & 7) === 0 && (y & 7) === 5;
const key = (x, y) => (x << 8) | y;

/** BFS over Link's 8-px grid from (x, y) to a node satisfying goal(x, y). Returns the node list. */
export function plan(st, x, y, goal, uw) {
  const minY = 0x3d, maxY = 0xdd, minX = 0x00, maxX = 0xf0; void uw;
  const prev = new Map([[key(x, y), null]]);
  const q = [[x, y]];
  while (q.length) {
    const [cx, cy] = q.shift();
    if (goal(cx, cy)) {
      const path = [];
      for (let k = key(cx, cy); k !== null; k = prev.get(k)) path.unshift([k >> 8, k & 0xff]);
      return path;
    }
    for (const d of [U, D, L, R]) {
      const nx = cx + DIRV[d][0], ny = cy + DIRV[d][1];
      if (nx < minX || nx > maxX || ny < minY || ny > maxY || prev.has(key(nx, ny))) continue;
      if (!canStep(st, cx, cy, d)) continue;
      prev.set(key(nx, ny), key(cx, cy));
      q.push([nx, ny]);
    }
  }
  return null;
}

const playing = (r) => [5, 9, 0x0b, 0x0c].includes(r[V.GameMode]);

/** Controller tasks. Each returns an input byte for the next frame, or null when done. */
export function walkTo(goal, { then = 0, attackEvery = 0, maxFrames = 1500, label = 'walk' } = {}) {
  let path = null, i = 0, n = 0, lastPos = -1, still = 0, kick = 0;
  return (st) => {
    const r = st.ram;
    if (++n > maxFrames) throw new Error(`${label}: gave up in room $${r[V.RoomId].toString(16)}`);
    if (!playing(r)) return 0;
    const x = r[V.ObjX], y = r[V.ObjY];
    const uw = r[V.CurLevel] !== 0;
    const pos = key(x, y);
    still = pos === lastPos ? still + 1 : 0;
    lastPos = pos;
    if (kick > 0) { kick--; return [U, D, L, R][(n >> 3) & 3]; }
    if (still > 90) { still = 0; kick = 12; path = null; }
    if (onGrid(x, y) && r[V.ObjGridOffset] === 0 && (path === null || i >= path.length || key(...path[i]) !== pos)) {
      if (path && i < path.length && key(...path[i]) === pos) i++;
      else { path = plan(st, x, y, goal, uw); i = 1; }
      if (!path) throw new Error(`${label}: no path from ($${x.toString(16)},$${y.toString(16)}) in room $${r[V.RoomId].toString(16)}`);
    }
    if (path && i < path.length && key(...path[i]) === pos) i++;
    let input;
    if (!path || i >= path.length) {
      if (then === null) return null;
      input = then; // at the goal: keep pushing (screen edge, cave door)
    } else {
      const [tx, ty] = path[i];
      input = tx > x ? R : tx < x ? L : ty > y ? D : U;
    }
    if (attackEvery && n % attackEvery === 0) input |= A;
    return input;
  };
}

/** Run tasks until each one's `until(st)` holds. */
export function task(fn, until) { return { fn, until }; }

export function exitRoom(dir, opts = {}) {
  let room = null;
  const goal = (x, y) => (dir === U ? y === 0x3d : dir === D ? y === 0xdd : dir === L ? x === 0x00 : x === 0xf0);
  const goalUW = (x, y) => (dir === U ? x === 0x78 && y === 0x5d : dir === D ? x === 0x78 && y === 0xbd
    : dir === L ? x === 0x20 && y === 0x8d : x === 0xd0 && y === 0x8d);
  const w = walkTo((x, y) => goal(x, y), { then: dir, ...opts, label: `exit ${dir}` });
  const wu = walkTo((x, y) => goalUW(x, y), { then: dir, ...opts, label: `exit UW ${dir}` });
  return task((st) => {
    room ??= st.ram[V.RoomId];
    if (st.ram[V.RoomId] !== room) return 0; // left: wait for the scroll to end
    if (st.ram[V.CurLevel] && st.ram[V.DoorwayDir]) return dir; // in the doorway: keep going
    return st.ram[V.CurLevel] ? wu(st) : w(st);
  }, (st) => room !== null && st.ram[V.RoomId] !== room && st.ram[V.GameMode] === 5 && st.ram[V.IsUpdatingMode] !== 0);
}

/** Walk room by room towards `target` (greedy on the room grid, only through reachable exits). */
export function travelTo(target, opts = {}) {
  const visits = new Map();
  let cur = null, sub = null;
  const goals = {
    [U]: (x, y) => y === 0x3d, [D]: (x, y) => y === 0xdd, [L]: (x, y) => x === 0x00, [R]: (x, y) => x === 0xf0,
  };
  const step = { [U]: -16, [D]: 16, [L]: -1, [R]: 1 };
  const dist = (a, b) => Math.abs((a >> 4) - (b >> 4)) + Math.abs((a & 15) - (b & 15));
  return task((st) => {
    const r = st.ram;
    if (!playing(r) || r[V.GameMode] !== 5) return 0;
    if (r[V.RoomId] !== cur) {
      if (r[V.IsUpdatingMode] === 0) return 0;
      cur = r[V.RoomId];
      visits.set(cur, (visits.get(cur) ?? 0) + 1);
      const s0 = { ram: Uint8Array.from(r), sram: Uint8Array.from(st.sram) };
      const x = r[V.ObjX] & 0xf8, y = (r[V.ObjY] & 0xf8) | 5;
      const opts2 = [U, D, L, R].filter((d) => plan(s0, x, y, goals[d], false))
        .map((d) => ({ d, n: (cur + step[d]) & 0x7f }))
        .sort((a, b) => (dist(a.n, target) + 3 * (visits.get(a.n) ?? 0)) - (dist(b.n, target) + 3 * (visits.get(b.n) ?? 0)));
      if (!opts2.length) throw new Error(`travel: no exit from room $${cur.toString(16)}`);
      console.log(`travel: room $${cur.toString(16)} -> exit ${opts2[0].d} (options ${opts2.map((o) => o.d).join(',')})`);
      sub = walkTo(goals[opts2[0].d], { then: opts2[0].d, ...opts, label: `travel ${opts2[0].d}` });
    }
    return sub(st);
  }, (st) => st.ram[V.RoomId] === target && st.ram[V.GameMode] === 5 && st.ram[V.IsUpdatingMode] !== 0);
}

export function enterTile(tile, dir, opts = {}) {
  let mode0 = null;
  const goalFn = (st) => (x, y) => rawTileAhead(st, x, y, dir) === tile;
  let w = null;
  return task((st) => {
    mode0 ??= st.ram[V.GameMode];
    w ??= walkTo(goalFn({ ram: Uint8Array.from(st.ram), sram: Uint8Array.from(st.sram) }), { then: dir, ...opts, label: `enter tile ${tile}` });
    return w(st);
  }, (st) => mode0 !== null && st.ram[V.GameMode] !== mode0);
}

export function hold(input, frames) {
  let n = 0;
  return task(() => input, () => ++n > frames);
}
export function waitUntil(pred, input = 0) {
  return task(() => input, pred);
}
export function wander(frames, seed, { attackEvery = 0 } = {}) {
  let n = 0, s = seed, w = null, goalXY = null;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s >>> 16; };
  return task((st) => {
    const r = st.ram;
    if (!w || (goalXY && r[V.ObjX] === goalXY[0] && r[V.ObjY] === goalXY[1])) {
      for (let t = 0; t < 50; t++) {
        const gx = (rnd() % 31) * 8, gy = 0x3d + (rnd() % 21) * 8;
        if (r[V.CurLevel] && (gx < 0x20 || gx > 0xd0 || gy < 0x5d || gy > 0xbd)) continue;
        goalXY = [gx, gy];
        if (plan({ ram: Uint8Array.from(r), sram: Uint8Array.from(st.sram) }, r[V.ObjX] & 0xf8, (r[V.ObjY] & 0xf8) | 5, (x, y) => x === gx && y === gy, r[V.CurLevel] !== 0)) break;
      }
      w = walkTo((x, y) => x === goalXY[0] && y === goalXY[1], { then: 0, attackEvery, maxFrames: 1e9, label: 'wander' });
    }
    return w(st);
  }, () => ++n > frames);
}

/** Plays `prefix` (fixed inputs) then the tasks in the oracle; returns the movie (inputs per frame). */
export async function record(prefix, tasks, { log = true } = {}) {
  const oracle = await Oracle.create({ rom: romBytes });
  const inputs = Array.from(prefix);
  let ti = 0;
  let done = false;
  const big = 200000;
  const movie = createMovie(new Uint8Array(big), null, { name: 'gen' });
  movie.p1.set(prefix);
  let lastRoom = -1;
  const sink = {
    write(rec) {
      const f = rec.frame;
      if (f < prefix.length || done) return;
      const st = { ram: rec.ram, sram: rec.sram };
      while (ti < tasks.length && tasks[ti].until(st)) {
        if (log) console.log(`frame ${f}: task ${ti} done (room $${st.ram[V.RoomId].toString(16)}, mode ${st.ram[V.GameMode]})`);
        ti++;
      }
      if (ti >= tasks.length) { done = true; throw new StopRecording(); }
      if (log && st.ram[V.RoomId] !== lastRoom) { lastRoom = st.ram[V.RoomId]; console.log(`frame ${f}: room $${lastRoom.toString(16)} level ${st.ram[V.CurLevel]}`); }
      const input = tasks[ti].fn(st) ?? 0;
      movie.p1[f] = input; // read by NMI f+1
      inputs[f] = input;
    },
  };
  try {
    oracle.run(movie, sink);
  } catch (e) {
    if (!(e instanceof StopRecording)) throw e;
  }
  return createMovie(Uint8Array.from(inputs), null, { name: 'gen' });
}
class StopRecording extends Error {}

/** The walk-first-screens inputs up to the start of play (register a name, start the game). */
export function startPrefix() {
  const m = parseZmv(readFileSync(join(MOVIES, 'walk-first-screens.zmv'), 'utf8'));
  return m.p1.subarray(0, 120 + 2 + 90 + 2 + 90 + 5 * 8 + 3 * 10 + 2 + 90 + 2 + 240);
}

export function caveAndSword() {
  return [
    enterTile(0x24, U), // the sword cave in $77 (mode $B)
    waitUntil((st) => st.ram[V.GameMode] === 0x0b && st.ram[V.IsUpdatingMode] !== 0),
    // Link is halted while the old man's text appears, then walks up until CheckPersonBlocking stops him.
    waitUntil((st) => st.ram[V.ObjY] === 0x8d && st.ram[V.ObjGridOffset] === 0, U),
    waitUntil((st) => st.ram[V.ObjX] === 0x78 && st.ram[V.ObjGridOffset] === 0, R), // below the sword
    waitUntil((st) => st.ram[V.Items] !== 0, D), // step down onto the sword
    waitUntil((st) => st.ram[V.ObjState] === 0), // holding it up
    hold(0, 30),
    task(walkTo((x, y) => y === 0xdd, { then: D, label: 'cave exit' }).bind(null), (st) => st.ram[V.GameMode] !== 0x0b),
    waitUntil((st) => st.ram[V.GameMode] === 5 && st.ram[V.IsUpdatingMode] !== 0),
  ];
}

export async function owCaveWalls() {
  const tasks = [
    ...caveAndSword(),
    wander(500, 7),
    exitRoom(R),
    wander(1200, 11, { attackEvery: 23 }),
    exitRoom(U),
    wander(900, 5, { attackEvery: 31 }),
    exitRoom(D),
    wander(400, 3),
  ];
  const m = await record(startPrefix(), tasks);
  return m;
}

/** Walk the overworld to level 1 ($37) and the first dungeon rooms. */
export async function toLevel1() {
  const tasks = [
    ...caveAndSword(),
    travelTo(0x37),
    enterTile(0x24, U), // level 1 entrance (modes 2, 3/4, 5 in UW)
    waitUntil((st) => st.ram[V.GameMode] === 5 && st.ram[V.CurLevel] === 1 && st.ram[V.IsUpdatingMode] !== 0),
    wander(400, 9, { attackEvery: 17 }),
    exitRoom(L), // $72 (doorway: DoorwayDir, CheckDoorway, bounds off)
    wander(500, 13, { attackEvery: 19 }),
    exitRoom(R), // back to $73
    exitRoom(R), // $74
    wander(500, 21, { attackEvery: 29 }),
  ];
  return record(startPrefix(), tasks);
}

const GENERATORS = {
  'p06-ow-cave-walls': [owCaveWalls, 'Register, start, sword cave, walls/edges in $77,$78,$68, octoroks, sword hits, knockback.'],
  'p06-to-level1': [toLevel1, 'Register, start, sword cave, walk the overworld towards level 1.'],
};

if (import.meta.main) {
  const only = process.argv[2];
  for (const [name, [gen, comment]] of Object.entries(GENERATORS)) {
    if (only && only !== name) continue;
    const m = await gen();
    const text = serializeZmv(m).replace('zmv 1\n', `zmv 1\n# ${comment}\n# Generated by tests/game/p06-make-movies.mjs (closed-loop play in the oracle).\n`);
    writeFileSync(join(MOVIES, `${name}.zmv`), text);
    console.log(`${name}: ${m.length} frames`);
  }
}

export async function debugState(tasks, extra = 0) {
  let last = null;
  const t = [...tasks, task((st) => { last = st; return 0; }, () => extra-- <= 0)];
  await record(startPrefix(), t, { log: false });
  return last;
}
