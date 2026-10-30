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
import { $br, $pxa } from '../../core/timing.js';

const SONG_ATTR = 0x05f1; // [05F1]: header byte 7 (unnamed in the asm); bit 7 = staccato triangle
const UNK_061A = 0x061a;
export { UNK_061A as _UNK_061A };

const rom = () => bus.rom;
/** LDA (SongScriptPtrLo), Y */
const script = (y) => read((word(SongScriptPtrLo) + y) & 0xffff);
/** LDY offset / INC offset / LDA (SongScriptPtrLo), Y */
function nextByte(offsetVar, ref) {
  const y = ram[offsetVar];
  ram[offsetVar]++;
  if (ref) $pxa(ref, word(SongScriptPtrLo), y);
  return script(y);
}

/** DriveSong (Z_00) */
export function DriveSong() {
  // DriveSong (Z_00)
  let a = ram[SongRequest];
  if (!$br('Z_00:699', a !== 0)) {
    if ($br('Z_00:701', ram[Song] !== 0)) return KeepPlayingSong(); // KeepPlaying: JMP KeepPlayingSong
    return;
  }
  // @ChangeSong
  ram[Song] = a;
  let y;
  if ($br('Z_00:706', (a & 0x80) !== 0)) { y = 0x19; $br('Z_00:723', true); } // @PlayFirstDemoPhrase
  else if (!$br('Z_00:708', a !== 0x06) && $br('Z_00:710', true)) return PrepPhrase(0x24);
  else if ($br('Z_00:713', a === 0x01)) y = 0x08; // @PlayFirstOverworldPhrase
  else if ($br('Z_00:715', a === 0x40)) { y = 0x0f; $br('Z_00:727', true); } // @PlayFirstUnderworldPhrase
  else if (!$br('Z_00:717', a !== 0x10)) { y = 0x11; $br('Z_00:719', true); }
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
    let first, limit, ln;
    if ($br('Z_00:737', (x & 0x80) !== 0)) { limit = 0x24; first = 0x19; ln = ['Z_00:773', 'Z_00:775']; } // @PlayNextDemoPhrase
    else if ($br('Z_00:739', a === 0x01)) { limit = 0x10; first = 0x09; ln = ['Z_00:765', 'Z_00:767']; } // @PlayNextOverworldPhrase
    else if ($br('Z_00:741', a === 0x40)) { limit = 0x12; first = 0x0f; ln = ['Z_00:757', 'Z_00:759']; } // @PlayNextUnderworldPhrase
    else if (!$br('Z_00:743', a !== 0x10)) { limit = 0x1a; first = 0x14; ln = ['Z_00:749', 'Z_00:751']; } // ending
    else {
      // @PlaySinglePhraseSong: index of the song bit, 2 to 6.
      return PrepPhrase(bitIndex(x, 'Z_00:784'));
    }
    ram[SongPhraseIndex]++;
    const y = ram[SongPhraseIndex];
    if ($br(ln[0], y !== limit)) return PrepPhrase(y);
    $br(ln[1], true);
    ram[SongPhraseIndex] = first; // SetPrevPhraseIndex, then PlayNextPhrase again
  }
}

/** PrepPhrase (Z_00, part of PlayNextPhrase): Y = phrase number (1-based). */
export function PrepPhrase(y) {
  // PrepPhrase (Z_00)
  const t = table(rom(), 'SongTable');
  $pxa('Z_00:787', t.addr - 1, y);
  y = t.byte(y - 1);
  for (let k = 0; k < 8; k++) $pxa(['Z_00:789', 'Z_00:791', 'Z_00:793', 'Z_00:795', 'Z_00:797', 'Z_00:799', 'Z_00:802', 'Z_00:804'][k], t.addr + k, y);
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
  if ($br('Z_00:816', ram[NoteCounterSongSq1] !== 0)) return ApplySq1Effects();
  const a = nextByte(NoteOffsetSongSq1, 'Z_00:819');
  if ($br('Z_00:820', a === 0)) {
    // @SongEnded: songs that repeat play again.
    const r = ram[Song] & 0xf1;
    if ($br('Z_00:828', r !== 0)) return PlayNextPhrase(r); // PlayAgain
    return SilenceSong();
  }
  if (!$br('Z_00:821', (a & 0x80) === 0) && $br('Z_00:822', true)) return PrepNote(a);
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
  return PlayNote(nextByte(NoteOffsetSongSq1, 'Z_00:846'));
}

