#!/usr/bin/env node
// Generator of the P25 oracle movie death-continue (tests/oracle/movies/death-continue.zmv). Run:
//   node tests/game/p25-make-movies.mjs
//
// No SRAM: register a name, start the game (3 hearts, no sword) and play the ORIGINAL game in the
// oracle with a closed-loop controller that walks left/up into the rooms with octoroks and runs into
// the nearest monster until Link dies (mode $11, then mode 8). The three answers of mode 8 are used:
//   1. die -> Select x4 (CONTINUE -> SAVE -> RETRY -> CONTINUE -> SAVE), Select x2 more -> CONTINUE,
//      Start: CONTINUE (mode 3, same level);
//   2. die again -> Select -> SAVE, Start: mode $D writes the files -> menu; Start slot 1 -> game;
//   3. die again -> Select x2 -> RETRY, Start: mode 0 submode 1 (updating) -> menu; Start -> game.
// The movie is replayed from power-on to check it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { createMovie, serializeZmv, parseZmv } from '../../tools/oracle/lib/movie.mjs';
import {
  GameMode, IsUpdatingMode, ObjX, ObjY, ObjType, ObjMetastate, RoomId, DeathCounts, GameSubmode,
} from '../../src/core/vars.js';

const MOVIES = join(import.meta.dirname, '..', 'oracle', 'movies');
const B = { A: 0x80, B: 0x40, S: 0x20, T: 0x10, U: 0x08, D: 0x04, L: 0x02, R: 0x01 };

let rom = null;

class Sim {
  constructor(inputs = []) {
    this.inputs = [...inputs];
    this.controller = () => 0;
  }

