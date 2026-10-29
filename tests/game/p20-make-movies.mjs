#!/usr/bin/env node
// Generator of the P20 oracle scenario uw-enemies-b (underworld monsters B). Run:
//   node tests/game/p20-make-movies.mjs [tour|check|all]      (P20_QUEST=0|1 picks one quest)
//
//  * Same prepared SRAM as uw-enemies-a (tests/oracle/movies/p19-items.sav: wooden sword, bombs, bow and
//    arrows, recorder, red potion, red ring, magic shield, magic key, 16 full hearts, the 8 triforce
//    pieces), first quest.
//  * Recorder to level 5's entrance room ($0B), walk west over Death Mountain to $05 (Spectacle Rock),
//    bomb the rock wall and enter level 9: red lamnola ($55), blue and red wizzrobes ($65, $46...).
//    Then recorder to level 6 (red wizzrobes in $78, traps in $48, mixed wizzrobes in $38) and to
//    level 1 (wallmasters in $45, traps in $22). Statues shoot fireballs in the rooms that have them.
//  * Boss rooms (P21/P22) are avoided: the controller backs out of them (oracle snapshots).
// The inputs come from the closed-loop controller of tests/game/p19-make-movies.mjs playing the ORIGINAL
// game in the oracle. Checkpoints in out/p20/ (P20_RESUME=name resumes after that step).
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as P from './p19-make-movies.mjs';
import * as V from '../../src/core/vars.js';
import { ram, sram } from '../../src/core/ram.js';

const { B, hex } = P;
export const MOVIES_BY_QUEST = ['uw-enemies-b', 'uw-enemies-b2'];
export const SRAMS_BY_QUEST = ['p20-items.sav', 'p20-items-q2.sav'];

/**
 * p19-items.sav (p19-items-q2.sav for the second quest) plus the power bracelet (the rock over the shortcut
 * stairs of $1D), the ladder and the magical sword, checksum fixed.
 */
export async function makeItemsSram(quest = 0) {
  const s = await P.ensureItemsSram(quest);
  const set = (v, value) => {
    const i = V.SaveFileAItems0 - 0x6000 + (v - V.Items);
    const delta = value - s[i];
    s[i] = value;
    let sum = (s[V.FileAChecksums - 0x6000] << 8) | s[V.FileAChecksums - 0x6000 + 1];
    sum = (sum + delta) & 0xffff;
    s[V.FileAChecksums - 0x6000] = sum >> 8;
    s[V.FileAChecksums - 0x6000 + 1] = sum & 0xff;
  };
  set(V.InvBracelet, 1);
  set(V.InvLadder, 1); // the water bands of level 9 ($65)
  set(V.Items, 3); // magical sword: the wizzrobes and lamnolas go down faster
  return s;
}

async function ensureSram(quest) {
  const file = SRAMS_BY_QUEST[quest];
  const path = join(P.MOVIES, file);
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  const s = await makeItemsSram(quest);
  writeFileSync(path, s);
  console.log(`wrote ${file}`);
  return s;
}

export const P20_TYPES = {
  0x23: 'blue wizzrobe', 0x24: 'red wizzrobe', 0x27: 'wallmaster', 0x3a: 'red lamnola', 0x3b: 'blue lamnola',
  0x49: 'trap', 0x4a: 'trap set',
};
// The P20 monsters are allowed now; bosses stay forbidden.
for (const t of [0x23, 0x24, 0x27, 0x3a, 0x3b]) P.FORBIDDEN.delete(t);

// The ladder crosses one water tile ($F4) of the underworld going up or down (Link_EndMoveAndAnimate
// @CheckLadder): the planner lets Link step onto water vertically, never sideways while on it.
P.hooks.walkable = (x, y, d, t, ok) => {
  if (ram[V.CurLevel] === 0 || ram[V.InvLadder] === 0) return ok;
  const onWater = P.rawTileStill(x, y) === 0xf4;
  ram[V.ObjX] = x; ram[V.ObjY] = y; ram[0x0f] = d; // rawTileStill moved them
  if (d === 1 || d === 2) return ok && !onWater;
  return ok || t === 0xf4;
};

