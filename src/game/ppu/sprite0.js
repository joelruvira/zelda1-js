// Sprite-0 HUD split (Z_05). Package P01.
//
// The original busy-waits on $2002 for the sprite 0 hit, burns cycles in delay loops and then rewrites
// scroll/PPUADDR mid-frame. With the cycle tracker (core/timing.js) every branch of those loops is a
// breadcrumb, so each register access lands on the cycle of the original; pollStatus() is the
// `LDA $2002 / AND #$40 / BEQ` loop. Without the tracker the writes happen right after the hit.

import { ram } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import { $br, pollStatus } from '../../core/timing.js';
import {
  GameMode, GameSubmode, ObjDir, VScrollAddrHi, VScrollAddrLo, CurPpuControl_2000,
  OddBaseNameTableOverride, CurHScroll,
} from '../../core/vars.js';
import { TurnOffAllVideo } from '../boot.js';

/** `LDY #$5E / : NOP / DEY / BPL :-` (Z_05 line of the BPL). */
function delay5E(bplRef) {
  for (let y = 0x5e; ;) {
    y = (y - 1) & 0xff;
    if (!$br(bplRef, y < 0x80)) break;
  }
}

export function WaitAndScrollToSplitBottom() {
  // WaitAndScrollToSplitBottom (Z_05)
  pollStatus(bus.ppu, 0x40, true); // LDA $2002 / AND #$40 / BEQ WaitAndScrollToSplitBottom
  read(0x2002);
  // LDY #$03 / : LDX #$30 / : DEX / BPL :- / DEY / BPL :--
  for (let y = 0x03; ;) {
    for (let x = 0x30; ;) {
      x = (x - 1) & 0xff;
      if (!$br('Z_05:1278', x < 0x80)) break;
    }
    y = (y - 1) & 0xff;
    if (!$br('Z_05:1280', y < 0x80)) break;
  }
  let a = ram[GameMode];
  if ($br('Z_05:1292', a >= 0x08)) {
    if (!$br('Z_05:1345', a >= 0x11)) return TurnOffAllVideo(); // JMP TurnOffAllVideo
    a = ram[CurPpuControl_2000] | 0x01; // change base nametable (0 -> 1 or 2 -> 3)
    ram[CurPpuControl_2000] = a;
    write(0x2000, a);
    return a;
  }
  if ($br('Z_05:1294', ram[GameSubmode] === 0)) return 0; // BEQ @Exit
  if (!$br('Z_05:1297', ram[ObjDir] < 0x04)) {
    // Scrolling vertically: set PPUADDR instead of PPUSCROLL.
    delay5E('Z_05:1305');
    read(0x2002);
    a = ram[VScrollAddrHi];
    const y = ram[VScrollAddrLo];
    write(0x2006, a);
    write(0x2006, y);
    read(0x2007);
    a = read(0x2007);
    return a;
  }
  delay5E('Z_05:1327');
  a = ((ram[CurPpuControl_2000] & 0xfe) | ram[OddBaseNameTableOverride]) & 0xff;
  ram[CurPpuControl_2000] = a;
  write(0x2000, a);
  write(0x2005, ram[CurHScroll]);
  write(0x2005, 0x00);
  return 0;
}