/** PlayNote (Z_00, part of KeepPlayingSong): A = note for square 1. */
export function PlayNote(a) {
  // PlayNote (Z_00)
  // If something is playing in tune channel 1, don't play a square note here.
  if (!$br('Z_00:852', ram[Tune1] !== 0)) {
    let x = 0; // LDX Tune1
    let y = a;
    a = EmitSquareNote1(a);
    if (!$br('Z_00:854', a === 0)) ({ a, x, y } = PrepareCustomSongEnvelope());
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
  if (!$br('Z_00:870', ram[Tune1] !== 0)) {
    ram[SongVibrationCounterSq1]++;
    const y = ram[CustomEnvelopeOffsetSongSq1];
    if (!$br('Z_00:873', y === 0)) ram[CustomEnvelopeOffsetSongSq1]--;
    write(Sq1Duty_4004, ShapeSongVolume(y));
    write(Sq1Sweep_4005, 0x7f);
    if (!$br('Z_00:881', (ram[Song] & 0x80) === 0)) {
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
  if ($br('Z_00:891', ram[NoteOffsetSongSq0] === 0)) return;
  ram[NoteCounterSongSq0]--;
  if (!$br('Z_00:893', ram[NoteCounterSongSq0] !== 0)) {
    let a = nextByte(NoteOffsetSongSq0, 'Z_00:896');
    if (!$br('Z_00:897', (a & 0x80) === 0)) {
      ram[NoteLengthSongSq0] = GetSongNoteLength(a);
      a = nextByte(NoteOffsetSongSq0, 'Z_00:902');
    }
    // @PlaySq0
    if (!$br('Z_00:906', ram[Tune0] !== 0)) {
      let x = 0; // LDX Tune0
      let y = a;
      a = EmitSquareNote0(a);
      if (!$br('Z_00:908', a === 0)) ({ a, x, y } = PrepareCustomSongEnvelope());
      ram[CustomEnvelopeOffsetSongSq0] = a;
      SetSq0DutyAndSweep(x, y);
      ram[SongVibrationCounterSq0] = 0;
    }
    // @SkipSq0
    ram[NoteCounterSongSq0] = ram[NoteLengthSongSq0];
  }
  // @ApplySq0Effects
  if ($br('Z_00:922', ram[Tune0] !== 0)) return;
  ram[SongVibrationCounterSq0]++;
  const y = ram[CustomEnvelopeOffsetSongSq0];
  if (!$br('Z_00:925', y === 0)) ram[CustomEnvelopeOffsetSongSq0]--;
  write(Sq0Duty_4000, ShapeSongVolume(y));
  if (!$br('Z_00:931', (ram[Song] & 0x80) === 0)) {
    write(Sq0Timer_4002, VibratePitch(ram[SongVibrationCounterSq0], ram[CurNoteLowPeriodSq0]));
  }
  write(Sq0Sweep_4001, 0x7f);
}

// ApplySq1Effects@HandleTrg .. @SetTrgLinear
function handleTrg() {
  if (!$br('Z_00:944', ram[NoteOffsetSongTrg] !== 0)) return; // JMP @HandleNoise (unverified)
  ram[NoteCounterSongTrg]--;
  let a;
  if (!$br('Z_00:950', ram[NoteCounterSongTrg] !== 0)) {
    // @PrepNoteOrPassage
    for (;;) {
      a = nextByte(NoteOffsetSongTrg, 'Z_00:955');
      if ($br('Z_00:956', a === 0)) { write(TrgLinear_4008, a); return; } // @SetTrgLinear
      if ($br('Z_00:957', !(a & 0x80))) break; // @PlayNoteTrg
      if ($br('Z_00:959', a === 0xf0)) {
        // @EndOfPassage
        ram[SongRepetitionsTrg]--;
        if (!$br('Z_00:973', ram[SongRepetitionsTrg] === 0)) ram[NoteOffsetSongTrg] = ram[SongRepeatStartOffset];
        continue;
      }
      if ($br('Z_00:960', a < 0xf0)) {
        // @PrepNoteTrg
        ram[NoteLengthSongTrg] = GetSongNoteLength(a);
        write(TrgLinear_4008, 0x1f);
        a = nextByte(NoteOffsetSongTrg, 'Z_00:986');
        if ($br('Z_00:987', a === 0)) { write(TrgLinear_4008, a); return; }
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
  write(TrgLinear_4008, !$br('Z_00:1005', !(ram[SONG_ATTR] & 0x80)) && $br('Z_00:1007', true) ? 0x1f : 0xff);
}

// ApplySq1Effects@HandleNoise: only the demo and ending songs use noise.
function handleNoise() {
  if ($br('Z_00:1019', (ram[Song] & 0x91) === 0)) return;
  ram[NoteCounterSongNoise]--;
  if ($br('Z_00:1021', ram[NoteCounterSongNoise] !== 0)) return;
  let a;
  for (;;) {
    a = nextByte(NoteOffsetSongNoise, 'Z_00:1025');
    if ($br('Z_00:1026', a !== 0)) break;
    // End of the track: noise always repeats.
    a = ram[FirstNoteIndexSongNoise];
    ram[NoteOffsetSongNoise] = a;
    if (!$br('Z_00:1031', a !== 0)) break; // BNE :- not taken: falls through with A = 0
  }
  const { a: len, x } = GetSongNoiseNoteLength(a);
  ram[NoteCounterSongNoise] = len;
  // From the original control note, extract an index 0-3 for the noise parameters.
  const y = (x & 0x3e) >> 4;
  $pxa('Z_00:1045', table(rom(), 'NoiseVolumes').addr, y);
  write(NoiseVolume_400C, table(rom(), 'NoiseVolumes').byte(y));
  $pxa('Z_00:1047', table(rom(), 'NoisePeriods').addr, y);
  write(NoisePeriod_400E, table(rom(), 'NoisePeriods').byte(y));
  $pxa('Z_00:1049', table(rom(), 'NoiseLengths').addr, y);
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
  $pxa('Z_00:1092', table(rom(), 'NoteLengthTable0').addr, y);
  return table(rom(), 'NoteLengthTable0').byte(y);
}

/** GetSongNoteLengthWithAbsIndex (Z_00, unreferenced/unverified). */
export function GetSongNoteLengthWithAbsIndex(a) {
  // GetSongNoteLengthWithAbsIndex (Z_00)
  $pxa('Z_00:1099', table(rom(), 'NoteLengthTable0').addr, a & 0x07);
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
  if (!$br('Z_00:1151', (ram[SongEnvelopeSelector] & 0x80) === 0)) {
    $pxa('Z_00:1152', env.addr, y); a = env.byte(y) & 0x0f;
    if ($br('Z_00:1154', a !== 0)) return a | 0x90;
  }
  $pxa('Z_00:1156', env.addr, y); a = env.byte(y) >> 4;
  return a | 0x90;
}
