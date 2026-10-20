// Parser + address calculator for the ca65 Zelda 1 disassembly (no ca65 needed).
// Produces, per bank, an ordered list of statements with CPU (run) address, PRG load offset and size.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Memory areas / segments from Z.cfg, hard-coded here because the layout is fixed and tiny.
// load: memory area the bytes live in (ROM bank). run: CPU address the code executes at.
export const SEGMENTS = {
  BANK_00_00: { bank: 0, start: 0x8D60 }, BANK_00_ISR: { bank: 0, start: 0xBF50 }, BANK_00_VEC: { bank: 0, start: 0xBFFA },
  BANK_01_00: { bank: 1 }, BANK_01_CODE: { bank: 1, run: 0x6C90 }, BANK_01_ISR: { bank: 1, start: 0xBF50 }, BANK_01_VEC: { bank: 1, start: 0xBFFA },
  BANK_02_00: { bank: 2 }, BANK_02_ISR: { bank: 2, start: 0xBF50 }, BANK_02_VEC: { bank: 2, start: 0xBFFA },
  BANK_03_00: { bank: 3 }, BANK_03_ISR: { bank: 3, start: 0xBF50 }, BANK_03_VEC: { bank: 3, start: 0xBFFA },
  BANK_04_00: { bank: 4 }, BANK_04_ISR: { bank: 4, start: 0xBF50 }, BANK_04_VEC: { bank: 4, start: 0xBFFA },
  BANK_05_00: { bank: 5 }, BANK_05_ISR: { bank: 5, start: 0xBF50 }, BANK_05_VEC: { bank: 5, start: 0xBFFA },
  BANK_06_00: { bank: 6 }, BANK_06_DATA: { bank: 6, run: 0x67F0 }, BANK_06_DLIST: { bank: 6, start: 0xA000 },
  BANK_06_ISR: { bank: 6, start: 0xBF50 }, BANK_06_VEC: { bank: 6, start: 0xBFFA },
  BANK_07_00: { bank: 7 }, BANK_07_ISR: { bank: 7, start: 0xFF50 }, BANK_07_VEC: { bank: 7, start: 0xFFEB },
};
export const bankBase = (bank) => (bank === 7 ? 0xC000 : 0x8000);

const BRANCHES = new Set(['BCC', 'BCS', 'BEQ', 'BNE', 'BMI', 'BPL', 'BVC', 'BVS']);
const IMPLIED = new Set(['BRK', 'CLC', 'CLD', 'CLI', 'CLV', 'DEX', 'DEY', 'INX', 'INY', 'NOP', 'PHA', 'PHP', 'PLA', 'PLP',
  'RTI', 'RTS', 'SEC', 'SED', 'SEI', 'TAX', 'TAY', 'TSX', 'TXA', 'TXS', 'TYA']);
const SHIFTS = new Set(['ASL', 'LSR', 'ROL', 'ROR']);
export const WRITE_OPS = new Set(['STA', 'STX', 'STY', 'INC', 'DEC', 'ASL', 'LSR', 'ROL', 'ROR']);
export const RMW_OPS = new Set(['INC', 'DEC', 'ASL', 'LSR', 'ROL', 'ROR']);

// Parses "Name := $1234" lines of the .inc RAM map.
export function parseInc(path) {
  const syms = new Map();
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const m = raw.replace(/;.*/, '').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*(\$[0-9A-Fa-f]+|\d+)\s*$/);
    if (m) syms.set(m[1], parseNum(m[2]));
  }
  return syms;
}

function parseNum(s) {
  if (s.startsWith('$')) return parseInt(s.slice(1), 16);
  if (s.startsWith('%')) return parseInt(s.slice(1), 2);
  return parseInt(s, 10);
}

