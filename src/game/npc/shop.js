// P15 npc — shops, hint caves and the money-making game (Z_01): price list transfer records,
// sign handling, and paying / winning rupees.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import {
  CaveFlags, CavePrices, CaveCurPriceIndex, CaveCurPriceOffset, CaveChosenIndex, DynTileBuf, ObjTimer,
  ObjState, ObjType, PersonTextSelector, PersonTextPtr, PersonTextIndex, Tune0Request, InvRupees,
  MoneyGameAmounts, RupeesToAdd, RupeesToSubtract,
} from '../../core/vars.js';
import { FormatDecimalByte } from '../text/format.js';
import { SetRoomFlagUWItemState } from '../items/roomitem.js';
import { CueTransferBufAndAdvanceState, IncCaveState } from './textbox.js';
import { ClearPricesCaveFlag } from './cave.js';
import { $br, $pxa } from '../../core/timing.js';

/** UpdateCavePersonState_TransferPrices (Z_01): state 0. Falls into WritePricesTransferBuf. */
export function UpdateCavePersonState_TransferPrices() {
  // UpdateCavePersonState_TransferPrices (Z_01)
  if ($br('Z_01:455', (ram[CaveFlags] & 0x08) === 0)) return IncCaveState(); // no "show prices"
  return WritePricesTransferBuf();
}

/** WritePricesTransferBuf (Z_01): price list with an "X" before the prices. */
export function WritePricesTransferBuf() {
  // WritePricesTransferBuf (Z_01)
  CopyPriceListTemplate();
  return WritePricesToDynamicTransferBuf(0x21); // "X"
}

/** WritePricesToDynamicTransferBuf (Z_01): A = price character. Falls into IncCaveState. */
export function WritePricesToDynamicTransferBuf(a) {
  // WritePricesToDynamicTransferBuf (Z_01)
  ram[DynTileBuf + 3] = a;
  let x = 0x00;
  ram[CaveCurPriceIndex] = x;
  ram[CaveCurPriceOffset] = x;
  do {
    $pxa('Z_01:475', CavePrices, x);
    a = ram[CavePrices + x];
    if (!$br('Z_01:478', a !== 0)) {
      x = 0x24;
      ram[0x01] = x;
      ram[0x02] = x;
      ram[0x03] = x;
    } else {
      FormatDecimalByte(a);
      x = 0x24;
      if (!$br('Z_01:493', (ram[CaveFlags] & 0x80) === 0)) x = 0x62; // negative amounts: "-"
    }
    // @Align: move the sign next to the number.
    ram[0x04] = x;
    const y = ram[CaveCurPriceOffset];
    ram[DynTileBuf + 6 + y] = SwapSpaceAndSign(ram[0x02]);
    ram[DynTileBuf + 5 + y] = SwapSpaceAndSign(ram[0x01]);
    ram[DynTileBuf + 7 + y] = ram[0x03];
    ram[CaveCurPriceOffset] = ram[CaveCurPriceOffset] + 0x04;
    ram[CaveCurPriceIndex]++;
    x = ram[CaveCurPriceIndex];
  } while ($br('Z_01:520', x !== 0x03));
  ram[ObjTimer + 1] = 0x0a; // delay at the start of the next state
  $br('Z_01:527', true);
  return IncCaveState();
}

/**
 * SwapSpaceAndSign (Z_01). A = a price character, [04] = prefix character.
 * @returns A: the character, or the prefix if the character was a space (then [04] = space)
 */
export function SwapSpaceAndSign(a) {
  // SwapSpaceAndSign (Z_01)
  if (!$br('Z_01:553', a !== 0x24)) {
    const x = a;
    a = ram[0x04];
    ram[0x04] = x;
  }
  return a;
}

