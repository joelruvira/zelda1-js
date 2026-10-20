// Helpers for fixed-bank (Z_07) routines that every ported module calls and whose
// side effects on RAM must match the original byte for byte.

import { ram } from './ram.js';
import { bus, read } from './bus.js';

/**
 * SwitchBank (Z_07): five serial writes of A to $E000 (MMC1 PRG bank register).
 * Returns A as the original leaves it (bank >> 4), in case the caller uses it.
 */
export function switchBank(bank) {
  bus.mapper.setPrgBank(bank & 0x1f);
  return (bank & 0xff) >> 4;
}

/**
 * TableJump (Z_07): `JSR TableJump` followed by a table of .ADDR entries.
 * Leaves $00-$03 exactly as the original ($00/$01 = table - 1, the JSR return address;
 * $02/$03 = the target read from the ROM), then calls handlers[index].
 * The table must be readable through the bus (switch the bank first, like the original).
 * @param {number} tableAddr CPU address of the .ADDR table (the label after the JSR)
 * @param {number} index     A at the JSR
 * @param {Array<Function>} handlers JS ports of the table entries, same order
 * @returns whatever the handler returns
 */
export function tableJump(tableAddr, index, handlers) {
  const ret = (tableAddr - 1) & 0xffff;
  const y = (index << 1) & 0xff; // ASL / TAY
  ram[0x00] = ret & 0xff;
  ram[0x01] = ret >> 8;
  ram[0x02] = read((ret + ((y + 1) & 0xff)) & 0xffff);
  ram[0x03] = read((ret + ((y + 2) & 0xff)) & 0xffff);
  const handler = handlers[index];
  if (!handler) throw new RangeError(`TableJump: no handler ${index} for table $${tableAddr.toString(16)}`);
  return handler();
}
