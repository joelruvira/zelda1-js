// Sound driver entry point and tune channels (Z_00): DriveAudio, DriveTune0/1, note emitters
// and VibratePitch. Package P02 (docs/PORT_MAP.md).
//
// Register contract: the original carries X across DriveTune1 -> DriveEffect -> DriveSample
// (DriveSample can emit it to $4011 on the background-sample path), so those routines take
// and return X explicitly. IsrNmi enters DriveAudio with X = $25 (end of the Random loop:
// LDX #$18 + 13 INX).

import { ram } from '../../core/ram.js';
import { bus, write } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  Paused, ApuStatus_4015, Ctrl2_FrameCtr_4017,
  Tune0Request, EffectRequest, Tune1Request, SampleRequest, SongRequest,
  Tune0, TunePtr0, Tune1, TunePtr1, NoteCounterTune1, NoteLengthTune1, CustomEnvelopeOffsetTune1,
  CurNoteLowPeriodSq0, CurNoteLowPeriodSq1, CurNoteLowPeriodTrg,
  Sq0Duty_4000, Sq0Sweep_4001, Sq0Timer_4002, Sq0Length_4003,
  Sq1Duty_4004, Sq1Sweep_4005, Sq1Timer_4006, Sq1Length_4007,
  TrgTimer_400A, TrgLength_400B,
} from '../../core/vars.js';
import { DriveEffect } from './effects.js';
import { DriveSample } from './samples.js';
import { DriveSong, SilenceSong } from './song.js';

const rom = () => bus.rom;

/** Index 1..8 of the lowest set bit of A (INY / LSR / BCC loop). A must be non-zero. */
function bitIndex(a) {
  let y = 0;
  let c;
  do {
    y = (y + 1) & 0xff;
    c = a & 1;
    a >>= 1;
  } while (!c);
  return y;
}
export { bitIndex as _bitIndex };

/**
 * DriveAudio (Z_00): one call per NMI.
 * @param {number} [x=0x25] X at the JSR in IsrNmi
 */
export function DriveAudio(x = 0x25) {
  // DriveAudio (Z_00)
  if (ram[Paused] !== 0) {
    write(ApuStatus_4015, 0x00);
    write(ApuStatus_4015, 0x0f);
  } else {
    write(Ctrl2_FrameCtr_4017, 0xff); // sync the APU frame counter
    x = DriveTune1(x);
    x = DriveEffect(x);
    x = DriveSample(x);
    DriveSong();
  }
  DriveTune0();
  ram[Tune0Request] = 0;
  ram[EffectRequest] = 0;
  ram[Tune1Request] = 0;
  ram[SampleRequest] = 0;
  ram[SongRequest] = 0;
}

/** DriveTune0 (Z_00): tune channel 0 on square 0. */
export function DriveTune0() {
  // DriveTune0 (Z_00)
  let a = ram[Tune0Request];
  if (a & 0x80) return SilenceSong(); // L18C9_SilenceSong: $80 only silences the song
  let change = false;
  if (a !== 0) {
    if (a !== 0x40) change = true;
    else if (ram[Tune0] === 0) change = true; // heart warning only if nothing else plays
  }
  if (!change) {
    // @CheckCurrentTune
    if (ram[Tune0] === 0) return;
  } else {
    // @ChangeTune
    ram[Tune0] = a;
    const y = bitIndex(a);
    ram[TunePtr0] = table(rom(), 'TuneScripts0').byte(y - 1);
  }
  // @KeepPlaying
  const scripts = table(rom(), 'TuneScripts0');
  let y = ram[TunePtr0];
  ram[TunePtr0]++;
  a = scripts.byte(y);
  if (a & 0x80) {
    // @PrepNote
    write(Sq0Duty_4000, a);
    y = ram[TunePtr0];
    ram[TunePtr0]++;
    a = scripts.byte(y);
  } else if (a === 0) {
    // End of the tune.
    write(Sq0Duty_4000, 0x90);
    write(Sq0Length_4003, 0x18);
    write(Sq0Timer_4002, 0x00);
    ram[Tune0] = 0;
    return;
  }
  // @PlayNote
  EmitSquareNote0(a);
  write(Sq0Sweep_4001, 0x7f);
}

/**
 * DriveTune1 (Z_00): tune channel 1 on square 1.
 * @param {number} x X on entry
 * @returns {number} X on exit
 */
