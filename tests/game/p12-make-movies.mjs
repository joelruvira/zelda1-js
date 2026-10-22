// Generates the P12 movies by playing the original game in the oracle with a closed-loop controller
// (tests/game/p12-driver.mjs): every input is chosen from the RAM and recorded, so the .zmv replays the
// same run from power-on.
//   ow-tour.zmv          register a file, start, then walk through as many overworld screens as
//                        possible (exits chosen towards the least visited neighbour screen).
//   cave-and-cellar.zmv  register, start, enter the sword cave of room $77, take the sword, leave,
//                        walk to level 1 ($37), go down its entrance and walk through UW rooms.
// Usage: node tests/game/p12-make-movies.mjs [ow-tour|cave-and-cellar] [--frames N]
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDriver } from './p12-driver.mjs';
import { loadMovie } from '../../tools/oracle/lib/movie.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOVIES = join(HERE, '../oracle/movies');

// RAM (src/core/vars.js names)
const GameMode = 0x12, RoomId = 0xeb, CurLevel = 0x10, ObjX = 0x70, ObjY = 0x84, ObjDir = 0x98;
const ObjGridOffset = 0x394, ObjectFirstUnwalkableTile = 0x34a, Paused = 0xe0, MenuState = 0xe1;
const ObjShoveDistance = 0xd3;
const PLAY_AREA = 0x0530; // PlayAreaTiles - $6000
const U = 0x08, D = 0x04, L = 0x02, R = 0x01;
const DIRS = [U, D, L, R];

export class Walker {
  constructor(d) {
    this.d = d;
    this.visits = new Map(); // "level:room" -> count
    this.blocked = new Set(); // "level:room:x:y:dir" moves that did not work
    this.exitFails = new Map(); // "level:room:dir" -> count
    this.avoid = new Set([0x24, 0x70, 0x71, 0x72, 0x73]); // caves/stairs: only when targeted
    this.walkableOW = []; // WalkableTiles, read from the ROM (readWalkable)
  }

  get ram() { return this.d.ram; }
  tile(col, row) { return this.d.sram[PLAY_AREA + col * 0x16 + row]; }
  key(x, y, dir) { return `${this.ram[CurLevel]}:${this.ram[RoomId]}:${x}:${y}:${dir}`; }

  walkableTile(t, allowAvoid) {
    const ow = this.ram[CurLevel] === 0;
    if (ow && !allowAvoid && this.avoid.has(t)) return false;
    if (ow && this.walkableOW.includes(t)) t = 0x26;
    return t < this.ram[ObjectFirstUnwalkableTile];
  }

  /** Tile check of GetCollidingTileMoving for Link at (x, y) moving in dir. */
  tileFree(x, y, dir, allowAvoid) {
    const row = (yy) => ((yy - 0x40) & 0xff) >> 3;
    if (dir === U || dir === D) {
      let yy = y + 0x0b;
      if (dir === U) yy -= 8;
      else if (yy < 0xdd) yy += 8;
      const c = x >> 3, r = row(yy);
      if (r >= 0x16) return false;
      return this.walkableTile(this.tile(c, r), allowAvoid) && (c + 1 > 31 || this.walkableTile(this.tile(c + 1, r), allowAvoid));
    }
    let xx = x;
    if (dir === L && x >= 0x10) xx = x - 8;
    if (dir === R && x < 0xf0) xx = x + 0x10;
    const r = row(y + 0x0b);
    if (r >= 0x16) return false;
    return this.walkableTile(this.tile(xx >> 3, r), allowAvoid);
  }

  /**
   * Can Link at grid node (x, y) move one step in dir? 'exit' when it leaves the room: at the OW
   * screen edge, or through an open UW doorway (from the edge of the floor, if the doorway is free).
   */
  canMove(x, y, dir, allowAvoid = false) {
    if (this.blocked.has(this.key(x, y, dir))) return false;
    const uw = this.ram[CurLevel] !== 0;
    const minY = uw ? 0x5d : 0x3d, maxY = uw ? 0xbd : 0xdd;
    const minX = uw ? 0x20 : 0x00, maxX = uw ? 0xd0 : 0xf0;
    const edge = (dir === U && y <= minY) || (dir === D && y >= maxY) || (dir === L && x <= minX) || (dir === R && x >= maxX);
    if (edge && !uw) return 'exit';
    const beyond = (dir === U && y < minY) || (dir === D && y > maxY) || (dir === L && x < minX) || (dir === R && x > maxX);
    if (beyond) return 'exit'; // already in the doorway
    if (edge) {
      // the doorway: check the step after the edge of the floor
      const [nx, ny] = Walker.step(x, y, dir);
      return this.tileFree(x, y, dir, allowAvoid) && this.tileFree(nx, ny, dir, allowAvoid) ? 'exit' : false;
    }
    return this.tileFree(x, y, dir, allowAvoid);
  }

