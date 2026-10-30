// DMC samples (Z_00): DriveSample. Package P02.

import { ram } from '../../core/ram.js';
import { bus, write } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  SampleRequest, Sample, SampleCounter, BackgroundSample, ApuStatus_4015,
  DmcFreq_4010, DmcCounter_4011, DmcAddress_4012, DmcLength_4013,
} from '../../core/vars.js';
import { _bitIndex as bitIndex } from './driver.js';
import { $br, $pxa } from '../../core/timing.js';

/**
 * DriveSample (Z_00)
 * @param {number} x X on entry: written to $4011 when a background sample restarts
 *                   (the asm branches to the STX with whatever X DriveEffect left).
 * @returns {number} X on exit
 */
export function DriveSample(x) {
  // DriveSample (Z_00)
  let a = ram[SampleRequest];
  if ($br('Z_00:517', (a & 0x80) !== 0)) return changeSample(a & 0xf0, 0x7f); // @ChangeSampleMid
  if ($br('Z_00:518', a !== 0)) { $br('Z_00:541', true); return changeSample(a, 0x00); } // @ChangeSampleLow
  a = ram[Sample];
  if (!$br('Z_00:520', a === 0)) {
    ram[SampleCounter]--;
    if ($br('Z_00:522', ram[SampleCounter] !== 0)) return x; // @Exit
    a = ram[Sample];
    if ($br('Z_00:524', (a & 0x80) !== 0)) return changeSample(a & 0xf0, 0x7f);
    if ($br('Z_00:526', (a & 0x70) !== 0)) { $br('Z_00:541', true); return changeSample(a & 0x70, 0x00); }
    ram[Sample] = 0;
    write(ApuStatus_4015, 0x0f);
  }
  // @CheckBgSample
  a = ram[BackgroundSample];
  if (!$br('Z_00:534', a !== 0)) return x;
  return changeSample(a, x);
}

// The common tail from `STX DmcCounter_4011` on; A = sample bits, X = DMC level.
function changeSample(a, x) {
  write(DmcCounter_4011, x);
  ram[Sample] = a;
  x = a; // TAX
  if (!$br('Z_00:551', (a & 0xf0) === 0)) ram[BackgroundSample] = a & 0xf0;
  const y = bitIndex(x, 'Z_00:559'); // TXA / INY / LSR / BCC
  const rom = bus.rom;
  $pxa('Z_00:560', table(rom, 'SampleRates').addr - 1, y);
  write(DmcFreq_4010, table(rom, 'SampleRates').byte(y - 1));
  $pxa('Z_00:562', table(rom, 'SampleAddrs').addr - 1, y);
  write(DmcAddress_4012, table(rom, 'SampleAddrs').byte(y - 1));
  $pxa('Z_00:564', table(rom, 'SampleLengths').addr - 1, y);
  write(DmcLength_4013, table(rom, 'SampleLengths').byte(y - 1));
  ram[SampleCounter] = 0xa0;
  write(ApuStatus_4015, 0x0f);
  write(ApuStatus_4015, 0x1f);
  return x;
}