// Tokenizes and evaluates a ca65 expression. resolve(name) returns a number or undefined.
export function evalExpr(expr, resolve) {
  const toks = expr.match(/\$[0-9A-Fa-f]+|%[01]+|\d+|@?[A-Za-z_][A-Za-z0-9_]*|:[+-]+|[()+\-*/<>&|^~]/g) || [];
  let i = 0;
  let unknown = false;
  const primary = () => {
    const t = toks[i++];
    if (t === undefined) throw new Error(`bad expr ${expr}`);
    if (t === '(') { const v = sum(); i++; return v; }
    if (t === '<') return primary() & 0xFF;
    if (t === '>') return (primary() >> 8) & 0xFF;
    if (t === '-') return -primary();
    if (t === '~') return ~primary();
    if (/^[$%\d]/.test(t)) return parseNum(t);
    const v = resolve(t);
    if (v === undefined) { unknown = true; return 0x8000; }
    return v;
  };
  const term = () => {
    let v = primary();
    while (toks[i] === '*' || toks[i] === '/') { const op = toks[i++]; const r = primary(); v = op === '*' ? v * r : Math.trunc(v / r); }
    return v;
  };
  const sum = () => {
    let v = term();
    while (['+', '-', '&', '|', '^'].includes(toks[i])) {
      const op = toks[i++]; const r = term();
      v = op === '+' ? v + r : op === '-' ? v - r : op === '&' ? v & r : op === '|' ? v | r : v ^ r;
    }
    return v;
  };
  const value = sum();
  return { value, unknown };
}

// Splits an instruction operand into addressing mode + expression.
export function decodeOperand(mnem, operand) {
  const op = operand.trim();
  if (op === '' || op === 'A') return { mode: 'imp' };
  if (BRANCHES.has(mnem)) return { mode: 'rel', expr: op };
  if (op.startsWith('#')) return { mode: 'imm', expr: op.slice(1).trim() };
  let m;
  if ((m = op.match(/^\((.*)\)\s*,\s*Y$/i))) return { mode: 'indy', expr: m[1] };
  if ((m = op.match(/^\((.*)\s*,\s*X\)$/i))) return { mode: 'indx', expr: m[1] };
  if ((m = op.match(/^\((.*)\)$/))) return { mode: 'ind', expr: m[1] };
  let force = null;
  let body = op;
  if ((m = body.match(/^([az]):(.*)$/))) { force = m[1]; body = m[2]; }
  let index = null;
  if ((m = body.match(/^(.*?)\s*,\s*([XY])$/i))) { body = m[1]; index = m[2].toUpperCase(); }
  return { mode: 'mem', expr: body.trim(), index, force };
}

function instrSize(mnem, dec, value, unknown) {
  if (IMPLIED.has(mnem) || dec.mode === 'imp') return 1;
  if (dec.mode === 'rel' || dec.mode === 'imm' || dec.mode === 'indy' || dec.mode === 'indx') return 2;
  if (dec.mode === 'ind' || mnem === 'JMP' || mnem === 'JSR') return 3;
  if (dec.force === 'a') return 3;
  if (dec.force === 'z') return 2;
  if (dec.index === 'Y' && mnem !== 'LDX' && mnem !== 'STX') return 3;
  if (unknown) return 3;
  return value >= 0 && value < 0x100 ? 2 : 3;
}

// bins.xml lists every .INCBIN with its PRG offset and length (the .dat files themselves are not needed).
const binCache = new Map();
export function binSizes(srcDir) {
  if (!binCache.has(srcDir)) {
    const xml = readFileSync(join(srcDir, 'bins.xml'), 'utf8');
    const map = new Map();
    for (const m of xml.matchAll(/Offset='(\d+)' Length='(\d+)' FileName='([^']+)'/g)) map.set(m[3], { offset: +m[1], length: +m[2] });
    binCache.set(srcDir, map);
  }
  return binCache.get(srcDir);
}

// Reads one bank file, expanding nested .INCLUDE of dat/*.inc (not the RAM .inc headers).
function readLines(file, srcDir) {
  const out = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, idx) => {
    const inc = text.match(/^\s+\.INCLUDE\s+"([^"]+)"/);
    if (inc) {
      const sub = readFileSync(join(srcDir, inc[1]), 'utf8').split('\n');
      sub.forEach((t) => out.push({ text: t, line: idx + 1, included: inc[1] }));
    } else out.push({ text, line: idx + 1 });
  });
  return out;
}

