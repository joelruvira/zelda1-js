// 16-bit helpers on the zero-page pairs $00:01, $02:03, $04:05 (Z_01, BANK_01_CODE, run from WRAM).
// Package P01. Each returns A as the original leaves it (the low byte of the result).

import { ram, cpu } from '../../core/ram.js';
import { $br } from '../../core/timing.js';

export function Add1ToInt16At0() {
  // Add1ToInt16At0 (Z_01): falls through into AddToInt16At0 with A = 1
  return AddToInt16At0(1);
}

/** @returns A = low byte of the sum; cpu.c = carry out of the low byte (C after BCC). */
export function AddToInt16At0(a) {
  // AddToInt16At0 (Z_01)
  cpu.c = 0;
  a = cpu.adc(a & 0xff, ram[0x00]);
  ram[0x00] = a;
  if (!$br('Z_01:4257', !cpu.c)) ram[0x01]++;
  return a;
}

export function Add1ToInt16At2() {
  // Add1ToInt16At2 (Z_01): falls through into AddToInt16At2 with A = 1
  return AddToInt16At2(1);
}

export function AddToInt16At2(a) {
  // AddToInt16At2 (Z_01)
  cpu.c = 0;
  a = cpu.adc(a & 0xff, ram[0x02]);
  ram[0x02] = a;
  if (!$br('Z_01:4279', !cpu.c)) ram[0x03]++;
  return a;
}

export function Add1ToInt16At4() {
  // Add1ToInt16At4 (Z_01): falls through into AddToInt16At4 with A = 1
  return AddToInt16At4(1);
}

export function AddToInt16At4(a) {
  // AddToInt16At4 (Z_01)
  cpu.c = 0;
  a = cpu.adc(a & 0xff, ram[0x04]);
  ram[0x04] = a;
  if (!$br('Z_01:4300', !cpu.c)) ram[0x05]++;
  return a;
}

/** @returns A = new low byte; cpu.c = 0 if the low byte borrowed. */
export function Sub1FromInt16At4() {
  // Sub1FromInt16At4 (Z_01)
  cpu.c = 1;
  const a = cpu.sbc(ram[0x04], 1);
  ram[0x04] = a;
  if (!$br('Z_01:4313', cpu.c !== 0)) ram[0x05]--;
  return a;
}
