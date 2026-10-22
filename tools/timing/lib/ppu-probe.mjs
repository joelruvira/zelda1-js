// Instruments a tools/oracle Oracle (jsnes 2.1.0) to log, per NMI, every CPU write to the PPU
// registers ($2000-$3FFF mirrors) and OAM DMA ($4014) with its exact CPU cycle and raster position,
// plus NMI start/end, DMA/DMC halts and IRQs. Read-only with respect to emulation: it only wraps
// methods and observes, so RAM/timing are those of the plain oracle.
//
// jsnes timing facts this relies on (tools/oracle/node_modules/jsnes/src):
//  * cpu.write() for $2000-$3FFF calls mmap.write() BEFORE ppu.advanceDots(3) of that bus cycle, so
//    (ppu.scanline, ppu.curX) seen from the mapper hook is the raster position at the write cycle.
//  * cpu._cpuCycleBase + cpu.instrBusCycles = CPU cycles since power-on at that bus cycle.
//  * jsnes scanline 0 = NES line 241 (vblank set at dot 1), 20 = pre-render (261), 21..260 = visible
//    lines 0..239, 261 = post-render line 240.
import { symbolize } from './symbolize.mjs';

const OP_JSR = 0x20, OP_RTS = 0x60, OP_RTI = 0x40;
const VARS = { GameMode: 0x12, GameSubmode: 0x13, IsUpdatingMode: 0x11, IsSprite0CheckActive: 0xe3 };

export const DOTS = 341;
export const nesLine = (s) => (s <= 20 ? s + 241 : s - 21);
/** Dots since NES line 241 dot 1 (the port's ppu.clock origin) for a jsnes position. */
export const portDot = (s, x) => s * DOTS + x - 1;

