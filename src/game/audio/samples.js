// DMC samples (Z_00): DriveSample. Package P02.

import { ram } from '../../core/ram.js';
import { bus, write } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  SampleRequest, Sample, SampleCounter, BackgroundSample, ApuStatus_4015,
  DmcFreq_4010, DmcCounter_4011, DmcAddress_4012, DmcLength_4013,
} from '../../core/vars.js';
import { _bitIndex as bitIndex } from './driver.js';

/**
 * DriveSample (Z_00)
 * @param {number} x X on entry: written to $4011 when a background sample restarts
 *                   (the asm branches to the STX with whatever X DriveEffect left).
 * @returns {number} X on exit
 */
export function DriveSample(x) {
  // DriveSample (Z_00)
  let a = ram[SampleRequest];
  if (a & 0x80) return changeSample(a & 0xf0, 0x7f); // @ChangeSampleMid
  if (a !== 0) return changeSample(a, 0x00); // @ChangeSampleLow
  a = ram[Sample];
  if (a !== 0) {
    ram[SampleCounter]--;
    if (ram[SampleCounter] !== 0) return x; // @Exit
    a = ram[Sample];
    if (a & 0x80) return changeSample(a & 0xf0, 0x7f);
    if ((a & 0x70) !== 0) return changeSample(a & 0x70, 0x00);
    ram[Sample] = 0;
    write(ApuStatus_4015, 0x0f);
  }
  // @CheckBgSample
  a = ram[BackgroundSample];
  if (a === 0) return x;
  return changeSample(a, x);
}

// The common tail from `STX DmcCounter_4011` on; A = sample bits, X = DMC level.
function changeSample(a, x) {
  write(DmcCounter_4011, x);
  ram[Sample] = a;
  x = a; // TAX
  if ((a & 0xf0) !== 0) ram[BackgroundSample] = a & 0xf0;
  const y = bitIndex(x); // TXA / INY / LSR / BCC
  const rom = bus.rom;
  write(DmcFreq_4010, table(rom, 'SampleRates').byte(y - 1));
  write(DmcAddress_4012, table(rom, 'SampleAddrs').byte(y - 1));
  write(DmcLength_4013, table(rom, 'SampleLengths').byte(y - 1));
  ram[SampleCounter] = 0xa0;
  write(ApuStatus_4015, 0x0f);
  write(ApuStatus_4015, 0x1f);
  return x;
}
