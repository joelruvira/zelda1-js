#!/usr/bin/env node
// Annotation coverage of the cycle tracker (docs/TIMING.md §7 Paso 2), per routine and per package of
// docs/ROUTINES.json. Static: compares the asm with the breadcrumbs written in src/game.
//
//   node tools/timing/coverage.mjs P05            one package (routines, files)
//   node tools/timing/coverage.mjs P05 P06 --all  several / every package (summary)
//   node tools/timing/coverage.mjs --routine UpdateMode0Demo
//   options: --json out.json   --check (exit 1 if something is missing or wrong)   --verbose
//
// Reported per routine:
//   * missing branches: conditional branches of the asm (Bxx) with no $br('Z_0b:line', ...) anywhere in
//     src/ (any string literal 'Z_0b:line' counts: helpers receive the ref as an argument). The busy
//     loops on $2002 (LDA PpuStatus_2002 / AND / Bxx back) are automatic (pollStatus) and not listed.
//   * missing page hints: indexed reads (abs,X / abs,Y / (zp),Y) that can cross a page and have no
//     $px/$pxa. Tables whose address is page aligned can never cross and are not listed.
//   * wrong annotations: refs to a line without an instruction, $br on something that is not a
//     conditional branch, $px/$pxa on a read that cannot cross a page (sobrante) or on a non-indexed one.
// A routine also needs every path through it exercised by a movie: use cycle-diff --resync for that.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, loadRomFile } from '../oracle/lib/rom-file.mjs';
import { parseArgs, runCli } from '../oracle/lib/cli.mjs';
import { buildProgram, K_BRANCH } from '../../src/core/cfg.js';
import { CFG_FILES } from '../../src/core/cfg.gen.js';
import { SYMBOLS } from '../../src/core/symbols.js';
import { loadRom } from '../../src/core/rom.js';
import { OPCODES } from '../../src/core/opcodes.js';