// Parses a bank file into statements: {kind:'label'|'anon'|'instr'|'data'|'segment'|...}
export function parseBank(bank, srcDir) {
  const file = join(srcDir, `Z_0${bank}.asm`);
  const stmts = [];
  const imports = new Set();
  const exports = new Set();
  const incs = [];
  for (const { text, line, included } of readLines(file, srcDir)) {
    if (/^; Unknown block/.test(text)) { stmts.push({ kind: 'unknown', line }); continue; }
    if (/;\s*Begin unverified code/.test(text)) stmts.push({ kind: 'unverified', line });
    const code = text.replace(/;.*/, '').replace(/\s+$/, '');
    if (!code.trim()) continue;
    let m;
    if ((m = code.match(/^\.INCLUDE\s+"([^"]+)"/))) { incs.push(m[1]); continue; }
    if ((m = code.match(/^\.SEGMENT\s+"([^"]+)"/))) { stmts.push({ kind: 'segment', name: m[1], line }); continue; }
    if ((m = code.match(/^\.IMPORT\s+(.+)$/))) { m[1].split(',').forEach((s) => imports.add(s.trim())); continue; }
    if ((m = code.match(/^\.EXPORT\s+(.+)$/))) { m[1].split(',').forEach((s) => exports.add(s.trim())); continue; }
    let rest = code;
    if ((m = rest.match(/^(@?[A-Za-z_][A-Za-z0-9_]*):(.*)$/))) {
      stmts.push({ kind: 'label', name: m[1], local: m[1].startsWith('@'), line });
      rest = m[2];
    } else if ((m = rest.match(/^:(.*)$/))) {
      stmts.push({ kind: 'anon', line });
      rest = m[1];
    }
    rest = rest.trim();
    if (!rest) continue;
    if ((m = rest.match(/^\.(BYTE|WORD|ADDR|DBYT|LOBYTES|HIBYTES|INCBIN)\s+(.*)$/i))) {
      const dir = m[1].toUpperCase();
      if (dir === 'INCBIN') {
        const path = m[2].replace(/"/g, '').trim();
        const bin = binSizes(srcDir).get(path);
        if (!bin) throw new Error(`${path} missing from bins.xml`);
        stmts.push({ kind: 'data', dir, path, size: bin.length, binOffset: bin.offset, line, included });
      } else {
        const items = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        const per = dir === 'BYTE' || dir === 'LOBYTES' || dir === 'HIBYTES' ? 1 : 2;
        stmts.push({ kind: 'data', dir, items, size: items.length * per, line, included });
      }
      continue;
    }
    if ((m = rest.match(/^([A-Z]{3})\b\s*(.*)$/))) {
      const mnem = m[1];
      stmts.push({ kind: 'instr', mnem, operand: m[2], dec: decodeOperand(mnem, m[2]), line });
      continue;
    }
    throw new Error(`Z_0${bank}.asm:${line}: cannot parse "${text}"`);
  }
  return { bank, file, stmts, imports, exports, incs };
}

// Assigns run addresses and PRG offsets. resolveExt resolves symbols not defined in this bank.
export function assemble(parsed, ramSyms, resolveExt = () => undefined) {
  const labels = new Map();
  const { bank } = parsed;
  for (let pass = 0; pass < 3; pass++) {
    let loadPc = bankBase(bank);
    let runPc = loadPc;
    let seg = null;
    const resolve = (name, scope) => {
      if (name.startsWith('@')) return labels.get(`${scope}${name}`);
      if (labels.has(name)) return labels.get(name);
      if (ramSyms.has(name)) return ramSyms.get(name);
      return resolveExt(name);
    };
    let scope = '';
    for (const s of parsed.stmts) {
      if (s.kind === 'segment') {
        seg = SEGMENTS[s.name];
        if (!seg) throw new Error(`unknown segment ${s.name}`);
        if (seg.start !== undefined) { loadPc = seg.start; runPc = seg.start; }
        else if (seg.run !== undefined) runPc = seg.run;
        else runPc = loadPc;
        s.seg = s.name;
        continue;
      }
      s.addr = runPc;
      s.prg = bank * 0x4000 + (loadPc - bankBase(bank));
      s.scope = scope;
      if (s.kind === 'label') {
        if (!s.local) scope = s.name;
        s.scope = scope;
        labels.set(s.local ? `${scope}${s.name}` : s.name, runPc);
        continue;
      }
      if (s.kind === 'anon' || s.kind === 'unknown' || s.kind === 'unverified') continue;
      let size = s.size;
      if (s.kind === 'instr') {
        let v = 0; let unk = false;
        if (s.dec.expr !== undefined && s.dec.mode === 'mem') {
          const r = evalExpr(s.dec.expr, (n) => resolve(n, scope));
          v = r.value; unk = r.unknown;
        }
        size = instrSize(s.mnem, s.dec, v, unk);
        s.size = size;
      }
      loadPc += size;
      runPc += size;
    }
  }
  return labels;
}
