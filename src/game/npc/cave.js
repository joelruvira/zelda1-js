// P15 npc — overworld cave people (Z_01): setup of the person, bonfires, wares and the money game
// (InitCave), the per-frame state machine (UpdateCavePerson), drawing, taking/buying items.
// Also UpdateStandingFire (Z_04), the cave/person bonfire object ($40).

import { ram, peek } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { tableJump } from '../../core/asm.js';
import {
  ObjX, ObjY, ObjHP, ObjAttr, ObjState, ObjType, ObjDir, ObjTimer, PersonTextSelector, PersonTextIndex,
  PersonTextPtr, CaveItemIds, CavePrices, CaveFlags, LevelBlockAttrsE, Random, MoneyGameAmounts,
  FrameCounter, InvLetter, SelectedItemSlot, ButtonsPressed, Tune1Request, NameCharOffset,
  RupeesToSubtract, CaveChosenIndex, InvRupees, HeartValues,
} from '../../core/vars.js';
import { GetRoomFlagUWItemState, SetRoomFlagUWItemState, AnimateItemObject } from '../items/roomitem.js';
import { TakeItem } from '../items/take.js';
import { Abs } from '../movement/math.js';
import {
  Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored, AnimateObjectWalking,
} from '../draw/anim.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { CheckLinkCollision } from '../combat/collisions.js';
import {
  UpdatePersonState_Textbox, UpdatePersonState_CueTransferBlankPersonWares, CueTransferBufAndAdvanceState,
} from './textbox.js';
import {
  UpdateCavePersonState_TransferPrices, UpdateCavePersonState_HintOrMoneyGame, PostDebit,
} from './shop.js';

/** InitCave (Z_01): X = object slot (1). Sets up the person, the bonfires and the wares. */
export function InitCave(x) {
  // InitCave (Z_01): the person goes at ($78, $80).
  SetUpCommonCaveObjects(0x78, x, 0x80);
  const t = ram[ObjType + 1];
  // Caves that remember their state (give item, door charge): taken -> no person, no text.
  if (t === 0x72 || t === 0x71 || t >= 0x7b || t < 0x6e) {
    // @TakeType
    if (GetRoomFlagUWItemState() !== 0) {
      ram[ObjType + 1] = 0x00;
      return UnhaltLink(); // falls through
    }
  }
  return InitCaveContinue();
}

/** UnhaltLink (Z_01). @returns A = 0 */
export function UnhaltLink() {
  // UnhaltLink (Z_01)
  ram[ObjState] = 0x00;
  return 0x00;
}

/** InitCaveContinue (Z_01, part of InitCave): text selector, wares, cave flags, money game amounts. */
function InitCaveContinue() {
  // InitCaveContinue (Z_01)
  let y = (ram[ObjType + 1] - 0x6a) & 0xff; // cave index
  let a = table(bus.rom, 'OverworldPersonTextSelectors').byte(y);
  ram[PersonTextSelector] = a & 0x3f;
  ram[0x03] = a & 0xc0; // "pay" and "pick up" flags
  // Offset of the first of the 3 wares: index * 3.
  a = 0xfd;
  do {
    a = (a + 0x03) & 0xff;
    y = (y - 1) & 0xff;
  } while (!(y & 0x80));
  y = a;
  for (let x = 0x00; x !== 0x03; x++) {
    // @CopyCaveBytes
    a = peek(LevelBlockAttrsE + y);
    ram[CaveItemIds + x] = a;
    ram[0x00 + x] = a & 0xc0;
    ram[CavePrices + x] = peek(LevelBlockAttrsE + 60 + y);
    y = (y + 1) & 0xff;
  }
  // ASL / ROL / ROL: top 2 bits to the bottom.
  ram[0x00] = (ram[0x03] >> 6) | ram[0x00];
  ram[0x00] = (ram[0x02] >> 4) | ram[0x00];
  a = (ram[0x01] >> 2) | ram[0x00];
  ram[CaveFlags] = a;
  if (a & 0x20) {
    // Money game: choose a permutation index 6..1 with increasing probability.
    a = 0xff;
    y = 0x06;
    do {
      if (a < ram[Random + 1]) break; // BCC @FoundPermutation
      a = (a - 0x2b) & 0xff;
      y--;
    } while (y !== 0);
    // @FoundPermutation
    let x = table(bus.rom, 'MoneyGamePermutationEndIndexes').byte(y);
    const perms = table(bus.rom, 'MoneyGamePermutations');
    for (y = 0x02; y >= 0; y--) {
      ram[0x046c + y] = perms.byte(x);
      x = (x - 1) & 0xff;
    }
    ram[0x046f] = table(bus.rom, 'MoneyGameLossAmounts').byte(ram[Random + 2] & 0x01);
    ram[0x0470] = 0x0a;
    ram[0x0471] = ram[Random + 2] & 0x02 ? 0x32 : 0x14;
    for (x = 0x02; x >= 0; x--) {
      // @ArrangeAmounts
      y = ram[0x046c + x];
      ram[MoneyGameAmounts + x] = ram[0x046f + y];
    }
  }
  // @ResetTextbox
  ram[PersonTextIndex] = 0x00;
  ram[PersonTextPtr] = table(bus.rom, 'TextboxLineAddrsLo').byte(2);
}

