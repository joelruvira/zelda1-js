import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BTN, parseZmv, serializeZmv, parseFm2, parseJsonMovie, parseButtons, formatButtons, loadMovie,
} from '../../tools/oracle/lib/movie.mjs';

const MOVIES = join(import.meta.dirname, 'movies');

test('button letters follow FCEUX RLDUTSBA and the ButtonsPressed layout', () => {
  assert.equal(parseButtons('A'), 0x80);
  assert.equal(parseButtons('T'), BTN.START);
  assert.equal(parseButtons('S'), BTN.SELECT);
  assert.equal(parseButtons('RU'), 0x09);
  assert.equal(parseButtons('.'), 0);
  assert.equal(parseButtons('0x3c'), 0x3c);
  assert.equal(formatButtons(0x91), 'RTA');
  assert.throws(() => parseButtons('X'));
});

test('zmv parses runs, player 2 and timing; serialize round-trips', () => {
  const m = parseZmv('zmv 1\ntiming nmi\n3 .\n2 T # start\n1 RA L\n');
  assert.equal(m.length, 6);
  assert.deepEqual([...m.p1], [0, 0, 0, 0x10, 0x10, 0x81]);
  assert.equal(m.p2[5], BTN.LEFT);
  const again = parseZmv(serializeZmv(m));
  assert.deepEqual(again.p1, m.p1);
  assert.deepEqual(again.p2, m.p2);
  assert.throws(() => parseZmv('3 .'), /header/);
});

test('fm2 import maps gamepad columns and uses video timing', () => {
  const fm2 = [
    'version 3', 'emuVersion 22020', 'palFlag 0', 'port0 1', 'port1 0', 'port2 0',
    '|0|........|||', '|0|....T...|||', '|0|R......A|||',
  ].join('\n');
  const m = parseFm2(fm2);
  assert.equal(m.timing, 'video');
  assert.deepEqual([...m.p1], [0, BTN.START, BTN.RIGHT | BTN.A]);
  assert.throws(() => parseFm2('|1|........|||'), /reset/);
});

test('json movies accept byte arrays and runs', () => {
  const a = parseJsonMovie('{"format":"zelda-movie","version":1,"p1":[0,16,"A"]}');
  assert.deepEqual([...a.p1], [0, 16, 0x80]);
  const b = parseJsonMovie('{"format":"zelda-movie","version":1,"runs":[[2,"."],[1,"T"]]}');
  assert.deepEqual([...b.p1], [0, 0, 0x10]);
});

test('bundled test movies parse', () => {
  const files = readdirSync(MOVIES).filter((f) => f.endsWith('.zmv'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const m = loadMovie(join(MOVIES, f));
    assert.equal(m.timing, 'nmi', f);
    assert.ok(m.length >= 300, `${f} has ${m.length} frames`);
  }
  assert.equal(loadMovie(join(MOVIES, 'power-on-600.zmv')).length, 600);
});