const CKPT = join(import.meta.dirname, '..', '..', 'out', 'p20');

function save(sim, name, state) {
  mkdirSync(CKPT, { recursive: true });
  writeFileSync(join(CKPT, `${name}.json`), JSON.stringify({ inputs: sim.used(), events: sim.events, state }));
  console.log(`checkpoint ${name} f${sim.frame}`);
}

async function resume(s, name) {
  const c = JSON.parse(readFileSync(join(CKPT, `${name}.json`), 'utf8'));
  const sim = await new P.Sim(s, c.inputs).start();
  P.setCur(sim);
  sim.runUntil(() => false, c.inputs.length);
  sim.events = c.events;
  console.log(`resumed after ${name} at f${sim.frame}`);
  return { sim, state: c.state };
}

/** OW: walks rooms by the given edge letters. */
function owRoute(sim, route) {
  const L = { N: 8, S: 4, W: 2, E: 1 };
  for (const c of route) {
    if (!P.exitRoomOW(sim, L[c], 2400)) throw new Error(`OW: cannot leave ${hex(sim.ram[V.RoomId])} by ${c}`);
    sim.play([[20, 0]]);
    P.log(sim, `  ow ${c}`);
  }
}

const { getPalette, indicesToRgb } = await import('../../tools/oracle/lib/palette.mjs');
const { encodePng } = await import('../../tools/oracle/lib/png.mjs');
const PALETTE = await getPalette();
/** Debug: PNG of the oracle's current picture. */
export function shot(sim, file) {
  writeFileSync(file, encodePng(256, 240, indicesToRgb(sim.o.framebufferIndices(), PALETTE)));
}

/** Debug: the room's tiles (16x16 squares) as hex. */
export function dumpRoom(sim) {
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const rows = [];
  for (let y = 0x45; y <= 0xdd; y += 16) {
    const row = [];
    for (let x = 0; x <= 0xf0; x += 16) row.push(hex(P.rawTileStill(x, y)).slice(1));
    rows.push(row.join(' '));
  }
  console.log(`room ${hex(sim.ram[V.RoomId])}:\n${rows.join('\n')}`);
}

/** Squares reachable from Link (port collision on the oracle's state), as a Set of "x,y". */
function reachable(sim) {
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const sx = sim.ram[V.ObjX] & 0xf8, sy = (sim.ram[V.ObjY] & 0xf8) | 5;
  const seen = new Set([`${sx},${sy}`]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const d of [8, 4, 2, 1]) {
      const [dx, dy] = P.DXY[d];
      const nx = x + dx, ny = y + dy;
      if (!P.inside(nx, ny) || seen.has(`${nx},${ny}`) || !P.walkable(x, y, d)) continue;
      if (P.isWarpTile(P.rawTileStill(nx, ny))) continue;
      seen.add(`${nx},${ny}`);
      q.push([nx, ny]);
    }
  }
  return seen;
}

/** Edge squares of side c reachable from Link, one per contiguous segment. */
function edgeExits(sim, c) {
  const pts = [...reachable(sim)].map((k) => k.split(',').map(Number));
  const on = pts.filter(([x, y]) => (c === 'W' ? x === P.X0 : c === 'E' ? x === P.X1 : c === 'N' ? y === P.Y0 : y === P.Y1));
  const along = (p) => (c === 'W' || c === 'E' ? p[1] : p[0]);
  on.sort((a, b) => along(a) - along(b));
  const segs = [];
  for (const p of on) {
    const last = segs.at(-1);
    if (last && along(p) - along(last.at(-1)) === 8) last.push(p); else segs.push([p]);
  }
  return segs.map((s) => s[s.length >> 1]);
}

