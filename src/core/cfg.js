// The original program as an instruction-level control-flow graph, for the cycle tracker
// (src/core/timing.js, docs/TIMING.md §5.3). Built at load time from:
//   * cfg.gen.js   instruction boundaries + asm line of every instruction (generated, no ROM bytes),
//   * symbols.js   routine names and addresses,
//   * the user's ROM: opcode -> mnemonic, mode, size, cycles; operands; branch/jump targets.
// Everything is in typed arrays indexed by instruction id (0..n-1, file order Z_00..Z_07).
import { OPCODES } from './opcodes.js';

// instruction kinds (what the tracker does when its walk reaches one)
export const K_PLAIN = 0; // decision-free, cost = cycles (+ page-cross penalty for some indexed reads)
export const K_BRANCH = 1; // conditional branch: needs $br()
export const K_JSR = 2; // call: followed automatically (shadow stack); TableJump / SwitchBank are special
export const K_RTS = 3; // return: followed automatically
export const K_RTI = 4; // end of the NMI
export const K_JMP = 5; // followed automatically
export const K_JMPIND = 6; // JMP ($0002): only inside TableJump
export const K_IO = 7; // access to $2000-$401F or a store to the mapper ($8000+): bus.read/write breadcrumb

// flags of an instruction that is a routine entry
export const F_TABLEJUMP = 1; // TableJump: core/asm.js tableJump() is the breadcrumb
export const F_SWITCHBANK = 2; // SwitchBank*: core/asm.js switchBank() writes the mapper directly (opaque)
const OPAQUE_ROUTINES = ['SwitchBank', 'SwitchBank_Local1', 'SwitchBank_Local2', 'SwitchBank_Local5'];

const REGION_SRAM = 8;
const BRANCH_MN = new Set(['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS']);

function decodeBase64(s) {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(s, 'base64'));
}

/** Region of a run address: 0-6 = switchable bank, 7 = fixed bank, 8 = SRAM copy (BANK_01_CODE). */
export function regionOf(run, bank) {
  return run < 0x8000 ? REGION_SRAM : run >= 0xc000 ? 7 : bank;
}

/**
 * @param {{prgByte(bank:number, addr:number):number}} rom
 * @param {{count:number, data:string}[]} files  CFG_FILES of cfg.gen.js
 * @param {Record<string, any[]>} symbols        SYMBOLS of symbols.js
 */
