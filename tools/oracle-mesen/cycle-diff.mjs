#!/usr/bin/env node
// The port's cycle tracker in 'hardware' mode against Mesen2, event by event (docs/TIMING.md §11): every
// NMI start, RTI, write to $2000-$2007 (not OAM DMA's $2004) and $4000-$4017, read of $2002 and DMC DMA
// fetch must happen on the same CPU cycle (Mesen's CycleCount = the port's cycle + 1). Prints the first
// differences with Mesen's raster position and the preceding events; exit 1 if any.
//
//   node tools/oracle-mesen/cycle-diff.mjs <movie> [--frames N] [--from F] [--max-diffs K] [--keep]
//
// --from F: only NMIs F..N are compared (both emulators still run from power-on). Mesen's event log goes
// to out/oracle-mesen/cycle-diff/<movie>.mesen.txt (deleted unless --keep). Speed: ~40 frames/s.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../oracle/lib/rom-file.mjs';
import { parseArgs } from '../oracle/lib/cli.mjs';
import { findNmiAndRti, setupProblems, MesenMissingError, MESEN_BIN } from './lib/mesen.mjs';
import { loadMovieArg, sramForMovie, runCli } from './lib/common.mjs';
import { moviePath } from './vs-jsnes.mjs';

const OUT = join(REPO_ROOT, 'out/oracle-mesen/cycle-diff');
const hexs = (b) => Buffer.from(b).toString('hex');

function mesenEvents(spec, movie, frames, from, sram, keep) {
  const problems = setupProblems();
  if (problems.length) throw new MesenMissingError(`Mesen2 is not ready (${problems.join('; ')}). Run: node tools/oracle-mesen/setup.mjs`);
  const rom = loadRomFile(DEFAULT_ROM_PATH);
  const { nmi, rti } = findNmiAndRti(rom.bytes);
  mkdirSync(OUT, { recursive: true });
  const txt = join(OUT, `${movie.name}.mesen.txt`);
  const P = { out: txt, nmi, rti, p1: hexs(movie.p1), p2: hexs(movie.p2), sram: sram ? hexs(sram.subarray(0, 0x2000)) : null, frames, f0: from, f1: frames };
  const lua = `local P = {${Object.entries(P).map(([k, v]) => `${k} = ${v === null ? 'nil' : typeof v === 'string' ? JSON.stringify(v) : v}`).join(', ')}}\n` +
    readFileSync(join(import.meta.dirname, 'lua/cycles.lua'), 'utf8');
  const script = join(OUT, `${movie.name}.lua`);
  writeFileSync(script, lua);
  execFileSync(MESEN_BIN, ['--testrunner', resolve(DEFAULT_ROM_PATH), script, `--timeout=${Math.ceil(120 + frames / 10)}`], { stdio: 'ignore' });
  const ev = readFileSync(txt, 'utf8').trim().split('\n').map((l) => {
    const [k, a, v, c, sl, dot, fc] = l.split(' ');
    return { k, a: k === 'B' || k === 'R' ? parseInt(a, 16) : parseInt(a, 16), v: parseInt(v, 16), c: +c, pos: `${sl}:${dot} f${fc}` };
  });
  rmSync(script, { force: true });
  if (!keep) rmSync(txt, { force: true });
  // a DMA halt repeats the pending read on its halt/dummy cycles: drop reads followed by the same read or
  // by a DMC fetch on the next cycle
  return fromNmi(ev.filter((e, i) => !(e.k === 'r' && ev[i + 1] && ev[i + 1].c === e.c + 1 && (ev[i + 1].k === 'D' || (ev[i + 1].k === 'r' && ev[i + 1].a === e.a)))), from);
}