/** SetUpCommonCaveObjects (Z_01): A = X coordinate, X = object slot, Y = Y coordinate. Halts Link. */
export function SetUpCommonCaveObjects(a, x, y) {
  // SetUpCommonCaveObjects (Z_01)
  ram[ObjX + x] = a;
  ram[ObjY + x] = y;
  ram[ObjHP + x] = 0x00;
  ram[ObjAttr + x] = 0x81;
  ram[ObjState] = 0x40; // halt Link
  // The two bonfires.
  ram[ObjType + 2] = 0x40;
  ram[ObjType + 3] = 0x40;
  ram[ObjX + 1 + x] = 0x48;
  ram[ObjX + 2 + x] = 0xa8;
  ram[ObjY + 1 + x] = y;
  ram[ObjY + 2 + x] = y;
}

let caveHandlers;
/** UpdateCavePerson (Z_01): X = object slot (1). */
export function UpdateCavePerson(x) {
  // UpdateCavePerson (Z_01)
  // In state 4, every other frame skip drawing the person and the items.
  if (!(ram[ObjState + 1] === 0x04 && (ram[FrameCounter] & 0x01) !== 0)) {
    DrawCavePerson(x);
    // Medicine shop ($74) before the letter is used: B with the letter selected uses it.
    if (ram[ObjType + 1] === 0x74 && ram[InvLetter] !== 0x02) {
      if (ram[SelectedItemSlot] !== 0x0f || (ram[ButtonsPressed] & 0x40) === 0) {
        // @Unhalt
        if (ram[ObjState] === 0x40) UnhaltLink();
        return;
      }
      // @UseLetter
      ram[Tune1Request] = 0x04; // "secret found"
      ram[InvLetter]++;
      ram[SelectedItemSlot] = 0x07; // the potion's slot
    }
    // @DrawItems
    DrawCaveItems();
  }
  // @UpdateCavePersonDirect
  caveHandlers ??= [
    UpdateCavePersonState_TransferPrices, UpdatePersonState_Textbox,
    UpdateCavePersonState_TalkOrShopOrDoorCharge, UpdatePersonState_CueTransferBlankPersonWares,
    UpdatePersonState_DelayThenHide, UpdateCavePersonState_HintOrMoneyGame,
    UpdatePersonState_CueTransferBlankPersonWares, UpdatePersonState_Textbox,
    UpdateCavePersonState_DoNothing,
  ];
  return tableJump(label('UpdateCavePerson_JumpTable').addr, ram[ObjState + 1], caveHandlers);
}

/** DrawCavePerson (Z_01): X = object slot. Moblins (>= $7B) are not mirrored. */
export function DrawCavePerson(x) {
  // DrawCavePerson (Z_01)
  const a = Anim_FetchObjPosForSpriteDescriptor(x);
  if (ram[ObjType + 1] < 0x7b) return DrawObjectMirrored(a, x);
  return DrawObjectNotMirrored(a, x);
}

/** DrawCaveItems (Z_01): the wares (room item slot $13) and the rupee before the prices. */
export function DrawCaveItems() {
  // DrawCaveItems (Z_01)
  if (ram[CaveFlags] & 0x04) {
    // Show items: loop over the wares 2..0, indexed by [0421].
    ram[NameCharOffset] = 0x02;
    const xs = table(bus.rom, 'CaveWareXs');
    do {
      const x = ram[NameCharOffset];
      ram[ObjX + 19] = xs.byte(x);
      ram[ObjY + 19] = 0x98;
      const a = ram[CaveItemIds + x] & 0x3f;
      if (a !== 0x3f) AnimateItemObject(a, 0x13);
      // @NextWare
      ram[NameCharOffset]--;
    } while (!(ram[NameCharOffset] & 0x80));
  }
  // @ShowPriceRupee
  if ((ram[CaveFlags] & 0x08) === 0) return;
  ram[ObjX + 19] = 0x30;
  ram[ObjY + 19] = 0xab;
  AnimateItemObject(0x18, 0x13);
}

