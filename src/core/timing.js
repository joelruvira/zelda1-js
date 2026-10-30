// Cycle tracker: exact 6502 cycle accounting for the port (docs/TIMING.md, docs/ARCHITECTURE.md §3).
//
// The tracker keeps a position in the ORIGINAL program (instruction id of src/core/cfg.js) and the
// absolute CPU cycle since power-on. Between two breadcrumbs of the ported JS, the original code has no
// decision the tracker cannot make by itself, so it walks it and adds its cost:
//   * JSR / RTS / JMP are followed automatically (shadow return stack), SwitchBank* is opaque,
//   * bus.read/write of $2000-$401F and mapper stores report I/O accesses   (automatic, core/bus.js)
//   * core/asm.js tableJump() / switchBank() report table jumps / bank changes (automatic)
//   * $br('Z_0b:line', cond)    one per conditional branch of the asm decided by the JS    (manual)
//   * $pxa('Z_0b:line', base, i) / $px(ref, crossed)  indexed read that may cross a page     (manual)
//   * pollStatus(mask, set)     the LDA $2002 / AND / Bxx busy loops                          (manual)
// Every breadcrumb is checked against the asm: an annotation in the wrong place fails with the asm
// location (strict mode throws TimingError; non-strict mode stops tracking until the next NMI and the
// port falls back to the old "zero-time" model for the rest of that NMI).
//
// The frame driver (runFrame / runVideoFrame below) adds what happens between NMIs: the idle loop, the
// NMI latency (jsnes rules: >= 5 dots before the end of the instruction -> next instruction boundary),
// nested NMIs, DMC halts (src/core/apu-timing.js), OAM DMA 513/514 and lag frames (the PPU crosses frame
// boundaries by itself in continuous mode and reports each picture).
import { buildProgram, refId, describe, regionOf, K_PLAIN, K_BRANCH, K_JSR, K_RTS, K_RTI, K_JMP, K_JMPIND, K_IO, F_TABLEJUMP, F_SWITCHBANK } from './cfg.js';
import { JsnesApuTiming, HardwareApuTiming } from './apu-timing.js';
import { OPCODES } from './opcodes.js';

export class TimingError extends Error {
  name = 'TimingError';
}

const K_IDLE = 100; // pseudo-kind returned by the walk: JMP to itself (LoopForever)
const MAX_GUARD = 2_000_000;
/** jsnes power-on alignment: the first instruction (IsrReset) starts at cycle 7 (reset sequence + SEI
 * are one APU call of 9 cycles) and the PPU is at 241/1 at absolute dot 16 (dot = 3 x cycle). */
const RESET_FIRST_CYCLE = 7;
const POWER_ON_FRAME_DOT = 16;

export class Tracker {
  constructor() {
    this.P = null;
    /** 'off' | 'jsnes' (CI oracle) | 'hardware' */
    this.mode = 'off';
    this.strict = false;
    /** breadcrumbs are being checked and counted (inside a tracked NMI / reset) */
    this.on = false;
    this.ppu = null;
    this.mapper = null;
    this.apu = new JsnesApuTiming();
    this.cycle = 0; // absolute CPU cycle: every cycle before it has been executed
    this.pos = -1;
    this.stack = new Int32Array(256);
    this.sp = 0;
    this.intStack = []; // return positions of the interrupted code (nested NMIs)
    this.bank = 0;
    this.bankQ = [];
    this.pxQ = new Map();
    this.pxPending = 0;
    this.nmiEnabled = false;
    this.nmiPend = null; // 'one' = NMI after the next instruction (edge too late in the current one)
    this.synced = false; // the absolute cycle is exact since power-on (no failure since)
    this.failure = null; // first failure of the current NMI {msg, where}
    this.log = null; // optional array: accesses and NMI boundaries (tools/timing/cycle-diff.mjs)
    this.diag = null; // optional {unhinted: Map id->count} (coverage)
    this.onFail = null; // optional callback(failure) (non-strict diagnostics)
    this.seedNmi = null; // optional (n) => start cycle of the n-th NMI (tools: resync with the oracle)
    this.stats = { crumbs: 0, nmis: 0, failures: 0 };
    this.nmiCount = 0;
  }

  get enabled() { return this.mode !== 'off' && this.P !== null; }

