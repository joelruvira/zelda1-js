// P14: generates the prepared SRAM and the movies of the doors/secrets/warps/mazes scenarios.
//   tests/oracle/movies/p14-items.sav       save slot 1 "AAAAA" (register-name played in the oracle)
//                                            with sword, 8 bombs, the recorder, the red ring, 16
//                                            hearts, the bracelet and triforce piece 1. Only the
//                                            player's save area ($6000-$652F) is kept: no ROM data.
//   tests/oracle/movies/lost-woods-maze.zmv  continue that file, walk to the lost woods ($61) and
//                                            leave it by a wrong exit (the room repeats, MazeStep 0),
//                                            then up, left, down, left (MazeStep 1..3, secret tune,
//                                            out to $60): CheckMazes.
//   tests/oracle/movies/ow-bomb-secret.zmv   continue, walk up to $67, bomb its rock wall (the secret
//                                            cave appears: PlaySecretFoundTune), enter the cave
//                                            (CheckWarps/HandleWarpOW: modes $10, $B) and leave it.
//   tests/oracle/movies/recorder-warp.zmv    continue, select the recorder in the submenu and play
//                                            it: the whirlwind takes Link to level 1's room ($37);
//                                            walk into the entrance (HandleWarpOW: mode $10 -> 2).
// The walks are found by closed-loop control on the oracle (tests/game/p12-driver.mjs and the
// Walker of tests/game/p12-make-movies.mjs); the inputs are deterministic.
//   tests/oracle/movies/ow-shortcut.zmv      continue, walk to $79, push its rock with the bracelet
//                                            (stairs, secret tune), take the stairs (HandleWarpOW,
//                                            cave attribute $50: mode $10 -> $C) and leave the cave.
//   tests/oracle/movies/uw-block-shutter.zmv from p08-items.sav: uw-level1-full up to level 1 room
//                                            $42, kill its gels, push the block: the shutter opens
//                                            (CheckSecretTriggerBlockDoor, CheckShutters, UpdateDoors).
//   tests/oracle/movies/uw-cellar.zmv        from p08-items.sav: uw-level1-full up to level 1 room
//                                            $22, its stairs (CheckWarps UW: mode $10 -> 9, cellar
//                                            $7F), walk in the cellar and climb out (mode $A).
// Usage: node tests/game/p14-make-movies.mjs [sram|lost-woods-maze|ow-bomb-secret|recorder-warp|ow-shortcut|uw-cellar|uw-block-shutter|all]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { parseZmv } from '../../tools/oracle/lib/movie.mjs';
import { loadSymbols, loadRom, table } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { ram, sram } from '../../src/core/ram.js';
import { switchBank } from '../../src/core/asm.js';
import * as V from '../../src/core/vars.js';
import { CopyCommonCodeToRam } from '../../src/game/boot.js';
import { FetchFileAAddressSet, CalculateFileAChecksum } from '../../src/game/save/files.js';
import { createDriver } from './p12-driver.mjs';
import { Walker, walk, searchTour } from './p12-make-movies.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MOVIES = join(ROOT, 'tests/oracle/movies');
const SAV = 'p14-items.sav';
const romBytes = readFileSync(join(ROOT, 'roms/zelda.nes'));

const U = 0x08, D = 0x04, L = 0x02, R = 0x01, B = 0x40, T = 0x10;
const Recorder = V.InvCandle + 1; // $065C: the recorder (unnamed in Variables.inc)

// ------------------------------------------------------------------ SRAM

const ITEMS = {
  [V.Items]: 0x01, // wooden sword
  [V.InvBombs]: 0x08,
  [V.MaxBombs]: 0x08,
  [Recorder]: 0x01,
  [V.InvRing]: 0x02, // red ring
  [V.HeartValues]: 0xff, // 16 containers, full
  [V.HeartPartial]: 0xff,
  [V.InvTriforce]: 0x01, // piece 1: the whirlwind goes to level 1
  [V.InvBracelet]: 0x01, // pushes the rock over the shortcut stairs of $79
};

