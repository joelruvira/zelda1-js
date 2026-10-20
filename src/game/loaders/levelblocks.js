// Level block / level info copies from bank 6 ROM to WRAM (Z_06). Package P03.
//   InitMode2_Sub0: level block  -> $687E-$6B7D (FetchLevelBlockDestInfo)
//   InitMode2_Sub1: level info   -> $6B7E-$6C7D (FetchLevelInfoDestInfo)
//   CopyCommonDataToRam (P01, boot.js) also uses CopyBlock.

import { ram, cpu, word } from '../../core/ram.js';
import { read, write } from '../../core/bus.js';
import { GameSubmode } from '../../core/vars.js';

/** FetchLevelBlockDestInfo (Z_06): [$02:03] = $687E (destination), [$04:05] = $6B7D (end). */
export function FetchLevelBlockDestInfo() {
  // FetchLevelBlockDestInfo (Z_06)
  ram[0x02] = 0x7e;
  ram[0x03] = 0x68;
  ram[0x04] = 0x7d;
  ram[0x05] = 0x6b;
  return 0x6b;
}

/** FetchLevelInfoDestInfo (Z_06): [$02:03] = $6B7E (destination), [$04:05] = $6C7D (end). */
export function FetchLevelInfoDestInfo() {
  // FetchLevelInfoDestInfo (Z_06)
  ram[0x02] = 0x7e;
  ram[0x03] = 0x6b;
  ram[0x04] = 0x7d;
  ram[0x05] = 0x6c;
  return 0x6c;
}

/**
 * CopyBlock (Z_06): copy from [$00:01] to [$02:03] up to and including the end address [$04:05],
 * then INC GameSubmode. The source is read through the bus (bank 6 mapped by the caller).
 */
export function CopyBlock() {
  // CopyBlock (Z_06)
  const y = 0x00;
  for (;;) {
    write((word(0x02) + y) & 0xffff, read((word(0x00) + y) & 0xffff)); // LDA ($00), Y / STA ($02), Y
    if (ram[0x02] === ram[0x04] && ram[0x03] === ram[0x05]) {
      ram[GameSubmode]++;
      return;
    }
    // @Next
    cpu.c = 0;
    ram[0x02] = cpu.adc(ram[0x02], 0x01);
    ram[0x03] = cpu.adc(ram[0x03], 0x00);
    cpu.c = 0;
    ram[0x00] = cpu.adc(ram[0x00], 0x01);
    ram[0x01] = cpu.adc(ram[0x01], 0x00);
  }
}
