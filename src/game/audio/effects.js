// Sound effects on the noise channel (Z_00): DriveEffect and its internal labels
// (sword, arrow, flame, stairs, bomb, sea), SetSfxVolumeLength, SilenceSfxIfEnded. Package P02.
//
// The internal labels are separate functions because the asm reaches them by branches and
// fall-through from several places; each one ends the way the asm does (fall-through =
// tail call). They all take/return X (see driver.js) and receive Y where the asm uses it.

import { ram } from '../../core/ram.js';
import { bus, write } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  EffectRequest, Effect, EffectCounter, SeaSfxCounter, Tune0Request, Sample, Tune1,
  BackgroundSample, ApuStatus_4015, NoiseVolume_400C, NoisePeriod_400E, NoiseLength_400F,
} from '../../core/vars.js';
import { $br, $pxa } from '../../core/timing.js';

const rom = () => bus.rom;
const STEP = 0x68; // $68: stairs step counter / sea volume (no name in the asm)

/**
 * DriveEffect (Z_00)
 * @param {number} x X on entry
 * @returns {number} X on exit
 */
export function DriveEffect(x) {
  // DriveEffect (Z_00)
  const y = ram[EffectRequest];
  if ($br('Z_00:308', (y & 0x80) !== 0)) return SilenceSample(x); // $80 silences samples and tune 1
  let a = ram[Effect];
  const lsrReq = () => { const c = ram[EffectRequest] & 1; ram[EffectRequest] >>= 1; return c; };
  const lsrA = () => { const c = a & 1; a >>= 1; return c; };
  if ($br('Z_00:311', lsrReq() !== 0)) return PlaySwordSfx(x, y);
  if ($br('Z_00:313', lsrA() !== 0)) return ContinueSwordSfx(x);
  if ($br('Z_00:315', lsrReq() !== 0)) return PlayArrowSfx(x, y);
  if ($br('Z_00:317', lsrA() !== 0)) return ContinueArrowSfx(x);
  if ($br('Z_00:319', lsrReq() !== 0)) return PlayFlameSfx(x, y);
  if ($br('Z_00:321', lsrA() !== 0)) return ContinueFlameSfx(x);
  if ($br('Z_00:323', lsrReq() !== 0)) return PlayStairsSfx(x, y);
  if ($br('Z_00:325', lsrA() !== 0)) return ContinueStairsSfx(x);
  if ($br('Z_00:327', lsrReq() !== 0)) return PlayBombSfx(x, y);
  if ($br('Z_00:329', lsrA() !== 0)) return ContinueBombSfx(x);
  if ($br('Z_00:331', lsrA() !== 0)) return ContinueSeaSfx(x);
  if ($br('Z_00:333', lsrReq() !== 0)) return PlaySeaSfx(x, y);
  return x;
}

/** DriveEffect@SilenceSample (Z_00) */
export function SilenceSample(x) {
  // SilenceSample (Z_00)
  write(ApuStatus_4015, 0x0f);
  ram[Sample] = 0;
  ram[Tune1] = 0;
  ram[0x061a] = 0;
  ram[BackgroundSample] = 0;
  return x;
}

/** PlayArrowSfx (Z_00, part of DriveEffect) */
export function PlayArrowSfx(x, y) {
  // PlayArrowSfx (Z_00)
  ram[Effect] = y;
  ram[EffectCounter] = 0x05;
  // If "heart taken" is requested in tune channel 0, then cancel it.
  const a = ram[Tune0Request] & 0xef;
  if (!$br('Z_00:241', a !== 0)) ram[Tune0Request] = a;
  return ContinueArrowSfx(x);
}

/** ContinueArrowSfx (Z_00, part of DriveEffect) */
export function ContinueArrowSfx(x) {
  // ContinueArrowSfx (Z_00)
  const y = ram[EffectCounter];
  $pxa('Z_00:246', table(rom(), 'ArrowSfxNotes').addr - 1, y);
  const a = table(rom(), 'ArrowSfxNotes').byte(y - 1);
  if ($br('Z_00:247', a !== 0)) return PlaySfxNote(a);
  return PlayStairsSfx(x, y); // falls through
}

/** PlayStairsSfx (Z_00, part of DriveEffect) */
export function PlayStairsSfx(x, y) {
  // PlayStairsSfx (Z_00)
  ram[Effect] = y;
  ram[EffectCounter] = 0x38;
  ram[STEP] = 0x0d; // the sound of one step lasts $C frames
  return ContinueStairsSfx(x);
}

/** ContinueStairsSfx (Z_00, part of DriveEffect) */
export function ContinueStairsSfx(x) {
  // ContinueStairsSfx (Z_00)
  let y;
  for (;;) {
    ram[STEP]--;
    y = ram[STEP];
    if (!$br('Z_00:260', y === 0)) break;
    ram[STEP] = 0x0d;
  }
  if (!$br('Z_00:262', y < 0x07)) { $br('Z_00:264', true); return SetSfxVolumeLength(0x10, x); }
  $pxa('Z_00:266', table(rom(), 'StairsSfxNotes').addr - 1, y);
  return PlaySfxNote(table(rom(), 'StairsSfxNotes').byte(y - 1));
}