async function makeSram() {
  const movie = parseZmv(readFileSync(join(MOVIES, 'register-name.zmv'), 'utf8'), 'm');
  const oracle = await Oracle.create({ rom: romBytes, sram: null, powerOnFill: 0 });
  let last = null;
  oracle.run(movie, { write: (rec) => { if (rec.sram) last = rec.sram; } });
  const sav = new Uint8Array(0x2000);
  sav.set(last.subarray(0, 0x530)); // $6000-$652F: save files, markers, checksums
  await loadSymbols();
  createMachine(loadRom(romBytes));
  sram.set(sav);
  switchBank(1);
  CopyCommonCodeToRam(); // FetchFileAAddressSet reads its table from the WRAM copy
  for (const [addr, v] of Object.entries(ITEMS)) sram[V.SaveFileAItems0 - 0x6000 + (addr - V.Items)] = v;
  ram[V.CurSaveSlot] = 0;
  FetchFileAAddressSet();
  CalculateFileAChecksum();
  sram[V.FileAChecksums - 0x6000] = ram[0x0e];
  sram[V.FileAChecksums + 1 - 0x6000] = ram[0x0f];
  sav.set(sram.subarray(0, 0x530));
  return sav;
}

async function ensureSram(force = false) {
  const path = join(MOVIES, SAV);
  if (!force && existsSync(path)) return new Uint8Array(readFileSync(path));
  const s = await makeSram();
  writeFileSync(path, s);
  console.log(`${SAV} written`);
  return s;
}

// ------------------------------------------------------------------ driver with the SRAM

/** p12's driver, with the oracle created from `sav` (Oracle.create is patched for the duration). */
async function driverWithSram(sav) {
  const orig = Oracle.create;
  Oracle.create = (opts) => orig.call(Oracle, { ...opts, sram: sav });
  try {
    const d = await createDriver();
    // rewind() boots a new oracle: keep the SRAM there too.
    const rewind = d.rewind;
    d.rewind = async (f) => {
      Oracle.create = (opts) => orig.call(Oracle, { ...opts, sram: sav });
      try { await rewind(f); } finally { Oracle.create = orig; }
    };
    return d;
  } finally {
    Oracle.create = orig;
  }
}

async function newWalker(d) {
  await loadSymbols();
  const w = new Walker(d);
  w.walkableOW = Array.from(table(loadRom(romBytes), 'WalkableTiles').bytes());
  return w;
}

function waitMode(d, mode, limit = 1500) {
  const ram = d.ram;
  const f0 = d.frame;
  while (!(ram[V.GameMode] === mode && ram[V.IsUpdatingMode]) && d.frame - f0 < limit) d.step(0);
  if (!(ram[V.GameMode] === mode && ram[V.IsUpdatingMode])) throw new Error(`mode $${mode.toString(16)} not reached (frame ${d.frame}: mode $${ram[V.GameMode].toString(16)} room $${ram[V.RoomId].toString(16)} Link $${ram[V.ObjX].toString(16)},$${ram[V.ObjY].toString(16)})`);
}

/** Title -> Start -> file select (slot 1) -> Start: mode 5 in room $77. */
function continueGame(d) {
  d.comment('continue the prepared file (tests/oracle/movies/p14-items.sav): title, Start, Start');
  d.run(120); d.run(2, T); d.run(90); d.run(2, T); d.run(240);
  waitMode(d, 5);
  if (d.ram[V.RoomId] !== 0x77 || d.ram[V.InvBombs] !== 8) throw new Error('continue: not in $77 with the prepared items');
}

/** Open the submenu, move the cursor until SelectedItemSlot = slot (Items index), close it. */
function selectItem(d, slot, name) {
  const ram = d.ram;
  d.comment(`open the submenu, move the cursor to ${name}, close it`);
  d.run(2, T); d.run(90);
  for (let i = 0; i < 8 && ram[V.SelectedItemSlot] !== slot; i++) { d.run(2, R); d.run(12); }
  if (ram[V.SelectedItemSlot] !== slot) throw new Error(`${name} not selected (slot ${ram[V.SelectedItemSlot]})`);
  d.run(2, T); d.run(90);
  waitMode(d, 5);
  d.run(10);
}