/** OW: breadth-first search over (room, region) (oracle snapshots) until room `target`; returns the edge letters. */
function owSearch(sim, target, allowed = () => true) {
  const L = { N: 8, S: 4, W: 2, E: 1 };
  const start = sim.ram[V.RoomId];
  const regionKey = () => `${sim.ram[V.RoomId]}:${[...reachable(sim)].sort()[0]}`;
  const k0 = regionKey();
  const seen = new Map([[k0, { snap: sim.snapshot(), path: '', room: start }]]);
  const q = [k0];
  while (q.length) {
    const key = q.shift();
    const node = seen.get(key);
    const room = node.room;
    sim.restore(node.snap);
    const exits = [];
    for (const c of 'WNSE') for (const p of edgeExits(sim, c)) exits.push([c, p]);
    for (const [c, [gx, gy]] of exits) {
      sim.restore(node.snap);
      sim.controller = P.walkController((x, y) => x === gx && y === gy, { finalDir: L[c] });
      const ok = sim.runUntil((r) => P.playing(r) && r[V.RoomId] !== room, 1500);
      sim.controller = () => 0;
      if (!ok) continue;
      sim.play([[20, 0]]);
      if (!P.playing(sim.ram) || sim.ram[V.CurLevel] !== 0) continue;
      const to = sim.ram[V.RoomId];
      if (!allowed(to)) continue;
      const k = regionKey();
      if (seen.has(k)) continue;
      console.log(`  ow ${hex(room)} -${c}(${hex(gx)},${hex(gy)})-> ${hex(to)} [${k}] (${node.path + c})`);
      if (process.env.P20_SHOT) shot(sim, join(process.env.P20_SHOT, `ow-${hex(to).slice(1)}-${seen.size}.png`));
      seen.set(k, { snap: sim.snapshot(), path: node.path + c, room: to });
      if (to === target) return node.path + c;
      q.push(k);
    }
  }
  throw new Error(`OW: ${hex(target)} not reachable from ${hex(start)}`);
}

/** Pushes the rock of this OW room up (bracelet) and steps on the shortcut stairs under it (mode $C). */
function pushRockAndTakeShortcut(sim, target) {
  const r = sim.ram;
  let slot = 0;
  for (let i = 1; i < 0x0c; i++) if (r[V.ObjType + i] === 0x62) slot = i;
  if (!slot) throw new Error(`no rock in ${hex(r[V.RoomId])}`);
  const rx = r[V.ObjX + slot], ry = r[V.ObjY + slot];
  console.log(`  rock at ${hex(rx)},${hex(ry)}`);
  if (!P.walkTo(sim, rx, ((ry + 0x10) & 0xf8) | 5, 2400)) throw new Error('cannot stand below the rock');
  let tune = false;
  sim.controller = (rr) => { if (rr[V.Tune1Request] === 0x04) tune = true; return B.U; };
  sim.runUntil(() => false, 120);
  sim.controller = () => 0;
  sim.play([[30, 0]]);
  if (!tune) throw new Error('the rock did not move');
  // Stairs where the rock was.
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const set = new Set();
  for (let x = P.X0; x <= P.X1; x += 8) for (let y = P.Y0; y <= P.Y1; y += 8) if (P.isWarpTile(P.rawTileStill(x, y))) set.add(`${x},${y}`);
  console.log(`  stairs squares: ${[...set].join(' ')}`);
  sim.controller = P.walkController((x, y) => set.has(`${x},${y}`), { finalDir: 8, allowWarp: true, sword: false });
  if (!sim.runUntil((rr) => rr[V.GameMode] === 0x0c, 900)) throw new Error('no shortcut cave');
  sim.controller = () => 0;
  sim.runUntil((rr) => rr[V.GameMode] === 0x0c && rr[V.IsUpdatingMode] !== 0, 600);
  sim.play([[120, 0]]);
  P.log(sim, `  shortcut cave (mode ${hex(sim.ram[V.GameMode])})`);
  // The three stairs lead to the other shortcut caves: take the one to `target`.
  const snap = sim.snapshot();
  for (const sx of [0x50, 0x80, 0xb0]) {
    sim.restore(snap);
    sim.controller = (rr) => {
      if (rr[V.ObjGridOffset] !== 0) return P.DIR_BTN[rr[V.ObjDir]];
      if (rr[V.ObjY] > 0x9d) return B.U;
      if (rr[V.ObjX] < sx) return B.R;
      if (rr[V.ObjX] > sx) return B.L;
      return B.U;
    };
    const ok = sim.runUntil((rr) => P.playing(rr) && rr[V.RoomId] !== 0x1d, 1500);
    sim.controller = () => 0;
    if (!ok) { console.log(`  stairs ${hex(sx)}: nothing`); continue; }
    sim.play([[30, 0]]);
    P.log(sim, `  stairs ${hex(sx)} ->`);
    if (sim.ram[V.RoomId] === target) return;
  }
  throw new Error(`no stairs to ${hex(target)}`);
}