  static step(x, y, dir) {
    if (dir === U) return [x, y - 8];
    if (dir === D) return [x, y + 8];
    if (dir === L) return [x - 8, y];
    return [x + 8, y];
  }

  /** Positions of live monsters/projectiles (slots 1-$B), to keep Link away from them. */
  enemies() {
    const out = [];
    for (let s = 1; s <= 0x0b; s++) {
      const t = this.ram[0x34f + s];
      if (t !== 0 && t < 0x5f) out.push([this.ram[ObjX + s], this.ram[ObjY + s]]);
    }
    return out;
  }

  /** BFS that first avoids nodes close to enemies, then ignores them. */
  plan(x, y, goal, allowAvoid = false) {
    const en = this.enemies();
    if (en.length) {
      const near = (nx, ny) => en.some(([ex, ey]) => Math.abs(nx - ex) < 22 && Math.abs(ny - ey) < 22);
      const p = this.bfs(x, y, goal, allowAvoid, near);
      if (p) return p;
    }
    return this.bfs(x, y, goal, allowAvoid, null);
  }

  /** BFS from (x, y); goal(x, y) -> dir to finish (or null). Returns the list of dirs. */
  bfs(x, y, goal, allowAvoid, near) {
    const start = `${x},${y}`;
    const prev = new Map([[start, null]]);
    const q = [[x, y]];
    while (q.length) {
      const [cx, cy] = q.shift();
      const g = goal(cx, cy);
      if (g) {
        const path = [g];
        let k = `${cx},${cy}`;
        while (prev.get(k)) { const [pk, dir] = prev.get(k); path.unshift(dir); k = pk; }
        return path;
      }
      for (const dir of DIRS) {
        if (this.canMove(cx, cy, dir, allowAvoid) !== true) continue;
        const [nx, ny] = Walker.step(cx, cy, dir);
        const k = `${nx},${ny}`;
        if (prev.has(k)) continue;
        if (near && near(nx, ny)) continue;
        prev.set(k, [`${cx},${cy}`, dir]);
        q.push([nx, ny]);
      }
    }
    return null;
  }

  neighbour(dir) {
    const room = this.ram[RoomId];
    const col = room & 0x0f, row = room >> 4;
    if (dir === U) return row > 0 ? room - 16 : null;
    if (dir === D) return row < 7 ? room + 16 : null;
    if (dir === L) return col > 0 ? room - 1 : null;
    return col < 15 ? room + 1 : null;
  }

  /** Choose the exit of the current room towards the least visited neighbour. */
  /** All exits reachable from (x, y), best first (least visited neighbour, then failures, distance). */
  exits(x, y) {
    const lvl = this.ram[CurLevel], room = this.ram[RoomId];
    const out = [];
    for (const dir of DIRS) {
      const n = this.neighbour(dir);
      if (n === null) continue;
      const path = this.bfs(x, y, (cx, cy) => (this.canMove(cx, cy, dir) === 'exit' ? dir : null), false, null);
      if (!path) continue;
      const fails = this.exitFails.get(`${lvl}:${room}:${dir}`) ?? 0;
      const visits = this.visits.get(`${lvl}:${n}`) ?? 0;
      // novelty: a column/row of the map that no visited room has
      const cols = new Set(), rows = new Set();
      for (const key of this.visits.keys()) {
        const [l, r] = key.split(':').map(Number);
        if (l === lvl) { cols.add(r & 15); rows.add(r >> 4); }
      }
      const novel = this.novelty ? (cols.has(n & 15) ? 0 : 1) + (rows.has(n >> 4) ? 0 : 1) : 0;
      const bias = this.colBias ? this.colBias(n) : 0;
      out.push({ dir, target: n, visits, fails, score: visits * 1000 + fails * 5000 - novel * 400 + bias + path.length });
    }
    return out.sort((a, b) => a.score - b.score);
  }