const roomDist = (a, b) => Math.abs((a & 15) - (b & 15)) + Math.abs((a >> 4) - (b >> 4));

/** Walk the OW (look-ahead tour) until RoomId = target. */
function goToRoom(d, w, target, maxFrames = 12000) {
  w.colBias = (r) => roomDist(r, target) * 400;
  searchTour(d, w, { maxFrames, filter: false, stop: () => d.ram[V.RoomId] === target && d.ram[V.CurLevel] === 0 });
  if (d.ram[V.RoomId] !== target) throw new Error(`room $${target.toString(16)} not reached (room $${d.ram[V.RoomId].toString(16)})`);
}

/** Leave the room by its `dir` edge; returns when the next room (or the same one) is playing. */
function exitBy(d, w, dir, maxFrames = 2500) {
  const ram = d.ram;
  const ok = walk(w, {
    goal: (cx, cy) => (w.canMove(cx, cy, dir) === 'exit' ? dir : null),
    done: () => ram[V.GameMode] === 7,
    maxFrames,
  });
  if (!ok) throw new Error(`no exit ${dir} from $${ram[V.RoomId].toString(16)} (frame ${d.frame})`);
  waitMode(d, 5);
}

// ------------------------------------------------------------------ scenarios

async function makeLostWoods(sav) {
  const d = await driverWithSram(sav);
  const w = await newWalker(d);
  continueGame(d);
  d.comment('walk to the lost woods ($61), exits chosen by look-ahead');
  goToRoom(d, w, 0x61);
  d.run(10);
  const ram = d.ram;
  const steps = [];
  const log = (what) => {
    steps.push(`${what}: room $${ram[V.RoomId].toString(16)} MazeStep ${ram[V.MazeStep]}`);
    console.log(steps.at(-1));
  };
  d.comment('lost woods: wrong exit (down): the room repeats, MazeStep = 0');
  exitBy(d, w, D);
  log('down');
  if (ram[V.RoomId] !== 0x61) throw new Error('the wrong exit did not repeat the room');
  for (const [dir, name] of [[U, 'up'], [L, 'left'], [D, 'down'], [L, 'left']]) {
    d.comment(`lost woods: ${name}`);
    exitBy(d, w, dir);
    log(name);
  }
  if (ram[V.RoomId] !== 0x60) throw new Error(`the maze sequence did not lead to $60 (room $${ram[V.RoomId].toString(16)})`);
  d.run(30);
  return { d, steps };
}

/** Link's node standing on the stairs square: the first stairs tile ($70) of the play area map. */
function stairsNode(d) {
  for (let c = 0; c < 32; c++) {
    for (let r = 0; r < 22; r++) if (d.sram[0x530 + c * 22 + r] === 0x70) return { x: c * 8, y: 0x40 + r * 8 - 3 };
  }
  throw new Error(`no stairs in room $${d.ram[V.RoomId].toString(16)}`);
}

/** Walk onto the stairs node; returns when the mode changes. */
function walkOntoStairs(d, w, maxFrames = 2000) {
  const ram = d.ram;
  const st = stairsNode(d);
  walk(w, {
    goal: (cx, cy) => (cx === st.x && cy === st.y ? R : null),
    allowAvoid: true,
    done: () => ram[V.GameMode] !== 5,
    maxFrames,
  });
  return st;
}

/** walk() until Link stands (aligned) on a node satisfying goalNode; finalDir = dir at the goal. */
function walkTo(d, w, goalNode, finalDir, maxFrames = 1500, allowAvoid = false) {
  const ram = d.ram;
  let at = false;
  walk(w, {
    allowAvoid,
    goal: (cx, cy) => (goalNode(cx, cy) ? finalDir : null),
    done: () => {
      const x = ram[V.ObjX], y = ram[V.ObjY];
      at = ram[V.ObjGridOffset] === 0 && (x & 7) === 0 && (y & 7) === 5 && goalNode(x, y);
      return at;
    },
    maxFrames,
  });
  if (!at) throw new Error(`goal not reached in $${ram[V.RoomId].toString(16)} (frame ${d.frame})`);
}

