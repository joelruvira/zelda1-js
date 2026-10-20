// Sprite-0 HUD split (Z_05). Package P01.
//
// The original busy-waits on $2002 and burns cycles before rewriting scroll/PPUADDR mid-frame.
// The catch-up PPU (core/ppu.js) renders up to its clock before each register access, so the
// delays are translated into ppu.cpuCycles(n) with the exact 6502 cycle counts below.
// Convention: a register access happens on the last cycle of its instruction. tick(n) accumulates
// the cycles of instructions without accesses; at(n) advances the clock to the last cycle of an
// n-cycle accessing instruction (the remaining cycle is carried over to the next advance).
// All branches here stay inside page $85xx (no page-crossing penalties).

import { ram } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import {
  GameMode, GameSubmode, ObjDir, VScrollAddrHi, VScrollAddrLo, CurPpuControl_2000,
  OddBaseNameTableOverride, CurHScroll,
} from '../../core/vars.js';
import { TurnOffAllVideo } from '../boot.js';

let pending = 0;
/** Add n CPU cycles of instructions without register accesses. */
const tick = (n) => { pending += n; };
/** Register access by an instruction of n cycles (access on its last cycle). */
function at(n) {
  bus.ppu.cpuCycles(pending + n - 1);
  pending = 1;
}
function flush() {
  if (pending) bus.ppu.cpuCycles(pending);
  pending = 0;
}

export function WaitAndScrollToSplitBottom() {
  // WaitAndScrollToSplitBottom (Z_05)
  bus.ppu.waitSprite0Hit(); // LDA $2002 (4) / AND #$40 (2) / BEQ (3): 9 cycles per poll
  pending = 1; // rest of the LDA that saw the hit
  tick(2 + 2); // AND, BEQ not taken
  at(4); read(0x2002);
  // LDY #$03 (2); 4 x [LDX #$30 (2) + 49 DEX (2) + 48 BPL taken (3) + BPL not taken (2) = 246];
  // 4 DEY (2) + 3 BPL taken (3) + 1 BPL not taken (2)  => 2 + 984 + 8 + 9 + 2 = 1005
  tick(1005);
  tick(9 * 2); // 9 NOPs
  tick(3 + 2); // LDA GameMode, CMP #$08
  let a = ram[GameMode];
  if (a >= 0x08) {
    tick(3); // BCS taken
    tick(2); // CMP #$11
    if (a < 0x11) {
      tick(2 + 3); // BCS not taken, JMP TurnOffAllVideo
      tick(2); // LDA #$00
      at(4); // STA PpuMask_2001
      const r = TurnOffAllVideo();
      flush();
      return r;
    }
    tick(3); // BCS taken
    a = ram[CurPpuControl_2000] | 0x01; // change base nametable (0 -> 1 or 2 -> 3)
    ram[CurPpuControl_2000] = a;
    tick(3 + 2 + 3); // LDA zp, ORA #, STA zp
    at(4); write(0x2000, a);
    flush();
    return a;
  }
  tick(2); // BCS not taken
  tick(3); // LDA GameSubmode
  if (ram[GameSubmode] === 0) { // BEQ @Exit
    flush();
    return 0;
  }
  tick(2); // BEQ not taken
  tick(3 + 2); // LDA ObjDir, CMP #$04
  if (ram[ObjDir] >= 0x04) {
    tick(2); // BCC not taken
    // Scrolling vertically: set PPUADDR instead of PPUSCROLL.
    // LDY #$5E (2) + 95 x (NOP 2 + DEY 2) + 94 BPL taken (3) + BPL not taken (2) = 666
    tick(666);
    tick(5 * 2); // 5 NOPs
    at(4); read(0x2002);
    a = ram[VScrollAddrHi];
    const y = ram[VScrollAddrLo];
    tick(3 + 3); // LDA zp, LDY zp
    at(4); write(0x2006, a);
    at(4); write(0x2006, y);
    at(4); read(0x2007);
    at(4); a = read(0x2007);
    flush();
    return a;
  }
  tick(3); // BCC taken
  tick(666); // same LDY #$5E delay loop
  tick(3 * 2); // 3 NOPs
  a = ((ram[CurPpuControl_2000] & 0xfe) | ram[OddBaseNameTableOverride]) & 0xff;
  ram[CurPpuControl_2000] = a;
  tick(3 + 2 + 3 + 3); // LDA zp, AND #, ORA zp, STA zp
  at(4); write(0x2000, a);
  tick(3); // LDA CurHScroll
  at(4); write(0x2005, ram[CurHScroll]);
  tick(2); // LDA #$00
  at(4); write(0x2005, 0x00);
  flush();
  return 0;
}
