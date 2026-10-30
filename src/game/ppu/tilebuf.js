// VRAM transfer buffers (Z_06). Package P01.
// Record format: hiVRAM, loVRAM, ctl, data...  ctl bit7 = +32 increment, bit6 = repeat one byte,
// bits0-5 = count (0 => 64). A record whose first byte has bit 7 set ends the buffer.
// Buffers may live in RAM, SRAM or bank 6 ROM, so they are read through the bus.

import { ram, cpu, word } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { TileBufSelector, SwitchNameTablesReq, DynTileBufLen, DynTileBuf, CurPpuControl_2000 } from '../../core/vars.js';
import { $br, $pxa } from '../../core/timing.js';

export function TransferCurTileBuf() {
  // TransferCurTileBuf (Z_06)
  let x = ram[TileBufSelector];
  const addrs = table(bus.rom, 'TransferBufAddrs');
  ram[0x00] = addrs.byte(x);
  $pxa('Z_06:561', addrs.addr + 1, x); ram[0x01] = addrs.byte(x + 1);
  TransferTileBuf();
  ram[0x0300] = 0x3f; // UNKNOWN in the original: [$0300] is only ever written
  x = 0x00;
  ram[TileBufSelector] = x;
  ram[SwitchNameTablesReq] = x;
  ram[DynTileBufLen] = x;
  x = 0xff;
  ram[DynTileBuf] = x; // empty the tile buffer
  return x;
}

/**
 * TransferTileBuf (Z_06) with its loop body ContinueTransferTileBuf.
 * [$00:01] = buffer address; it is advanced past each record.
 */
export function TransferTileBuf() {
  // TransferTileBuf (Z_06)
  for (;;) {
    read(0x2002); // LDX PpuStatus_2002
    let y = 0;
    $pxa('Z_06:651', ram[0x00], 0);
    const hi = read(word(0x00)); // high byte of VRAM address
    if (!$br('Z_06:652', (hi & 0x80) === 0)) return hi; // end when we read a negative VRAM address
    y = ContinueTransferTileBuf(hi);
    // @AdvanceSource: [$00:01] += Y + 1 (SEC / TYA / ADC $00)
    cpu.c = 1;
    ram[0x00] = cpu.adc(y, ram[0x00]);
    ram[0x01] = cpu.adc(0x00, ram[0x01]);
  }
}

/** ContinueTransferTileBuf (Z_06, internal label of TransferTileBuf): writes one record; returns Y. */
function ContinueTransferTileBuf(a) {
  // ContinueTransferTileBuf (Z_06)
  const ptr = word(0x00);
  const pushedHi = a; // PHA
  write(0x2006, a);
  let y = 1;
  $pxa('Z_06:585', ptr, y); write(0x2006, read((ptr + y) & 0xffff)); // low byte of VRAM address
  y = 2;
  $pxa('Z_06:588', ptr, y); a = read((ptr + y) & 0xffff); // count and attribute byte
  const vertical = a & 0x80; // ASL -> C
  a = (a << 1) & 0xff;
  const pushedCtl = a; // PHA
  let ctl = ram[CurPpuControl_2000] | 0x04;
  if (!$br('Z_06:593', vertical !== 0)) ctl &= 0xfb;
  write(0x2000, ctl);
  ram[CurPpuControl_2000] = ctl;
  a = pushedCtl; // PLA
  const repeat = a & 0x80; // ASL -> C (bit 6 of ctl)
  a = (a << 1) & 0xff;
  const zero = a === 0; // PHP saves Z of the ASL result
  if (!$br('Z_06:601', !repeat)) {
    a |= 0x02;
    y++; // point to the byte to repeat
  }
  // PLP / CLC / BNE / SEC / ROR / LSR: count in A (0 => 64), C = repeat flag
  a = (a >> 1) | ($br('Z_06:610', !zero) ? 0 : 0x80);
  a >>= 1;
  let x = a;
  do {
    if (!$br('Z_06:621', !!repeat)) y++;
    $pxa('Z_06:624', ptr, y); write(0x2007, read((ptr + y) & 0xffff));
    x = (x - 1) & 0xff;
  } while ($br('Z_06:627', x !== 0));
  cpu.c = repeat ? 1 : 0;
  a = pushedHi; // PLA
  if (!$br('Z_06:632', a !== 0x3f)) { // wrote to $3Fxx: set PPUADDR to $3F00, then $0000
    write(0x2006, a);
    write(0x2006, x);
    write(0x2006, x);
    write(0x2006, x);
  }
  return y;
}