async function makeBombSecret(sav) {
  const d = await driverWithSram(sav);
  const w = await newWalker(d);
  const ram = d.ram;
  continueGame(d);
  d.comment('walk up to $67');
  exitBy(d, w, U);
  if (ram[V.RoomId] !== 0x67) throw new Error('not in $67');
  d.run(10);
  let slot = 0;
  for (let i = 1; i < 0x0c; i++) if (ram[V.ObjType + i] === 0x63) slot = i;
  if (!slot) throw new Error('no rock wall object in $67');
  const wx = ram[V.ObjX + slot], wy = ram[V.ObjY + slot];
  console.log(`rock wall at $${wx.toString(16)},$${wy.toString(16)} (slot ${slot})`);
  selectItem(d, 0x01, 'the bombs');
  d.comment('stand below the rock wall and face up');
  walkTo(d, w, (cx, cy) => cx === wx && cy > wy && cy < wy + 0x18 && w.canMove(cx, cy, U, true) !== true, U);
  d.run(4, U);
  d.run(4);
  d.comment('drop a bomb (B) and step back');
  d.run(2, B);
  d.run(10);
  d.run(24, D);
  let tune = false;
  for (let i = 0; i < 200; i++) { d.step(0); if (ram[V.Tune1Request] === 0x04) tune = true; }
  if (!tune) throw new Error('the secret was not found (no secret tune)');
  d.comment('the cave appeared: walk into it (modes $10, $B)');
  const room = ram[V.RoomId];
  walk(w, {
    goal: (cx, cy) => {
      if (w.canMove(cx, cy, U, true) !== true) return null;
      return w.tile(cx >> 3, ((cy + 3 - 0x40) & 0xff) >> 3) === 0x24 ? U : null;
    },
    allowAvoid: true,
    done: () => ram[V.GameMode] !== 5 || ram[V.RoomId] !== room,
    maxFrames: 1500,
  });
  waitMode(d, 0x0b, 2000);
  d.comment('in the cave: wait, then leave it (modes $A, 4, 5)');
  d.run(200);
  for (let f0 = d.frame; ram[V.GameMode] === 0x0b && d.frame - f0 < 600;) d.step(D);
  waitMode(d, 5);
  d.run(30);
  return { d };
}

async function makeRecorderWarp(sav) {
  const d = await driverWithSram(sav);
  const w = await newWalker(d);
  const ram = d.ram;
  continueGame(d);
  selectItem(d, 0x05, 'the recorder');
  d.comment('play the recorder (B): the whirlwind takes Link to level 1 ($37)');
  d.run(2, B);
  for (let f0 = d.frame; !(ram[V.RoomId] === 0x37 && ram[V.GameMode] === 5 && ram[V.IsUpdatingMode] && ram[V.WhirlwindTeleportingState] === 0) && d.frame - f0 < 2000;) d.step(0);
  if (ram[V.RoomId] !== 0x37) throw new Error(`whirlwind did not reach $37 (room $${ram[V.RoomId].toString(16)})`);
  d.run(60);
  d.comment('walk into the level 1 entrance (mode $10 -> 2 -> 3)');
  const room = ram[V.RoomId];
  walk(w, {
    goal: (cx, cy) => {
      if (w.canMove(cx, cy, U, true) !== true) return null;
      return w.tile(cx >> 3, ((cy + 3 - 0x40) & 0xff) >> 3) === 0x24 ? U : null;
    },
    allowAvoid: true,
    done: () => ram[V.GameMode] !== 5 || ram[V.RoomId] !== room,
    maxFrames: 2000,
  });
  waitMode(d, 5, 3000);
  if (ram[V.CurLevel] !== 1) throw new Error('not in level 1');
  d.run(30);
  return { d };
}


/**
 * ow-shortcut: continue, walk to $79, push its rock up (bracelet: the stairs appear), step on the
 * stairs (HandleWarpOW with cave attribute $50: mode $10 -> $C, the shortcut cave) and leave it.
 */