/** Bombs the rock wall of the current OW room and walks into the opening (a level entrance). */
function bombRockWallAndEnter(sim) {
  const r = sim.ram;
  let slot = 0;
  for (let i = 1; i < 0x0c; i++) if (r[V.ObjType + i] === 0x63) slot = i;
  if (!slot) throw new Error(`no rock wall object in ${hex(r[V.RoomId])}`);
  const wx = r[V.ObjX + slot], wy = r[V.ObjY + slot];
  console.log(`  rock wall at ${hex(wx)},${hex(wy)}`);
  dumpRoom(sim);
  P.selectItem(sim, 1);
  // Stand below it facing up, drop a bomb and step back; again while the rock wall is still there.
  let tune = false;
  const hasWall = () => P.slotsOf(sim.ram, (t) => t === 0x63).length > 0;
  for (let attempt = 0; attempt < 4 && hasWall(); attempt++) {
    let ok = false;
    for (let dy = 0x10; dy <= 0x18 && !ok; dy += 8) ok = P.walkTo(sim, wx, ((wy + dy) & 0xf8) | 5, 1500);
    if (!ok) throw new Error('cannot stand below the rock wall');
    P.log(sim, `  below the wall (attempt ${attempt}, bombs ${sim.ram[V.InvBombs]})`);
    const seq = P.expand([[3, B.U], [6, 0], [2, B.B], [10, 0], [24, B.D], [200, 0]]);
    const f0 = sim.frame;
    sim.controller = (rr, n) => { if (rr[V.Tune1Request] === 0x04) tune = true; return seq[n - 1 - f0] ?? 0; };
    sim.runUntil(() => false, seq.length);
    sim.controller = () => 0;
  }
  console.log(`  secret tune: ${tune}`);
  ram.set(sim.ram);
  sram.set(sim.o.sram);
  const t = [];
  for (let x = P.X0; x <= P.X1; x += 8) for (let y = P.Y0; y <= P.Y1; y += 8) if (P.isWarpTile(P.rawTileStill(x, y))) t.push(`${hex(x)},${hex(y)}`);
  console.log(`  warp squares: ${t.join(' ')}`);
  // Back under the opening, then up into it.
  if (!P.walkTo(sim, wx, ((wy + 0x10) & 0xf8) | 5, 900)) throw new Error('cannot go back below the opening');
  sim.controller = (rr) => (P.playing(rr) && rr[V.CurLevel] === 0 ? B.U : 0);
  const inLevel = sim.runUntil((rr) => rr[V.CurLevel] !== 0 && P.playing(rr), 1500);
  sim.controller = () => 0;
  if (!inLevel) throw new Error("no level entrance after bombing");
  sim.play([[20, 0]]);
  P.log(sim, 'entered');
  return sim.ram[V.CurLevel];
}