  chooseExit(x, y, prefer) {
    const lvl = this.ram[CurLevel], room = this.ram[RoomId];
    let best = null;
    for (const dir of DIRS) {
      const n = this.neighbour(dir);
      if (n === null) continue;
      const path = this.bfs(x, y, (cx, cy) => (this.canMove(cx, cy, dir) === 'exit' ? dir : null), false, null);
      if (!path) continue;
      const fails = this.exitFails.get(`${lvl}:${room}:${dir}`) ?? 0;
      const score = (prefer ? prefer(n, dir) : (this.visits.get(`${lvl}:${n}`) ?? 0) * 1000) + fails * 5000 + path.length;
      if (!best || score < best.score) best = { dir, path, score, target: n };
    }
    return best;
  }
}

/**
 * Walk with a per-frame controller. goal(x, y) gives the final dir at the goal node (as for plan()).
 * Returns when done() is true or after maxFrames.
 */
export function walk(w, { goal, done, maxFrames = 3000, allowAvoid = false, onRoom }) {
  const d = w.d, ram = w.ram;
  let lastDir = U, stillFor = 0, lastPos = -1, lastRoom = -1, start = d.frame;
  while (!done() && d.frame - start < maxFrames) {
    const mode = ram[GameMode];
    if (mode === 0x11 || mode === 0x08) { d.step(d.frame & 1 ? 0x10 : 0); continue; } // death: continue
    if (mode !== 5 || ram[Paused] || ram[MenuState]) { d.step(0); continue; }
    const room = (ram[CurLevel] << 8) | ram[RoomId];
    if (room !== lastRoom) { lastRoom = room; onRoom?.(); }
    const x = ram[ObjX], y = ram[ObjY];
    const aligned = ram[ObjGridOffset] === 0 && (x & 7) === 0 && (y & 7) === 5 && ram[ObjShoveDistance] === 0;
    let dir = lastDir;
    if (aligned) {
      const p = w.plan(x, y, goal, allowAvoid);
      if (!p) { d.step(0); continue; }
      dir = p[0];
    }
    const pos = (x << 8) | y;
    if (pos === lastPos && ram[ObjShoveDistance] === 0) {
      if (++stillFor > 16 && aligned) {
        w.blocked.add(w.key(x, y, dir));
        stillFor = 0;
      }
    } else stillFor = 0;
    lastPos = pos;
    lastDir = dir;
    if (process.env.P12_TRACE) console.error(`f${d.frame} m${ram[GameMode]} ${x.toString(16)},${y.toString(16)} go${ram[ObjGridOffset]} al${aligned} dir${dir}`);
    d.step(dir);
  }
  return done();
}

async function prefix(d) {
  const m = loadMovie(join(MOVIES, 'register-name.zmv'));
  d.comment('register-name.zmv: register a name, start the game (mode 5 in room $77)');
  for (let i = 0; i < m.length; i++) d.step(m.p1[i]);
}

async function readWalkable(w) {
  const { table, loadSymbols } = await import('../../src/core/rom.js');
  const { loadRom } = await import('../../src/core/rom.js');
  await loadSymbols();
  const rom = loadRom(w.d.rom.bytes);
  w.walkableOW = Array.from(table(rom, 'WalkableTiles').bytes());
}

const health = (ram) => ((ram[0x66f] & 0x0f) << 8) | ram[0x670]; // HeartValues / HeartPartial

/**
 * Overworld tour with look-ahead: in each room the candidate exits (and a variant that waits first)
 * are played from a savestate; the one that loses the least health (never dying) wins, preferring
 * less visited neighbours. Returns the log [frame, level, room] of the kept run.
 */
