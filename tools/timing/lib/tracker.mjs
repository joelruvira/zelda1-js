// Cycle tracker: exact 6502 cycle accounting for the port, driven by sparse "breadcrumbs" from the
// ported JS and by the asm control-flow graph (lib/cfg.mjs).
//
// The tracker keeps a position in the original program (instruction index) and a cycle counter.
// Between two breadcrumbs the original code is decision-free (no conditional branch, call or I/O),
// so the tracker walks it and adds its static cost. Breadcrumbs:
//   enter(routine, bank) / leave(token)   automatic: every ported function starts with "// Name (Z_0n)"
//   io(addr)                              automatic: bus read/write of $2000-$401F (and MMC1 writes)
//   tableJump(table, index, target)       automatic: core/asm.js tableJump
//   br(ref, taken)                        manual: one per asm conditional branch the JS decides
//   px(ref, crossed)                      manual: indexed reads that can cross a page (+1 cycle)
// Every breadcrumb is checked against the asm (strict mode): a JS annotation in the wrong place
// throws with the asm location, so the annotations are verified, not trusted.
import { instrAt } from './cfg.mjs';

const BRANCHES = new Set(['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS']);
const OPAQUE = new Set(['SwitchBank']); // implemented in src/core without the "// Name (Z_0n)" convention

export class TimingError extends Error {}

export class Tracker {
  /** @param {{instrs: object[], byKey: Map, routines: Map}} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.I = cfg.instrs;
    this.on = false;
    this.strict = true;
    this.log = null; // optional array of {kind, addr, cycle, routine}
    this.refs = new Map(); // "Z_07:391" -> instr index
    for (const i of this.I) this.refs.set(`${i.file}:${i.line}`, i.idx);
    this.entries = new Map(); // "Name/bank" -> idx  (bank = file bank of the comment)
    for (const i of this.I) for (const l of i.labels) if (!l.includes('@')) this.entries.set(`${l}/${i.bank}`, i.idx);
    // classify instructions
    for (const i of this.I) {
      i.kind = 'plain';
      if (BRANCHES.has(i.mn)) i.kind = 'branch';
      else if (i.mn === 'JSR') {
        const callee = this.routineAt(i.target, i.bank);
        i.kind = OPAQUE.has(callee) ? 'opaque' : i.mn === 'JSR' && callee === 'TableJump' ? 'tablejump' : 'call';
      } else if (i.mn === 'RTS') i.kind = 'rts';
      else if (i.mn === 'RTI') i.kind = 'rti';
      else if (i.mn === 'JMP') i.kind = i.mode === 'ind' ? 'jmpind' : 'jmp';
      else if ((i.mode === 'abs' || i.mode === 'abx' || i.mode === 'aby') &&
        ((i.operand >= 0x2000 && i.operand < 0x4020) || (i.operand >= 0x8000 && /^ST/.test(i.mn)))) i.kind = 'io';
    }
    this.opaqueCost = new Map();
    this.segCache = new Map();
    this.cacheable = false;
    this.pendingPx = new Map();
    this.reset();
  }

  routineAt(run, bank) {
    const idx = instrAt(this.cfg, run, bank);
    return idx === undefined ? null : this.I[idx].routine;
  }

  reset() {
    this.pos = -1;
    this.cycles = 0; // CPU cycles since the start of the NMI sequence (index of the next cycle)
    this.frames = [];
    this.bank = 0;
    this.pendingBank = null;
    this.absStart = 0; // absolute CPU cycle of the NMI start (jsnes numbering) for DMA parity
    this.dot0 = 0; // PPU frameDot of the NMI start
    this.unhintedPx = new Map();
    this.failed = false;
    this.stats = { events: 0, walked: 0 };
  }

  /** Starts tracking an NMI: called right before IsrNmi runs. */
  beginNmi({ absStart, dot0, bank }) {
    this.reset();
    this.on = true;
    this.absStart = absStart;
    this.dot0 = dot0;
    this.bank = bank;
    this.cycles = 7; // the NMI sequence itself
    this.pos = this.entries.get('IsrNmi/7');
  }

  /** Ends the NMI: walks to the RTI (6 cycles) so `cycles` is the NMI's total length. */
  endNmi() {
    if (this.on && !this.failed && this.pos >= 0) {
      try {
        const at = this.advance();
        if (this.I[at].kind === 'rti') { this.cycles += 6; this.pos = -1; }
      } catch { /* report-only */ }
    }
    this.on = false;
  }

  where(idx = this.pos) {
    const i = this.I[idx];
    return i ? `${i.file}:${i.line} ${i.mn} ${i.operandText} [${i.routine} $${i.run.toString(16)}] @cycle ${this.cycles}` : `pos ${idx}`;
  }

  fail(msg) {
    if (this.failed) return;
    this.failed = true;
    if (this.strict) throw new TimingError(`${msg}\n  at ${this.where()}`);
  }

