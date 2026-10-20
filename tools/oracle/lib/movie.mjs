// Input movies: one controller byte per frame, in the game's own ButtonsPressed layout.
//
// Bit layout (as ReadInputs in Z_07 rolls it in): A=$80 B=$40 Select=$20 Start=$10
// Up=$08 Down=$04 Left=$02 Right=$01.
//
// Formats:
//  - .zmv text  : "zmv 1" header, optional "timing nmi|video", then "<count> <p1> [<p2>]" lines.
//                 Buttons use FCEUX letters RLDUTSBA (T=Start, S=Select), "." for none, or 0xNN.
//  - .json      : {"format":"zelda-movie","version":1,"timing":"nmi","p1":[...],"p2":[...]}
//                 or {"format":"zelda-movie","version":1,"runs":[[count,"T"],[count,"."]]}
//  - .fm2       : FCEUX movie (gamepad on port0/port1); timing is per video frame.
import { readFileSync } from 'node:fs';
import { extname, basename } from 'node:path';

export const BTN = Object.freeze({ A: 0x80, B: 0x40, SELECT: 0x20, START: 0x10, UP: 0x08, DOWN: 0x04, LEFT: 0x02, RIGHT: 0x01 });

// FCEUX order: R L D U T S B A (leftmost char = Right).
const FM2_ORDER = 'RLDUTSBA';
const FM2_BITS = [BTN.RIGHT, BTN.LEFT, BTN.DOWN, BTN.UP, BTN.START, BTN.SELECT, BTN.B, BTN.A];
const LETTER_BITS = Object.fromEntries([...FM2_ORDER].map((c, i) => [c, FM2_BITS[i]]));

export const TIMINGS = ['nmi', 'video'];

export function createMovie(p1, p2 = null, { timing = 'nmi', name = 'movie', meta = {} } = {}) {
  if (!TIMINGS.includes(timing)) throw new Error(`movie: unknown timing "${timing}"`);
  const a = Uint8Array.from(p1);
  const b = p2 ? Uint8Array.from(p2) : new Uint8Array(a.length);
  if (b.length !== a.length) throw new Error('movie: p1 and p2 lengths differ');
  return { name, timing, meta, length: a.length, p1: a, p2: b };
}

export function parseButtons(token) {
  if (token === '.' || token === '-' || token === '0') return 0;
  if (/^0x[0-9a-f]{1,2}$/i.test(token)) return parseInt(token, 16);
  let mask = 0;
  for (const c of token) {
    if (c === '.') continue;
    const bit = LETTER_BITS[c];
    if (bit === undefined) throw new Error(`movie: unknown button letter "${c}" (use RLDUTSBA)`);
    mask |= bit;
  }
  return mask;
}

export function formatButtons(mask) {
  if (!mask) return '.';
  return [...FM2_ORDER].filter((c) => mask & LETTER_BITS[c]).join('');
}

export function parseZmv(text, name = 'movie') {
  const p1 = [], p2 = [];
  let timing = 'nmi', sawHeader = false;
  for (const [n, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'zmv') {
      if (parts[1] !== '1') throw new Error(`zmv: unsupported version ${parts[1]}`);
      sawHeader = true;
    } else if (parts[0] === 'timing') {
      timing = parts[1];
    } else {
      const count = Number(parts[0]);
      if (!Number.isInteger(count) || count < 0) throw new Error(`zmv line ${n + 1}: bad count "${parts[0]}"`);
      const a = parseButtons(parts[1] ?? '.');
      const b = parseButtons(parts[2] ?? '.');
      for (let i = 0; i < count; i++) { p1.push(a); p2.push(b); }
    }
  }
  if (!sawHeader) throw new Error('zmv: missing "zmv 1" header');
  return createMovie(p1, p2, { timing, name });
}

export function serializeZmv(movie) {
  const lines = ['zmv 1', `timing ${movie.timing}`];
  let i = 0;
  while (i < movie.length) {
    let j = i;
    while (j < movie.length && movie.p1[j] === movie.p1[i] && movie.p2[j] === movie.p2[i]) j++;
    const p2 = movie.p2[i] ? ` ${formatButtons(movie.p2[i])}` : '';
    lines.push(`${j - i} ${formatButtons(movie.p1[i])}${p2}`);
    i = j;
  }
  return lines.join('\n') + '\n';
}

export function parseJsonMovie(text, name = 'movie') {
  const obj = JSON.parse(text);
  if (obj.format !== 'zelda-movie') throw new Error('json movie: missing "format":"zelda-movie"');
  const toMask = (v) => (typeof v === 'number' ? v & 0xff : parseButtons(String(v)));
  if (obj.runs) {
    const p1 = [], p2 = [];
    for (const [count, a, b] of obj.runs) {
      for (let i = 0; i < count; i++) { p1.push(toMask(a ?? 0)); p2.push(toMask(b ?? 0)); }
    }
    return createMovie(p1, p2, { timing: obj.timing ?? 'nmi', name });
  }
  return createMovie(obj.p1.map(toMask), obj.p2?.map(toMask), { timing: obj.timing ?? 'nmi', name });
}

/** Imports an FCEUX .fm2 movie. Resets other than at frame 0 are rejected. */
export function parseFm2(text, name = 'movie') {
  const p1 = [], p2 = [];
  const meta = {};
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (rawLine[0] !== '|') {
      const sp = rawLine.indexOf(' ');
      if (sp > 0) meta[rawLine.slice(0, sp)] = rawLine.slice(sp + 1);
      continue;
    }
    const fields = rawLine.split('|');
    const commands = Number(fields[1] || 0);
    if (commands & 1 || (commands & 2 && p1.length > 0)) {
      throw new Error(`fm2: reset command at frame ${p1.length} is not supported`);
    }
    p1.push(parseFm2Pad(fields[2]));
    p2.push(parseFm2Pad(fields[3]));
  }
  if (meta.palFlag === '1') throw new Error('fm2: PAL movies are not supported');
  return createMovie(p1, p2, { timing: 'video', name, meta });
}

function parseFm2Pad(field) {
  if (!field || field.length < 8) return 0;
  let mask = 0;
  for (let i = 0; i < 8; i++) if (field[i] !== '.' && field[i] !== ' ') mask |= FM2_BITS[i];
  return mask;
}

export function parseMovie(text, fileName = 'movie.zmv') {
  const name = basename(fileName).replace(/\.[^.]+$/, '');
  switch (extname(fileName).toLowerCase()) {
    case '.json': return parseJsonMovie(text, name);
    case '.fm2': return parseFm2(text, name);
    default: return parseZmv(text, name);
  }
}

export function loadMovie(path) {
  return parseMovie(readFileSync(path, 'utf8'), path);
}

/** Movie of `frames` frames with no input. */
export function idleMovie(frames, timing = 'nmi') {
  return createMovie(new Uint8Array(frames), null, { timing, name: `idle-${frames}` });
}