async function makeShortcut(sav) {
  const d = await driverWithSram(sav);
  const w = await newWalker(d);
  const ram = d.ram;
  continueGame(d);
  d.comment('walk to $79');
  goToRoom(d, w, 0x79);
  d.run(10);
  let slot = 0;
  for (let i = 1; i < 0x0c; i++) if (ram[V.ObjType + i] === 0x62) slot = i;
  if (!slot) throw new Error('no rock object in $79');
  const rx = ram[V.ObjX + slot], ry = ram[V.ObjY + slot];
  console.log(`rock at $${rx.toString(16)},$${ry.toString(16)} (slot ${slot})`);
  d.comment('stand below the rock and push it up (bracelet)');
  walkTo(d, w, (cx, cy) => cx === rx && cy > ry && cy < ry + 0x18 && w.canMove(cx, cy, U, true) !== true, U);
  let tune = false;
  for (let i = 0; i < 120; i++) { d.step(U); if (ram[V.Tune1Request] === 0x04) tune = true; }
  d.run(30);
  if (!tune) throw new Error('the rock did not reveal the stairs (no secret tune)');
  d.comment('step on the stairs: modes $10, $C (shortcut cave)');
  walkOntoStairs(d, w);
  waitMode(d, 0x0c, 2000);
  d.comment('in the shortcut cave: wait, then leave it walking down (modes $A, 4, 5)');
  d.run(200);
  for (let f0 = d.frame; ram[V.GameMode] === 0x0c && d.frame - f0 < 600;) d.step(D);
  waitMode(d, 5);
  d.run(30);
  return { d };
}

/**
 * uw-cellar: uw-level1-full (p08-items.sav) up to room $22 of level 1, push the block that closes
 * the stairs, then step on them
 * (CheckWarps UW: CellarSourceRoomId, cellar $7F, mode $10 -> 9), walk in the cellar and climb out
 * (mode $A back to $22, mode 4, 5).
 */
async function makeCellar() {
  const sav = new Uint8Array(readFileSync(join(MOVIES, 'p08-items.sav')));
  const d = await driverWithSram(sav);
  const w = await newWalker(d);
  const ram = d.ram;
  const movie = parseZmv(readFileSync(join(MOVIES, 'uw-level1-full.zmv'), 'utf8'), 'm');
  d.comment('uw-level1-full.zmv up to level 1 room $22');
  for (let i = 0; i < movie.length; i++) {
    if (ram[V.CurLevel] === 1 && ram[V.RoomId] === 0x22 && ram[V.GameMode] === 5 && ram[V.IsUpdatingMode]) break;
    d.step(movie.p1[i]);
  }
  if (ram[V.RoomId] !== 0x22 || ram[V.CurLevel] !== 1) throw new Error('room $22 of level 1 not reached');
  d.run(10);
  let slot = 0;
  for (let i = 1; i < 0x0c; i++) if (ram[V.ObjType + i] === 0x68) slot = i;
  if (!slot) throw new Error('no push block in $22');
  const bx = ram[V.ObjX + slot], by = ram[V.ObjY + slot];
  d.comment('push the block next to the stairs up');
  walkTo(d, w, (cx, cy) => cx === bx && cy > by && cy < by + 0x18 && w.canMove(cx, cy, U, true) !== true, U);
  for (let i = 0; i < 60; i++) d.step(U);
  d.run(20);
  d.comment('step on the stairs of $22 (CheckWarps: mode $10 -> 9, cellar $7F)');
  walkOntoStairs(d, w);
  waitMode(d, 0x09, 2000);
  if (ram[V.RoomId] !== 0x7f) throw new Error(`not in the cellar (room $${ram[V.RoomId].toString(16)})`);
  d.comment('in the cellar: walk right and back, then climb out (mode $A)');
  d.run(30);
  const x0 = ram[V.ObjX];
  for (let i = 0; i < 90; i++) d.step(R);
  for (let f0 = d.frame; ram[V.ObjX] > x0 && d.frame - f0 < 300;) d.step(L);
  for (let f0 = d.frame; ram[V.GameMode] === 0x09 && d.frame - f0 < 600;) d.step(U);
  waitMode(d, 5, 2000);
  if (ram[V.RoomId] !== 0x22) throw new Error(`not back in $22 (room $${ram[V.RoomId].toString(16)})`);
  d.run(60);
  return { d };
}

