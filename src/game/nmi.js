// IsrNmi and controller reading (Z_07). Package P01.
// One call of IsrNmi = one frame of the game (RunGame idles in LoopForever; see docs/ARCHITECTURE.md §3).

import { ram, cpu } from '../core/ram.js';
import { bus, read, write } from '../core/bus.js';
import { switchBank, tableJump } from '../core/asm.js';
import {
  CurPpuControl_2000, SwitchNameTablesReq, CurPpuMask_2001, IsSprite0CheckActive, TileBufSelector,
  IsUpdatingMode, GameMode, CurHScroll, CurVScroll, MenuState, Paused, FrameCounter,
  ButtonsPressed, ButtonsDown,
} from '../core/vars.js';
import { TransferCurTileBuf } from './ppu/tilebuf.js';
import { WaitAndScrollToSplitBottom } from './ppu/sprite0.js';
import { InitializeGameOrMode, UpdateMode } from './modes/dispatch.js';
import { DriveAudio } from './audio/driver.js';
import { IsrResetJump } from './boot.js';
import { $br, $pxa, pollStatus } from '../core/timing.js';

/** TableJump (Z_07): implemented once in core/asm.js (tableJump); exported here under its asm name. */
export const TableJump = tableJump;

export function IsrNmi() {
  // IsrNmi (Z_07)
  let a = ram[CurPpuControl_2000];
  if (!$br('Z_07:391', ram[SwitchNameTablesReq] === 0)) a ^= 0x02; // switch to the other name table ($2000 <-> $2800)
  a &= 0x7f; // disable NMI
  ram[CurPpuControl_2000] = a;
  write(0x2000, a & 0x7e); // make sure table is 0 or 2

  // PPUMASK: all video on if checking sprite 0, or if TileBufSelector = 0 and [$17] = 0.
  a = ram[CurPpuMask_2001];
  if ($br('Z_07:403', ram[IsSprite0CheckActive] !== 0) || (!$br('Z_07:405', ram[TileBufSelector] !== 0) && !$br('Z_07:407', ram[0x17] !== 0))) a |= 0x1e;
  write(0x2001, a);
  ram[CurPpuMask_2001] = a;

  // Copy all our sprites to OAM.
  write(0x2003, 0x00);
  write(0x4014, 0x02);

  // Reset scroll register.
  write(0x2005, 0x00);
  write(0x2005, 0x00);
  switchBank(6);
  TransferCurTileBuf();

  // Reset PPUADDR.
  write(0x2006, 0x3f);
  write(0x2006, 0x00);
  write(0x2006, 0x00);
  write(0x2006, 0x00);

  // @WaitVBlankEnd: LDA $2002 / AND #$40 / BNE, until the sprite 0 flag clears (pre-render line).
  pollStatus(bus.ppu, 0x40, false);
  read(0x2002); // clear shift register

  if (!$br('Z_07:449', ram[IsSprite0CheckActive] === 0)) {
    switchBank(5);
    WaitAndScrollToSplitBottom();
  }

  // @CheckScroll
  if (!$br('Z_07:458', ram[IsUpdatingMode] === 0)) {
    const m = ram[GameMode];
    if ($br('Z_07:460', m === 0x00) || $br('Z_07:462', m === 0x05) || $br('Z_07:464', m === 0x09) || $br('Z_07:466', m === 0x0b) || $br('Z_07:468', m === 0x0c) || !$br('Z_07:470', m !== 0x13)) {
      read(0x2002);
      write(0x2005, ram[CurHScroll]);
      write(0x2005, ram[CurVScroll]);
      write(0x2000, ram[CurPpuControl_2000]);
    }
  }

  // @UpdateTimers: not when paused or in the menu.
  if (!$br('Z_07:485', (ram[MenuState] | ram[Paused]) !== 0)) {
    let x = 0x26; // advance the stun cycle
    a = 0x3c;
    const y = 0x4e;
    ram[0x00] = x;
    ram[x]--;
    if (!$br('Z_07:491', !(ram[x] & 0x80))) { // BPL not taken
      ram[x] = 0x09;
      a = y; // every 10th frame also the stun and long timers
    }
    x = a;
    do {
      if (!$br('Z_07:501', ram[x] === 0)) ram[x]--;
      x = (x - 1) & 0xff;
    } while ($br('Z_07:506', x !== ram[0x00]));
  }

  // @CheckInput: input isn't read while scrolling with sprite 0.
  if (!$br('Z_07:511', ram[IsSprite0CheckActive] !== 0)) ReadInputs();

  // @ScrambleRandom
  ram[0x00] = ram[0x18] & 0x02;
  a = (ram[0x19] & 0x02) ^ ram[0x00];
  cpu.c = $br('Z_07:524', a === 0) ? 0 : 1;
  for (let x = 0x18, y = 0x0d; ;) { cpu.rorMem(x); x++; y--; if (!$br('Z_07:531', y !== 0)) break; }

  switchBank(0);
  DriveAudio();
  ram[FrameCounter]++;
  try {
    if ($br('Z_07:537', ram[IsUpdatingMode] !== 0)) UpdateMode();
    else InitializeGameOrMode();
  } catch (e) {
    if (e instanceof IsrResetJump) return; // JMP IsrReset: this NMI never reaches @EnableNMI/RTI
    throw e;
  }

  // @EnableNMI
  read(0x2002);
  a = ram[CurPpuControl_2000] | 0x80;
  write(0x2000, a);
  ram[CurPpuControl_2000] = a;
}

export function ReadInputs() {
  // ReadInputs (Z_07)
  write(0x4016, 0x01); // signal the controllers to poll
  write(0x4016, 0x00);
  ram[0x03] = 0x00;
  ram[0x04] = 0x00;
  const a = ReadOneController(0x00, 0);
  return ReadOneController(a, 1); // INX, falls through
}

/** ReadOneController (Z_07): re-reads until two equal readings in a row. Returns A (= ButtonsDown,X). */
export function ReadOneController(a, x) {
  // ReadOneController (Z_07)
  for (;;) {
    ram[0x02] = a;
    write(0x4016, 0x01);
    write(0x4016, 0x00);
    for (let y = 8; ;) {
      $pxa('Z_07:712', 0x4016, x);
      a = read(0x4016 + x);
      a = cpu.lsr(a);
      cpu.rolMem(ButtonsPressed + x); // here ButtonsPressed means "down now"
      a = cpu.lsr(a);
      cpu.rolMem(0x00); // expansion port reading
      y--; if (!$br('Z_07:718', y !== 0)) break;
    }
    a = ram[ButtonsPressed + x];
    if ($br('Z_07:721', a !== ram[0x02])) continue; // not the same reading: try again
    ram[0x03 + x]++;
    if ($br('Z_07:725', ram[0x03 + x] < 0x02)) continue; // not at least two equal readings: try again
    break;
  }
  a = ram[0x00] | ram[ButtonsPressed + x]; // combine controller and expansion inputs
  ram[ButtonsPressed + x] = a;
  const pushed = a; // PHA
  ram[ButtonsPressed + x] = (a ^ ram[ButtonsDown + x]) & ram[ButtonsPressed + x]; // "newly down"
  ram[ButtonsDown + x] = pushed; // PLA
  return pushed;
}
