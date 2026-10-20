// Minimal two-pass ca65-subset assembler/linker for the Zelda disassembly.
// Purpose: compute the bank + CPU address of every label (code and data) so the
// port can read data tables from the user's ROM by name. It can also emit the
// assembled bytes (INCBIN regions left unknown) to verify itself against a ROM.
//
// Supported: .SEGMENT .INCLUDE .INCBIN .BYTE .ADDR .WORD .DBYT .LOBYTES .HIBYTES
//            .IMPORT .EXPORT, global/@cheap/unnamed labels, a: / z: prefixes,
//            expressions with + - * / & | ^ < > ( ) and $hex %bin decimal.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------- opcodes
// mode keys: imp acc imm zp zpx zpy abs abx aby ind izx izy rel
const OPS = {
  ADC: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6d, abx: 0x7d, aby: 0x79, izx: 0x61, izy: 0x71 },
  AND: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2d, abx: 0x3d, aby: 0x39, izx: 0x21, izy: 0x31 },
  ASL: { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, abx: 0x1e },
  BCC: { rel: 0x90 }, BCS: { rel: 0xb0 }, BEQ: { rel: 0xf0 }, BMI: { rel: 0x30 },
  BNE: { rel: 0xd0 }, BPL: { rel: 0x10 }, BVC: { rel: 0x50 }, BVS: { rel: 0x70 },
  BIT: { zp: 0x24, abs: 0x2c },
  BRK: { imp: 0x00 },
  CLC: { imp: 0x18 }, CLD: { imp: 0xd8 }, CLI: { imp: 0x58 }, CLV: { imp: 0xb8 },
  CMP: { imm: 0xc9, zp: 0xc5, zpx: 0xd5, abs: 0xcd, abx: 0xdd, aby: 0xd9, izx: 0xc1, izy: 0xd1 },
  CPX: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  CPY: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  DEC: { zp: 0xc6, zpx: 0xd6, abs: 0xce, abx: 0xde },
  DEX: { imp: 0xca }, DEY: { imp: 0x88 },
  EOR: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4d, abx: 0x5d, aby: 0x59, izx: 0x41, izy: 0x51 },
  INC: { zp: 0xe6, zpx: 0xf6, abs: 0xee, abx: 0xfe },
  INX: { imp: 0xe8 }, INY: { imp: 0xc8 },
  JMP: { abs: 0x4c, ind: 0x6c },
  JSR: { abs: 0x20 },
  LDA: { imm: 0xa9, zp: 0xa5, zpx: 0xb5, abs: 0xad, abx: 0xbd, aby: 0xb9, izx: 0xa1, izy: 0xb1 },
  LDX: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, aby: 0xbe },
  LDY: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, abx: 0xbc },
  LSR: { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, abx: 0x5e },
  NOP: { imp: 0xea },
  ORA: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0d, abx: 0x1d, aby: 0x19, izx: 0x01, izy: 0x11 },
  PHA: { imp: 0x48 }, PHP: { imp: 0x08 }, PLA: { imp: 0x68 }, PLP: { imp: 0x28 },
  ROL: { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, abx: 0x3e },
  ROR: { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, abx: 0x7e },
  RTI: { imp: 0x40 }, RTS: { imp: 0x60 },
  SBC: { imm: 0xe9, zp: 0xe5, zpx: 0xf5, abs: 0xed, abx: 0xfd, aby: 0xf9, izx: 0xe1, izy: 0xf1 },
  SEC: { imp: 0x38 }, SED: { imp: 0xf8 }, SEI: { imp: 0x78 },
  STA: { zp: 0x85, zpx: 0x95, abs: 0x8d, abx: 0x9d, aby: 0x99, izx: 0x81, izy: 0x91 },
  STX: { zp: 0x86, zpy: 0x96, abs: 0x8e },
  STY: { zp: 0x84, zpx: 0x94, abs: 0x8c },
  TAX: { imp: 0xaa }, TAY: { imp: 0xa8 }, TSX: { imp: 0xba }, TXA: { imp: 0x8a },
  TXS: { imp: 0x9a }, TYA: { imp: 0x98 },
};
const MODE_SIZE = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, rel: 2, izx: 2, izy: 2, abs: 3, abx: 3, aby: 3, ind: 3 };