export function buildProgram(rom, files, symbols) {
  let n = 0;
  for (const f of files) n += f.count;
  const P = {
    n,
    run: new Uint16Array(n), load: new Uint16Array(n), bank: new Uint8Array(n), region: new Uint8Array(n),
    line: new Uint16Array(n), op: new Uint8Array(n), size: new Uint8Array(n), cycles: new Uint8Array(n),
    operand: new Uint16Array(n), kind: new Uint8Array(n), next: new Int32Array(n).fill(-1),
    target: new Int32Array(n).fill(-1), // static target id; -2 = depends on the mapped bank (resolve at run time)
    penalty: new Uint8Array(n), // 1 = indexed read that may cross a page (+1 cycle): needs a $px hint
    flags: new Uint8Array(n), // routine-entry flags (F_*)
    routine: new Uint16Array(n), // index into routineNames: the global label the instruction belongs to
    routineNames: [],
    /** run-address lookup per region: Int32Array of ids (-1 = none) */
    byRegion: [],
    entries: new Map(), // routine name (symbols.js key) -> id
    refs: null, // 'Z_0b:line' -> id (built on first use)
    errors: [],
  };
  for (let r = 0; r <= REGION_SRAM; r++) P.byRegion.push(new Int32Array(r === REGION_SRAM ? 0x2000 : 0x4000).fill(-1));
  const slot = (region, run) => (region === REGION_SRAM ? run - 0x6000 : run & 0x3fff);

  // code labels by bank and address -> routine names (globals only)
  const labelsAt = Array.from({ length: 8 }, () => new Map());
  for (const [key, s] of Object.entries(symbols)) {
    if (s[3] !== 'c' || key.includes('@')) continue;
    const m = labelsAt[s[0]];
    if (!m.has(s[1])) m.set(s[1], []);
    m.get(s[1]).push(key);
  }

  let id = 0;
  for (let b = 0; b < files.length; b++) {
    const bytes = decodeBase64(files[b].data);
    let p = 0, line = 0, run = 0, load = 0, prev = -1, routine = 0;
    for (let k = 0; k < files[b].count; k++, id++) {
      let v = 0, shift = 0, c;
      do { c = bytes[p++]; v |= (c & 0x7f) << shift; shift += 7; } while (c & 0x80);
      line += v >>> 1;
      const explicit = v & 1;
      if (explicit) {
        run = bytes[p] | (bytes[p + 1] << 8);
        load = bytes[p + 2] | (bytes[p + 3] << 8);
        p += 4;
      } else if (prev >= 0) {
        P.next[prev] = id; // falls through from the previous instruction
      }
      const op = rom.prgByte(b, load);
      const info = OPCODES[op];
      const region = regionOf(run, b);
      P.run[id] = run; P.load[id] = load; P.bank[id] = b; P.region[id] = region; P.line[id] = line; P.op[id] = op;
      const names = labelsAt[b].get(run);
      if (names) {
        for (const nm of names) P.entries.set(nm, id);
        const base = names[0].replace(/#\d$/, '');
        let ri = P.routineNames.indexOf(base);
        if (ri < 0) { ri = P.routineNames.length; P.routineNames.push(base); }
        routine = ri;
      }
      P.routine[id] = routine;
      if (!info) {
        P.errors.push(`Z_0${b}:${line}: no official opcode at $${run.toString(16)} (ROM byte $${op.toString(16)})`);
        P.size[id] = 1; P.kind[id] = K_PLAIN;
        run += 1; load += 1; prev = -1;
        continue;
      }
      P.size[id] = info.size; P.cycles[id] = info.cycles;
      const b1 = info.size > 1 ? rom.prgByte(b, load + 1) : 0;
      const b2 = info.size > 2 ? rom.prgByte(b, load + 2) : 0;
      const operand = info.size === 3 ? b1 | (b2 << 8) : b1;
      P.operand[id] = operand;
      const mn = info.mn;
      let kind = K_PLAIN;
      if (BRANCH_MN.has(mn)) kind = K_BRANCH;
      else if (mn === 'JSR') kind = K_JSR;
      else if (mn === 'RTS') kind = K_RTS;
      else if (mn === 'RTI') kind = K_RTI;
      else if (mn === 'JMP') kind = info.mode === 'ind' ? K_JMPIND : K_JMP;
      else if ((info.mode === 'abs' || info.mode === 'abx' || info.mode === 'aby') &&
        ((operand >= 0x2000 && operand < 0x4020) || (operand >= 0x8000 && (mn === 'STA' || mn === 'STX' || mn === 'STY')))) kind = K_IO;
      P.kind[id] = kind;
      if (info.penalty) {
        // abs,X / abs,Y with a page-aligned base can never cross; (zp),Y and other bases depend on data
        P.penalty[id] = info.mode === 'izy' || (operand & 0xff) !== 0 ? 1 : 0;
      }
      if (kind === K_BRANCH) P.operand[id] = (run + 2 + ((b1 << 24) >> 24)) & 0xffff;
      P.byRegion[region][slot(region, run)] = id;
      const terminator = mn === 'JMP' || mn === 'RTS' || mn === 'RTI' || mn === 'BRK';
      prev = terminator ? -1 : id;
      run += info.size; load += info.size;
    }
  }

  // static targets
  const lookup = (run, bank) => {
    const region = regionOf(run, bank);
    const t = P.byRegion[region];
    return t ? t[slot(region, run)] : -1;
  };
  P.lookup = lookup;
  for (let i = 0; i < n; i++) {
    const k = P.kind[i];
    if (k !== K_BRANCH && k !== K_JSR && k !== K_JMP) continue;
    const t = P.operand[i];
    // a branch stays in its own region; a jump/call into $8000-$BFFF from the fixed bank or SRAM
    // depends on the bank mapped at run time
    const dynamic = k !== K_BRANCH && t >= 0x8000 && t < 0xc000 && P.region[i] >= 7;
    if (dynamic) { P.target[i] = -2; continue; }
    const tid = lookup(t, P.bank[i]);
    if (tid < 0) P.errors.push(`Z_0${P.bank[i]}:${P.line[i]}: no instruction at target $${t.toString(16)}`);
    P.target[i] = tid;
  }
  const tj = P.entries.get('TableJump');
  if (tj !== undefined) P.flags[tj] |= F_TABLEJUMP;
  for (const name of OPAQUE_ROUTINES) {
    const e = P.entries.get(name);
    if (e !== undefined) P.flags[e] |= F_SWITCHBANK;
  }
  return P;
}

/** 'Z_0b:line' -> instruction id (undefined if that line holds no instruction). */
export function refId(P, ref) {
  if (!P.refs) {
    P.refs = new Map();
    for (let i = 0; i < P.n; i++) P.refs.set(`Z_0${P.bank[i]}:${P.line[i]}`, i);
  }
  return P.refs.get(ref);
}

/** Human-readable location of an instruction: "Z_07:391 BEQ [IsrNmi $e48a]". */
export function describe(P, id) {
  if (id === undefined || id < 0 || id >= P.n) return `<pos ${id}>`;
  const info = OPCODES[P.op[id]];
  return `Z_0${P.bank[id]}:${P.line[id]} ${info ? info.mn : '???'} [${P.routineNames[P.routine[id]] ?? '?'} $${P.run[id].toString(16)}]`;
}