  /**
   * Builds the program graph from the ROM (once per ROM) and selects the mode.
   * @param {{rom, files, symbols, mode?: 'jsnes'|'hardware'|'off', strict?: boolean}} o
   */
  init({ rom, files, symbols, mode = 'jsnes', strict = false }) {
    this.P = buildProgram(rom, files, symbols);
    if (this.P.errors.length) throw new TimingError(`cfg: ${this.P.errors[0]} (+${this.P.errors.length - 1} more)`);
    const n = this.P.n;
    this.segEnd = new Int32Array(n).fill(-1);
    this.segCost = new Int32Array(n);
    this.segLast = new Uint8Array(n);
    this.segPx = [];
    this.opaque = new Map();
    this.brCost = new Uint8Array(n); // taken-branch cost: 3, or 4 across a page
    for (let i = 0; i < n; i++) {
      if (this.P.kind[i] === K_BRANCH) this.brCost[i] = ((this.P.run[i] + 2) & 0xff00) !== (this.P.operand[i] & 0xff00) ? 4 : 3;
    }
    // Plain instructions that run into a data byte $60 (RTS): GetObjectMiddle falls into
    // ObjTypeToDamagePoints, whose first byte is the routine's RTS (docs/TIMING.md §10).
    this.rtsAfter = new Set();
    for (let i = 0; i < n; i++) {
      if (this.P.kind[i] === K_PLAIN && this.P.next[i] < 0 && rom.prgByte(this.P.bank[i], this.P.load[i] + this.P.size[i]) === 0x60) this.rtsAfter.add(i);
    }
    this.idIsrNmi = this.P.entries.get('IsrNmi');
    this.idIsrReset = this.P.entries.get('IsrReset');
    this.idLoopForever = this.P.entries.get('LoopForever');
    this.setMode(mode, strict);
    return this;
  }

  setMode(mode, strict = this.strict) {
    this.mode = mode;
    this.strict = strict;
    this.apu = mode === 'hardware' ? new HardwareApuTiming() : new JsnesApuTiming();
  }

  // ------------------------------------------------------------------ failures
  where(id = this.pos) {
    return `${describe(this.P, id)} @cycle ${this.cycle}`;
  }

  fail(msg) {
    if (!this.on) return;
    this.on = false;
    this.synced = false;
    this.stats.failures++;
    this.failure = { msg, where: this.where(), nmi: this.nmiCount };
    this.onFail?.(this.failure);
    if (this.strict) throw new TimingError(`${msg}\n  at ${this.failure.where}`);
  }

  // ------------------------------------------------------------------ static segments
  /** Straight run of plain instructions from id: end (first non-plain id), total and last cost. */
  computeSeg(id) {
    const P = this.P;
    let p = id, cost = 0, last = 0, px = null;
    while (P.kind[p] === K_PLAIN) {
      cost += P.cycles[p];
      last = P.cycles[p];
      if (P.penalty[p]) (px ??= []).push(p);
      const nx = P.next[p];
      if (nx < 0) {
        if (!this.rtsAfter.has(p)) { this.segEnd[id] = -2; return; }
        this.segEnd[id] = -3; // the run ends in an RTS that is a data byte
        this.segCost[id] = cost;
        this.segLast[id] = last;
        if (px) this.segPx[id] = px;
        return;
      }
      p = nx;
    }
    this.segEnd[id] = p;
    this.segCost[id] = cost;
    this.segLast[id] = last;
    if (px) this.segPx[id] = px;
  }

  /** Costs of the instructions of an opaque routine (JSR + body + RTS). */
  opaqueCosts(entry) {
    let c = this.opaque.get(entry);
    if (c) return c;
    const P = this.P;
    const list = [6];
    let p = entry;
    for (let guard = 0; guard < 200; guard++) {
      const k = P.kind[p];
      if (k === K_RTS) { list.push(6); break; }
      if (k !== K_PLAIN && k !== K_IO) throw new TimingError(`opaque routine with decisions: ${describe(P, p)}`);
      list.push(P.cycles[p]);
      p = P.next[p];
    }
    c = { list, total: list.reduce((a, b) => a + b, 0) };
    this.opaque.set(entry, c);
    return c;
  }

  // ------------------------------------------------------------------ clock + APU
  /** One APU call of n cycles that ends at the current cycle (+ the DMC halts it causes). */
  call(n) {
    const f = this.apu.call(n);
    if (f) this.halt(4 * f);
  }