// ---------------------------------------------------------------- linker config
/** Parse Z.cfg MEMORY/SEGMENTS blocks. */
export function parseLinkerConfig(text) {
  const block = (name) => {
    const m = text.match(new RegExp(name + '\\s*\\{([\\s\\S]*?)\\}'));
    return m ? m[1] : '';
  };
  const parseAttrs = (body) => {
    const out = [];
    for (const line of body.split(/;\s*\n|;\s*$/m)) {
      const m = line.trim().match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/s);
      if (!m) continue;
      const attrs = {};
      for (const kv of m[2].split(',')) {
        const [k, v] = kv.split('=').map((s) => s?.trim());
        if (k) attrs[k] = v;
      }
      out.push({ name: m[1], attrs });
    }
    return out;
  };
  const num = (v) => (v?.startsWith('$') ? parseInt(v.slice(1), 16) : v === undefined ? undefined : Number(v));
  const memory = parseAttrs(block('MEMORY')).map(({ name, attrs }) => ({
    name, start: num(attrs.start), size: num(attrs.size), inFile: attrs.file === '%O',
  }));
  const segments = parseAttrs(block('SEGMENTS')).map(({ name, attrs }) => ({
    name, load: attrs.load, run: attrs.run, start: num(attrs.start),
  }));
  const symbols = [];
  for (const m of block('SYMBOLS').matchAll(/([A-Za-z0-9_]+)\s*:\s*type\s*=\s*export\s*,\s*value\s*=\s*([^;]+);/g)) {
    symbols.push([m[1], m[2].trim()]);
  }
  return { memory, segments, symbols };
}

/** Parse bins.xml -> Map(fileName -> {offset, length}); offsets are into PRG (no iNES header). */
export function parseBins(text) {
  const map = new Map();
  for (const m of text.matchAll(/<Binary\s+Offset='(\d+)'\s+Length='(\d+)'\s+FileName='([^']+)'/g)) {
    map.set(m[3], { offset: Number(m[1]), length: Number(m[2]) });
  }
  return map;
}

// ---------------------------------------------------------------- expressions
function tokenize(expr) {
  const toks = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    const rest = expr.slice(i);
    if ((m = rest.match(/^\$[0-9A-Fa-f]+/))) toks.push({ t: 'num', v: parseInt(m[0].slice(1), 16) });
    else if ((m = rest.match(/^%[01]+/))) toks.push({ t: 'num', v: parseInt(m[0].slice(1), 2) });
    else if ((m = rest.match(/^\d+/))) toks.push({ t: 'num', v: parseInt(m[0], 10) });
    else if ((m = rest.match(/^:(\++|-+)/))) toks.push({ t: 'anon', v: m[1] });
    else if ((m = rest.match(/^@?[A-Za-z_][A-Za-z0-9_]*/))) toks.push({ t: 'id', v: m[0] });
    else if ((m = rest.match(/^'(.)'/))) toks.push({ t: 'num', v: m[1].charCodeAt(0) });
    else if ('+-*/&|^<>()'.includes(c)) { toks.push({ t: 'op', v: c }); m = [c]; }
    else throw new Error(`bad expression token at "${rest}"`);
    i += m[0].length;
  }
  return toks;
}

/**
 * Evaluate an expression. resolve(token) returns a number or undefined (unknown).
 * Returns undefined if any symbol is unknown.
 */