/** Live monsters of the room (slots 1-$B, types $01-$52 not dying). */
function monsters(ram) {
  const out = [];
  for (let i = 1; i < 0x0c; i++) {
    const t = ram[V.ObjType + i];
    if (t !== 0 && t < 0x53 && ram[V.ObjMetastate + i] === 0) out.push([ram[V.ObjX + i], ram[V.ObjY + i]]);
  }
  return out;
}

/** Is a monster in reach of the sword from (x, y) facing dir? */
function inReach(ram, x, y, dir) {
  return monsters(ram).some(([ex, ey]) => {
    const dx = ex - x, dy = ey - y;
    if (dir === U) return Math.abs(dx) < 0x0c && dy < 0 && dy > -0x1c;
    if (dir === D) return Math.abs(dx) < 0x0c && dy > 0 && dy < 0x1c;
    if (dir === L) return Math.abs(dy) < 0x0c && dx < 0 && dx > -0x1c;
    return Math.abs(dy) < 0x0c && dx > 0 && dx < 0x1c;
  });
}

/** Kill the monsters of the room with the sword (RoomAllDead set). */
function hunt(d, w, maxFrames = 3000) {
  const ram = d.ram;
  const f0 = d.frame;
  let lastDir = U, swing = 0;
  while (!ram[V.RoomAllDead] && d.frame - f0 < maxFrames) {
    if (ram[V.GameMode] !== 5 || !ram[V.IsUpdatingMode]) { d.step(0); continue; }
    const x = ram[V.ObjX], y = ram[V.ObjY];
    if (swing > 0) { swing--; d.step(0); continue; }
    if (inReach(ram, x, y, ram[V.ObjDir])) { d.step(0x80); swing = 8; continue; }
    const aligned = ram[V.ObjGridOffset] === 0 && (x & 7) === 0 && (y & 7) === 5 && ram[V.ObjShoveDistance] === 0;
    let dir = lastDir;
    if (aligned) {
      const en = monsters(ram);
      const p = w.bfs(x, y, (cx, cy) => {
        for (const [ex, ey] of en) {
          if (Math.abs(ex - cx) < 0x08 && Math.abs(ey - cy) < 0x18) return ey < cy ? U : D;
          if (Math.abs(ey - cy) < 0x08 && Math.abs(ex - cx) < 0x18) return ex < cx ? L : R;
        }
        return null;
      }, true, null);
      if (!p) { d.step(0); continue; }
      dir = p[0];
    }
    lastDir = dir;
    d.step(dir);
  }
  if (!ram[V.RoomAllDead]) throw new Error(`monsters of $${ram[V.RoomId].toString(16)} not killed (frame ${d.frame})`);
}

/** Replays uw-level1-full.zmv (p08-items.sav) until Link plays in level 1 room `room`. */
async function level1Room(room) {
  const sav = new Uint8Array(readFileSync(join(MOVIES, 'p08-items.sav')));
  const d = await driverWithSram(sav);
  const w = await newWalker(d);
  const ram = d.ram;
  const movie = parseZmv(readFileSync(join(MOVIES, 'uw-level1-full.zmv'), 'utf8'), 'm');
  d.comment(`uw-level1-full.zmv up to level 1 room $${room.toString(16)}`);
  for (let i = 0; i < movie.length; i++) {
    if (ram[V.CurLevel] === 1 && ram[V.RoomId] === room && ram[V.GameMode] === 5 && ram[V.IsUpdatingMode]) break;
    d.step(movie.p1[i]);
  }
  if (ram[V.RoomId] !== room || ram[V.CurLevel] !== 1) throw new Error(`room $${room.toString(16)} of level 1 not reached`);
  d.run(10);
  return { d, w, ram };
}

