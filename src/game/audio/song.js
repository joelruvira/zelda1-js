// Song channel (Z_00): DriveSong, PlayNextPhrase, KeepPlayingSong (and its tail
// ApplySq1Effects / square 0 / triangle / noise), SilenceSong, note-length helpers and
// volume envelopes. Package P02.
//
// Song scripts are read through the bus at (SongScriptPtrLo),Y, so bank 0 must be mapped
// at $8000 (IsrNmi does SwitchBank 0 before DriveAudio), exactly as in the original.

import { ram, cpu, word } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  SongRequest, Song, SongPhraseIndex, NoteLengthTableBase, SongScriptPtrLo,
  NoteOffsetSongTrg, NoteOffsetSongSq0, NoteOffsetSongSq1, NoteOffsetSongNoise, FirstNoteIndexSongNoise,
  SongEnvelopeSelector, NoteCounterSongSq1, NoteCounterSongSq0, NoteCounterSongTrg, NoteCounterSongNoise,
  NoteLengthSongSq1, NoteLengthSongSq0, NoteLengthSongTrg,
  CustomEnvelopeOffsetSongSq1, CustomEnvelopeOffsetSongSq0,
  SongVibrationCounterSq1, SongVibrationCounterSq0, SongVibrationCounterTrg,
  SongRepetitionsTrg, SongRepeatStartOffset,
  Tune0, Tune1, CurNoteLowPeriodSq0, CurNoteLowPeriodSq1, CurNoteLowPeriodTrg,
  ApuStatus_4015, Sq0Duty_4000, Sq0Sweep_4001, Sq0Timer_4002,
  Sq1Duty_4004, Sq1Sweep_4005, Sq1Timer_4006, TrgLinear_4008, TrgTimer_400A,
  NoiseVolume_400C, NoisePeriod_400E, NoiseLength_400F,
} from '../../core/vars.js';
import {
  _bitIndex as bitIndex, EmitSquareNote0, EmitSquareNote1, EmitTriangleNote,
  SetSq0DutyAndSweep, SetSq1DutyAndSweep, VibratePitch,
} from './driver.js';

const SONG_ATTR = 0x05f1; // [05F1]: header byte 7 (unnamed in the asm); bit 7 = staccato triangle
const UNK_061A = 0x061a;
export { UNK_061A as _UNK_061A };

const rom = () => bus.rom;
/** LDA (SongScriptPtrLo), Y */
const script = (y) => read((word(SongScriptPtrLo) + y) & 0xffff);
/** LDY offset / INC offset / LDA (SongScriptPtrLo), Y */
function nextByte(offsetVar) {
  const y = ram[offsetVar];
  ram[offsetVar]++;
  return script(y);
}

/** DriveSong (Z_00) */
export function DriveSong() {
  // DriveSong (Z_00)
  let a = ram[SongRequest];
  if (a === 0) {
    if (ram[Song] !== 0) return KeepPlayingSong(); // KeepPlaying: JMP KeepPlayingSong
    return;
  }
  // @ChangeSong
  ram[Song] = a;
  let y;
  if (a & 0x80) y = 0x19; // @PlayFirstDemoPhrase
  else if (a === 0x06) return PrepPhrase(0x24);
  else if (a === 0x01) y = 0x08; // @PlayFirstOverworldPhrase
  else if (a === 0x40) y = 0x0f; // @PlayFirstUnderworldPhrase
  else if (a === 0x10) y = 0x11;
  else return PlayNextPhrase(a);
  return SetPrevPhraseIndex(a, y);
}

/** SetPrevPhraseIndex (Z_00, part of DriveSong): Y = phrase index - 1; A = song. */
export function SetPrevPhraseIndex(a, y) {
  // SetPrevPhraseIndex (Z_00)
  ram[SongPhraseIndex] = y;
  return PlayNextPhrase(a);
}

