// Builds the routine/data graph of the whole disassembly from parsed+assembled banks.
import { parseBank, parseInc, assemble, evalExpr, bankBase, WRITE_OPS, RMW_OPS } from './parse.mjs';
import { join } from 'node:path';

const INC_FILES = ['Variables.inc', 'ObjVars.inc', 'CommonVars.inc', 'CaveVars.inc', 'BeginEndVars.inc'];
const hex = (n, w = 4) => `$${n.toString(16).toUpperCase().padStart(w, '0')}`;

// Classifies a numeric address into a memory region.
function region(addr) {
  if (addr < 0x10) return 'temp';
  if (addr < 0x800) return 'ram';
  if (addr >= 0x2000 && addr < 0x4020) return 'io';
  if (addr >= 0x6000 && addr < 0x8000) return 'sram';
  return 'rom';
}

export function analyze(srcDir) {
  const ram = new Map();
  const ramByFile = {};
  for (const f of INC_FILES) {
    ramByFile[f] = parseInc(join(srcDir, f));
    for (const [k, v] of ramByFile[f]) ram.set(k, v);
  }
  const banks = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => parseBank(b, srcDir));
  const exported = new Map(); // name -> {bank, addr}
  // Linker-defined symbols (Z.cfg): BANK_01_CODE is loaded at $A500 in bank 1 and copied to $6C90.
  exported.set('__BANK_01_CODE_LOAD__', { bank: 1, addr: 0xA500, linker: true });
  exported.set('__BANK_01_CODE_RUN__', { bank: 1, addr: 0x6C90, linker: true });
  exported.set('__BANK_01_CODE_RUN_END__', { bank: 1, addr: 0x7F00, linker: true });
  for (let pass = 0; pass < 2; pass++) {
    for (const b of banks) {
      b.labels = assemble(b, ram, (n) => exported.get(n)?.addr);
      for (const name of b.exports) {
        if (!b.labels.has(name)) throw new Error(`bank ${b.bank} exports undefined ${name}`);
        exported.set(name, { bank: b.bank, addr: b.labels.get(name) });
      }
    }
  }
  for (const b of banks) for (const name of b.imports) if (!exported.has(name)) throw new Error(`bank ${b.bank} imports unknown ${name}`);

  // Blocks: each named (non-local) label starts a block that runs to the next named label or segment change.
  const blocks = [];
  for (const b of banks) {
    let cur = null;
    let seg = null;
    let pendingAliases = [];
    const close = () => { if (cur) { blocks.push(cur); cur = null; } };
    for (let i = 0; i < b.stmts.length; i++) {
      const s = b.stmts[i];
      if (s.kind === 'segment') { close(); seg = s.name; continue; }
      if (s.kind === 'unknown') { close(); continue; }
      if (s.kind === 'label' && !s.local) {
        // Label with no statements before the next named label = alias of the following block.
        const next = b.stmts.slice(i + 1).find((t) => t.kind !== 'anon' && !(t.kind === 'label' && t.local));
        close();
        if (next && next.kind === 'label') { pendingAliases.push(s); continue; }
        cur = { bank: b.bank, name: s.name, line: s.line, segment: seg, addr: s.addr, prg: s.prg, stmts: [], aliases: pendingAliases.map((a) => a.name) };
        pendingAliases = [];
        continue;
      }
      if (!cur) {
        if (s.kind === 'label' || s.kind === 'anon') continue;
        // Unlabeled bytes (e.g. "Unknown block" in ISR/VEC segments).
        cur = { bank: b.bank, name: `_Unlabeled_${b.bank}_${s.addr.toString(16).toUpperCase()}`, line: s.line, segment: seg, addr: s.addr, prg: s.prg, stmts: [], aliases: [], unlabeled: true };
      }
      cur.stmts.push(s);
    }
    close();
  }

  const byName = new Map();
  for (const bl of blocks) {
    for (const n of [bl.name, ...bl.aliases]) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(bl);
    }
  }
  // Resolve a symbol referenced from bank `bank` to the block that defines it (local bank first, then exports).
  const findBlock = (name, bank) => {
    const list = byName.get(name);
    if (!list) return null;
    return list.find((x) => x.bank === bank) || (exported.has(name) && list.find((x) => x.bank === exported.get(name).bank)) || null;
  };
  const ramName = new Map(); // addr -> first name
  for (const [k, v] of ramByFile['Variables.inc']) if (!ramName.has(v)) ramName.set(v, k);

  for (const bl of blocks) {
    bl.unverified = bl.stmts.some((s) => s.kind === 'unverified');
    const instrs = bl.stmts.filter((s) => s.kind === 'instr');
    const data = bl.stmts.filter((s) => s.kind === 'data');
    bl.kind = instrs.length && (!data.length || bl.stmts[0].kind === 'instr') ? 'code' : 'data';
    bl.size = bl.stmts.reduce((a, s) => a + (s.size || 0), 0);
    if (bl.unlabeled && data.length && data.every((d) => d.items && d.items.every((x) => x === '$FF'))) bl.padding = true;
    // Inline data inside code (tables after an @local label) and code embedded in data blocks.
    bl.inlineData = [];
    let run = null;
    let lastLocal = null;
    for (const s of bl.stmts) {
      if (s.kind === 'label') { lastLocal = s.name; run = null; continue; }
      if (s.kind === 'data' && bl.kind === 'code') {
        if (!run) { run = { label: lastLocal, line: s.line, addr: s.addr, prg: s.prg, size: 0 }; bl.inlineData.push(run); }
        run.size += s.size;
      } else if (s.kind === 'instr') run = null;
    }
    if (bl.kind === 'data' && instrs.length) bl.embeddedCodeInstrs = instrs.length;
    bl.endLine = bl.stmts.length ? bl.stmts[bl.stmts.length - 1].line : bl.line;
    bl.instrCount = instrs.length;
    bl.calls = [];
    bl.refs = new Set();
    bl.memRefs = new Set();
    bl.ram = { read: new Set(), write: new Set() };
    bl.io = new Set();
    bl.switchBank = [];
    bl.indirectJump = false;
    const addEdge = (kind, name, line) => {
      const t = findBlock(name, bl.bank);
      if (!t) return;
      if (t === bl) return;
      bl.calls.push({ kind, name: t.name, bank: t.bank, line });
    };
    let lastImm = null;
    for (const s of bl.stmts) {
      if (s.kind === 'data') {
        if (s.items) for (const it of s.items) for (const id of it.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) if (byName.has(id)) bl.refs.add(id);
        continue;
      }
      if (s.kind !== 'instr') continue;
      const { mnem, dec } = s;
      if (mnem === 'LDA' && dec.mode === 'imm') lastImm = dec.expr;
      const ids = dec.expr ? (dec.expr.match(/@?[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((x) => !x.startsWith('@')) : [];
      if (mnem === 'JSR' || (mnem === 'JMP' && dec.mode === 'mem')) {
        if (ids[0] === 'SwitchBank' && lastImm !== null) bl.switchBank.push(evalExpr(lastImm, () => 0).value);
        if (ids.length) addEdge(mnem === 'JSR' ? 'jsr' : 'jmp', ids[0], s.line);
        continue;
      }
      if (mnem === 'JMP' && dec.mode === 'ind') { bl.indirectJump = true; continue; }
      if (dec.mode === 'rel') { if (ids.length) addEdge('branch', ids[0], s.line); continue; }
      if (!dec.expr) continue;
      // Memory / immediate operands: RAM variables, hardware registers, ROM labels.
      for (const id of ids) {
        if (ram.has(id) && dec.mode !== 'imm') {
          const isWrite = WRITE_OPS.has(mnem) && dec.mode !== 'imp';
          if (isWrite) bl.ram.write.add(id);
          if (!isWrite || RMW_OPS.has(mnem)) bl.ram.read.add(id);
          const a = ram.get(id);
          if (region(a) === 'io') { bl.io.add(id); bl.ram.read.delete(id); bl.ram.write.delete(id); }
        } else if (byName.has(id)) {
          bl.refs.add(id);
          // A code label used as a memory operand is data living inside code (e.g. FileBChecksums), not a call.
          if (dec.mode !== 'imm') bl.memRefs.add(id);
        }
      }
      if (!ids.length && dec.mode !== 'imm') {
        const v = evalExpr(dec.expr, () => 0).value;
        const reg = region(v);
        const name = reg === 'io' ? hex(v) : v < 0x100 ? ramName.get(v) || hex(v, 2) : ramName.get(v) || hex(v);
        if (reg === 'io' || reg === 'rom') bl.io.add(hex(v));
        else if (WRITE_OPS.has(mnem) && dec.mode !== 'imp') { bl.ram.write.add(name); if (RMW_OPS.has(mnem)) bl.ram.read.add(name); }
        else bl.ram.read.add(name);
      }
    }
    const last = [...bl.stmts].reverse().find((s) => s.kind === 'instr' || s.kind === 'data');
    bl.endsWith = last ? (last.kind === 'instr' ? last.mnem : 'data') : null;
  }

  // Data blocks: which routines reference them; jump tables become dispatch edges.
  const blockIndex = new Map(blocks.map((b, i) => [b, i]));
  for (const bl of blocks) {
    if (bl.kind !== 'data') continue;
    const addrItems = bl.stmts.filter((s) => s.dir === 'ADDR').flatMap((s) => s.items);
    const codeTargets = [];
    for (const it of addrItems) {
      const id = (it.match(/^[A-Za-z_][A-Za-z0-9_]*$/) || [])[0];
      const t = id && findBlock(id, bl.bank);
      if (t && t.kind === 'code') codeTargets.push(t.name);
    }
    bl.codeTargets = codeTargets;
    bl.isJumpTable = codeTargets.length > 0 && codeTargets.length === addrItems.length;
    // A jump table placed right after "JSR TableJump" is dispatched by the preceding routine.
    const prev = blocks[blockIndex.get(bl) - 1];
    // A jump table right after a data block with embedded "JSR TableJump" code (UpdateMenuOW) belongs to the same dispatcher.
    if (bl.isJumpTable && prev && prev.kind === 'data' && prev.embeddedCodeInstrs && prev.dispatchedBy) {
      const owner = blocks.find((x) => x.name === prev.dispatchedBy && x.bank === bl.bank);
      bl.dispatchedBy = owner.name;
      owner.dispatch2 = { table: bl.name, targets: codeTargets };
      codeTargets.forEach((t, i) => owner.calls.push({ kind: 'dispatch', name: t, bank: findBlock(t, bl.bank).bank, index: i, table: bl.name }));
    }
    if (bl.isJumpTable && prev && prev.bank === bl.bank && prev.kind === 'code') {
      const lastI = [...prev.stmts].reverse().find((s) => s.kind === 'instr');
      if (lastI && lastI.mnem === 'JSR' && /TableJump$/.test(lastI.dec.expr)) {
        bl.dispatchedBy = prev.name;
        prev.dispatch = { table: bl.name, targets: codeTargets };
        codeTargets.forEach((t, i) => prev.calls.push({ kind: 'dispatch', name: t, bank: findBlock(t, bl.bank).bank, index: i, table: bl.name }));
      }
    }
  }
  // Data tables referenced by code (and tables of code addresses) become 'table' edges.
  for (const bl of blocks) {
    if (bl.kind !== 'code') continue;
    for (const r of bl.refs) {
      const t = findBlock(r, bl.bank);
      if (t && t.kind === 'code' && !bl.memRefs.has(r)) bl.calls.push({ kind: 'addr', name: t.name, bank: t.bank });
      if (t && t.kind === 'code' && bl.memRefs.has(r)) (bl.codeAsData ||= []).push(t.name);
      if (t && t.kind === 'data' && t.isJumpTable && !t.dispatchedBy) {
        for (const x of t.codeTargets) bl.calls.push({ kind: 'table', name: x, bank: findBlock(x, t.bank).bank, via: t.name });
      }
    }
  }
  // Fall-through: code that does not end with RTS/RTI/JMP continues into the next block.
  for (let i = 0; i < blocks.length; i++) {
    const bl = blocks[i];
    if (bl.kind !== 'code' || bl.dispatch) continue;
    const nx = blocks[i + 1];
    if (!['RTS', 'RTI', 'JMP'].includes(bl.endsWith) && nx && nx.bank === bl.bank && nx.segment === bl.segment && nx.kind === 'code') {
      bl.fallsInto = nx.name;
      bl.calls.push({ kind: 'fall', name: nx.name, bank: nx.bank });
    }
  }
  // Entry points: blocks reached by JSR/JMP/dispatch/address tables or exported. Other code blocks are only
  // reached by branch/fall-through from the previous routine, so they are ported inside it (partOf).
  const reached = new Map();
  for (const bl of blocks) for (const c of bl.calls) {
    if (!reached.has(c.name)) reached.set(c.name, new Set());
    reached.get(c.name).add(c.kind);
  }
  for (const bl of blocks) for (const t of bl.codeTargets || []) {
    if (!reached.has(t)) reached.set(t, new Set());
    reached.get(t).add('table');
  }
  const vectorEntries = new Set(['IsrNmi', 'IsrReset']);
  const usedAsData = new Set(blocks.flatMap((b) => b.codeAsData || []));
  for (let i = 0; i < blocks.length; i++) {
    const bl = blocks[i];
    if (bl.kind !== 'code') continue;
    const kinds = reached.get(bl.name) || new Set();
    const isExported = exported.has(bl.name) && exported.get(bl.name).bank === bl.bank;
    const called = [...kinds].some((k) => k !== 'branch' && k !== 'fall');
    bl.entry = called || vectorEntries.has(bl.name) || (isExported && !usedAsData.has(bl.name));
    if (!bl.entry) {
      const prev = blocks[i - 1];
      if (prev && prev.kind === 'code' && prev.bank === bl.bank && prev.fallsInto === bl.name) bl.partOf = prev.partOf || prev.name;
      else {
        // Reached only by a branch from another routine (e.g. after an inline jump table).
        const from = blocks.find((b) => b.kind === 'code' && b.bank === bl.bank && b.calls.some((c) => c.name === bl.name && c.kind === 'branch'));
        if (from) bl.partOf = from.partOf || from.name;
      }
    }
  }
  return { banks, blocks, exported, ram, ramByFile, findBlock };
}