  /** CPU halted `n` cycles (DMC fetches, OAM DMA): jsnes clocks the APU in chunks of up to 8. */
  halt(n) {
    let rem = n;
    while (rem > 0) {
      const chunk = rem < 8 ? rem : 8;
      this.cycle += chunk;
      rem -= chunk;
      rem += 4 * this.apu.call(chunk);
    }
  }

  takePx(id) {
    const q = this.pxQ.get(id);
    if (q && q.length) { this.pxPending--; return q.shift() ? 1 : 0; }
    if (this.diag) this.diag.unhinted.set(id, (this.diag.unhinted.get(id) ?? 0) + 1);
    return 0;
  }

  /** Executes the straight segment starting at p (already computed). */
  runSeg(p) {
    const P = this.P;
    let cost = this.segCost[p];
    if (!cost) return;
    let last = this.segLast[p];
    const pxl = this.segPx[p];
    const precise = this.apu.safeCycles() <= cost + 8;
    if (pxl && (this.pxPending || this.diag) && !precise) {
      const end = this.segEnd[p];
      for (let k = 0; k < pxl.length; k++) {
        const x = this.takePx(pxl[k]);
        cost += x;
        if (x && P.next[pxl[k]] === end) last += 1;
      }
    }
    if (!precise) {
      this.cycle += cost;
      const f = this.apu.bulk(cost, last);
      if (f) this.halt(4 * f);
      return;
    }
    // a DMC fetch may fall inside: one APU call per instruction, as jsnes does
    for (let q = p; P.kind[q] === K_PLAIN; q = P.next[q]) {
      const c = P.cycles[q] + (P.penalty[q] ? this.takePx(q) : 0);
      this.cycle += c;
      this.call(c);
    }
  }

  resolve(id) {
    const P = this.P;
    let t = P.target[id];
    if (t === -2) t = P.lookup(P.operand[id], this.bank);
    return t;
  }

  /**
   * Walks decision-free code from pos; stops at the next instruction that needs a breadcrumb (branch,
   * I/O, JSR TableJump, JMP indirect, RTI) or at the idle loop. Returns its id (pos), -1 on failure.
   */
  advance() {
    const P = this.P;
    let p = this.pos;
    for (let guard = 0; guard < MAX_GUARD; guard++) {
      let e = this.segEnd[p];
      if (e === -1) { this.computeSeg(p); e = this.segEnd[p]; }
      if (e === -2) { this.pos = p; this.fail('the walk fell into data'); return -1; }
      if (e === -3) { // straight run + an RTS that is a data byte (rtsAfter)
        this.runSeg(p);
        if (this.sp === 0) { this.pos = p; this.fail('RTS with an empty shadow stack'); return -1; }
        this.cycle += 6; this.call(6);
        p = this.stack[--this.sp];
        continue;
      }
      if (e !== p) { this.runSeg(p); p = e; }
      switch (P.kind[p]) {
        case K_JMP: {
          const t = this.resolve(p);
          if (t === p) { this.pos = p; return p; } // LoopForever
          if (t < 0) { this.pos = p; this.fail(`JMP to $${P.operand[p].toString(16)}: no instruction in bank ${this.bank}`); return -1; }
          if (P.flags[t] & F_SWITCHBANK) { // tail call: JMP SwitchBank*
            if (!this.bankQ.length || this.sp === 0) { this.pos = p; this.fail('JMP SwitchBank but the JS did not call switchBank()'); return -1; }
            this.bank = this.bankQ.shift();
            const oc = this.opaqueCosts(t);
            this.cycle += 3; this.call(3);
            for (let k = 1; k < oc.list.length; k++) { this.cycle += oc.list[k]; this.call(oc.list[k]); }
            p = this.stack[--this.sp];
            continue;
          }
          this.cycle += 3; this.call(3);
          p = t;
          continue;
        }
        case K_JSR: {
          const t = this.resolve(p);
          if (t < 0) { this.pos = p; this.fail(`JSR to $${P.operand[p].toString(16)}: no instruction in bank ${this.bank}`); return -1; }
          const f = P.flags[t];
          if (f & F_TABLEJUMP) { this.pos = p; return p; }
          if (f & F_SWITCHBANK) {
            if (!this.bankQ.length) { this.pos = p; this.fail('JSR SwitchBank but the JS did not call switchBank()'); return -1; }
            this.bank = this.bankQ.shift();
            const oc = this.opaqueCosts(t);
            if (this.apu.safeCycles() > oc.total + 8) {
              this.cycle += oc.total;
              const fx = this.apu.bulk(oc.total, 6);
              if (fx) this.halt(4 * fx);
            } else for (const c of oc.list) { this.cycle += c; this.call(c); }
            p = P.next[p];
            continue;
          }
          if (this.sp >= this.stack.length) { this.pos = p; this.fail('shadow stack overflow'); return -1; }
          this.stack[this.sp++] = P.next[p];
          this.cycle += 6; this.call(6);
          p = t;
          continue;
        }
        case K_RTS:
          if (this.sp === 0) { this.pos = p; this.fail('RTS with an empty shadow stack'); return -1; }
          this.cycle += 6; this.call(6);
          p = this.stack[--this.sp];
          continue;
        default:
          this.pos = p;
          return p;
      }
    }
    this.pos = p;
    this.fail('advance: no decision point found');
    return -1;
  }