export function searchTour(d, w, { maxFrames, stop = () => false, level = 0, byVisits = true, filter = true }) {
  const ram = d.ram;
  const startFrame = d.frame;
  const log = [];
  while (d.frame - startFrame < maxFrames && !stop()) {
    while (ram[GameMode] !== 5) d.step(0);
    if (ram[CurLevel] !== level) break;
    const room = ram[RoomId];
    log.push([d.frame, level, room]);
    const k = `${level}:${room}`;
    w.visits.set(k, (w.visits.get(k) ?? 0) + 1);
    const x = ram[ObjX] & 0xf8, y = (ram[ObjY] & 0xf8) | 5;
    const exits = w.exits(x, y);
    if (process.env.P12_VERBOSE) console.error(`room $${room.toString(16)} link ${x.toString(16)},${y.toString(16)} exits ${JSON.stringify(exits.map((e) => [e.dir, e.target]))}`);
    if (!exits.length) { console.error(`room $${room.toString(16)}: no exit`); break; }
    const minVisits = exits[0].visits;
    const cp = d.save();
    const h0 = health(ram);
    let best = null;
    const tryExit = (e, wait) => {
      d.load(cp);
      d.run(wait);
      walk(w, {
        goal: (cx, cy) => (w.canMove(cx, cy, e.dir) === 'exit' ? e.dir : null),
        done: () => ram[RoomId] !== room || ram[CurLevel] !== level || ram[GameMode] === 0x11,
        maxFrames: 1200,
      });
      while (ram[GameMode] !== 5 && ram[GameMode] !== 0x11 && d.frame - cp.done < 3000) d.step(0);
      const left = ram[RoomId] !== room && ram[GameMode] === 5 && ram[CurLevel] === level;
      if (!left) {
        const kk = `${level}:${room}:${e.dir}`;
        w.exitFails.set(kk, (w.exitFails.get(kk) ?? 0) + 1);
        return;
      }
      const lost = h0 - health(ram);
      const score = lost * 4 + (byVisits ? (w.visits.get(`${level}:${ram[RoomId]}`) ?? 0) * 600 : 0) + (d.frame - cp.done) / 10 +
        (w.colBias ? w.colBias(ram[RoomId]) : 0);
      if (!best || score < best.score) best = { score, lost, st: d.save() };
    };
    // first the least visited exits without waiting, then everything with waits
    for (const e of (filter ? exits.filter((c) => c.visits <= minVisits + 1) : exits).slice(0, 3)) {
      tryExit(e, 0);
      if (best && best.lost === 0) break;
    }
    if (!best || best.lost > 0) {
      for (const wait of [30, 70, 120, 200]) {
        for (const e of exits) {
          tryExit(e, wait);
          if (best && best.lost === 0) break;
        }
        if (best && best.lost === 0) break;
      }
    }
    if (!best) { d.load(cp); console.error(`room $${room.toString(16)}: stuck, stop`); break; }
    d.load(best.st);
    if (process.env.P12_VERBOSE) console.error(`$${room.toString(16)} -> $${ram[RoomId].toString(16)} lost ${best.lost} health ${health(ram)} frame ${d.frame}`);
    if (health(ram) < 0x100) { console.error(`low health at $${room.toString(16)}: stop`); break; }
  }
  return log;
}

export async function makeOwTour(maxFrames, west = false) {
  const d = await createDriver();
  const w = new Walker(d);
  await readWalkable(w);
  await prefix(d);
  d.comment('overworld tour (generated by tests/game/p12-make-movies.mjs)');
  if (west) {
    w.novelty = true;
    w.colBias = (r) => (r & 15) * 20;
  }
  const log = searchTour(d, w, { maxFrames, stop: () => w.visits.size >= 128 });
  return { d, w, log };
}

/** Walk into a square made of `tile` (cave or level entrance) going up; returns when the mode changes. */
function walkIntoTile(w, tile, maxFrames = 2000) {
  const ram = w.ram;
  const room = ram[RoomId];
  return walk(w, {
    goal: (cx, cy) => {
      if (w.canMove(cx, cy, U, true) !== true) return null;
      return w.tile(cx >> 3, ((cy + 3 - 0x40) & 0xff) >> 3) === tile ? U : null;
    },
    allowAvoid: true,
    done: () => ram[GameMode] !== 5 || ram[RoomId] !== room,
    maxFrames,
  });
}

const roomDist = (a, b) => Math.abs((a & 15) - (b & 15)) + Math.abs((a >> 4) - (b >> 4));