const SRC = join(REPO_ROOT, 'src/game');
const ROUTINES = JSON.parse(readFileSync(join(REPO_ROOT, 'docs/ROUTINES.json'), 'utf8'));
const DISASM = join(REPO_ROOT, 'reference/zelda1-disassembly/src');

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Every 'Z_0b:line' string literal in src/game, with the API call it is used in (if direct). */
export function scanAnnotations() {
  const refs = new Map(); // ref -> [{file, line, api, fn}]
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    let fn = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const m = /^\s*\/\/\s*([A-Za-z_]\w*)\s*\(Z_0\d\)/.exec(l);
      if (m) fn = m[1];
      for (const mm of l.matchAll(/(\$br|\$pxa|\$px)?\(?\s*'(Z_0[0-7]:\d+)'/g)) {
        const api = mm[1] ?? (/\$pxa?\(\[/.test(l) ? '$pxa' : /\$br\(/.test(l) && !/\$pxa?\(/.test(l) ? 'ref' : 'ref');
        const ref = mm[2];
        if (!refs.has(ref)) refs.set(ref, []);
        refs.get(ref).push({ file: relative(REPO_ROOT, file), line: i + 1, api, fn });
      }
    }
  }
  return refs;
}

export function analyze(P) {
  const refs = scanAnnotations();
  const asm = Array.from({ length: 8 }, (_, b) => readFileSync(join(DISASM, `Z_0${b}.asm`), 'utf8').split(/\r?\n/));
  const idOf = new Map();
  for (let i = 0; i < P.n; i++) idOf.set(`Z_0${P.bank[i]}:${P.line[i]}`, i);
  // automatic: LDA $2002 / AND #imm / Bxx back to that LDA
  const auto = new Set();
  for (let i = 0; i < P.n; i++) {
    if (P.kind[i] !== K_BRANCH) continue;
    const t = P.target[i];
    if (t < 0) continue;
    const ti = OPCODES[P.op[t]];
    if (ti?.mn === 'LDA' && P.operand[t] === 0x2002 && P.next[t] >= 0 && P.next[P.next[t]] === i) auto.add(i);
  }
  const problems = [];
  for (const [ref, uses] of refs) {
    const id = idOf.get(ref);
    if (id === undefined) { problems.push({ ref, kind: 'inexistente', why: 'no instruction at that line', uses }); continue; }
    const info = OPCODES[P.op[id]];
    const isBranch = P.kind[id] === K_BRANCH;
    for (const u of uses) {
      if (u.api === '$br' && !isBranch) problems.push({ ref, kind: 'incorrecta', why: `$br on ${info.mn} ${info.mode}`, uses: [u] });
      if ((u.api === '$px' || u.api === '$pxa') && !info.penalty) problems.push({ ref, kind: 'incorrecta', why: `$px on ${info.mn} ${info.mode} (no page penalty)`, uses: [u] });
      else if ((u.api === '$px' || u.api === '$pxa') && !P.penalty[id]) problems.push({ ref, kind: 'sobrante', why: 'page-aligned table: never crosses', uses: [u] });
      if (u.api === '$br' && auto.has(id)) problems.push({ ref, kind: 'sobrante', why: '$2002 busy loop: use pollStatus()', uses: [u] });
    }
  }
  return { refs, idOf, auto, problems, asm };
}

export function routineReport(P, A, r) {
  const missing = [], hintsMissing = [], branches = [];
  for (let i = 0; i < P.n; i++) {
    if (P.bank[i] !== r.bank || P.line[i] < r.line || P.line[i] > r.endLine) continue;
    const ref = `Z_0${P.bank[i]}:${P.line[i]}`;
    const text = A.asm[P.bank[i]][P.line[i] - 1].replace(/;.*$/, '').trim();
    if (P.kind[i] === K_BRANCH) {
      branches.push(ref);
      if (!A.auto.has(i) && !A.refs.has(ref)) missing.push(`${ref} ${text}`);
    }
    if (P.penalty[i] && !A.refs.has(ref) && r.name !== 'TableJump') hintsMissing.push(`${ref} ${text}`); // TableJump: automatic
  }
  const wrong = A.problems.filter((p) => {
    const id = A.idOf.get(p.ref);
    return id !== undefined && P.bank[id] === r.bank && P.line[id] >= r.line && P.line[id] <= r.endLine;
  });
  return { name: r.name, bank: r.bank, package: r.package, branches: branches.length, missing, hintsMissing, wrong };
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['all', 'check', 'verbose'] });
  const P = buildProgram(loadRom(loadRomFile().bytes), CFG_FILES, SYMBOLS);
  const A = analyze(P);
  const pkgs = args.all ? ROUTINES.packages.map((p) => p.id) : args._.map((x) => x.toUpperCase());
  const only = args.routine ? [].concat(args.routine) : null;
  if (!pkgs.length && !only) { console.error('usage: coverage.mjs <Pxx ...> | --all | --routine Name'); return 2; }
  const reports = [];
  for (const r of ROUTINES.routines) {
    if (only ? !only.includes(r.name) : !pkgs.includes(r.package)) continue;
    reports.push(routineReport(P, A, r));
  }
  const byPkg = new Map();
  for (const rr of reports) {
    const s = byPkg.get(rr.package) ?? { package: rr.package, routines: 0, branches: 0, missing: 0, hints: 0, wrong: 0, done: 0 };
    s.routines++; s.branches += rr.branches; s.missing += rr.missing.length; s.hints += rr.hintsMissing.length; s.wrong += rr.wrong.length;
    if (!rr.missing.length && !rr.hintsMissing.length && !rr.wrong.length) s.done++;
    byPkg.set(rr.package, s);
  }
  const showRoutines = !args.all || args.verbose || only;
  for (const rr of reports) {
    if (!showRoutines) break;
    if (!rr.missing.length && !rr.hintsMissing.length && !rr.wrong.length && !args.verbose) continue;
    console.log(`${rr.package} ${rr.name} (Z_0${rr.bank}): ${rr.branches} branches, ${rr.missing.length} without $br, ${rr.hintsMissing.length} page reads without $px/$pxa, ${rr.wrong.length} wrong`);
    for (const m of rr.missing) console.log(`    missing $br   ${m}`);
    for (const m of rr.hintsMissing) console.log(`    missing $pxa  ${m}`);
    for (const w of rr.wrong) console.log(`    ${w.kind.padEnd(11)} ${w.ref}: ${w.why} (${w.uses.map((u) => `${u.file}:${u.line}`).join(', ')})`);
  }
  console.log('\npackage  routines  done  branches  missing$br  missing$pxa  wrong');
  for (const s of [...byPkg.values()].sort((a, b) => a.package.localeCompare(b.package))) {
    console.log(`${s.package.padEnd(8)} ${String(s.routines).padStart(8)} ${String(s.done).padStart(5)} ${String(s.branches).padStart(9)} ${String(s.missing).padStart(11)} ${String(s.hints).padStart(12)} ${String(s.wrong).padStart(6)}`);
  }
  const orphan = A.problems.filter((p) => p.kind === 'inexistente');
  if (orphan.length) {
    console.log('\nrefs to lines without an instruction:');
    for (const p of orphan) console.log(`  ${p.ref} (${p.uses.map((u) => `${u.file}:${u.line}`).join(', ')})`);
  }
  const out = { packages: [...byPkg.values()], routines: reports, orphan };
  if (args.json) writeFileSync(args.json, JSON.stringify(out, null, 1));
  else {
    mkdirSync(join(REPO_ROOT, 'out/timing/coverage'), { recursive: true });
    writeFileSync(join(REPO_ROOT, 'out/timing/coverage', `${args.all ? 'all' : (only ? 'routines' : pkgs.join('-'))}.json`), JSON.stringify(out, null, 1));
  }
  const bad = reports.some((r) => r.missing.length || r.hintsMissing.length || r.wrong.length) || orphan.length;
  return args.check && bad ? 1 : 0;
}

if (import.meta.main) runCli(main);