  // ------------------------------------------------------------------ breadcrumbs
  /** Conditional branch at asm line `ref` decided by the JS. Returns `taken`. */
  br(ref, taken) {
    this.stats.crumbs++;
    const p = this.advance();
    if (p < 0) return taken;
    const P = this.P;
    if (P.kind[p] !== K_BRANCH || refId(P, ref) !== p) {
      this.fail(`$br('${ref}') but the asm is at ${describe(P, p)}${refId(P, ref) === undefined ? ` (no instruction at ${ref})` : ''}`);
      return taken;
    }
    this.brAt(p, taken);
    return taken;
  }

  /** Executes the branch at p (the walk is there). */
  brAt(p, taken) {
    let c = 2;
    if (taken) {
      c = this.brCost[p];
      this.pos = this.P.target[p];
    } else this.pos = this.P.next[p];
    this.cycle += c;
    this.call(c);
  }

  /** Page-cross hint for the next execution of the indexed read at `ref`. */
  px(ref, crossed) {
    const id = refId(this.P, ref);
    if (id === undefined || !OPCODES[this.P.op[id]]?.penalty) {
      this.fail(`$px('${ref}'): not an indexed read that can cross a page`);
      return;
    }
    if (!this.P.penalty[id]) { // page-aligned base: can never cross
      if (crossed) this.fail(`$px('${ref}'): crossing claimed for a page-aligned table`);
      return;
    }
    let q = this.pxQ.get(id);
    if (!q) this.pxQ.set(id, q = []);
    q.push(!!crossed);
    this.pxPending++;
  }

  /**
   * I/O access by the JS (bus.read/write). Moves the PPU to the access (last cycle of the instruction),
   * clocks the APU and the OAM DMA. Returns the absolute cycle of the access, or -1 (not tracked).
   */
  io(addr, isWrite, value) {
    this.stats.crumbs++;
    const p = this.advance();
    if (p < 0) return -1;
    const P = this.P;
    const reg = addr >= 0x2000 && addr < 0x4000 ? 0x2000 | (addr & 7) : addr;
    const op = P.operand[p];
    const ireg = op >= 0x2000 && op < 0x4000 ? 0x2000 | (op & 7) : op;
    const info = OPCODES[P.op[p]];
    const indexed = info.mode === 'abx' || info.mode === 'aby';
    const match = P.kind[p] === K_IO && (ireg === reg || (op >= 0x8000 && addr >= 0x8000) ||
      (indexed && addr >= op && addr <= op + 0xff));
    const storeOp = info.mn === 'STA' || info.mn === 'STX' || info.mn === 'STY';
    if (!match || storeOp !== isWrite) {
      this.fail(`${isWrite ? 'write' : 'read'} $${addr.toString(16)} but the asm is at ${describe(P, p)}`);
      return -1;
    }
    const c = P.cycles[p] + (P.penalty[p] ? this.takePx(p) : 0);
    const acc = this.cycle + c - 1;
    if (this.log) this.log.push({ k: isWrite ? 'w' : 'r', a: reg, c: acc, id: p, v: value });
    if (reg < 0x4000 || reg === 0x4014 || reg >= 0x8000) this.ppu.syncTo(3 * acc);
    if (isWrite) {
      if (reg >= 0x4000 && reg < 0x4018) this.apu.write(reg, value);
      if (reg === 0x2000) this.noteCtrl(value, acc);
    }
    this.pos = P.next[p];
    this.cycle += c;
    const f = this.apu.call(c);
    if (isWrite && reg === 0x4014) {
      // OAM DMA: 513 cycles, 514 when the write cycle is even (jsnes; on hardware the get/put parity)
      this.halt((acc % 2 === 0 ? 514 : 513) + 4 * f);
    } else if (f) this.halt(4 * f);
    return acc;
  }

