// Hearts refill and rupee counter (Z_01, Z_05). Package P11.

import { ram } from '../../core/ram.js';
import {
  TileBufSelector, DynTileBuf, InvRupees, Items, FrameCounter, RupeesToAdd, RupeesToSubtract,
  Tune0Request, World_IsFillingHearts, HeartPartial, HeartValues, SwordBlocked, Paused,
} from '../../core/vars.js';
import { FormatStatusBarText } from '../text/format.js';
import { CompareHeartsToContainers } from '../items/take.js';

/**
 * World_ChangeRupees (Z_01, BANK_01_CODE): every other frame move one rupee from RupeesToAdd /
 * RupeesToSubtract into InvRupees, then format the status bar text into DynTileBuf. Does nothing if
 * a transfer buffer is already pending.
 */
export function World_ChangeRupees() {
  // World_ChangeRupees (Z_01)
  if (ram[TileBufSelector] !== 0) return; // L6506_Exit
  if ((ram[DynTileBuf] & 0x80) === 0) return;
  // Reset RupeesToAdd (rupees = $FF) or RupeesToSubtract (rupees = 0).
  let y = 0x27; // RupeesToSubtract item slot
  const a = ram[InvRupees];
  let reset = a === 0;
  if (!reset) {
    y = 0x26; // RupeesToAdd item slot
    reset = a === 0xff;
  }
  if (reset) ram[Items + y] = 0x00;
  if (ram[FrameCounter] & 0x01) return;
  if (ram[RupeesToAdd] !== 0) {
    ram[RupeesToAdd]--;
    ram[InvRupees]++;
    ram[Tune0Request] = 0x10; // "heart taken" tune
  }
  if (ram[RupeesToSubtract] !== 0) {
    ram[RupeesToSubtract]--;
    ram[InvRupees]--;
    ram[Tune0Request] = 0x10;
  }
  return FormatStatusBarText(); // falls through
}

/** World_FillHearts (Z_05): while filling, add 6 to HeartPartial per frame and complete hearts. */
export function World_FillHearts() {
  // World_FillHearts (Z_05)
  if (ram[World_IsFillingHearts] === 0) return 0;
  ram[Tune0Request] = 0x10; // "heart taken" tune
  const a = ram[HeartPartial];
  if (a < 0xf8) {
    ram[HeartPartial] = a + 0x06;
    return;
  }
  // @CompleteHeart
  ram[HeartPartial] = 0x00;
  if (CompareHeartsToContainers() !== ram[0x00]) {
    ram[HeartValues]++; // @IncHearts
    return;
  }
  // Hearts = containers: make HeartPartial full and stop filling.
  ram[HeartPartial]--;
  ram[SwordBlocked] = 0x00;
  ram[World_IsFillingHearts] = 0x00;
  ram[Paused] = 0x00;
  return 0;
}