/** Level 1: to $45 (wallmasters) and let one carry Link back to the entrance ($73). */
function wallmaster(sim, onRoom) {
  const L = { N: 8, S: 4, W: 2, E: 1 };
  const start = sim.ram[V.RoomId];
  P.excursion(sim, 'NNNE', onRoom);
  // Same route, but stay in $45 until a wallmaster grabs Link.
  for (const c of 'NNNE') {
    const to = P.goSmart(sim, L[c]);
    if (typeof to !== 'number' || to < 0) throw new Error(`wallmaster route stopped at ${c}`);
    sim.play([[30, 0]]);
  }
  const room = sim.ram[V.RoomId];
  const to = P.goSmart(sim, L.E);
  if (to !== 0x45) throw new Error(`wallmaster room: ${to}`);
  P.log(sim, '  wallmasters');
  // Stand next to the walls (a wallmaster comes out of the wall when Link's X is $20/$D0 or his Y is
  // $5D/$BD, away from the corners: UpdateWallmaster @State0).
  const corners = [[0x20, 0x8d], [0x78, 0x5d], [0xd0, 0x8d], [0x78, 0xbd]];
  let ci = 0, dwell = 0, inner = P.walkController((x, y) => x === corners[0][0] && y === corners[0][1], { sword: false });
  sim.controller = (r, f) => {
    if (inner.arrived && ++dwell > 240) {
      dwell = 0;
      ci = (ci + 1) % corners.length;
      const [gx, gy] = corners[ci];
      inner = P.walkController((x, y) => x === gx && y === gy, { sword: false });
    }
    return inner(r, f);
  };
  const grabbed = sim.runUntil((r) => r[V.RoomId] === start && P.playing(r), 6000);
  sim.controller = () => 0;
  if (!grabbed) {
    P.log(sim, '  not grabbed');
    if (process.env.P20_SHOT) shot(sim, join(process.env.P20_SHOT, 'wallmaster.png'));
    throw new Error('no wallmaster grabbed Link');
  }
  sim.events.push(`wallmaster carried Link to the entrance f${sim.frame}`);
  sim.play([[60, 0]]);
  P.log(sim, '  grabbed: back at the entrance');
  void room;
}