/** PlayNextPhrase (Z_00): A = song (bit set). */
export function PlayNextPhrase(a) {
  // PlayNextPhrase (Z_00)
  for (;;) {
    const x = a; // TAX
    let first, limit;
    if (x & 0x80) { limit = 0x24; first = 0x19; } // @PlayNextDemoPhrase
    else if (a === 0x01) { limit = 0x10; first = 0x09; } // @PlayNextOverworldPhrase
    else if (a === 0x40) { limit = 0x12; first = 0x0f; } // @PlayNextUnderworldPhrase
    else if (a === 0x10) { limit = 0x1a; first = 0x14; } // ending
    else {
      // @PlaySinglePhraseSong: index of the song bit, 2 to 6.
      return PrepPhrase(bitIndex(x));
    }
    ram[SongPhraseIndex]++;
    const y = ram[SongPhraseIndex];
    if (y !== limit) return PrepPhrase(y);
    ram[SongPhraseIndex] = first; // SetPrevPhraseIndex, then PlayNextPhrase again
  }
}

/** PrepPhrase (Z_00, part of PlayNextPhrase): Y = phrase number (1-based). */
export function PrepPhrase(y) {
  // PrepPhrase (Z_00)
  const t = table(rom(), 'SongTable');
  y = t.byte(y - 1);
  ram[NoteLengthTableBase] = t.byte(y);
  ram[SongScriptPtrLo] = t.byte(y + 1);
  ram[SongScriptPtrLo + 1] = t.byte(y + 2); // SongScriptPtrHi
  ram[NoteOffsetSongTrg] = t.byte(y + 3);
  ram[NoteOffsetSongSq0] = t.byte(y + 4);
  const a = t.byte(y + 5);
  ram[NoteOffsetSongNoise] = a;
  ram[FirstNoteIndexSongNoise] = a;
  ram[SongEnvelopeSelector] = t.byte(y + 6);
  ram[SONG_ATTR] = t.byte(y + 7);
  ram[NoteCounterSongSq1] = 0x01;
  ram[NoteCounterSongSq0] = 0x01;
  ram[NoteCounterSongTrg] = 0x01;
  ram[NoteCounterSongNoise] = 0x01;
  ram[NoteOffsetSongSq1] = 0x00; // LSR of 1
  return KeepPlayingSong();
}

/** KeepPlayingSong (Z_00): one frame of the song on all four channels. */
export function KeepPlayingSong() {
  // KeepPlayingSong (Z_00)
  ram[NoteCounterSongSq1]--;
  if (ram[NoteCounterSongSq1] !== 0) return ApplySq1Effects();
  const a = nextByte(NoteOffsetSongSq1);
  if (a === 0) {
    // @SongEnded: songs that repeat play again.
    const r = ram[Song] & 0xf1;
    if (r !== 0) return PlayNextPhrase(r); // PlayAgain
    return SilenceSong();
  }
  if (a & 0x80) return PrepNote(a);
  return PlayNote(a);
}

/** SilenceSong (Z_00) */
export function SilenceSong() {
  // SilenceSong (Z_00)
  ram[Song] = 0;
  write(ApuStatus_4015, 0x00);
  write(ApuStatus_4015, 0x0f);
}

/** PrepNote (Z_00, part of KeepPlayingSong): A = length control byte. */
export function PrepNote(a) {
  // PrepNote (Z_00)
  ram[NoteLengthSongSq1] = GetSongNoteLength(a);
  return PlayNote(nextByte(NoteOffsetSongSq1));
}

/** PlayNote (Z_00, part of KeepPlayingSong): A = note for square 1. */
export function PlayNote(a) {
  // PlayNote (Z_00)
  // If something is playing in tune channel 1, don't play a square note here.
  if (ram[Tune1] === 0) {
    let x = 0; // LDX Tune1
    let y = a;
    a = EmitSquareNote1(a);
    if (a !== 0) ({ a, x, y } = PrepareCustomSongEnvelope());
    ram[CustomEnvelopeOffsetSongSq1] = a;
    SetSq1DutyAndSweep(x, y);
    ram[SongVibrationCounterSq1] = 0;
  }
  // @SkipSq1
  ram[NoteCounterSongSq1] = ram[NoteLengthSongSq1];
  return ApplySq1Effects();
}