async function portEvents(movie, frames, from, sram) {
  const { createGame } = await import('../../src/headless.js');
  const game = await createGame({ rom: loadRomFile(DEFAULT_ROM_PATH).bytes, sram: sram ? Uint8Array.from(sram) : null, timing: 'hardware',
    inputFor: (n) => [movie.p1[n - 1] ?? 0, movie.p2[n - 1] ?? 0] });
  const t = game.timing;
  const out = [];
  const log = [];
  t.log = log;
  for (let f = 1; f <= frames; f++) {
    log.length = 0;
    game.stepFrame(movie.p1[f - 1] ?? 0, movie.p2[f - 1] ?? 0);
    const fr = [];
    for (const e of log) {
      if (e.k === 'begin') fr.push({ k: 'B', a: e.n, v: 0, c: e.c });
      else if (e.k === 'rti') fr.push({ k: 'R', a: f, v: 0, c: e.s ?? e.c - 6 });
      else if (e.k === 'D') fr.push({ k: 'D', a: 0, v: 0, c: e.c + 1 });
      else if (e.k === 'w' && ((e.a >= 0x2000 && e.a < 0x2008 && e.a !== 0x2004) || (e.a >= 0x4000 && e.a <= 0x4017))) fr.push({ k: 'w', a: e.a, v: e.v, c: e.c + 1, pos: `${e.l === 261 ? -1 : e.l}:${e.d}` });
      else if (e.k === 'r' && e.a === 0x2002) fr.push({ k: 'r', a: e.a, v: 0, c: e.c + 1, pos: `${e.l === 261 ? -1 : e.l}:${e.d}` });
    }
    fr.sort((a, b) => (a.c - (a.k === 'B' ? 0.5 : 0)) - (b.c - (b.k === 'B' ? 0.5 : 0)));
    out.push(...fr);
  }
  return fromNmi(out, from);
}

/** Events from the start of NMI `from` on. */
function fromNmi(ev, from) {
  const i = ev.findIndex((e) => e.k === 'B' && e.a >= from);
  return i < 0 ? [] : ev.slice(i);
}

export async function cycleDiff(spec, { frames, from = 1, maxDiffs = 5, keep = false } = {}) {
  const movie = loadMovieArg(spec, frames);
  const n = movie.length;
  const { sram } = sramForMovie(spec);
  const M = mesenEvents(spec, movie, n, from, sram, keep);
  const Pt = await portEvents(movie, n, from, sram);
  const diffs = [];
  let i = 0, j = 0;
  let nmi = 0, lastB = null;
  while (i < M.length && j < Pt.length) {
    const m = M[i], p = Pt[j];
    if (m.k === 'B') { nmi = m.a; lastB = m.c; }
    const same = m.k === p.k && m.c === p.c && (m.k === 'D' || m.a === p.a) && (m.k !== 'w' || m.v === p.v);
    if (!same) {
      const fmt = (e) => `${e.k} ${e.k === 'B' || e.k === 'R' ? e.a : '$' + e.a.toString(16)}${e.k === 'w' ? '=' + e.v.toString(16) : ''} @${e.c} (+${e.c - lastB})`;
      diffs.push({ nmi, mesen: `${fmt(m)} [${m.pos}]`, port: `${fmt(p)}${p.pos ? ` [${p.pos}]` : ''}`, before: M.slice(Math.max(0, i - 4), i).map((e) => `${fmt(e)} [${e.pos}]`) });
      if (diffs.length >= maxDiffs) break;
      // resynchronise on the next NMI
      do i++; while (i < M.length && M[i].k !== 'B');
      do j++; while (j < Pt.length && Pt[j].k !== 'B');
      continue;
    }
    i++; j++;
  }
  if (diffs.length < maxDiffs && (i < M.length || j < Pt.length)) {
    diffs.push({ nmi, mesen: i < M.length ? `${M.length - i} more events from ${M[i].k} @${M[i].c}` : 'end', port: j < Pt.length ? `${Pt.length - j} more events from ${Pt[j].k} @${Pt[j].c}` : 'end', before: [] });
  }
  return { movie: movie.name, frames: n, from, mesenEvents: M.length, portEvents: Pt.length, compared: Math.min(i, M.length), diffs };
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['keep'] });
  if (!args._[0]) { console.error('usage: cycle-diff.mjs <movie> [--frames N] [--from F] [--max-diffs K] [--keep]'); return 2; }
  const rep = await cycleDiff(moviePath(args._[0]), { frames: args.frames, from: Number(args.from ?? 1), maxDiffs: Number(args['max-diffs'] ?? 5), keep: !!args.keep });
  for (const d of rep.diffs) {
    console.log(`NMI ${d.nmi}: mesen ${d.mesen}  port ${d.port}`);
    for (const b of d.before) console.log(`    before: ${b}`);
  }
  console.log(`${rep.movie}: NMIs ${rep.from}-${rep.frames}, ${rep.mesenEvents} Mesen events, ${rep.portEvents} port events, ${rep.diffs.length ? `${rep.diffs.length} difference(s)` : 'identical'}`);
  return rep.diffs.length || rep.mesenEvents !== rep.portEvents ? 1 : 0;
}

if (import.meta.main) runCli(main);