/** UpdateCavePersonState_TalkOrShopOrDoorCharge (Z_01): state 2. Talk, door charge, or wait for a pick. */
export function UpdateCavePersonState_TalkOrShopOrDoorCharge() {
  // UpdateCavePersonState_TalkOrShopOrDoorCharge (Z_01)
  if ((ram[CaveFlags] & 0x01) === 0) {
    // Not a "choose/pick up" cave: stay in state 8 showing the person.
    ram[ObjState + 1] = 0x08;
    if (ram[ObjType + 1] !== 0x71) return;
    // Door charge: 20 rupees.
    ram[RupeesToSubtract] = ram[RupeesToSubtract] + 0x14;
    return SetRoomFlagUWItemState();
  }
  // @CheckPickUp
  if (ram[RupeesToSubtract] !== 0) return;
  const xs = table(bus.rom, 'CaveWareXs');
  let x;
  for (x = 0x02; x >= 0; x--) {
    // @LoopWare
    if ((ram[CaveItemIds + x] & 0x3f) === 0x3f) continue;
    if (ram[ObjX] !== xs.byte(x)) continue;
    if (Abs((ram[ObjY] - 0x98) & 0xff) < 0x06) break;
  }
  if (x < 0) return;
  // @PickedUp
  ram[CaveChosenIndex] = x;
  let a = ram[CaveFlags] & 0x30;
  if (a !== 0) {
    if (a & 0x10) {
      // Hint: pay the price first.
      if (ram[InvRupees] < ram[CavePrices + x]) return; // Exit
      PostDebit(ram[CavePrices + x]);
    }
    // @MadeWager
    ram[ObjState + 1] = 0x05;
    return;
  }
  // @PickedUpWare
  if (ram[CaveFlags] & 0x02) {
    if (ram[InvRupees] < ram[CavePrices + x]) return; // Exit
    PostDebit(ram[CavePrices + x]);
  }
  // @TryToTake
  if (ram[CaveFlags] & 0x40) {
    // Heart container requirement: 5 for the white sword ($6C), else $C.
    const y = ram[ObjType + 1] === 0x6c ? 0x40 : 0xb0;
    if (y > ram[HeartValues]) return; // unverified code 490E
  }
  // @Take
  SetRoomFlagUWItemState();
  a = ram[CaveItemIds + x] & 0x3f; // PHA
  ram[CaveItemIds + x] = 0xff; // taken
  TakeItem(a);
  CueTransferBufAndAdvanceState(0x1e); // blank textbox lines
  ram[ObjTimer + 1] = 0x40; // delay in state 4
  return ClearPricesCaveFlag(); // falls through
}

/** ClearPricesCaveFlag (Z_01): remove "show prices" (the generic rupee). Falls into Exit (RTS). */
export function ClearPricesCaveFlag() {
  // ClearPricesCaveFlag (Z_01)
  ram[CaveFlags] = ram[CaveFlags] & 0xf7;
}

/** UpdatePersonState_DelayThenHide (Z_01): state 4. When the timer expires, remove the person. */
export function UpdatePersonState_DelayThenHide() {
  // UpdatePersonState_DelayThenHide (Z_01)
  const a = ram[ObjTimer + 1];
  if (a !== 0) return; // L493A_Exit
  ram[ObjType + 1] = a;
}

/** UpdateCavePersonState_DoNothing (Z_01): state 8. */
export function UpdateCavePersonState_DoNothing() {
  // UpdateCavePersonState_DoNothing (Z_01)
}

/** UpdateStandingFire (Z_04): X = object slot. A red, always-up walking flame. */
export function UpdateStandingFire(x) {
  // UpdateStandingFire (Z_04)
  CheckLinkCollision(x);
  Anim_SetSpriteDescriptorAttributes(0x02); // normal sprites, palette row 6 (red)
  ram[ObjDir + x] = 0x08; // up
  AnimateObjectWalking(x);
  if (ram[ObjType + x] !== 0x40) ram[0x0f] = 0x00; // unverified code 10065
  return DrawObjectNotMirrored(0x00, x); // frame image 0
}
