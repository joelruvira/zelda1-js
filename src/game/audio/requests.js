// Sound requests used by the game logic (Z_01, BANK_01_CODE copied to WRAM): PlaySample,
// PlayEffect, PlayBoomerangSfx, SilenceAllSound. Package P02.

import { ram } from '../../core/ram.js';
import { SongRequest, ObjTimer, Tune0Request, EffectRequest, Tune0, Tune1 } from '../../core/vars.js';

/** PlaySample (Z_01): SampleRequest |= A. Returns A (the new request byte). */
export function PlaySample(a) {
  // PlaySample (Z_01)
  return requestSound(a, 0x01);
}

/** PlayEffect (Z_01): EffectRequest |= A. Returns A (the new request byte). */
export function PlayEffect(a) {
  // PlayEffect (Z_01)
  return requestSound(a, 0x03);
}

// The shared tail ':' of PlaySample/PlayEffect: ORA SongRequest, Y / STA SongRequest, Y
function requestSound(a, y) {
  a = (a | ram[SongRequest + y]) & 0xff;
  ram[SongRequest + y] = a;
  return a;
}

/** PlayBoomerangSfx (Z_01): Y = effect bit (2); replays every $A frames using ObjTimer+19. */
export function PlayBoomerangSfx(y) {
  // PlayBoomerangSfx (Z_01)
  if (ram[ObjTimer + 19] !== 0) return;
  PlayEffect(y);
  ram[ObjTimer + 19] = 0x0a;
}

/** SilenceAllSound (Z_01): returns A = 0. */
export function SilenceAllSound() {
  // SilenceAllSound (Z_01)
  ram[Tune0Request] = 0x80;
  ram[EffectRequest] = 0x80;
  ram[Tune0] = 0x00; // ASL
  ram[Tune1] = 0x00;
  return 0;
}