  /** $2000 write: NMI enable bookkeeping (also called by the bus when not tracking). */
  noteCtrl(value, acc) {
    const en = (value & 0x80) !== 0;
    if (en && !this.nmiEnabled && this.ppu) {
      // rising enable: edge now if the vblank flag is set (1-delay: NMI after the next instruction)
      if (this.ppu.status & 0x80) this.nmiPend = 'one';
      else {
        const v = this.ppu.nextFrameDot();
        if (acc >= 0 && v > 3 * acc && v <= 3 * (acc + 1)) this.nmiPend = 'one';
      }
    }
    if (!en) this.nmiPend = null;
    this.nmiEnabled = en;
  }

  /** Bus write while not tracking (tracker enabled, failed NMI): keep the APU/NMI state. */
  noteWrite(addr, value) {
    if (addr >= 0x4000 && addr < 0x4018) this.apu.write(addr, value);
    else if ((addr & 0xe007) === 0x2000) this.noteCtrl(value, -1);
  }

  /** core/asm.js tableJump: JSR TableJump, its body (two LDA ($00),Y) and JMP ($0002) to `target`. */
  tableJump(tableAddr, index, target) {
    this.stats.crumbs++;
    let p = this.advance();
    if (p < 0) return;
    const P = this.P;
    if (P.kind[p] !== K_JSR || !(P.flags[this.resolve(p)] & F_TABLEJUMP)) {
      this.fail(`tableJump but the asm is at ${describe(P, p)}`);
      return;
    }
    const entry = this.resolve(p);
    this.cycle += 6; this.call(6); // JSR (the return address is popped by TableJump's PLA/PLA)
    // page-cross hints of the two LDA ($00),Y: pointer = table - 1, Y = index*2 + 1, + 2
    const ptr = (tableAddr - 1) & 0xffff;
    const y1 = ((index << 1) + 1) & 0xff;
    let lda = 0;
    for (let q = entry; P.kind[q] === K_PLAIN; q = P.next[q]) {
      if (P.penalty[q]) {
        const y = (y1 + lda++) & 0xff;
        let qq = this.pxQ.get(q);
        if (!qq) this.pxQ.set(q, qq = []);
        qq.push(((ptr & 0xff) + y) > 0xff);
        this.pxPending++;
      }
    }
    this.pos = entry;
    p = this.advance();
    if (p < 0) return;
    if (P.kind[p] !== K_JMPIND) { this.fail(`tableJump: expected JMP ($0002), the asm is at ${describe(P, p)}`); return; }
    this.cycle += 5; this.call(5);
    const t = P.lookup(target, this.bank);
    if (t < 0) { this.fail(`tableJump: no instruction at $${target.toString(16)} (bank ${this.bank})`); return; }
    this.pos = t;
  }

  /** core/asm.js switchBank: the bank becomes current when the walk passes the JSR SwitchBank. */
  switchBank(bank) {
    this.bankQ.push(bank & 7);
  }

  /**
   * Busy loop `LDA $2002 / AND #mask / BEQ|BNE back` (IsrReset's vblank waits, IsrNmi @WaitVBlankEnd,
   * WaitAndScrollToSplitBottom). Every read happens at its exact cycle. Returns the last value read.
   */
  pollStatus(mask) {
    const P = this.P;
    for (let guard = 0; guard < 20000; guard++) {
      if (this.io(0x2002, false, 0) < 0) return -1;
      const v = this.ppu.readStatus();
      const p = this.advance();
      if (p < 0) return v;
      if (P.kind[p] !== K_BRANCH) { this.fail(`pollStatus: expected the loop branch, the asm is at ${describe(P, p)}`); return v; }
      const mn = OPCODES[P.op[p]].mn;
      const set = (v & mask) !== 0;
      if (mn !== 'BEQ' && mn !== 'BNE') { this.fail(`pollStatus: ${mn}`); return v; }
      const taken = mn === 'BNE' ? set : !set;
      this.stats.crumbs++;
      this.brAt(p, taken);
      if (!taken) return v;
    }
    this.fail('pollStatus: the loop never ends');
    return -1;
  }