/** CopyPriceListTemplate (Z_01): $11 bytes of PriceListTemplateTransferBuf to DynTileBuf. */
export function CopyPriceListTemplate() {
  // CopyPriceListTemplate (Z_01)
  const t = table(bus.rom, 'PriceListTemplateTransferBuf');
  for (let y = 0x10; ; y--) {
    $pxa('Z_01:564', t.addr, y);
    ram[DynTileBuf + y] = t.byte(y);
    if (!$br('Z_01:567', y - 1 >= 0)) break;
  }
}

/** UpdateCavePersonState_HintOrMoneyGame (Z_01): state 5 (hint, moblin giveaway, money game). */
export function UpdateCavePersonState_HintOrMoneyGame() {
  // UpdateCavePersonState_HintOrMoneyGame (Z_01)
  if (!$br('Z_01:868', (ram[CaveFlags] & 0x10) === 0)) {
    // Hint: selector by cave type ($75: first set) and the chosen item.
    let a = $br('Z_01:875', ram[ObjType + 1] === 0x75) ? 0x00 : 0x03;
    const y = (a + ram[CaveChosenIndex]) & 0xff;
    $pxa('Z_01:886', label('HintCaveTextSelectors0').addr, y);
    ram[PersonTextSelector] = table(bus.rom, 'HintCaveTextSelectors0').byte(y);
    ram[PersonTextPtr] = table(bus.rom, 'TextboxLineAddrsLo').byte(2);
    ram[PersonTextIndex] = 0x00;
    ClearPricesCaveFlag();
    return CueTransferBufAndAdvanceState(0x1e); // blank textbox lines
  }
  // @HandleMoneyGameOrGiveaway
  if (!$br('Z_01:906', ram[ObjType + 1] < 0x7b)) {
    // A moblin giving away money.
    CopyPriceListTemplate();
    WritePricesToDynamicTransferBuf(0x24); // a space instead of "X"
    ram[Tune0Request] = 0x08; // "key taken"
    SetRoomFlagUWItemState();
    ram[ObjState + 1] = 0x08;
    return PostCredit(ram[CavePrices + 1]);
  }
  // @HandleMoneyGame
  if ($br('Z_01:931', ram[InvRupees] < 0x0a)) return; // L493A_Exit
  ram[Tune0Request] = 0x08;
  for (let y = 0x02; ; y--) {
    $pxa('Z_01:938', MoneyGameAmounts, y);
    ram[CavePrices + y] = ram[MoneyGameAmounts + y];
    if (!$br('Z_01:941', y - 1 >= 0)) break;
  }
  WritePricesTransferBuf();
  ram[ObjState + 1] = 0x08;
  PrependSignToPrice(ram[MoneyGameAmounts + 0], 0x01);
  PrependSignToPrice(ram[MoneyGameAmounts + 1], 0x05);
  PrependSignToPrice(ram[MoneyGameAmounts + 2], 0x09);
  const x = ram[CaveChosenIndex];
  $pxa('Z_01:962', MoneyGameAmounts, x);
  const a = ram[MoneyGameAmounts + x];
  if ($br('Z_01:964', a === 0x14)) return PostCredit(a);
  if ($br('Z_01:966', a !== 0x32)) return PostDebit(a);
  return PostCredit(a); // falls through
}

/** PostCredit (Z_01): A = amount to add to RupeesToAdd. */
export function PostCredit(a) {
  // PostCredit (Z_01)
  ram[RupeesToAdd] = a + ram[RupeesToAdd];
}

/** PostDebit (Z_01): A = amount to add to RupeesToSubtract. */
export function PostDebit(a) {
  // PostDebit (Z_01)
  ram[RupeesToSubtract] = a + ram[RupeesToSubtract];
}

/**
 * PrependSignToPrice (Z_01): A = amount, Y = offset after the "X". "+" for 20/50, else "-".
 * Falls into UpdateCavePersonState_DoNothing (RTS).
 */
export function PrependSignToPrice(a, y) {
  // PrependSignToPrice (Z_01)
  let x = 0x64; // "+"
  if (!$br('Z_01:994', a === 0x14) && !$br('Z_01:996', a === 0x32)) x = 0x62; // "-"
  ram[DynTileBuf + 4 + y] = x;
}
