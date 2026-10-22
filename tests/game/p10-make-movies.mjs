#!/usr/bin/env node
// Generator of the P10 oracle scenario triforce-level1. Run:  node tests/game/p10-make-movies.mjs
//
// From tests/oracle/movies/p10-items.sav (p08-items.sav: slot 1 with wooden sword, ladder, magic
// shield, red ring and magic key, here with 14 full heart containers; rebuilt reproducibly from
// tests/game/p08-make-movies.mjs#makeItemsSram if missing; only the player area $6000-$652F, no ROM
// data) it replays uw-doorways.zmv up to the
// entrance of level 1 and then plays the ORIGINAL game in the oracle with a closed-loop controller
// along the route $73 -N-> $63 -N-> $53 -W-> $52 -N-> $42 -E-> $43 -E-> $44 -E-> $45 -N-> $35
// (Aquamentus) -E-> $36. On the way it takes every dropped item and visible room item (TryTakeItem,
// UpdateItem with Link and the sword as takers, rupees, hearts, keys, the map: TakeClass0Complex
// and StatusBarMapTrigger, the boomerang), hunts the monsters of rooms whose item is not visible
// yet, kills Aquamentus, takes the heart container (take-heart-container) and the triforce piece
// (mode $12, end of level), and waits until Link is back in the overworld.
// Inside a room the route is a BFS over Link's 8-pixel grid using the port's tile collision
// (GetCollidingTileMoving) on the oracle's RAM/SRAM. The movie is replayed from power-on to check it.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { createMovie, serializeZmv, loadMovie } from '../../tools/oracle/lib/movie.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram } from '../../src/core/ram.js';
import {
  GameMode, RoomId, ObjX, ObjY, ObjDir, ObjGridOffset, ObjectFirstUnwalkableTile, CurLevel, ObjType,
  ObjShoveDir, IsUpdatingMode, ObjState, RoomItemId, Item_ObjItemId, ObjMetastate, Items, HeartValues,
  LevelInfo_WorldFlagsAddr, InvTriforce, SaveFileAItems0, FileAChecksums,
} from '../../src/core/vars.js';

const MOVIES = join(import.meta.dirname, '..', 'oracle', 'movies');
const SRAM_REL = 'p10-items.sav';
const B = { A: 0x80, B: 0x40, S: 0x20, T: 0x10, U: 0x08, D: 0x04, L: 0x02, R: 0x01 };
const DIR_BTN = { 1: B.R, 2: B.L, 4: B.D, 8: B.U };
const DXY = { 1: [8, 0], 2: [-8, 0], 4: [0, 8], 8: [0, -8] };
const DOOR = { 8: [0x78, 0x5d], 4: [0x78, 0xbd], 2: [0x20, 0x8d], 1: [0xd0, 0x8d] };
const ROUTE = [8, 8, 2, 8, 1, 1, 1, 8]; // $73 -> $35
const BOSS_ROOM = 0x35;
const hex = (v) => `$${v.toString(16).padStart(2, '0')}`;

let rom = null;
let sramInit = null;
let GetCollidingTileMoving = null;
async function init() {
  rom = loadRomFile();
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  ({ GetCollidingTileMoving } = await import('../../src/game/movement/tiles.js'));
  const p = join(MOVIES, SRAM_REL);
  if (existsSync(p)) sramInit = readFileSync(p);
  else {
    sramInit = await makeP10Sram();
    writeFileSync(p, sramInit);
    console.log(`wrote ${SRAM_REL}`);
  }
}

/**
 * p10-items.sav: p08-items.sav (rebuilt by p08-make-movies#makeItemsSram if missing) with 14 heart
 * containers, all full (HeartValues $DD), so the heart container of level 1 adds one (TakeItem
 * @TakeHeartContainer). File A's checksum is fixed. Player area $6000-$652F only, no ROM data.
 */
async function makeP10Sram() {
  const p8 = join(MOVIES, 'p08-items.sav');
  let s;
  if (existsSync(p8)) s = Uint8Array.from(readFileSync(p8));
  else {
    const { makeItemsSram } = await import('./p08-make-movies.mjs');
    s = await makeItemsSram();
    writeFileSync(p8, s);
  }
  const i = SaveFileAItems0 - 0x6000 + (HeartValues - Items);
  const delta = 0xdd - s[i];
  s[i] = 0xdd;
  const c = FileAChecksums - 0x6000;
  const sum = ((((s[c] << 8) | s[c + 1]) + delta) & 0xffff);
  s[c] = sum >> 8;
  s[c + 1] = sum & 0xff;
  return s;
}

class Sim {
  constructor(inputs = []) {
    this.inputs = [...inputs];
    this.controller = () => 0;
  }