  // ------------------------------------------------------------------ CPU between breadcrumbs: NMIs
  /** Starts tracking an NMI whose 7-cycle sequence ended at the current cycle. */
  beginNmi(resume) {
    this.nmiCount++;
    this.stats.nmis++;
    this.intStack.push(resume);
    this.pos = this.idIsrNmi;
    this.sp = 0;
    this.bankQ.length = 0;
    this.pxQ.clear();
    this.pxPending = 0;
    this.failure = null;
    this.bank = this.mapper ? this.mapper.prgBank & 7 : this.bank;
    this.nmiEnabled = false; // IsrNmi disables it first (and the hardware line is low until re-enabled)
    this.nmiPend = null;
    this.on = true;
  }

  /**
   * After the JS of an NMI (or of the reset) returned: runs the asm to its end and on, until the next
   * NMI is taken or an RTI completes. Breadcrumb-free code only (the tail of IsrNmi, the idle loop).
   * Returns {rti: cycle after an RTI | null, nmi: cycle of the first instruction of the next NMI | null,
   * nmiStart: first cycle of its 7-cycle sequence}.
   */
  runUntil({ stopAtRti = true } = {}) {
    const P = this.P;
    const ppu = this.ppu;
    if (this.pos < 0) return { rti: null, nmi: null };
    ppu.syncTo(3 * this.cycle);
    let rti = null;
    for (let guard = 0; guard < MAX_GUARD; guard++) {
      let p = this.pos;
      const s = this.cycle;
      // idle loop with nothing pending: skip whole JMPs up to the one where the vblank edge lands
      if (P.kind[p] === K_JMP && P.target[p] === p && this.intStack.length && rti === null) this.intStack.length = 0; // JMP IsrReset from an NMI
      if (P.kind[p] === K_JMP && P.target[p] === p && this.nmiPend === null) {
        const v = this.vblankAfter(3 * s);
        const k = Math.ceil((v - 3 * s) / 9) - 1; // JMPs that end before the edge
        if (k > 1 && this.apu.safeCycles() > 3 * k + 16) {
          this.cycle += 3 * k;
          const f = this.apu.bulk(3 * k, 3);
          if (f) this.halt(4 * f);
          continue;
        }
      }
      // execute one instruction
      let c, next;
      const kind = P.kind[p];
      if (kind === K_PLAIN) { c = P.cycles[p] + (P.penalty[p] ? this.takePx(p) : 0); next = P.next[p]; }
      else if (kind === K_JMP) { c = 3; next = this.resolve(p); }
      else if (kind === K_RTS) {
        if (this.sp === 0) return this.lost('RTS with an empty shadow stack');
        c = 6; next = this.stack[--this.sp];
      } else if (kind === K_JSR && !(P.flags[this.resolve(p)] & (F_TABLEJUMP | F_SWITCHBANK))) {
        c = 6; this.stack[this.sp++] = P.next[p]; next = this.resolve(p);
      } else if (kind === K_RTI) {
        c = 6;
        next = this.intStack.length ? this.intStack.pop() : this.idLoopForever;
        this.sp = 0;
      } else return this.lost(`code with a decision after the JS ended: ${describe(P, p)}`);
      const e = s + c;
      this.pos = next;
      if (this.nmiPend === 'one') {
        // 1-delay NMI: taken at the end of this instruction; jsnes clocks both in one APU call
        this.cycle = e + 7;
        this.nmiPend = null;
        if (kind === K_RTI) { rti = e; this.log?.push({ k: 'rti', c: e }); }
        this.call(c + 7);
        return { rti, nmi: this.cycle, nmiStart: e };
      }
      this.cycle = e;
      const f = this.apu.call(c);
      // vblank edge inside this instruction?
      let pend = null;
      if (this.nmiEnabled) {
        const v = this.vblankAfter(3 * s);
        if (v <= 3 * e) pend = 3 * e - v >= 5 ? 'zero' : 'one';
        if (f) {
          const h0 = this.cycle;
          this.halt(4 * f);
          if (!pend && v > 3 * h0 && v <= 3 * this.cycle) pend = 'one';
        }
      } else if (f) this.halt(4 * f);
      if (kind === K_RTI) {
        rti = e;
        this.log?.push({ k: 'rti', c: e });
      }
      if (pend === 'zero') {
        const start = this.cycle;
        this.cycle += 7;
        this.call(7);
        return { rti, nmi: this.cycle, nmiStart: start };
      }
      this.nmiPend = pend;
      if (rti !== null && stopAtRti) return { rti, nmi: null };
    }
    return this.lost('runUntil: no NMI');
  }