/**
 * uw-block-shutter: uw-level1-full up to level 1 room $42 (secret trigger 4: block opens the
 * shutters), kill its gels (the block only moves then), push its block (CheckSecretTriggerBlockDoor -> ShutterTrigger, CheckShutters ->
 * TriggerOpenDoor, UpdateDoors opens the shutter: commands 6, 7) and walk through that door.
 */
async function makeBlockShutter() {
  const { d, w, ram } = await level1Room(0x42);
  let slot = 0;
  for (let i = 1; i < 0x0c; i++) if (ram[V.ObjType + i] === 0x68) slot = i;
  if (!slot) throw new Error('no push block in $42');
  const bx = ram[V.ObjX + slot], by = ram[V.ObjY + slot];
  console.log(`block at $${bx.toString(16)},$${by.toString(16)} (slot ${slot})`);
  d.comment('kill the gels (the block moves only with RoomAllDead)');
  hunt(d, w);
  d.run(10);
  const start = d.save();
  const behind = {
    [U]: (cx, cy) => cx === bx && cy > by && cy < by + 0x18 && w.canMove(cx, cy, U, true) !== true,
    [D]: (cx, cy) => cx === bx && cy < by && cy > by - 0x18 && w.canMove(cx, cy, D, true) !== true,
    [L]: (cx, cy) => ((cy + 3) & 0xf0) === (by & 0xf0) + 0x10 - 0x10 && cx > bx && cx <= bx + 0x10 && w.canMove(cx, cy, L, true) !== true,
    [R]: (cx, cy) => ((cy + 3) & 0xf0) === (by & 0xf0) && cx < bx && cx >= bx - 0x10 && w.canMove(cx, cy, R, true) !== true,
  };
  for (const dir of [U, L, R, D]) {
    d.load(start);
    try {
      d.comment(`push the block (direction ${dir})`);
      walkTo(d, w, behind[dir], dir);
    } catch { continue; }
    for (let i = 0; i < 60 && !ram[V.ShutterTrigger] && !ram[V.TriggeredDoorCmd]; i++) d.step(dir);
    if (!ram[V.ShutterTrigger] && !ram[V.TriggeredDoorCmd] && !ram[V.BlockPushComplete]) continue;
    // Let the shutter open (UpdateDoors: commands 6, 7 every 8 frames).
    for (let i = 0; i < 60; i++) d.step(0);
    if (ram[V.BlockPushComplete] === 0 || ram[V.TriggeredDoorCmd] !== 0) continue;
    console.log(`block pushed (dir ${dir}), CurOpenedDoors $${ram[V.CurOpenedDoors].toString(16)}`);
    d.comment('the shutter opened: walk out through the doorways');
    const visited = ram[V.RoomId];
    const ok = walk(w, {
      goal: (cx, cy) => {
        for (const e of [U, D, L, R]) if (w.canMove(cx, cy, e) === 'exit') return e;
        return null;
      },
      done: () => ram[V.RoomId] !== visited || ram[V.GameMode] !== 5,
      maxFrames: 1500,
    });
    if (!ok) throw new Error('could not leave $42');
    waitMode(d, 5, 2000);
    d.run(30);
    return { d };
  }
  throw new Error('the block of $42 did not open the shutters');
}

// ------------------------------------------------------------------ main

const HEADER = (name, lines) => [`P14 ${name}: ${lines[0]}`, ...lines.slice(1),
  `Generated by tests/game/p14-make-movies.mjs. Run with --sram tests/oracle/movies/${SAV}.`];