export function DriveTune1(x) {
  // DriveTune1 (Z_00)
  let a = ram[Tune1Request];
  let change = false;
  if (a & 0x80) {
    // @SilenceThenPlay
    SilenceSong();
    a = 0x80;
    change = true;
  } else if (a !== 0) {
    change = true;
  } else {
    if (ram[Tune1] === 0) return x;
  }
  const scripts = table(rom(), 'TuneScripts1');
  for (;;) {
    if (change) {
      // @ChangeTune
      ram[Tune1] = a;
      const y = bitIndex(a);
      ram[TunePtr1] = scripts.byte(y - 1);
      ram[NoteCounterTune1] = 0x01;
      change = false;
    }
    // @KeepPlaying
    ram[NoteCounterTune1]--;
    if (ram[NoteCounterTune1] !== 0) break; // -> @CheckVibrate
    let y = ram[TunePtr1];
    ram[TunePtr1]++;
    a = scripts.byte(y);
    if (a & 0x80) {
      // @PrepNote
      ram[NoteLengthTune1] = a & 0x7f;
      y = ram[TunePtr1];
      ram[TunePtr1]++;
      a = scripts.byte(y);
    } else if (a === 0) {
      // End of the tune: "Game Over" ($40) repeats.
      a = ram[Tune1];
      if (a === 0x40) { change = true; continue; }
      write(Sq1Duty_4004, 0x90);
      write(Sq1Length_4007, 0x18);
      x = 0x00;
      ram[Tune1] = x;
      write(Sq1Timer_4006, x);
      return x;
    }
    // @PlayNote
    EmitSquareNote1(a);
    write(Sq1Sweep_4005, 0x7f);
    write(Sq1Duty_4004, 0x86);
    ram[NoteCounterTune1] = ram[NoteLengthTune1];
    ram[CustomEnvelopeOffsetTune1] = 0x1f;
    break;
  }
  // @CheckVibrate: only "flute" and "Link dying" vibrate.
  if ((ram[Tune1] & 0x90) === 0) return x;
  const y = ram[CustomEnvelopeOffsetTune1];
  if (y !== 0) ram[CustomEnvelopeOffsetTune1]--;
  write(Sq1Duty_4004, table(rom(), 'CustomEnvelopeTune1').byte(y));
  x = VibratePitch(ram[NoteCounterTune1], ram[CurNoteLowPeriodSq1]);
  write(Sq1Timer_4006, x);
  return x;
}

/** SetSq0DutyAndSweep (Z_00): X = duty byte, Y = sweep byte. */
export function SetSq0DutyAndSweep(x, y) {
  // SetSq0DutyAndSweep (Z_00)
  write(Sq0Sweep_4001, y);
  write(Sq0Duty_4000, x);
}

/** EmitSquareNoteWithDutyAndSweep0 (Z_00, unreferenced/unverified). */
export function EmitSquareNoteWithDutyAndSweep0(a, x, y) {
  // EmitSquareNoteWithDutyAndSweep0 (Z_00)
  SetSq0DutyAndSweep(x, y);
  return EmitSquareNote0(a);
}

/**
 * EmitSquareNote0 (Z_00). A = note offset in NotePeriodTable.
 * @returns {number} A: 0 (Z set) if the note is a rest; Y = the input note on exit.
 */
export function EmitSquareNote0(a) {
  // EmitSquareNote0 (Z_00)
  const periods = table(rom(), 'NotePeriodTable');
  const y = a;
  a = periods.byte(y + 1);
  if (a === 0) return 0; // Exit
  ram[CurNoteLowPeriodSq0] = a;
  write(Sq0Timer_4002, a);
  a = periods.byte(y) | 0x08;
  write(Sq0Length_4003, a);
  return a;
}

/** SetSq1DutyAndSweep (Z_00): X = duty byte, Y = sweep byte. */
export function SetSq1DutyAndSweep(x, y) {
  // SetSq1DutyAndSweep (Z_00)
  write(Sq1Duty_4004, x);
  write(Sq1Sweep_4005, y);
}

/** EmitSquareNoteWithDutyAndSweep1 (Z_00, unreferenced/unverified). */
export function EmitSquareNoteWithDutyAndSweep1(a, x, y) {
  // EmitSquareNoteWithDutyAndSweep1 (Z_00)
  SetSq1DutyAndSweep(x, y);
  return EmitSquareNote1(a);
}

/**
 * EmitSquareNote1 (Z_00). A = note ID.
 * @returns {number} A: 0 (Z set) if the note is a rest; Y = the note ID on exit.
 */
export function EmitSquareNote1(a) {
  // EmitSquareNote1 (Z_00)
  const periods = table(rom(), 'NotePeriodTable');
  const y = a;
  a = periods.byte(y + 1);
  if (a === 0) return 0; // Exit
  ram[CurNoteLowPeriodSq1] = a;
  write(Sq1Timer_4006, a);
  a = periods.byte(y) | 0x08;
  write(Sq1Length_4007, a);
  return a;
}

/**
 * EmitTriangleNote (Z_00). A = note offset.
 * @returns {number} A: 0 if the note is a rest.
 */
export function EmitTriangleNote(a) {
  // EmitTriangleNote (Z_00)
  const periods = table(rom(), 'NotePeriodTable');
  const y = a;
  a = periods.byte(y + 1);
  if (a === 0) return 0; // Exit
  ram[CurNoteLowPeriodTrg] = a;
  write(TrgTimer_400A, a);
  a = periods.byte(y) | 0x08;
  write(TrgLength_400B, a);
  return a;
}

/**
 * VibratePitch (Z_00): A = note counter, X = period.
 * @returns {number} X: period, period+1 or period-1 (unchanged if counter < $10)
 */
export function VibratePitch(a, x) {
  // VibratePitch (Z_00)
  if (a < 0x10) return x;
  if (((a >> 2) & 1) === 0) {
    // Carry clear after the third LSR: TXA / ADC #$01 (C=0)
    const r = (x + 1) & 0xff;
    if (r !== 0) return r;
    // BNE not taken ($FF+1 = 0): falls into @GoDown with X unchanged.
  }
  // @GoDown: TXA / CLC / ADC #$FF
  return (x + 0xff) & 0xff;
}