  async start() {
    this.o = await Oracle.create({ rom: rom.bytes, sram: sramInit, powerOnFill: 0 });
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

async function replay(inputs) {
  const sim = await new Sim(inputs).start();
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
      if (!inside(nx, ny) && !goal(nx, ny)) continue;
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

const playing = (r) => r[GameMode] === 5 && r[IsUpdatingMode] !== 0;
const isMonster = (r, i) => r[ObjType + i] !== 0 && r[ObjType + i] < 0x53 && r[ObjMetastate + i] === 0;

function roomItemTaken(sim) {
  const s = sim.o.sram, r = sim.ram;
  const p = s[LevelInfo_WorldFlagsAddr - 0x6000] | (s[LevelInfo_WorldFlagsAddr - 0x6000 + 1] << 8);
  return (r[(p + r[RoomId]) & 0x7ff] & 0x10) !== 0;
}

/** Items Link should walk to: dropped items ($60) and the visible room item. [{x, y}] */
function itemsToTake(sim) {
  const r = sim.ram;
  const out = [];
  for (let i = 1; i < 0x0c; i++) {
    if (r[ObjType + i] === 0x60 && r[ObjMetastate + i] === 0 && r[Item_ObjItemId + i] !== 0xff) out.push({ x: r[ObjX + i], y: r[ObjY + i] });
  }
  if (!(r[ObjState + 0x13] & 0x80) && r[RoomItemId] !== 0x3f && !roomItemTaken(sim)) {
    const carried = [0x17, 0x2a, 0x30].includes(r[ObjType + 1]);
    if (!carried) out.push({ x: r[ObjX + 0x13], y: r[ObjY + 0x13] });
  }
  return out;
}

/** The room has an item that is not visible yet (it appears when the monsters are killed). */
const hiddenItem = (sim) => (sim.ram[ObjState + 0x13] & 0x80) !== 0 && sim.ram[RoomItemId] !== 0x3f && !roomItemTaken(sim);

function nearest(list, x, y) {
  let best = null, bd = 1e9;
  for (const p of list) {
    const d = Math.abs(p.x - x) + Math.abs(p.y - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/**
 * Room controller: takes items, hunts monsters while hunt() says so, then walks to the doorway
 * `door` (0: stay) and pushes through it.
 */
function roomController(sim, door, hunt) {
  const blocked = new Set();
  let last = null, still = 0, lastDir = 0, phase = 0;
  return (r, frame) => {
    if (!playing(r) || r[ObjShoveDir] !== 0) return 0;
    const x = r[ObjX], y = r[ObjY];
    const pos = `${x},${y}`;
    if (pos === last && lastDir) {
      if (++still > 24) { blocked.add(`${x},${y},${lastDir}`); still = 0; }
    } else { still = 0; }
    last = pos;
    phase++;
    // Defensive swing at monsters close to Link.
    const monsters = [];
    for (let i = 1; i < 0x0c; i++) if (isMonster(r, i)) monsters.push({ x: r[ObjX + i], y: r[ObjY + i], i });
    if (r[ObjGridOffset] !== 0) { lastDir = r[ObjDir]; return DIR_BTN[r[ObjDir]] ?? 0; }

    ram.set(r);
    sram.set(sim.o.sram);
    let goal = null, faceTo = 0;
    const items = itemsToTake(sim);
    const it = nearest(items, x, y);
    if (it) {
      goal = (gx, gy) => Math.abs(gx - it.x) < 8 && Math.abs(gy + 3 - it.y) < 8;
    } else if (monsters.length && hunt(r)) {
      const m = nearest(monsters, x, y);
      goal = (gx, gy) => {
        const dx = m.x - gx, dy = m.y - gy;
        return (Math.abs(dy) < 8 && Math.abs(dx) >= 8 && Math.abs(dx) <= 24) || (Math.abs(dx) < 8 && Math.abs(dy) >= 8 && Math.abs(dy) <= 24);
      };
      const dx = m.x - x, dy = m.y - y;
      faceTo = Math.abs(dy) < 8 ? (dx > 0 ? 1 : 2) : (dy > 0 ? 4 : 8);
    } else if (door) {
      const [gx, gy] = DOOR[door];
      // Already in the doorway (past its grid point): keep pushing.
      const past = door === 8 ? y < gy : door === 4 ? y > gy : door === 2 ? x < gx : x > gx;
      if (past && (door & 0x0c ? x === gx : y === gy)) { lastDir = door; return DIR_BTN[door]; }
      goal = (px, py) => px === gx && py === gy;
      faceTo = -door;
    } else {
      return 0;
    }
    const d = planStep(x, y, goal, blocked);
    if (d === -1) {
      if (faceTo < 0) { lastDir = -faceTo; return DIR_BTN[-faceTo]; } // through the doorway
      if (faceTo) {
        // Face the monster, then swing.
        lastDir = 0;
        if (r[ObjDir] !== faceTo) return DIR_BTN[faceTo];
        return phase % 4 === 0 ? B.A : 0;
      }
      lastDir = 0;
      return 0;
    }
    if (d === 0) { lastDir = 0; return phase % 8 === 0 ? B.A : 0; }
    const near = monsters.some((m) => Math.abs(m.x - x) < 0x18 && Math.abs(m.y - y) < 0x18);
    if (near && phase % 12 === 0) { lastDir = 0; return B.A; }
    lastDir = d;
    return DIR_BTN[d];
  };
}

// ------------------------------------------------------------------ scenario

export async function makeTriforceLevel1() {
  await init();
  const doorways = loadMovie(join(MOVIES, 'uw-doorways.zmv'));
  let sim = await new Sim([...doorways.p1]).start();
  if (!sim.runUntil((r) => r[CurLevel] === 1 && playing(r), doorways.p1.length)) throw new Error('uw-doorways does not enter level 1');
  sim = await replay(sim.used());
  console.log(`level 1 at frame ${sim.frame}, room ${hex(sim.ram[RoomId])}`);

  const visited = [sim.ram[RoomId]];
  for (const d of ROUTE) {
    const room = sim.ram[RoomId];
    const start = sim.frame;
    // Hunt while the room hides its item (up to a budget), then go.
    sim.controller = roomController(sim, d, () => hiddenItem(sim) && sim.frame - start < 2400);
    const ok = sim.runUntil((r) => playing(r) && r[RoomId] !== room, 4000);
    sim.controller = () => 0;
    if (!ok) throw new Error(`blocked in ${hex(room)} going ${d} (frame ${sim.frame}, at ${hex(sim.ram[ObjX])},${hex(sim.ram[ObjY])})`);
    visited.push(sim.ram[RoomId]);
    console.log(`  ${hex(room)} -${d}-> ${hex(sim.ram[RoomId])} frame ${sim.frame} rupees? hearts ${hex(sim.ram[HeartValues])}`);
  }
  if (sim.ram[RoomId] !== BOSS_ROOM) throw new Error(`not in the boss room: ${hex(sim.ram[RoomId])}`);

  // Kill Aquamentus and take the heart container.
  const hc = sim.ram[HeartValues];
  sim.controller = roomController(sim, 0, () => true);
  if (!sim.runUntil((r) => (r[HeartValues] & 0xf0) !== (hc & 0xf0), 6000)) {
    throw new Error(`boss room: no heart container (frame ${sim.frame})`);
  }
  console.log(`heart container at frame ${sim.frame}: hearts ${hex(sim.ram[HeartValues])}`);
  // Through the east shutter to the triforce room and take it (mode $12).
  sim.controller = roomController(sim, 1, () => false);
  if (!sim.runUntil((r) => playing(r) && r[RoomId] !== BOSS_ROOM, 3000)) throw new Error('cannot leave the boss room');
  visited.push(sim.ram[RoomId]);
  console.log(`triforce room ${hex(sim.ram[RoomId])} frame ${sim.frame}`);
  sim.controller = roomController(sim, 0, () => false);
  if (!sim.runUntil((r) => r[GameMode] === 0x12, 3000)) throw new Error('triforce not taken');
  const triforceFrame = sim.frame;
  console.log(`mode $12 at frame ${triforceFrame}`);
  sim.controller = () => 0;
  if (!sim.runUntil((r) => r[CurLevel] === 0 && playing(r), 3000)) throw new Error('not back in the OW');
  sim.runUntil(() => false, 60);
  const inputs = sim.used();

  const comment = [
    'P10: from tests/oracle/movies/p10-items.sav (14 hearts), replay uw-doorways up to level 1, then $73 $63 $53 $52',
    '$42 $43 $44 $45 $35: take dropped and room items, kill Aquamentus, take the heart container, then',
    `the triforce piece in $36 (mode $12 at frame ${triforceFrame}) and back to the overworld.`,
    'Generated by tests/game/p10-make-movies.mjs. Run with --sram tests/oracle/movies/p10-items.sav.',
  ];
  const m = createMovie(Uint8Array.from(inputs), null, { name: 'triforce-level1' });
  writeFileSync(join(MOVIES, 'triforce-level1.zmv'),
    serializeZmv(m).replace(/^zmv 1\n/, `zmv 1\n${comment.map((c) => `# ${c}`).join('\n')}\n`));

  // Check from power-on and record what was reached.
  const check = await replay(inputs);
  const r = check.ram;
  if (r[CurLevel] !== 0 || !playing(r) || !(r[InvTriforce] & 0x01)) throw new Error('replay does not end in the OW with triforce 1');
  writeFileSync(join(MOVIES, 'triforce-level1.expect.json'), `${JSON.stringify({
    comment: 'Level 1 to Aquamentus: items taken on the way, heart container, triforce piece (mode $12), back to the OW.',
    sram: SRAM_REL,
    reaches: { RoomId: [...new Set(visited)], GameMode: [5, 0x12], InvTriforce: [1] },
  }, null, 2)}\n`);
  console.log(`triforce-level1: ${inputs.length} frames, items ${[...r.subarray(Items, Items + 0x21)].map((v) => v.toString(16)).join(' ')}`);
}

if (import.meta.main) {
  await makeTriforceLevel1();
}