/** ApplySq1Effects (Z_00, part of KeepPlayingSong): envelopes and the other channels. */
export function ApplySq1Effects() {
  // ApplySq1Effects (Z_00)
  if (ram[Tune1] === 0) {
    ram[SongVibrationCounterSq1]++;
    const y = ram[CustomEnvelopeOffsetSongSq1];
    if (y !== 0) ram[CustomEnvelopeOffsetSongSq1]--;
    write(Sq1Duty_4004, ShapeSongVolume(y));
    write(Sq1Sweep_4005, 0x7f);
    if (ram[Song] & 0x80) {
      // The demo/title song ($80) vibrates the pitch.
      write(Sq1Timer_4006, VibratePitch(ram[SongVibrationCounterSq1], ram[CurNoteLowPeriodSq1]));
    }
  }
  handleSq0();
  handleTrg();
  return handleNoise();
}

// ApplySq1Effects@HandleSq0 .. @ApplySq0Effects
function handleSq0() {
  if (ram[NoteOffsetSongSq0] === 0) return;
  ram[NoteCounterSongSq0]--;
  if (ram[NoteCounterSongSq0] === 0) {
    let a = nextByte(NoteOffsetSongSq0);
    if (a & 0x80) {
      ram[NoteLengthSongSq0] = GetSongNoteLength(a);
      a = nextByte(NoteOffsetSongSq0);
    }
    // @PlaySq0
    if (ram[Tune0] === 0) {
      let x = 0; // LDX Tune0
      let y = a;
      a = EmitSquareNote0(a);
      if (a !== 0) ({ a, x, y } = PrepareCustomSongEnvelope());
      ram[CustomEnvelopeOffsetSongSq0] = a;
      SetSq0DutyAndSweep(x, y);
      ram[SongVibrationCounterSq0] = 0;
    }
    // @SkipSq0
    ram[NoteCounterSongSq0] = ram[NoteLengthSongSq0];
  }
  // @ApplySq0Effects
  if (ram[Tune0] !== 0) return;
  ram[SongVibrationCounterSq0]++;
  const y = ram[CustomEnvelopeOffsetSongSq0];
  if (y !== 0) ram[CustomEnvelopeOffsetSongSq0]--;
  write(Sq0Duty_4000, ShapeSongVolume(y));
  if (ram[Song] & 0x80) {
    write(Sq0Timer_4002, VibratePitch(ram[SongVibrationCounterSq0], ram[CurNoteLowPeriodSq0]));
  }
  write(Sq0Sweep_4001, 0x7f);
}

// ApplySq1Effects@HandleTrg .. @SetTrgLinear
function handleTrg() {
  if (ram[NoteOffsetSongTrg] === 0) return; // JMP @HandleNoise (unverified)
  ram[NoteCounterSongTrg]--;
  let a;
  if (ram[NoteCounterSongTrg] === 0) {
    // @PrepNoteOrPassage
    for (;;) {
      a = nextByte(NoteOffsetSongTrg);
      if (a === 0) { write(TrgLinear_4008, a); return; } // @SetTrgLinear
      if (!(a & 0x80)) break; // @PlayNoteTrg
      if (a === 0xf0) {
        // @EndOfPassage
        ram[SongRepetitionsTrg]--;
        if (ram[SongRepetitionsTrg] !== 0) ram[NoteOffsetSongTrg] = ram[SongRepeatStartOffset];
        continue;
      }
      if (a < 0xf0) {
        // @PrepNoteTrg
        ram[NoteLengthSongTrg] = GetSongNoteLength(a);
        write(TrgLinear_4008, 0x1f);
        a = nextByte(NoteOffsetSongTrg);
        if (a === 0) { write(TrgLinear_4008, a); return; }
        break;
      }
      // Control note >= $F1: repeat the passage starting at the next offset (low nibble) times.
      ram[SongRepetitionsTrg] = a - 0xf0;
      ram[SongRepeatStartOffset] = ram[NoteOffsetSongTrg];
    }
    // @PlayNoteTrg
    EmitTriangleNote(a);
    ram[SongVibrationCounterTrg] = 0;
    ram[NoteCounterSongTrg] = ram[NoteLengthSongTrg];
  }
  // @ApplyTrgEffects
  ram[SongVibrationCounterTrg]++;
  write(TrgTimer_400A, VibratePitch(ram[SongVibrationCounterTrg], ram[CurNoteLowPeriodTrg]));
  write(TrgLinear_4008, (ram[SONG_ATTR] & 0x80) ? 0x1f : 0xff);
}