export function evalExpr(expr, resolve) {
  const toks = tokenize(expr);
  let p = 0;
  let unknown = false;
  const peek = () => toks[p];
  const primary = () => {
    const t = toks[p++];
    if (!t) throw new Error(`unexpected end in "${expr}"`);
    if (t.t === 'num') return t.v;
    if (t.t === 'id' || t.t === 'anon') {
      const v = resolve(t);
      if (v === undefined) { unknown = true; return 0x10000; }
      return v;
    }
    if (t.v === '(') { const v = binary(0); p++; return v; }
    if (t.v === '<') return primary() & 0xff;
    if (t.v === '>') return (primary() >> 8) & 0xff;
    if (t.v === '-') return -primary();
    throw new Error(`unexpected "${t.v}" in "${expr}"`);
  };
  const PREC = { '|': 1, '^': 2, '&': 3, '+': 4, '-': 4, '*': 5, '/': 5 };
  const binary = (minPrec) => {
    let left = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !(t.v in PREC) || PREC[t.v] < minPrec) return left;
      p++;
      const right = binary(PREC[t.v] + 1);
      switch (t.v) {
        case '+': left += right; break;
        case '-': left -= right; break;
        case '*': left *= right; break;
        case '/': left = Math.trunc(left / right); break;
        case '&': left &= right; break;
        case '|': left |= right; break;
        case '^': left ^= right; break;
      }
    }
  };
  const v = binary(0);
  if (p !== toks.length) throw new Error(`trailing tokens in "${expr}"`);
  return unknown ? undefined : v;
}

function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------- parsing
/** Parse an operand into {mode candidates, expr, force}. */
function parseOperand(mn, operand) {
  const ops = OPS[mn];
  if (!operand || operand === 'A') {
    if (ops.imp !== undefined) return { mode: 'imp' };
    if (ops.acc !== undefined) return { mode: 'acc' };
    throw new Error(`${mn} needs an operand`);
  }
  if (ops.rel !== undefined) return { mode: 'rel', expr: operand };
  if (operand.startsWith('#')) return { mode: 'imm', expr: operand.slice(1) };
  let m;
  if ((m = operand.match(/^\((.*)\)\s*,\s*[Yy]$/))) return { mode: 'izy', expr: m[1] };
  if ((m = operand.match(/^\((.*),\s*[Xx]\s*\)$/))) return { mode: 'izx', expr: m[1] };
  if (mn === 'JMP' && (m = operand.match(/^\((.*)\)$/))) return { mode: 'ind', expr: m[1] };
  let index = '';
  if ((m = operand.match(/^(.*?),\s*([XxYy])$/))) { operand = m[1].trim(); index = m[2].toUpperCase(); }
  let force = '';
  if ((m = operand.match(/^([az]):(.*)$/))) { force = m[1]; operand = m[2].trim(); }
  return { mode: 'mem', index, force, expr: operand };
}

function chooseMemMode(mn, ins, value) {
  const ops = OPS[mn];
  const zpKey = ins.index ? 'zp' + ins.index.toLowerCase() : 'zp';
  const absKey = ins.index ? 'ab' + ins.index.toLowerCase() : 'abs';
  const canZp = ops[zpKey] !== undefined;
  if (ins.force === 'z') return zpKey;
  if (ins.force !== 'a' && canZp && value !== undefined && value >= 0 && value < 0x100) return zpKey;
  if (ops[absKey] === undefined) throw new Error(`${mn}: no ${absKey} mode`);
  return absKey;
}

/**
 * Assemble the whole disassembly.
 * @param {string} srcDir  directory with Z_0*.asm, *.inc, Z.cfg, bins.xml
 * @param {{emit?: boolean}} opts
 * @returns {{symbols: Map, segments: Map, banks?: Array<Int16Array>}}
 */