  idxOf(run) {
    const idx = instrAt(this.cfg, run, this.bank);
    if (idx === undefined) this.fail(`no instruction at $${run.toString(16)} (bank ${this.bank})`);
    return idx;
  }

  /** Cost of an opaque routine (decision-free until RTS), JSR and RTS included. */
  opaque(entry) {
    let c = this.opaqueCost.get(entry);
    if (c !== undefined) return c;
    c = 6;
    let p = entry;
    for (let guard = 0; guard < 1000; guard++) {
      const i = this.I[p];
      c += i.cycles;
      if (i.kind === 'rts') break;
      if (i.kind === 'branch' || i.kind === 'call' || i.kind === 'jmpind') throw new TimingError(`opaque routine has decisions: ${this.where(p)}`);
      p = i.next;
    }
    this.opaqueCost.set(entry, c);
    return c;
  }

  /** Walk decision-free code; stop at a decision instruction or when stopAt(pos) is true. */
  advance(stopAt = null) {
    // fast path: memoised decision-free segments (no page-cross candidates, no bank switch)
    if (!stopAt) {
      const key = this.pos * 8 + (this.bank & 7);
      const seg = this.segCache.get(key);
      if (seg) { this.cycles += seg.cost; this.stats.walked += seg.n; this.pos = seg.end; return seg.end; }
      const start = this.pos, c0 = this.cycles, w0 = this.stats.walked;
      this.cacheable = true;
      const end = this.advanceSlow(null);
      if (this.cacheable && !this.failed) this.segCache.set(key, { end, cost: this.cycles - c0, n: this.stats.walked - w0 });
      void start;
      return end;
    }
    return this.advanceSlow(stopAt);
  }

  advanceSlow(stopAt) {
    for (let guard = 0; guard < 100000; guard++) {
      if (stopAt && stopAt(this.pos)) return this.pos;
      const i = this.I[this.pos];
      if (!i) { this.fail('ran off the program'); return this.pos; }
      switch (i.kind) {
        case 'plain':
          this.cycles += i.cycles;
          if (i.penalty) { this.cycles += this.takePx(i); this.cacheable = false; }
          if (i.next === null) { this.fail('fell into data'); return this.pos; }
          this.pos = i.next;
          this.stats.walked++;
          break;
        case 'jmp':
          this.cycles += 3;
          this.pos = this.idxOf(i.target);
          break;
        case 'opaque': {
          this.cacheable = false;
          if (this.pendingBank !== null && this.routineAt(i.target, this.bank) === 'SwitchBank') {
            this.bank = this.pendingBank;
            this.pendingBank = null;
          }
          this.cycles += this.opaque(instrAt(this.cfg, i.target, 7) ?? this.idxOf(i.target));
          this.pos = i.next;
          break;
        }
        default:
          return this.pos;
      }
    }
    this.fail('advance: no decision point found (infinite decision-free loop?)');
    return this.pos;
  }

  takePx(i) {
    const q = this.pendingPx.get(i.idx);
    if (q && q.length) return q.shift() ? 1 : 0;
    this.unhintedPx.set(i.idx, (this.unhintedPx.get(i.idx) ?? 0) + 1);
    return 0;
  }

  // ------------------------------------------------------------------ breadcrumbs
  enter(name, bank) {
    if (!this.on) return 0;
    this.stats.events++;
    const entry = this.entries.get(`${name}/${bank}`) ?? this.entries.get(`${name}/7`);
    if (entry === undefined) { this.fail(`enter: unknown routine ${name} (Z_0${bank})`); return 0; }
    if (this.pos === entry) return 0;
    const at = this.advance((p) => p === entry);
    if (at === entry) return 0; // fallthrough or JMP into it
    const i = this.I[at];
    if (i.kind === 'call' && this.idxOf(i.target) === entry) {
      this.cycles += 6;
      this.frames.push(i.next);
      this.pos = entry;
      return 1;
    }
    this.fail(`enter(${name}): the asm is at a ${i.kind}, not at a call/jump to ${name}`);
    return 0;
  }

  leave(token) {
    if (!this.on || token !== 1 || this.failed) return;
    this.stats.events++;
    const at = this.advance();
    const i = this.I[at];
    if (i.kind !== 'rts') { this.fail(`leave: expected RTS, the asm is at a ${i.kind} (missing br()?)`); return; }
    this.cycles += 6;
    this.pos = this.frames.pop();
  }

  /** Conditional branch decided by the JS. Returns `taken` so it can wrap the condition. */
  br(ref, taken) {
    if (!this.on) return taken;
    this.stats.events++;
    const at = this.advance();
    const i = this.I[at];
    const want = this.refs.get(ref);
    if (at !== want) { this.fail(`br(${ref}): the asm is at ${this.where(at)}`); return taken; }
    this.cycles += 2;
    if (taken) {
      const t = this.idxOf(i.target);
      this.cycles += ((i.run + 2) & 0xff00) !== (i.target & 0xff00) ? 2 : 1;
      this.pos = t;
    } else this.pos = i.next;
    return taken;
  }