  /** Absolute dot of the first vblank (frame start, 241/1) after dot d. */
  vblankAfter(d) {
    const ppu = this.ppu;
    if (ppu.frameStart > d) return ppu.frameStart; // the PPU is ahead (picture already rendered)
    let v = ppu.nextFrameDot();
    if (v <= d) {
      ppu.syncTo(d);
      v = ppu.frameStart > d ? ppu.frameStart : ppu.nextFrameDot();
    }
    return v;
  }

  lost(msg) {
    this.on = true; // report through fail() even outside an NMI
    this.fail(msg);
    this.on = false;
    return { rti: null, nmi: null, lost: true };
  }

  /** Power-on: PPU at 241/1 (vblank flag clear) at dot 16, IsrReset at cycle 7 (jsnes alignment). */
  beginReset() {
    this.apu.reset();
    this.cycle = RESET_FIRST_CYCLE;
    this.ppu.powerOn(POWER_ON_FRAME_DOT);
    this.pos = this.idIsrReset;
    this.sp = 0;
    this.intStack.length = 0;
    this.bankQ.length = 0;
    this.pxQ.clear();
    this.pxPending = 0;
    this.nmiEnabled = false;
    this.nmiPend = null;
    this.failure = null;
    this.bank = 0;
    this.synced = true;
    this.on = true;
    // jsnes clocks the reset sequence with the first instruction (one APU call of 9 cycles); no
    // sample boundary falls before cycle 38, so a separate call is equivalent
    this.apu.call(RESET_FIRST_CYCLE);
  }
}

// ------------------------------------------------------------------ frame driver
Object.assign(Tracker.prototype, {
  /** Connects the tracker to a machine (core/machine.js) for the selected mode. */
  attach(machine) {
    this.ppu = machine.ppu;
    this.mapper = machine.mapper;
    this.ppu.jsnesCompat = this.mode === 'jsnes';
    this.pending = null;
    this.frames = 0;
    this.idRti = -1;
    for (let i = 0; i < this.P.n; i++) if (this.P.kind[i] === K_RTI) { this.idRti = i; break; }
  },

  /** Power-on + reset(): runs the JS of IsrReset/RunGame with the tracker from cycle 7. */
  runReset(resetFn) {
    this.beginReset();
    try {
      resetFn();
    } finally {
      if (!this.on) this.recover(this.idLoopForever);
      this.on = false;
    }
  },

  /** Position lost (failed breadcrumb): continue from `id` at the last known time (approximate). */
  recover(id) {
    this.synced = false;
    this.pos = id;
    this.sp = 0;
    const ppuCycle = Math.ceil(this.ppu.absDot / 3);
    if (ppuCycle > this.cycle) this.cycle = ppuCycle;
    this.bankQ.length = 0;
  },

  /**
   * One logical frame (docs/ORACLE.md): runs the CPU until the next RTI, executing the NMIs that start
   * meanwhile (`nmiFn` = the ported IsrNmi), then renders up to the picture shown after that RTI.
   */
  stepFrame(nmiFn) {
    for (let guard = 0; guard < 64; guard++) {
      const inNmi = this.intStack.length > 0;
      const r = this.pending ?? this.runUntil();
      this.pending = null;
      if (r.lost) {
        // the asm needs a decision the JS did not give: inside an NMI, finish it at its RTI (one RTI per
        // logical frame, like the oracle); in the idle loop, take the next vblank
        if (inNmi) this.recover(this.idRti);
        else { this.nmiEnabled = true; this.recover(this.idLoopForever); }
        continue;
      }
      if (r.rti !== null) {
        if (r.nmi !== null) this.pending = { rti: null, nmi: r.nmi, nmiStart: r.nmiStart };
        this.finishPicture(r.rti, r.nmi !== null ? r.nmiStart : null);
        this.frames++;
        return;
      }
      // an NMI starts (tools may impose its start: cycle-diff --resync seeds it from the oracle)
      if (this.seedNmi) {
        const s = this.seedNmi(this.nmiCount + 1);
        // keep the entry's own length (7 cycles + a DMC halt that may fall inside the sequence)
        if (s !== null && s !== undefined) { r.nmi = s + (r.nmi - r.nmiStart); r.nmiStart = s; this.cycle = r.nmi; }
      }
      this.log?.push({ k: 'begin', c: r.nmi, start: r.nmiStart, n: this.nmiCount + 1 });
      this.beginNmi(this.pos);
      let ok = false;
      try {
        nmiFn(this.nmiCount);
        ok = true;
      } finally {
        if (ok && !this.on) this.recover(this.idRti);
        else if (ok) this.on = false;
        else this.on = false;
      }
    }
    throw new TimingError('stepFrame: no RTI after 64 NMIs');
  },

  /**
   * Renders up to the first frame start after the RTI that began at cycle rtiEnd - 6. With an NMI
   * starting right after the RTI (`nmiStart`: lag NMI, the vblank came during it), only up to that
   * NMI: its vblank completed the picture, and the next NMI writes the PPU before the next frame start.
   */
  finishPicture(rtiEnd, nmiStart = null) {
    const ppu = this.ppu;
    const d = 3 * (rtiEnd - 6);
    if (ppu.frameStart > d) return; // the PPU is already past the RTI's frame start
    if (nmiStart !== null) { ppu.syncTo(3 * nmiStart); return; }
    ppu.syncTo(d);
    ppu.syncTo(ppu.nextFrameDot());
  },
});