export async function makeCaveAndCellar(maxFrames) {
  const d = await createDriver();
  const w = new Walker(d);
  await readWalkable(w);
  await prefix(d);
  const ram = d.ram;
  const IsUpdatingMode = 0x11, Sword = 0x657;
  const waitMode = (mode, limit = 1500) => {
    const f0 = d.frame;
    while (!(ram[GameMode] === mode && ram[IsUpdatingMode]) && d.frame - f0 < limit) d.step(0);
    if (ram[GameMode] !== mode) throw new Error(`mode $${mode.toString(16)} not reached (frame ${d.frame})`);
  };
  d.comment('walk into the cave of room $77 (modes $10, $B)');
  walkIntoTile(w, 0x24);
  waitMode(0x0b);
  d.comment('in the cave: wait for the old man text, take the sword');
  d.run(250);
  while (ram[ObjX] < 0x78) d.step(R);
  for (let f0 = d.frame; ram[Sword] === 0 && d.frame - f0 < 400;) d.step(U);
  if (!ram[Sword]) throw new Error('sword not taken');
  d.run(60);
  d.comment('leave the cave (modes $A, 4, 5)');
  for (let f0 = d.frame; ram[GameMode] === 0x0b && d.frame - f0 < 600;) d.step(D);
  waitMode(5);
  d.comment('walk to level 1 (room $37), choosing exits by look-ahead');
  w.colBias = (r) => roomDist(r, 0x37) * 400;
  searchTour(d, w, { maxFrames, filter: false, stop: () => ram[RoomId] === 0x37 && ram[CurLevel] === 0 });
  if (ram[RoomId] !== 0x37) throw new Error(`level 1 room not reached (room $${ram[RoomId].toString(16)})`);
  d.comment('enter level 1 (modes $10, 2, 3)');
  walkIntoTile(w, 0x24);
  waitMode(5, 3000);
  if (ram[CurLevel] !== 1) throw new Error('not in level 1');
  d.comment('level 1: walk through open doorways (modes 6, 7, 4)');
  w.colBias = null;
  const log = searchTour(d, w, {
    maxFrames, level: 1,
    stop: () => [...w.visits.keys()].filter((k) => k.startsWith('1:')).length >= 3,
  });
  d.run(30);
  return { d, w, log };
}

const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const which = argv.find((a) => !a.startsWith('--')) ?? 'ow-tour';
  const fi = argv.indexOf('--frames');
  const frames = fi >= 0 ? Number(argv[fi + 1]) : 12000;
  if (which === 'ow-tour' || which === 'ow-tour-west') {
    const west = which === 'ow-tour-west';
    const { d, log } = await makeOwTour(frames, west);
    const rooms = [...new Set(log.filter((e) => e[1] === 0).map((e) => e[2]))];
    const text = d.toZmv([
      `P12 ${which}: register-name.zmv, then a walk through the overworld${west ? ' (biased to the west)' : ''}`,
      '(PlayAreaTiles $6530-$67EF and nametables), without dying: each exit is chosen by look-ahead',
      `from a savestate. Generated by tests/game/p12-make-movies.mjs; ${rooms.length} OW rooms visited.`,
    ]);
    writeFileSync(join(MOVIES, `${which}.zmv`), text);
    writeFileSync(join(MOVIES, `${which}.expect.json`), JSON.stringify({
      comment: `Overworld tour: ${rooms.length} distinct OW rooms (OW scrolls, no death, no cave).`,
      reaches: { GameMode: [5, 7], RoomId: rooms.sort((a, b) => a - b) },
    }, null, 2) + '\n');
    console.log(`${which}: ${d.frame} frames, ${rooms.length} rooms: ${rooms.map((r) => r.toString(16)).join(' ')}`);
  }
  if (which === 'cave-and-cellar') {
    const { d, log } = await makeCaveAndCellar(frames);
    const uw = [...new Set(log.filter((e) => e[1] === 1).map((e) => e[2]))];
    writeFileSync(join(MOVIES, 'cave-and-cellar.zmv'), d.toZmv([
      'P12 cave-and-cellar: register-name.zmv, sword cave of room $77 (LayoutCaveAndAvanceSubmode, modes',
      '$10/$B, leaving it with modes $A/4: LayoutRoom_SubmodeTask), walk to level 1 and its UW rooms',
      `(LayOutRoom UW: walls, doors, floor). Generated by tests/game/p12-make-movies.mjs; UW rooms: ${uw.map((r) => '$' + r.toString(16)).join(' ')}.`,
    ]));
    writeFileSync(join(MOVIES, 'cave-and-cellar.expect.json'), JSON.stringify({
      comment: 'Sword cave in $77 (modes $10, $B, $A, 4), level 1 entrance (modes 2, 3) and UW rooms (modes 6, 7).',
      reaches: { GameMode: [2, 3, 4, 5, 6, 7, 10, 11, 16], CurLevel: 1, RoomId: [0x77, 0x37, ...uw] },
    }, null, 2) + '\n');
    console.log(`cave-and-cellar: ${d.frame} frames, UW rooms ${uw.map((r) => r.toString(16)).join(' ')}`);
  }
}