export function attachProbe(oracle, { onWrite = null, onNmiEnd = null, onNmiStart = null, onRead = null } = {}) {
  const nes = oracle.nes;
  const cpu = nes.cpu;
  const ppu = nes.ppu;
  const mem = cpu.mem;
  const st = {
    nmi: null, // current NMI record (null outside the handler)
    nmiCount: 0,
    pc: 0,
    stack: [], // shadow call stack: [{ret, target}]
    ctrl: 0, mask: 0, // last values written to $2000/$2001
    lastNmi: null,
  };
  const cycleNow = () => cpu._cpuCycleBase + cpu.instrBusCycles;

  // ---- per instruction: PC, shadow call stack, RTI
  const emulate = cpu.emulate; // the oracle's wrapper (snapshot on RTI) – keep it in the chain
  cpu.emulate = function () {
    const pc = (cpu.REG_PC + 1) & 0xffff;
    st.pc = pc;
    st.bankAtFetch = oracle.prgBank;
    const willInterrupt = cpu.nmiImmediate || (cpu.irqRequested && cpu.F_INTERRUPT === 0);
    const op = willInterrupt ? -1 : mem[pc] ?? 0;
    if (op === OP_RTI && st.nmi) {
      // the snapshot hook in the oracle runs for the same instruction; end the record here
      const n = st.nmi;
      n.endCycle = cpu._cpuCycleBase + 6; // RTI = 6 cycles (instrBusCycles still holds the previous instruction)
      n.cycles = n.endCycle - n.startCycle;
      n.endLine = nesLine(ppu.scanline);
      n.endDot = ppu.curX;
      n.endVideo = oracle.videoFrames;
      st.nmi = null;
      st.lastNmi = n;
      onNmiEnd?.(n);
    }
    const r = emulate();
    if (!willInterrupt) {
      if (op === OP_JSR) {
        st.stack.push({ ret: (pc + 3) & 0xffff, site: pc, bank: st.bankAtFetch });
        if (st.stack.length > 64) st.stack.shift();
      } else if (op === OP_RTS) {
        const to = (cpu.REG_PC + 1) & 0xffff;
        // TableJump-style stack games: pop until the frame whose return address we landed on
        let i = st.stack.length - 1;
        while (i >= 0 && st.stack[i].ret !== to) i--;
        if (i >= 0) st.stack.length = i;
        else st.stack.pop();
      }
    }
    return r;
  };

  // ---- NMI entry
  const nmi = cpu.doNonMaskableInterrupt;
  cpu.doNonMaskableInterrupt = function (status) {
    st.nmiCount = oracle.nmiCount; // the oracle's hook (inner) increments after ours runs; fixed below
    const rec = {
      frame: oracle.nmiCount + 1, // logical frame this NMI produces (oracle increments right after)
      video: oracle.videoFrames,
      startCycle: cycleNow(), // first cycle of the 7-cycle NMI sequence
      startLine: nesLine(ppu.scanline),
      startDot: ppu.curX,
      startPortDot: portDot(ppu.scanline, ppu.curX),
      mode: mem[VARS.GameMode], submode: mem[VARS.GameSubmode],
      updating: mem[VARS.IsUpdatingMode], sprite0: mem[VARS.IsSprite0CheckActive],
      oamDma: 0, dmcHalt: 0, dmcHalts: 0, irqs: 0,
      writes: 0, maskAtStart: st.mask,
    };
    st.nmi = rec;
    st.stack.length = 0;
    onNmiStart?.(rec);
    return nmi.call(cpu, status);
  };

  const doIrq = cpu.doIrq;
  cpu.doIrq = function (status) {
    if (st.nmi) st.nmi.irqs++;
    return doIrq.call(cpu, status);
  };

  // ---- halts: OAM DMA (513/514) and DMC DMA (4)
  const halt = cpu.haltCycles;
  let inDma = false;
  cpu.haltCycles = function (cycles) {
    if (st.nmi) {
      if (inDma) st.nmi.oamDma = cycles;
      else { st.nmi.dmcHalt += cycles; st.nmi.dmcHalts++; }
    }
    return halt.call(cpu, cycles);
  };

  // ---- register writes
  const mmap = nes.mmap;
  const write = mmap.write.bind(mmap);
  mmap.write = (addr, value) => {
    const isPpu = addr >= 0x2000 && addr < 0x4000;
    if (isPpu || addr === 0x4014) {
      const reg = isPpu ? 0x2000 | (addr & 7) : addr;
      const s = ppu.scanline, x = ppu.curX;
      const ev = {
        frame: st.nmi ? st.nmi.frame : null,
        cyc: st.nmi ? cycleNow() - 1 - st.nmi.startCycle : null, // bus cycle index since NMI start
        line: nesLine(s), dot: x, portDot: portDot(s, x), jsLine: s,
        reg, val: value,
        pc: st.pc, bank: st.bankAtFetch,
        ctrlBefore: st.ctrl, maskBefore: st.mask,
        v: ppu.vramAddress, tNt: (ppu.regV << 1) | ppu.regH, firstWrite: ppu.firstWrite, vAfter: 0,
        video: oracle.videoFrames, frameDot: 0,
        mode: mem[VARS.GameMode], submode: mem[VARS.GameSubmode],
        stack: st.stack.map((f) => f.site),
        stackBanks: st.stack.map((f) => f.bank),
      };
      if (st.nmi) st.nmi.writes++;
      if (reg === 0x2000) st.ctrl = value;
      if (reg === 0x2001) st.mask = value;
      if (reg === 0x4014) inDma = true;
      const r = write(addr, value);
      inDma = false;
      ev.vAfter = ppu.vramAddress;
      // frame-relative position, continuing past the end of the NMI's video frame when it overran
      ev.frameDot = st.nmi ? (ev.video - st.nmi.video) * 89342 + ev.portDot : ev.portDot;
      onWrite?.(ev);
      return r;
    }
    return write(addr, value);
  };

  // ---- register reads with side effects on the PPU ($2002 clears w, $2007 increments v)
  if (onRead) {
    const load = mmap.load.bind(mmap);
    mmap.load = (addr) => {
      if (addr >= 0x2000 && addr < 0x4000 && ((addr & 7) === 2 || (addr & 7) === 7)) {
        const s = ppu.scanline, x = ppu.curX;
        const video = oracle.videoFrames;
        const value = load(addr);
        const portD = portDot(s, x);
        onRead({ frame: st.nmi ? st.nmi.frame : null, reg: 0x2000 | (addr & 7), val: value, pc: st.pc, bank: st.bankAtFetch,
          video, portDot: portD, frameDot: st.nmi ? (video - st.nmi.video) * 89342 + portD : portD });
        return value;
      }
      return load(addr);
    };
  }

  return st;
}

/** Routine of the writing instruction, then the routines that contain each JSR site (innermost first). */
export function describeCallChain(ev, depth = 4) {
  const own = symbolize(ev.pc, ev.bank);
  const chain = [own.routine];
  for (let i = ev.stack.length - 1; i >= 0 && chain.length < depth; i--) {
    const r = symbolize(ev.stack[i], ev.stackBanks[i]).routine;
    if (r !== chain[chain.length - 1]) chain.push(r);
  }
  return chain;
}

/** Routine + local label of the writing instruction ("IsrNmi@CheckScroll"). */
export function writeSite(ev) {
  const own = symbolize(ev.pc, ev.bank);
  return own.local ?? own.routine;
}
