// Instruction-level control-flow graph of the whole program, built from the disassembly
// (reference/zelda1-disassembly/src/Z_0*.asm: instruction boundaries, labels, routines, segments)
// and the user's ROM (opcode -> addressing mode, size, base cycles, operand). Every instruction's
// mnemonic is checked against the ROM byte, so a desynchronised parse fails loudly.
//
// Nothing here is shipped: it is derived at run time / build time from the two inputs, like
// src/core/symbols.js is derived from the disassembly.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYMBOLS, SEGMENTS } from '../../../src/core/symbols.js';
import { OPCODES, BRANCHES } from './opcodes.mjs';

export const DISASM_DIR = join(import.meta.dirname, '../../../reference/zelda1-disassembly/src');

/** Region of a run address: 'sram' (BANK_01_CODE copy), 7 (fixed bank) or the switchable bank. */
export const regionOf = (run, bank) => (run < 0x8000 ? 'sram' : run >= 0xc000 ? 7 : bank);
export const keyOf = (region, run) => `${region}:${run}`;

function lookupLabel(name, bank, scope) {
  const tries = name.startsWith('@')
    ? [`${scope}${name}`, `${scope}#${bank}${name}`]
    : [name, `${name}#${bank}`];
  for (const k of tries) {
    const s = SYMBOLS[k];
    if (s && s[0] === bank) return { key: k, addr: s[1] };
  }
  return null;
}

/**
 * @param {{prgByte(bank:number, addr:number):number}} rom  core/rom.js Rom
 * @returns {{instrs: object[], byKey: Map<string, number>, routines: Map<string, number>, errors: string[]}}
 */
export function buildCfg(rom) {
  const instrs = [];
  const byKey = new Map();
  const routines = new Map(); // routine name -> instr index of its entry
  const errors = [];
  for (let bank = 0; bank <= 7; bank++) {
    const lines = readFileSync(join(DISASM_DIR, `Z_0${bank}.asm`), 'utf8').split(/\r?\n/);
    let seg = null, run = 0, load = 0;
    let scope = null; // current global label
    let pendingLabels = [];
    let anon = 0; // anonymous label counter within the current global label
    let prevInstr = null; // previous instruction, for fallthrough
    let afterData = true;
    for (let ln = 0; ln < lines.length; ln++) {
      const raw = lines[ln];
      const code = raw.replace(/;.*$/, '').trimEnd();
      if (!code.trim()) continue;
      let m;
      if ((m = /^\s*\.SEGMENT\s+"([^"]+)"/.exec(code))) {
        seg = SEGMENTS[m[1]];
        if (!seg) { errors.push(`Z_0${bank}:${ln + 1}: unknown segment ${m[1]}`); continue; }
        run = seg.run; load = seg.load;
        prevInstr = null; afterData = true;
        continue;
      }
      if ((m = /^([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(code)) || (m = /^(@[A-Za-z0-9_]+):\s*$/.exec(code))) {
        const name = m[1];
        const sym = lookupLabel(name, bank, scope);
        if (!name.startsWith('@')) { scope = name; anon = 0; }
        if (sym) {
          if (sym.addr !== run && seg) {
            // resync (data of unknown size, e.g. .INCBIN, before this label)
            load += sym.addr - run;
            run = sym.addr;
          }
        }
        pendingLabels.push(name.startsWith('@') ? `${scope}${name}` : name);
        continue;
      }
      if (/^\s*:\s*$/.test(code)) {
        anon++;
        pendingLabels.push(`${scope}@:${anon}`);
        continue;
      }
      if (/^\s*\.(INCLUDE|EXPORT|IMPORT|IMPORTZP|EXPORTZP)\b/i.test(code)) continue;
      if ((m = /^\s*\.(BYTE|ADDR|WORD|DBYT|LOBYTES|HIBYTES|INCBIN)\b(.*)$/i.exec(code))) {
        const kind = m[1].toUpperCase();
        const items = m[2].split(',').map((s) => s.trim()).filter(Boolean).length;
        const size = kind === 'BYTE' || kind === 'LOBYTES' || kind === 'HIBYTES' ? items
          : kind === 'INCBIN' ? 0 : items * 2;
        run += size; load += size;
        pendingLabels = [];
        if (prevInstr) prevInstr.dataAfter = true;
        prevInstr = null; afterData = true;
        continue;
      }
      if ((m = /^\s+([A-Z]{3})\b\s*(.*)$/.exec(code))) {
        const mn = m[1];
        const operandText = m[2].trim();
        const op = rom.prgByte(bank, load);
        const info = OPCODES[op];
        if (!info || info.mn !== mn) {
          errors.push(`Z_0${bank}:${ln + 1}: ${mn} ${operandText} at $${run.toString(16)} but ROM has $${op.toString(16)} (${info?.mn ?? '???'})`);
          // try to continue with the asm size guess
          run += 1; load += 1; prevInstr = null; pendingLabels = [];
          continue;
        }
        const b1 = info.size > 1 ? rom.prgByte(bank, load + 1) : 0;
        const b2 = info.size > 2 ? rom.prgByte(bank, load + 2) : 0;
        let operand = info.size === 2 ? b1 : info.size === 3 ? b1 | (b2 << 8) : null;
        let target = null;
        if (info.mode === 'rel') target = (run + 2 + ((b1 << 24) >> 24)) & 0xffff;
        else if (mn === 'JMP' && info.mode === 'abs') target = operand;
        else if (mn === 'JSR') target = operand;
        const region = regionOf(run, bank);
        const ins = {
          idx: instrs.length, bank, region, run, load, mn, mode: info.mode, size: info.size, cycles: info.cycles,
          penalty: info.penalty, operand, target, labels: pendingLabels, routine: scope, file: `Z_0${bank}`, line: ln + 1,
          operandText, next: null, branch: BRANCHES.has(mn), afterData,
        };
        pendingLabels = [];
        afterData = false;
        if (prevInstr) prevInstr.next = ins.idx;
        instrs.push(ins);
        byKey.set(keyOf(region, run), ins.idx);
        for (const l of ins.labels) if (!l.includes('@') && !routines.has(l)) routines.set(l, ins.idx);
        const terminator = mn === 'JMP' || mn === 'RTS' || mn === 'RTI' || mn === 'BRK';
        prevInstr = terminator ? null : ins;
        run += info.size; load += info.size;
        continue;
      }
      errors.push(`Z_0${bank}:${ln + 1}: unparsed line: ${code.trim()}`);
    }
  }
  // a terminator-free instruction followed by data: no fallthrough
  return { instrs, byKey, routines, errors };
}

/** Instruction at a run address with `bank` mapped at $8000. */
export function instrAt(cfg, run, bank) {
  return cfg.byKey.get(keyOf(regionOf(run, bank), run));
}