export function assemble(srcDir, opts = {}) {
  const cfg = parseLinkerConfig(readFileSync(join(srcDir, 'Z.cfg'), 'utf8'));
  const bins = parseBins(readFileSync(join(srcDir, 'bins.xml'), 'utf8'));
  const asmFiles = Array.from({ length: 8 }, (_, i) => `Z_0${i}.asm`);

  // Statements per segment, in file order.
  const segStatements = new Map(cfg.segments.map((s) => [s.name, []]));
  const exports = asmFiles.map(() => new Set()); // per file: exported names
  const fileConsts = []; // per file: Map name->value from .inc and = definitions
  const globals = new Map(); // global label name -> [sym] (one per bank defining it)

  for (let fi = 0; fi < asmFiles.length; fi++) {
    const consts = new Map();
    fileConsts.push(consts);
    let seg = null;
    let scope = '';
    let anonCount = 0;
    let order = 0;
    const lines = [];
    const readLines = (path, depth = 0) => {
      for (const [ln, raw] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
        lines.push({ raw, file: path, ln: ln + 1 });
        const inc = raw.match(/^\s*\.INCLUDE\s+"([^"]+)"/i);
        if (inc) { lines.pop(); readLines(join(dirname(path), inc[1]), depth + 1); }
      }
    };
    readLines(join(srcDir, asmFiles[fi]));
    for (const { raw, file, ln } of lines) {
      let line = raw.replace(/;.*$/, '').trim();
      if (!line) continue;
      const where = `${file}:${ln}`;
      let m;
      if ((m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(:=|=)\s*(.+)$/))) {
        const v = evalExpr(m[3], (t) => consts.get(t.v));
        if (v === undefined) throw new Error(`${where}: cannot evaluate ${m[3]}`);
        consts.set(m[1], v);
        continue;
      }
      if ((m = line.match(/^\.SEGMENT\s+"([^"]+)"/i))) {
        seg = m[1];
        if (!segStatements.has(seg)) throw new Error(`${where}: unknown segment ${seg}`);
        continue;
      }
      if ((m = line.match(/^\.EXPORT(?:ZP)?\s+(.*)$/i))) { for (const n of splitArgs(m[1])) exports[fi].add(n); continue; }
      if (/^\.IMPORT(ZP)?\b/i.test(line)) continue;
      // labels (possibly followed by a statement)
      while ((m = line.match(/^(@?[A-Za-z_][A-Za-z0-9_]*|):(?!=)\s*(.*)$/))) {
        const name = m[1];
        const st = segStatements.get(seg);
        if (name === '') st.push({ kind: 'label', anon: anonCount++, file: fi, order: order++, where });
        else if (name.startsWith('@')) st.push({ kind: 'label', name: scope + name, local: true, file: fi, order: order++, where });
        else { scope = name; st.push({ kind: 'label', name, file: fi, order: order++, where }); }
        line = m[2].trim();
      }
      if (!line) continue;
      if (!seg) throw new Error(`${where}: statement outside segment`);
      const st = segStatements.get(seg);
      if ((m = line.match(/^\.(BYTE|BYT|ADDR|WORD|DBYT|LOBYTES|HIBYTES)\s+(.*)$/i))) {
        const dir = m[1].toUpperCase();
        const args = splitArgs(m[2]);
        const width = dir === 'ADDR' || dir === 'WORD' || dir === 'DBYT' ? 2 : 1;
        st.push({ kind: 'data', dir, args, size: args.length * width, file: fi, scope, order: order++, where });
        continue;
      }
      if ((m = line.match(/^\.INCBIN\s+"([^"]+)"/i))) {
        const bin = bins.get(m[1]);
        if (!bin) throw new Error(`${where}: ${m[1]} not in bins.xml`);
        st.push({ kind: 'incbin', file: fi, fileName: m[1], size: bin.length, binOffset: bin.offset, order: order++, where });
        continue;
      }
      if ((m = line.match(/^([A-Za-z]{3})\b\s*(.*)$/)) && OPS[m[1].toUpperCase()]) {
        const mn = m[1].toUpperCase();
        const ins = parseOperand(mn, m[2].trim());
        let mode = ins.mode;
        if (mode === 'mem') {
          // ca65 picks zero page only if the value is already known (constants/.inc).
          let v;
          try { v = evalExpr(ins.expr, (t) => (t.t === 'id' ? consts.get(t.v) : undefined)); } catch { v = undefined; }
          mode = chooseMemMode(mn, ins, v);
        }
        if (OPS[mn][mode] === undefined) throw new Error(`${where}: ${mn} has no mode ${mode}`);
        st.push({ kind: 'ins', mn, mode, expr: ins.expr, size: MODE_SIZE[mode], file: fi, scope, order: order++, where });
        continue;
      }
      throw new Error(`${where}: cannot parse "${line}"`);
    }
  }

  // ---- placement (ld65 semantics: segments in order within each memory area)
  const memByName = new Map(cfg.memory.map((m) => [m.name, m]));
  const memPtr = new Map(cfg.memory.map((m) => [m.name, m.start]));
  const segments = new Map();
  for (const s of cfg.segments) {
    const size = segStatements.get(s.name).reduce((n, st) => n + (st.size ?? 0), 0);
    const mem = memByName.get(s.load);
    let load = memPtr.get(s.load);
    if (s.start !== undefined) {
      if (s.start < load) throw new Error(`segment ${s.name} overlaps previous (${load.toString(16)} > ${s.start.toString(16)})`);
      load = s.start;
    }
    if (load + size > mem.start + mem.size) throw new Error(`segment ${s.name} overflows ${mem.name}`);
    memPtr.set(s.load, load + size);
    let run = load;
    if (s.run) { run = memPtr.get(s.run); memPtr.set(s.run, run + size); }
    const bank = Number(s.load.match(/ROM_(\d+)/)[1]);
    segments.set(s.name, { name: s.name, bank, load, run, size, memStart: mem.start });
  }

  // ld65 "define = yes" symbols, plus the SYMBOLS block used by the disassembly.
  const linkerSymbols = new Map();
  for (const seg of segments.values()) {
    linkerSymbols.set(`__${seg.name}_LOAD__`, seg.load);
    linkerSymbols.set(`__${seg.name}_RUN__`, seg.run);
    linkerSymbols.set(`__${seg.name}_SIZE__`, seg.size);
  }
  for (const [name, expr] of cfg.symbols) {
    linkerSymbols.set(name, evalExpr(expr, (t) => linkerSymbols.get(t.v)));
  }

  // ---- assign label addresses
  const symbols = new Map(); // name -> {bank, addr(run), load, seg, kind, size}
  const anonPositions = []; // per file: [{order, addr}]
  const scopedLabels = []; // per file: Map name -> addr (globals + locals)
  for (let fi = 0; fi < 8; fi++) { anonPositions.push([]); scopedLabels.push(new Map()); }
  const order = [];
  for (const s of cfg.segments) {
    const seg = segments.get(s.name);
    let off = 0;
    const stmts = segStatements.get(s.name);
    stmts.forEach((st, idx) => {
      if (st.kind === 'label') {
        const addr = seg.run + off;
        if (st.anon !== undefined) { anonPositions[st.file].push({ order: st.order, addr }); return; }
        // kind: data if next non-label statement is data/incbin
        let next = stmts.slice(idx + 1).find((x) => x.kind !== 'label');
        const kind = !next ? 'end' : next.kind === 'ins' ? 'code' : 'data';
        const sym = { name: st.name, bank: seg.bank, addr, load: seg.load + off, seg: s.name, kind, local: !!st.local, file: st.file };
        if (scopedLabels[st.file].has(st.name)) throw new Error(`${st.where}: duplicate label ${st.name}`);
        scopedLabels[st.file].set(st.name, addr);
        if (!st.local) {
          // Labels are file-local unless exported; the same name may exist in several banks.
          if (!globals.has(st.name)) globals.set(st.name, []);
          globals.get(st.name).push(sym);
        }
        order.push(sym);
      } else {
        st.addr = seg.run + off;
        st.loadAddr = seg.load + off;
        st.bank = seg.bank;
        off += st.size;
      }
    });
  }
  // Unique public key per symbol: Name, or Name#bank when the name exists in several banks.
  // Cheap locals are keyed Scope@Local (also suffixed when ambiguous).
  const keyCount = new Map();
  for (const x of order) keyCount.set(x.name, (keyCount.get(x.name) ?? 0) + 1);
  for (const x of order) {
    x.key = keyCount.get(x.name) > 1 ? `${x.name}#${x.bank}` : x.name;
    if (symbols.has(x.key)) throw new Error(`symbol key collision ${x.key}`);
    symbols.set(x.key, x);
  }

  // size of each symbol = distance to the next symbol (any kind) in the same segment
  for (const s of cfg.segments) {
    const seg = segments.get(s.name);
    // Globals extend to the next global label; cheap locals to the next label of any kind.
    const syms = order.filter((x) => x.seg === s.name);
    syms.forEach((x, i) => {
      const next = syms.slice(i + 1).find((y) => !x.local ? !y.local : true);
      x.size = (next ? next.addr : seg.run + seg.size) - x.addr;
    });
  }

  // ---- verification against bins.xml offsets (PRG offset = bank*0x4000 + load - memStart)
  const problems = [];
  for (const s of cfg.segments) {
    const seg = segments.get(s.name);
    for (const st of segStatements.get(s.name)) {
      if (st.kind !== 'incbin') continue;
      const prgOffset = seg.bank * 0x4000 + (st.loadAddr - seg.memStart);
      if (prgOffset !== st.binOffset) problems.push(`${st.fileName}: computed ${prgOffset}, bins.xml ${st.binOffset}`);
    }
  }

  const result = { symbols, segments, problems, banks: undefined, statements: segStatements };
  if (!opts.emit) return result;

  // ---- pass 2: emit bytes (-1 = unknown / incbin / fill)
  // 0xFF = ld65 fill for unused space; -1 = INCBIN bytes (not known without the ROM).
  const banks = Array.from({ length: 8 }, () => new Int16Array(0x4000).fill(0xff));
  for (const s of cfg.segments) {
    const seg = segments.get(s.name);
    const stmts = segStatements.get(s.name);
    for (const st of stmts) {
      if (st.kind === 'label') continue;
      if (st.kind === 'incbin') { banks[seg.bank].fill(-1, st.loadAddr - seg.memStart, st.loadAddr - seg.memStart + st.size); continue; }
      const fi = st.file;
      const resolve = (t) => {
        if (t.t === 'anon') return resolveAnon(fi, st, t.v);
        if (t.v.startsWith('@')) return scopedLabels[fi].get(st.scope + t.v);
        if (fileConsts[fi].has(t.v)) return fileConsts[fi].get(t.v);
        if (scopedLabels[fi].has(t.v)) return scopedLabels[fi].get(t.v);
        if (linkerSymbols.has(t.v)) return linkerSymbols.get(t.v);
        const g = (globals.get(t.v) ?? []).filter((x) => exports[x.file].has(t.v));
        if (g.length !== 1) throw new Error(`${st.where}: ${g.length ? 'ambiguous' : 'unresolved'} import ${t.v}`);
        return g[0].addr;
      };
      const ev = (e) => {
        const v = evalExpr(e, resolve);
        if (v === undefined) throw new Error(`${st.where}: unresolved "${e}"`);
        return v;
      };
      const bytes = [];
      if (st.kind === 'data') {
        for (const a of st.args) {
          const v = ev(a);
          if (st.dir === 'BYTE' || st.dir === 'BYT') bytes.push(v & 0xff);
          else if (st.dir === 'LOBYTES') bytes.push(v & 0xff);
          else if (st.dir === 'HIBYTES') bytes.push((v >> 8) & 0xff);
          else if (st.dir === 'DBYT') bytes.push((v >> 8) & 0xff, v & 0xff);
          else bytes.push(v & 0xff, (v >> 8) & 0xff);
        }
      } else {
        bytes.push(OPS[st.mn][st.mode]);
        if (st.mode === 'rel') {
          const d = ev(st.expr) - (st.addr + 2);
          if (d < -128 || d > 127) throw new Error(`${st.where}: branch out of range`);
          bytes.push(d & 0xff);
        } else if (st.size === 2) bytes.push(ev(st.expr) & 0xff);
        else if (st.size === 3) { const v = ev(st.expr); bytes.push(v & 0xff, (v >> 8) & 0xff); }
      }
      const base = st.loadAddr - seg.memStart;
      bytes.forEach((b, i) => { banks[seg.bank][base + i] = b; });
    }
  }
  result.banks = banks;
  return result;

  function resolveAnon(fi, st, dirs) {
    const list = anonPositions[fi];
    const n = dirs.length;
    if (dirs[0] === '+') return list.filter((a) => a.order > st.order)[n - 1]?.addr;
    const before = list.filter((a) => a.order < st.order);
    return before[before.length - n]?.addr;
  }
}

export const _internal = { OPS, MODE_SIZE, tokenize, chooseMemMode, parseOperand };

/** CRC32 (IEEE) of a byte sequence. Same algorithm as src/core/rom.js crc32(). */
export function crc32(bytes, crc = 0) {
  crc = ~crc >>> 0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Per-bank CRC32 over the bytes the assembler knows (INCBIN bytes, marked -1, are skipped). */
export function bankFingerprints(banks) {
  return banks.map((bank) => crc32([...bank].filter((b) => b >= 0)));
}