// ApplySq1Effects@HandleNoise: only the demo and ending songs use noise.
function handleNoise() {
  if ((ram[Song] & 0x91) === 0) return;
  ram[NoteCounterSongNoise]--;
  if (ram[NoteCounterSongNoise] !== 0) return;
  let a;
  for (;;) {
    a = nextByte(NoteOffsetSongNoise);
    if (a !== 0) break;
    // End of the track: noise always repeats.
    a = ram[FirstNoteIndexSongNoise];
    ram[NoteOffsetSongNoise] = a;
    if (a === 0) break; // BNE :- not taken: falls through with A = 0
  }
  const { a: len, x } = GetSongNoiseNoteLength(a);
  ram[NoteCounterSongNoise] = len;
  // From the original control note, extract an index 0-3 for the noise parameters.
  const y = (x & 0x3e) >> 4;
  write(NoiseVolume_400C, table(rom(), 'NoiseVolumes').byte(y));
  write(NoisePeriod_400E, table(rom(), 'NoisePeriods').byte(y));
  write(NoiseLength_400F, table(rom(), 'NoiseLengths').byte(y));
}

/**
 * GetSongNoiseNoteLength (Z_00): rotates bits 0,7,6 of the control note to bits 2,1,0.
 * @returns {{a:number, x:number}} A = note length, X = original control note
 */
export function GetSongNoiseNoteLength(a) {
  // GetSongNoiseNoteLength (Z_00)
  const x = a; // TAX
  cpu.ror(a); // only for the carry (bit 0)
  a = cpu.rol(x);
  a = cpu.rol(a);
  a = cpu.rol(a);
  return { a: GetSongNoteLength(a), x };
}

/** GetSongNoteLength (Z_00): A = control note; returns A = note length (Y = table index). */
export function GetSongNoteLength(a) {
  // GetSongNoteLength (Z_00)
  const y = ((a & 0x07) + ram[NoteLengthTableBase]) & 0xff; // CLC / ADC
  cpu.c = (a & 0x07) + ram[NoteLengthTableBase] > 0xff ? 1 : 0;
  return table(rom(), 'NoteLengthTable0').byte(y);
}

/** GetSongNoteLengthWithAbsIndex (Z_00, unreferenced/unverified). */
export function GetSongNoteLengthWithAbsIndex(a) {
  // GetSongNoteLengthWithAbsIndex (Z_00)
  return table(rom(), 'NoteLengthTable0').byte(a & 0x07);
}

/**
 * PrepareCustomSongEnvelope (Z_00)
 * @returns {{a:number, x:number, y:number}} A = starting envelope offset $20, X = duty $82, Y = sweep $7F
 */
export function PrepareCustomSongEnvelope() {
  // PrepareCustomSongEnvelope (Z_00) — the LDA SongEnvelopeSelector is overwritten at once
  return { a: 0x20, x: 0x82, y: 0x7f };
}

/** ShapeSongVolume (Z_00): Y = envelope offset; returns A = duty/volume byte. */
export function ShapeSongVolume(y) {
  // ShapeSongVolume (Z_00)
  const env = table(rom(), 'CustomEnvelopeSong');
  let a;
  if (ram[SongEnvelopeSelector] & 0x80) {
    a = env.byte(y) & 0x0f;
    if (a !== 0) return a | 0x90;
  }
  a = env.byte(y) >> 4;
  return a | 0x90;
}