async function makeTour(quest) {
  await P.init();
  const MOVIE = MOVIES_BY_QUEST[quest], SRAM_FILE = SRAMS_BY_QUEST[quest];
  const s = await ensureSram(quest);
  let sim, state = { quest };
  const from = process.env.P20_RESUME;
  if (from) ({ sim, state } = await resume(s, `q${quest}-${from}`));
  else sim = await P.startGame(s, quest);
  const baseOnRoom = P.makeOnRoom(state);
  // Rooms with wizzrobes or lamnolas: fight them (the default stays 4 seconds in the middle of the room).
  const onRoom = (sim2) => {
    sim2.play([[20, 0]]);
    const fight = [0x23, 0x24, 0x3a, 0x3b];
    if (!P.slotsOf(sim2.ram, (t) => fight.includes(t)).length) return baseOnRoom(sim2);
    P.heal(sim2);
    P.log(sim2, '  fight');
    const snap = sim2.snapshot();
    try {
      const ok = P.hunt(sim2, fight, (r) => P.slotsOf(r, (t) => fight.includes(t)).length === 0
        || (P.playing(r) && (r[V.HeartValues] & 0x0f) < 3), 3000);
      P.log(sim2, `  fight ${ok ? 'over' : 'timeout'}`);
      P.heal(sim2);
    } catch (e) {
      if (!/died/.test(e.message)) throw e;
      sim2.restore(snap);
      console.log('  died fighting: backed out');
    }
  };
  const toL9 = [
    ['to-1d', () => { owRoute(sim, 'SWWWWSEEEEENE'); sim.play([[10, 0]]); }],
    ['shortcut', () => { pushRockAndTakeShortcut(sim, 0x23); }],
    ['to-05', () => { console.log(`route to $05: ${owSearch(sim, 0x05, (r) => r < 0x50 && (r & 15) < 9)}`); }],
    ['enter-l9', () => { const l = bombRockWallAndEnter(sim); if (l !== 9) throw new Error(`entered level ${l}`); }],
  ];
  const steps = quest ? [
    // Second quest: level 4 (the whirlwind's third stop, $45): red/blue bubbles and wizzrobes ($71), black
    // keeses ($70). (Level 9's blue lamnolas, $63, stay out: in the second quest bombing the rock wall of
    // $05 does not open the entrance from below it.)
    ['enter-l4', () => { for (let i = 0; i < 3; i++) P.warp(sim); const l = P.enterLevel(sim); if (l !== 4) throw new Error(`entered level ${l}`); }],
    ...levelSteps('l4', ['NWSW']),
  ] : [
    ['to-l5', () => { for (let i = 0; i < 4; i++) P.warp(sim); }],
    ...toL9,
    ...levelSteps('l9', ['NWN']),
    ['enter-l6', () => { P.warp(sim); const l = P.enterLevel(sim); if (l !== 6) throw new Error(`entered level ${l}`); }],
    ...levelSteps('l6', ['W', 'WNNN']),
    ['enter-l1', () => { for (let i = 0; i < 3; i++) P.warp(sim); const l = P.enterLevel(sim); if (l !== 1) throw new Error(`entered level ${l}`); }],
    ['l1-wallmaster', () => wallmaster(sim, onRoom)],
    ['l1-leave', () => P.leaveLevel(sim)],
  ];
  function levelSteps(tag, routes) {
    return [
      ...routes.map((route) => [`${tag}-${route}`, () => {
        try { P.excursion(sim, route, onRoom); } catch (e) { console.log(`  excursion ${route}: ${e.message}`); throw e; }
        const got = Object.keys(P20_TYPES).map(Number).filter((t) => sim.seen.has(t));
        console.log(`  P20 types so far: ${got.map(hex).join(' ')}`);
      }]),
      [`${tag}-leave`, () => P.leaveLevel(sim)],
    ];
  }
  let started = !from;
  for (const [name, fn] of steps) {
    if (!started) { if (name === from) started = true; continue; }
    fn();
    save(sim, `q${quest}-${name}`, state);
  }
  sim.play([[30, 0]]);
  const seenP20 = Object.keys(P20_TYPES).map(Number).filter((t) => sim.seen.has(t));
  console.log(`P20 monsters seen: ${seenP20.map((t) => P20_TYPES[t]).join(', ')}`);
  P.writeMovie(MOVIE, [
    `P20${quest ? ' (second quest)' : ''}: continue the prepared file (tests/oracle/movies/${SRAM_FILE}: magical sword, bracelet,`,
    'ladder, recorder, bow and arrows, bombs, red ring, magic shield, magic key, 16 full hearts, the 8',
    'triforce pieces).',
    ...(quest ? [
      'Recorder to level 4: zols, traps, like likes, red/blue bubbles and wizzrobes ($71), black keeses ($70).',
    ] : [
      'Recorder to $0B, Death Mountain (rock pushed in $1D, shortcut stairs to $23), bomb Spectacle',
      'Rock ($05) and enter level 9: wizzrobes ($65, ladder over the water band), red lamnolas ($55).',
      'Recorder to level 6: red wizzrobes ($78), zols, keeses and statue fireballs, traps ($48). Recorder to',
      'level 1: a wallmaster ($45) carries Link back to the entrance (mode 3).',
    ]),
    `Events: ${sim.events.join('; ') || 'none'}.`,
    `P20 monsters seen: ${seenP20.map((t) => P20_TYPES[t]).join(', ')}.`,
    'Generated by tests/game/p20-make-movies.mjs (closed-loop on the original game).',
    `Run the oracle with --sram tests/oracle/movies/${SRAM_FILE}.`,
  ], sim.used(), {
    comment: `Underworld monsters B (P20)${quest ? ', second quest' : ''}.`,
    sram: SRAM_FILE,
    reaches: quest ? { CurLevel: [0, 4], GameMode: [5] } : { CurLevel: [0, 9, 6, 1], GameMode: [3, 5, 0x0c] },
    monsterTypes: [...sim.seen.keys()].filter((t) => t < 0x53).sort((a, b) => a - b),
    events: sim.events,
  });
  return sim;
}

async function main() {
  const what = process.argv[2] ?? 'all';
  const quests = process.env.P20_QUEST ? [Number(process.env.P20_QUEST)] : [0, 1];
  for (const q of quests) {
    if (what === 'tour' || what === 'all') await makeTour(q);
    if (what === 'check' || what === 'tour' || what === 'all') await P.check(MOVIES_BY_QUEST[q]);
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