function write(name, d, header, expect, sav = SAV) {
  writeFileSync(join(MOVIES, `${name}.zmv`), d.toZmv(HEADER(name, header).map((l) => l.replace(SAV, sav))));
  writeFileSync(join(MOVIES, `${name}.expect.json`), `${JSON.stringify({ sram: sav, ...expect }, null, 2)}\n`);
  console.log(`${name}: ${d.frame} frames`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv[2] ?? 'all';
  const sav = await ensureSram(which === 'sram');
  if (which === 'lost-woods-maze' || which === 'all') {
    const { d, steps } = await makeLostWoods(sav);
    write('lost-woods-maze', d, [
      'continue the prepared file, walk to the lost woods ($61); leave it down (wrong: the room',
      'repeats, MazeStep 0), then up, left, down, left: MazeStep 1, 2, 3, secret tune, room $60.',
      ...steps,
    ], {
      comment: 'Forest maze: CheckMazes repeats $61 (NextRoomId = RoomId) and plays the secret tune.',
      reaches: { RoomId: [0x61, 0x60], MazeStep: [0, 1, 2, 3], Tune1Request: [4], GameMode: [5, 7] },
    });
  }
  if (which === 'ow-bomb-secret' || which === 'all') {
    const { d } = await makeBombSecret(sav);
    write('ow-bomb-secret', d, [
      'continue the prepared file, walk up to $67, bomb its rock wall (secret cave, secret tune),',
      'enter the cave (CheckWarps/HandleWarpOW: modes $10, $B) and leave it (modes $A, 4, 5).',
    ], {
      comment: 'Bombable rock wall of $67: secret tune (PlaySecretFoundTune), cave entered and left.',
      reaches: { RoomId: [0x67], Tune1Request: [4], GameMode: [5, 0x10, 0x0b, 0x0a, 4], TargetMode: [0x0b] },
    });
  }
  if (which === 'recorder-warp' || which === 'all') {
    const { d } = await makeRecorderWarp(sav);
    write('recorder-warp', d, [
      'continue the prepared file (triforce piece 1), select the recorder in the submenu and play it:',
      'the whirlwind takes Link to $37; walk into level 1 (HandleWarpOW: mode $10, target 2).',
    ], {
      comment: 'Recorder warp to level 1 ($37), then the level 1 entrance (modes $10, 2, 3).',
      reaches: { RoomId: [0x77, 0x37], CurLevel: [0, 1], GameMode: [5, 0x10, 2, 3], TargetMode: [2] },
    });
  }
  if (which === 'ow-shortcut' || which === 'all') {
    const { d } = await makeShortcut(sav);
    write('ow-shortcut', d, [
      'continue the prepared file, walk to $79, push its rock (bracelet: secret tune, stairs), step',
      'on the stairs (HandleWarpOW, cave attribute $50: modes $10, $C) and leave the shortcut cave.',
    ], {
      comment: 'Shortcut stairs under the rock of $79: modes $10 -> $C (TargetMode $C), $A, 4, 5.',
      reaches: { RoomId: [0x79], Tune1Request: [4], GameMode: [5, 0x10, 0x0c, 0x0a, 4], TargetMode: [0x0c] },
    });
  }
  if (which === 'uw-block-shutter' || which === 'all') {
    const { d } = await makeBlockShutter();
    write('uw-block-shutter', d, [
      'uw-level1-full.zmv up to level 1 room $42, kill its gels, push its block (secret trigger 4: BlockPushComplete,',
      'ShutterTrigger, CheckShutters, TriggerOpenDoor, UpdateDoors opens the shutter) and leave the room.',
    ], {
      comment: 'Level 1 room $42: the pushed block opens the shutters (TriggeredDoorCmd 6 -> 7 in the same frame).',
      reaches: { CurLevel: [1], RoomId: [0x42], BlockPushComplete: [1], ShutterTrigger: [1], TriggeredDoorCmd: [7] },
    }, 'p08-items.sav');
  }
  if (which === 'uw-cellar' || which === 'all') {
    const { d } = await makeCellar();
    write('uw-cellar', d, [
      'uw-level1-full.zmv up to level 1 room $22, push its block, step on the stairs (CheckWarps UW:',
      'cellar $7F, modes $10, 9), walk in the cellar and climb out (modes $A, 4, 5) back to $22.',
    ], {
      comment: 'Level 1 cellar $7F under room $22: modes $10 -> 9 (TargetMode 9), $A, 4, 5.',
      reaches: { CurLevel: [1], RoomId: [0x22, 0x7f], CellarSourceRoomId: [0x22], GameMode: [5, 0x10, 9, 0x0a, 4], TargetMode: [9] },
    }, 'p08-items.sav');
  }
}
