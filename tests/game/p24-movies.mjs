// Generator of the P24 oracle movies (tests/oracle/movies/*.zmv). Run:
//   node tests/game/p24-movies.mjs        (writes file-eliminate, second-quest-name, save-and-continue)
// Each movie is built from small steps so the frame counts stay readable; the timings were
// calibrated in the oracle (jsnes) with tools/oracle/trace-info.mjs --watch GameMode,GameSubmode,...
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MOVIES = join(import.meta.dirname, '..', 'oracle', 'movies');

class Movie {
  constructor(comment) { this.lines = ['zmv 1', ...comment.map((c) => `# ${c}`), 'timing nmi']; }
  note(text) { this.lines.push(`# ${text}`); return this; }
  wait(n) { this.lines.push(`${n} .`); return this; }
  /** Press p1 buttons for `hold` frames, then release for `gap` frames. */
  press(buttons, hold = 2, gap = 8, p2 = null) {
    this.lines.push(p2 ? `${hold} ${buttons} ${p2}` : `${hold} ${buttons}`);
    if (gap) this.wait(gap);
    return this;
  }
  repeat(buttons, n, hold = 2, gap = 8) { for (let i = 0; i < n; i++) this.press(buttons, hold, gap); return this; }
  text() { return `${this.lines.join('\n')}\n`; }
}

/** Power-on -> title -> Start -> file select menu (mode 1, updating at frame 130). */
function toMenu(m) {
  return m.note('title screen, then Start -> file select menu').wait(120).press('T', 2, 90);
}

/**
 * Type a name on the mode $E character board. The board cursor starts on 'A' (index 0); the board
 * is 11 characters wide: A-K / L-V / W-Z ... Each direction press is 1 frame + 1 frame released
 * (releasing resets the button repeat state, so every press moves the cursor once).
 */
function typeName(m, moves) {
  for (const [dirs, label] of moves) {
    m.note(`'${label}'`);
    for (const d of dirs) m.press(d, 1, 1);
    m.press('A', 2, 6);
  }
  return m;
}

export function fileEliminate() {
  const m = new Movie([
    'Register a name in slot 1, then eliminate it (mode $F), go from "End" to register (mode $E),',
    'and back to the menu. Covers InitModeEandF (E and F), UpdateModeFElimination, DeleteSlot,',
    'FormatFileA, UpdateModeERegister (End with and without names), UpdateMode0Demo_Sub1/2.',
  ]);
  toMenu(m);
  m.note('no saves: the cursor is on "Register your name": Start -> mode $E').press('T', 2, 90);
  m.note('type 3 letters with A (the board cursor starts on A)').repeat('A', 3, 2, 6);
  m.note('Select x3: slot 1 -> 2 -> 3 -> "End"; Start: files B written, back to the menu');
  m.repeat('S', 3).press('T', 2, 90);
  m.note('menu cursor on slot 1: Select -> Register (slots 2, 3 are empty) -> Elimination; Start -> mode $F');
  m.repeat('S', 2).press('T', 2, 60);
  m.note('mode $F: cursor on slot 1; Select x3 -> End and back x1 -> slot 1 (wraps); Start deletes it');
  m.repeat('S', 4).press('T', 2, 30);
  m.note('Select x3 -> "End"; Start -> mode $E (register)').repeat('S', 3).press('T', 2, 60);
  m.note('mode $E with no names: Select x3 -> "End", Start -> back to the menu').repeat('S', 3).press('T', 2, 90);
  return m.text();
}

export function secondQuestName() {
  const m = new Movie([
    'Register "ZELDA" (second quest) in slot 1 and go back to the menu, which shows the sword',
    'next to Link; then start the game (second quest overworld).',
  ]);
  toMenu(m);
  m.note('Start -> mode $E').press('T', 2, 90);
  typeName(m, [
    [['D', 'D', 'R', 'R', 'R'], 'Z'], // 0 -> 22 (W) -> 25 (Z)
    [['U', 'U', 'R'], 'E'], // 25 -> 3 (D) -> 4 (E)
    [['D', 'L', 'L', 'L', 'L'], 'L'], // 4 -> 15 (P) -> 11 (L)
    [['U', 'R', 'R', 'R'], 'D'], // 11 -> 0 (A) -> 3 (D)
    [['L', 'L', 'L'], 'A'], // 3 -> 0 (A)
  ]);
  m.note('Select x3 -> "End"; Start: file B of slot 1 gets the second quest flag').repeat('S', 3).press('T', 2, 90);
  m.note('menu: slot 1 selected (sword marker); Start -> game').press('T', 2, 240);
  return m.text();
}

export function saveAndContinue() {
  const m = new Movie([
    'Register a name, start the game, walk a little, open the submenu (Start) and hold Up+A on',
    'pad 2 (UpdateMenuActive) -> CONTINUE/SAVE/RETRY (mode 8); choose SAVE: mode $D writes file B',
    'and commits it to file A -> title submode 1 -> menu; then load the slot again.',
    'Compare SRAM $6000-$7FFF. Needs P05/P11/P13/P25 in the port (modes 2-5 and 8).',
  ]);
  toMenu(m);
  m.press('T', 2, 90).repeat('A', 3, 2, 6).repeat('S', 3).press('T', 2, 90);
  m.note('Start slot 1 -> game (mode 5)').press('T', 2, 240);
  m.note('walk left a bit').press('L', 20, 10);
  m.note('Start: submenu scrolls down; then pad 2 Up+A -> mode 8').press('T', 2, 90).press('.', 2, 90, 'UA');
  m.note('Select -> SAVE; Start (flashes $40 frames) -> mode $D -> menu').press('S', 2, 10).press('T', 2, 180);
  m.note('menu: Start slot 1 again -> game').press('T', 2, 240);
  return m.text();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(join(MOVIES, 'file-eliminate.zmv'), fileEliminate());
  writeFileSync(join(MOVIES, 'second-quest-name.zmv'), secondQuestName());
  writeFileSync(join(MOVIES, 'save-and-continue.zmv'), saveAndContinue());
}