/** PlaySfxNote (Z_00, part of DriveEffect): A = note (high nibble volume, low nibble period). */
export function PlaySfxNote(a) {
  // PlaySfxNote (Z_00)
  const x = a; // TAX
  write(NoisePeriod_400E, a & 0x0f);
  a = (x >> 4) | 0x10;
  return SetSfxVolumeLength(a, x);
}

/** SetSfxVolumeLength (Z_00): A = noise volume. Returns X. */
export function SetSfxVolumeLength(a, x) {
  // SetSfxVolumeLength (Z_00)
  write(NoiseVolume_400C, a);
  write(NoiseLength_400F, 0x08);
  ram[EffectCounter]--;
  return SilenceSfxIfEnded(ram[EffectCounter] === 0, x);
}

/**
 * SilenceSfxIfEnded (Z_00)
 * @param {boolean} z the Z flag of the caller's DEC (counter reached 0)
 * @returns {number} X
 */
export function SilenceSfxIfEnded(z, x) {
  // SilenceSfxIfEnded (Z_00)
  if (!$br('Z_00:286', !z)) {
    write(NoiseVolume_400C, 0xf0);
    ram[Effect] = 0;
  }
  return x;
}

/** PlaySwordSfx (Z_00, part of DriveEffect) */
export function PlaySwordSfx(x, y) {
  // PlaySwordSfx (Z_00)
  ram[Effect] = y;
  ram[EffectCounter] = 0x0a;
  return ContinueSwordSfx(x);
}

/** ContinueSwordSfx (Z_00, part of DriveEffect) */
export function ContinueSwordSfx(x) {
  // ContinueSwordSfx (Z_00)
  const y = ram[EffectCounter];
  $pxa('Z_00:301', table(rom(), 'SwordSfxNotes').addr - 1, y);
  const a = table(rom(), 'SwordSfxNotes').byte(y - 1);
  if ($br('Z_00:302', a !== 0)) return PlaySfxNote(a);
  return DriveEffect(x); // falls through
}

/** DriveEffect@PlayBombSfx (Z_00) */
export function PlayBombSfx(x, y) {
  // DriveEffect@PlayBombSfx (Z_00)
  ram[Effect] = y;
  ram[EffectCounter] = 0x18;
  return ContinueBombSfx(x);
}

/** DriveEffect@ContinueBombSfx (Z_00) */
export function ContinueBombSfx(x) {
  // DriveEffect@ContinueBombSfx (Z_00)
  const y = ram[EffectCounter];
  $pxa('Z_00:343', table(rom(), 'BombSfxNotes').addr - 1, y);
  const a = table(rom(), 'BombSfxNotes').byte(y - 1);
  if ($br('Z_00:344', a !== 0)) return PlaySfxNote(a);
  return PlayFlameSfx(x, y); // falls through
}

/** DriveEffect@PlayFlameSfx (Z_00) */
export function PlayFlameSfx(x, y) {
  // DriveEffect@PlayFlameSfx (Z_00)
  ram[Effect] = y;
  ram[EffectCounter] = 0x20;
  return ContinueFlameSfx(x);
}

/** DriveEffect@ContinueFlameSfx (Z_00) */
export function ContinueFlameSfx() {
  // DriveEffect@ContinueFlameSfx (Z_00)
  const y = ram[EffectCounter] >> 1;
  const x = 0x0e;
  write(NoisePeriod_400E, x);
  $pxa('Z_00:357', table(rom(), 'FlameSfxNotes').addr - 1, y);
  return SetSfxVolumeLength(table(rom(), 'FlameSfxNotes').byte(y - 1), x);
}

/** DriveEffect@PlaySeaSfx (Z_00) */
export function PlaySeaSfx(x, y) {
  // DriveEffect@PlaySeaSfx (Z_00)
  ram[Effect] = y;
  ram[SeaSfxCounter] = 0xd0;
  ram[STEP] = 0x10; // the volume begins and ends at $10
  return ContinueSeaSfx(x);
}

/** DriveEffect@ContinueSeaSfx (Z_00) */
export function ContinueSeaSfx() {
  // DriveEffect@ContinueSeaSfx (Z_00)
  let fast = false;
  if (!$br('Z_00:370', ram[SeaSfxCounter] < 0xbf)) {
    // Counter >= $BF: increase volume fast.
    ram[STEP]++;
    fast = $br('Z_00:374', ram[STEP] !== 0); // BNE @SetSeaSfxParams, else falls into the slow path
  }
  if (!fast) {
    // Decrease volume slowly down to $10 when (counter MOD 8) = 7.
    const c = ram[SeaSfxCounter];
    if (!$br('Z_00:380', !(c & 1)) && !$br('Z_00:382', !(c & 2)) && !$br('Z_00:384', !(c & 4)) &&
      !$br('Z_00:387', ram[STEP] === 0x10)) ram[STEP]--;
  }
  // @SetSeaSfxParams
  write(NoiseVolume_400C, ram[STEP]);
  const x = 0x03;
  write(NoisePeriod_400E, x);
  write(NoiseLength_400F, 0x08);
  ram[SeaSfxCounter]--;
  return SilenceSfxIfEnded(ram[SeaSfxCounter] === 0, x);
}
