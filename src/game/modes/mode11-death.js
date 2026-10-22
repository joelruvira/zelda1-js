// Mode $11: Link's death (Z_05). Package P25.
// Early port by the wave-3 integrator of the small routines that modes 3, 7, 9, A and B share with
// mode $11 (they are used by every room transition): CueTransferPlayAreaAttrsHalfAndAdvanceSubmode(NT2)
// and UpdateMode11Death_Sub8_AnimateFade. The rest is still a stub (docs/PORT_MAP.md rule 5).
import { ram } from '../../core/ram.js';
import { GameSubmode } from '../../core/vars.js';
import { stub } from '../stub.js';
import { CopyPlayAreaAttrsHalfToDynTransferBuf } from './mode7-scroll.js';
import { AnimateWorldFading } from '../ppu/fade.js';

export const InitMode11 = stub('InitMode11');
export const UpdateMode11Death_Full = stub('UpdateMode11Death_Full');

/**
 * CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2 (Z_05): X = $2B (nametable 2), then falls into
 * CueTransferPlayAreaAttrsHalfAndAdvanceSubmode. A = low PPU address, Y = end offset in PlayAreaAttrs.
 */
export function CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2(a, x, y) {
  // CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2 (Z_05)
  return CueTransferPlayAreaAttrsHalfAndAdvanceSubmode(a, 0x2b, y);
}

/**
 * CueTransferPlayAreaAttrsHalfAndAdvanceSubmode (Z_05): X = high PPU address, A = low PPU address,
 * Y = end offset in PlayAreaAttrs. Copies the attribute half to DynTileBuf and INC GameSubmode.
 */
export function CueTransferPlayAreaAttrsHalfAndAdvanceSubmode(a, x, y) {
  // CueTransferPlayAreaAttrsHalfAndAdvanceSubmode (Z_05)
  CopyPlayAreaAttrsHalfToDynTransferBuf(a, x, y);
  ram[GameSubmode] = (ram[GameSubmode] + 1) & 0xff;
}

/** UpdateMode11Death_Sub8_AnimateFade (Z_05): AnimateWorldFading; when done, INC GameSubmode. */
export function UpdateMode11Death_Sub8_AnimateFade() {
  // UpdateMode11Death_Sub8_AnimateFade (Z_05)
  if (AnimateWorldFading() !== 0) return;
  // L14CD7_IncSubmode
  ram[GameSubmode] = (ram[GameSubmode] + 1) & 0xff;
}