  async start() {
    this.o = await Oracle.create({ rom: rom.bytes, sram: null, powerOnFill: 0 });
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

  /** Run `n` frames with a fixed button byte. */
  hold(buttons, n) {
    this.controller = () => buttons;
    this.runUntil(() => false, n);
  }

  used() { return this.inputs.slice(0, this.frame); }
}

const playing = (r) => r[GameMode] === 5 && r[IsUpdatingMode] === 1;

/** Closed loop: run into the nearest live monster; with none, walk left (then up) to other rooms. */
function chaser(r, n) {
  const lx = r[ObjX];
  const ly = r[ObjY];
  let best = null;
  for (let x = 1; x <= 0x0b; x++) {
    const t = r[ObjType + x];
    if (t === 0 || t >= 0x53 || r[ObjMetastate + x] !== 0) continue;
    const d = Math.abs(r[ObjX + x] - lx) + Math.abs(r[ObjY + x] - ly);
    if (!best || d < best.d) best = { x, d };
  }
  if (!best) {
    // Wander: in the start room, get to the row of its west exit first; then mostly left, sometimes
    // up/down to get around obstacles.
    if (r[RoomId] === 0x77 && Math.abs(ly - 0x8d) > 3) return ly < 0x8d ? B.D : B.U;
    const phase = (n >> 5) % 6;
    return phase < 4 ? B.L : phase === 4 ? B.U : B.D;
  }
  const dx = r[ObjX + best.x] - lx;
  const dy = r[ObjY + best.x] - ly;
  // Alternate the axis every 24 frames, so walls don't stop Link forever.
  const horizontalFirst = ((n / 24) | 0) % 2 === 0;
  const h = dx < 0 ? B.L : B.R;
  const v = dy < 0 ? B.U : B.D;
  if (horizontalFirst) return Math.abs(dx) > 2 ? h : v;
  return Math.abs(dy) > 2 ? v : h;
}

/** From playing: chase monsters until Link dies and mode 8 is updating. */
function dieAndWaitMode8(sim) {
  sim.controller = chaser;
  if (!sim.runUntil((r) => r[GameMode] === 0x11, 20000)) throw new Error('Link did not die');
  console.log(`  died at frame ${sim.frame}, room $${sim.ram[RoomId].toString(16)}`);
  sim.controller = () => 0;
  if (!sim.runUntil((r) => r[GameMode] === 0x08 && r[IsUpdatingMode] === 1, 2000)) throw new Error('no mode 8');
  console.log(`  mode 8 at frame ${sim.frame}`);
  sim.hold(0, 20);
}

/** In mode 8: press Select `n` times (each 2 frames + 6 released), then Start. */
function answer(sim, n) {
  for (let i = 0; i < n; i++) { sim.hold(B.S, 2); sim.hold(0, 6); }
  sim.hold(B.T, 2);
  sim.hold(0, 4);
}

async function main() {
  rom = loadRomFile();
  // Prefix: title -> menu -> register "AAA" in slot 1 -> End -> menu -> Start slot 1 -> game.
  const prefix = parseZmv([
    'zmv 1', 'timing nmi', '120 .', '2 T', '90 .', '2 T', '90 .',
    '2 A', '6 .', '2 A', '6 .', '2 A', '6 .',
    '2 S', '8 .', '2 S', '8 .', '2 S', '8 .', '2 T', '90 .', '2 T', '240 .',
  ].join('\n'), 'prefix');
  const sim = await new Sim([...prefix.p1]).start();
  sim.runUntil(() => false, prefix.p1.length);
  if (!playing(sim.ram)) throw new Error('prefix does not reach mode 5');
  console.log(`playing at frame ${sim.frame}`);

  console.log('death 1 -> CONTINUE (after cycling through all the options)');
  dieAndWaitMode8(sim);
  answer(sim, 6); // 0 -> 1 -> 2 -> 0 -> 1 -> 2 -> 0: CONTINUE
  if (!sim.runUntil((r) => r[GameMode] === 0x03, 200)) throw new Error('CONTINUE does not go to mode 3');
  sim.controller = () => 0;
  if (!sim.runUntil(playing, 1000)) throw new Error('no play after CONTINUE');

  console.log('death 2 -> SAVE');
  dieAndWaitMode8(sim);
  answer(sim, 1);
  if (!sim.runUntil((r) => r[GameMode] === 0x0d, 200)) throw new Error('SAVE does not go to mode $D');
  sim.controller = () => 0;
  if (!sim.runUntil((r) => r[GameMode] === 0x01 && r[IsUpdatingMode] === 1, 1000)) throw new Error('no menu after SAVE');
  sim.hold(0, 30);
  sim.hold(B.T, 2);
  if (!sim.runUntil(playing, 1000)) throw new Error('no play after loading the save');

  console.log('death 3 -> RETRY');
  dieAndWaitMode8(sim);
  answer(sim, 2);
  if (!sim.runUntil((r) => r[GameMode] === 0x00, 200)) throw new Error('RETRY does not go to mode 0');
  sim.controller = () => 0;
  if (!sim.runUntil((r) => r[GameMode] === 0x01 && r[IsUpdatingMode] === 1, 1000)) throw new Error('no menu after RETRY');
  sim.hold(0, 30);
  sim.hold(B.T, 2);
  if (!sim.runUntil(playing, 1000)) throw new Error('no play after RETRY');
  sim.hold(0, 60);

  const inputs = sim.used();
  const comment = [
    'Register a name, play with 3 hearts and no sword and run into octoroks until Link dies (mode $11:',
    'InitMode11, the 13 submodes of UpdateMode11Death, DeathCounts) -> mode 8 (InitMode8,',
    'UpdateMode8ContinueQuestion_Full). Answers: CONTINUE after cycling the cursor through all the',
    'options; SAVE (mode $D) -> menu -> load; RETRY (mode 0 submode 1) -> menu -> game.',
    'Generated by tests/game/p25-make-movies.mjs (closed-loop controller on the original game).',
  ];
  const m = createMovie(Uint8Array.from(inputs), null, { name: 'death-continue' });
  writeFileSync(join(MOVIES, 'death-continue.zmv'),
    serializeZmv(m).replace(/^zmv 1\n/, `zmv 1\n${comment.map((c) => `# ${c}`).join('\n')}\n`));

  // Check from power-on.
  const check = await new Sim(inputs).start();
  const modes = new Set();
  check.runUntil((r) => { modes.add(r[GameMode]); return false; }, inputs.length);
  for (const g of [0x11, 0x08, 0x03, 0x0d, 0x01, 0x00]) if (!modes.has(g)) throw new Error(`replay misses mode ${g}`);
  if (!playing(check.ram)) throw new Error('replay does not end playing');
  // RETRY does not save: the menu reloads the count saved by SAVE (2).
  if (check.ram[DeathCounts] !== 2) throw new Error(`death count ${check.ram[DeathCounts]} != 2`);
  writeFileSync(join(MOVIES, 'death-continue.expect.json'), `${JSON.stringify({
    comment: 'Die 3 times: CONTINUE (cursor cycled), SAVE (mode $D), RETRY (mode 0 submode 1); 3 deaths counted (2 after RETRY reloads the saved file).',
    reaches: { GameMode: [5, 0x11, 8, 3, 0x0d, 1, 0], DeathCounts: [1, 2, 3] },
  }, null, 2)}\n`);
  console.log(`death-continue: ${inputs.length} frames, submode ${check.ram[GameSubmode]}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