/** The tracker (one per page / process, like the rest of the core). */
export const timing = new Tracker();

/**
 * Turns the tracker on (or off) for a ROM: loads the generated tables and builds the program graph.
 * @param {{rom: import('./rom.js').Rom, mode?: 'jsnes'|'hardware'|'off', strict?: boolean}} o
 */
export async function setupTiming({ rom, mode = 'jsnes', strict = false }) {
  if (mode === 'off' || !rom) { timing.mode = 'off'; timing.on = false; return timing; }
  const [{ CFG_FILES }, { SYMBOLS }] = await Promise.all([import('./cfg.gen.js'), import('./symbols.js')]);
  if (timing.P && timing.romRef === rom) timing.setMode(mode, strict);
  else {
    try {
      timing.init({ rom, files: CFG_FILES, symbols: SYMBOLS, mode, strict });
      timing.romRef = rom;
    } catch (e) {
      // not the ROM the disassembly describes (other revision, synthetic test ROM): no tracker
      timing.P = null; timing.romRef = null; timing.mode = 'off'; timing.on = false;
      if (strict) throw e;
      return timing;
    }
  }
  timing.on = false;
  timing.log = null;
  timing.stats = { crumbs: 0, nmis: 0, failures: 0 };
  timing.nmiCount = 0;
  return timing;
}

// ------------------------------------------------------------------ annotation API (game code)
/** Conditional branch of the asm at `ref` ('Z_0b:line'): returns `taken` (wrap the JS condition). */
export const $br = (ref, taken) => (timing.on ? timing.br(ref, taken) : taken);
/** Indexed read at `ref` will cross a page (+1 cycle) on its next execution. */
export const $px = (ref, crossed) => { if (timing.on) timing.px(ref, crossed); };
/** Same, from the base address and the index register (`LDA Table, Y` -> base = table address). */
export const $pxa = (ref, base, index) => { if (timing.on) timing.px(ref, ((base & 0xff) + (index & 0xff)) > 0xff); };

/**
 * `LDA $2002 / AND #mask / BEQ|BNE back`: polls PPUSTATUS at the exact cycles of the original until the
 * loop exits; returns the last value read. Without the tracker: the old catch-up wait.
 */
export function pollStatus(ppu, mask, untilSet) {
  if (timing.on) {
    const v = timing.pollStatus(mask);
    if (v >= 0) return v;
  }
  // catch-up model: the sprite-0 waits move the PPU clock; the vblank waits of IsrReset only read
  if (mask === 0x40) ppu.waitStatus(mask, untilSet);
  return ppu.readStatus();
}

void regionOf; void K_IDLE;