  /** Page-crossing hint for the next execution of the indexed read at `ref`. */
  px(ref, crossed) {
    if (!this.on) return;
    const idx = this.refs.get(ref);
    if (!this.pendingPx.has(idx)) this.pendingPx.set(idx, []);
    this.pendingPx.get(idx).push(!!crossed);
  }

  /** Indexed read hint from base address + index (abs,X / abs,Y / (zp),Y with the pointer). */
  pxAddr(ref, base, index) {
    this.px(ref, ((base & 0xff) + (index & 0xff)) > 0xff);
  }

  /**
   * I/O access by the JS. Returns the PPU frameDot at which it happens (last cycle of the
   * instruction), or null when not tracking.
   */
  io(addr, isWrite) {
    if (!this.on) return null;
    this.stats.events++;
    const at = this.advance();
    const i = this.I[at];
    const reg = addr >= 0x2000 && addr < 0x4000 ? 0x2000 | (addr & 7) : addr;
    const ireg = i.operand >= 0x2000 && i.operand < 0x4000 ? 0x2000 | (i.operand & 7) : i.operand;
    const indexed = i.mode === 'abx' || i.mode === 'aby';
    const match = ireg === reg || (i.operand >= 0x8000 && addr >= 0x8000) ||
      (indexed && addr >= i.operand && addr <= i.operand + 0xff);
    if (i.kind !== 'io' || !match) {
      this.fail(`io(${isWrite ? 'write' : 'read'} $${addr.toString(16)}): the asm is at a ${i.kind}`);
      return null;
    }
    let accessCycle = this.cycles + i.cycles - 1;
    if (i.penalty) accessCycle += this.takePx(i);
    const dot = this.dot0 + 3 * accessCycle;
    this.log?.push({ kind: isWrite ? 'w' : 'r', addr: reg, cycle: accessCycle, routine: i.routine, line: `${i.file}:${i.line}` });
    this.cycles = accessCycle + 1;
    this.pos = i.next;
    if (isWrite && reg === 0x4014) {
      // OAM DMA halts the CPU after the write: 513 cycles, 514 when the write cycle is even
      // (jsnes: absolute index of the write cycle; on hardware the parity of the "get/put" cycle).
      this.cycles += (this.absStart + accessCycle) % 2 === 0 ? 514 : 513;
    }
    return dot;
  }

  /** core/asm.js tableJump: JSR TableJump + its body + JMP ($0002). */
  tableJump(tableAddr, index, target) {
    if (!this.on) return;
    this.stats.events++;
    const at = this.advance();
    const i = this.I[at];
    if (i.kind !== 'tablejump') { this.fail(`tableJump: the asm is at a ${i.kind}`); return; }
    // JSR (6) + ASL TAY PLA STA PLA STA INY (2+2+4+3+4+3+2) + LDA (zp),Y (5+px) + STA (3) + INY (2)
    // + LDA (zp),Y (5+px) + STA (3) + JMP (ind) (5)
    const ptr = (tableAddr - 1) & 0xffff;
    const y1 = ((index << 1) + 1) & 0xff;
    const px = (y) => (((ptr & 0xff) + y) > 0xff ? 1 : 0);
    this.cycles += 6 + 20 + 5 + px(y1) + 3 + 2 + 5 + px((y1 + 1) & 0xff) + 3 + 5;
    this.pos = this.idxOf(target);
  }

  /** core/asm.js switchBank: the bank becomes visible when the walk passes JSR SwitchBank. */
  switchBank(bank) {
    if (!this.on) return;
    this.pendingBank = bank & 7;
  }

  /**
   * Busy-wait on $2002 (IsrNmi @WaitVBlankEnd, WaitAndScrollToSplitBottom): LDA $2002 / AND # /
   * branch back. readStatus(dot) returns the status at that dot. Returns the dot of the last read.
   */
  pollStatus(mask, readStatus) {
    for (let guard = 0; guard < 20000; guard++) {
      const dot = this.io(0x2002, false);
      const v = readStatus(dot);
      const at = this.advance();
      const i = this.I[at];
      if (i.kind !== 'branch') { this.fail('pollStatus: expected the loop branch'); return dot; }
      const set = (v & mask) !== 0;
      const taken = i.mn === 'BNE' ? set : i.mn === 'BEQ' ? !set : this.fail(`pollStatus: ${i.mn}`);
      this.br(`${i.file}:${i.line}`, taken);
      if (!taken || this.idxOf(i.target) > at) return dot;
    }
    this.fail('pollStatus: never left the loop');
    return null;
  }
}
