// P10 items — the room item, item objects and lifting items (Z_07, Z_01 BANK_01_CODE, Z_04).
//
// Contracts:
//   GetShortcutOrItemXY():           returns {a, y}: A = X, Y = Y coordinate of the shortcut (OW) or item (UW).
//   GetShortcutOrItemXYForRoom(y):   same for room Y.
//   GetRoomFlagUWItemState():        returns A = $10 if the room item was taken, else 0 (Y = RoomId,
//                                    [$08:09] = LevelInfo_WorldFlagsAddr).
//   SetRoomFlagUWItemState():        marks the room item taken.
//   AnimateItemObject(a, x):         A = item ID, X = object slot. Returns X = [08] (DrawItemBySlot).
//   UpdateItem(x):                   X = object slot (object type $60).
//   CheckLiftItem(), MoveAndDrawRoomItem(): no parameters.

import { ram, peek } from '../../core/ram.js';
import { read, write, bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import {
  RoomId, LevelBlockAttrsF, LevelInfo_ShortcutOrItemPosArray, LevelInfo_WorldFlagsAddr, ObjX, ObjY,
  ObjState, ObjType, RoomItemId, Item_ObjItemLifetime, Item_ObjItemId, ItemTypeToLift, ItemLiftTimer,
  LeftSpriteOffset, RightSpriteOffset, LeftAlignHalfWidthObj, ProcessedNarrowObj, Sprites, CurLevel,
  SongRequest, FrameCounter, CurObjIndex,
} from '../../core/vars.js';
import { GetRoomFlags } from '../world/roomflags.js';
import { Anim_FetchObjPosForSpriteDescriptor } from '../draw/anim.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { Anim_WriteSpecificItemSprites } from '../draw/items.js';
import { DrawItemBySlot } from '../hud/statusbar.js';
import { DestroyMonster_Bank4 } from '../objects/slots.js';
import { TryTakeItem } from './take.js';
import { UpdateFairyObject } from './fairy.js';

const wram = (name, i) => peek(label(name).addr + i); // BANK_01_CODE data, read in WRAM

// ------------------------------------------------------------------ room item position and flags (Z_01)

/** GetShortcutOrItemXY (Z_01). @returns {a, y}: A = X, Y = Y coordinate (falls into ...ForRoom) */
export function GetShortcutOrItemXY() {
  // GetShortcutOrItemXY (Z_01)
  return GetShortcutOrItemXYForRoom(ram[RoomId]);
}

/** GetShortcutOrItemXYForRoom (Z_01): Y = room ID. @returns {a, y} */
export function GetShortcutOrItemXYForRoom(y) {
  // GetShortcutOrItemXYForRoom (Z_01)
  y = (peek(LevelBlockAttrsF + y) & 0x30) >> 4; // one of the 4 positions
  const pos = peek(LevelInfo_ShortcutOrItemPosArray + y); // PHA
  y = ((pos & 0x0f) << 4) & 0xff;
  return { a: pos & 0xf0, y };
}

/** SetRoomFlagUWItemState (Z_01): room flags |= $10 (item taken). */
export function SetRoomFlagUWItemState() {
  // SetRoomFlagUWItemState (Z_01)
  const a = GetRoomFlags() | 0x10;
  write((((ram[0x01] << 8) | ram[0x00]) + ram[RoomId]) & 0xffff, a); // STA ($00),Y
}

/** GetRoomFlagUWItemState (Z_01). @returns A = $10 if the item was taken, else 0 */
export function GetRoomFlagUWItemState() {
  // GetRoomFlagUWItemState (Z_01)
  ram[0x08] = peek(LevelInfo_WorldFlagsAddr);
  ram[0x09] = peek(LevelInfo_WorldFlagsAddr + 1);
  const y = ram[RoomId];
  return read((((ram[0x09] << 8) | ram[0x08]) + y) & 0xffff) & 0x10;
}

// ------------------------------------------------------------------ drawing the room item (Z_07)

/** AnimateRoomItemOnMonster (Z_07, part of MoveAndDrawRoomItem): X = 1. */
export function AnimateRoomItemOnMonster(x) {
  // AnimateRoomItemOnMonster (Z_07): put the room item where the first monster is.
  ram[ObjX + 19] = ram[ObjX + 1];
  ram[ObjY + 19] = ram[ObjY + 1];
  return AnimateRoomItemObject(x);
}

/** MoveAndDrawRoomItem (Z_07) */
export function MoveAndDrawRoomItem() {
  // MoveAndDrawRoomItem (Z_07); PopAndExit's RTS is the early exits
  if (GetRoomFlagUWItemState() !== 0) return;
  if (ram[ObjState + 19] & 0x80) return;
  if (ram[RoomItemId] === 0x3f) return; // no item
  let x = 0x01;
  const t = ram[ObjType + 1];
  if (t === 0x17 || t === 0x2a || t === 0x30) return AnimateRoomItemOnMonster(x); // like-like, stalfos, gibdo
  x = 0x13;
  return AnimateRoomItemObject(x); // falls through
}

/** AnimateRoomItemObject (Z_07): X = object slot. */
export function AnimateRoomItemObject(x) {
  // AnimateRoomItemObject (Z_07)
  return AnimateItemObject(ram[RoomItemId], x); // falls through
}

/** AnimateItemObject (Z_07): A = item ID, X = object slot. @returns X = [08] or undefined if not drawn */
export function AnimateItemObject(a, x) {
  // AnimateItemObject (Z_07)
  const id = a; // PHA
  const life = ram[Item_ObjItemLifetime + x];
  if (life >= 0xf0 && !(life & 0x01)) return PopAndExit(); // flashes at first
  Anim_FetchObjPosForSpriteDescriptor(x);
  x = id; // PLA / TAX
  a = wram('ItemIdToDescriptor', x);
  if (a === 0x30) a = 0xff; // @SetItemValueFF (unverified code 1E731)
  else a &= 0x0f;
  ram[0x04] = a; // [04] item value
  x = wram('ItemIdToSlot', x);
  return DrawItemBySlot(x, x);
}

/** PopAndExit (Z_07, part of AnimateItemObject): PLA / RTS. */
export function PopAndExit() {
  // PopAndExit (Z_07)
  return undefined;
}

// ------------------------------------------------------------------ lifting items (Z_07)

/** CheckLiftItem (Z_07) */
export function CheckLiftItem() {
  // CheckLiftItem (Z_07)
  if (ram[ItemTypeToLift] === 0) return; // L1E859_Exit
  ram[ItemLiftTimer]--;
  if (ram[ItemLiftTimer] === 0) return EndLinkLiftingItem();
  ram[ObjState] = 0x40; // halted
  return SetUpAndDrawLinkLiftingItem(); // falls through
}

/** SetUpAndDrawLinkLiftingItem (Z_07): [0505] = item type. */
export function SetUpAndDrawLinkLiftingItem() {
  // SetUpAndDrawLinkLiftingItem (Z_07)
  ram[ObjX + 19] = ram[ObjX];
  ram[ObjY + 19] = ram[ObjY] - 0x10;
  return DrawLinkLiftingItem(); // falls through
}

/** DrawLinkLiftingItem (Z_07): [0505] = item type. */
export function DrawLinkLiftingItem() {
  // DrawLinkLiftingItem (Z_07)
  let x = 0x00;
  const a = Anim_FetchObjPosForSpriteDescriptor(x);
  Anim_SetSpriteDescriptorAttributes(a); // A = 0
  ram[0x0c] = a; // frame 0
  ram[LeftSpriteOffset] = 0x48; // Link's sprites
  ram[RightSpriteOffset] = 0x4c;
  Anim_WriteSpecificItemSprites(x, 0x21);
  ram[LeftAlignHalfWidthObj]++;
  x = 0x13;
  AnimateItemObject(ram[ItemTypeToLift], x);
  ram[LeftAlignHalfWidthObj]--;
  if (ram[ProcessedNarrowObj] === 0) return; // L1E847_Exit
  ram[Sprites + 77] = 0x08; // half-width item: lift with one hand
}

/** EndLinkLiftingItem (Z_07, part of CheckLiftItem) */
export function EndLinkLiftingItem() {
  // EndLinkLiftingItem (Z_07)
  ram[ObjState] = 0x00;
  ram[ItemTypeToLift] = 0x00;
  const y = ram[CurLevel];
  if (y === 0) return; // L1E859_Exit
  ram[SongRequest] = table(bus.rom, 'LevelSongIds').byte(y);
}

// ------------------------------------------------------------------ item object ($60, Z_04)

/** UpdateItem (Z_04): X = object slot. Item lifetime, drawing, and taking by Link or his weapons. */
export function UpdateItem(x) {
  // UpdateItem (Z_04)
  if (ram[FrameCounter] & 0x01) ram[Item_ObjItemLifetime + x]--; // every other frame
  if (ram[Item_ObjItemLifetime + x] === 0) return DestroyMonster_Bank4(x);
  if (ram[Item_ObjItemId + x] === 0x23) UpdateFairyObject(x); // @AnimateFairy
  else AnimateItemObject(ram[Item_ObjItemId + x], x);
  if ((ram[ObjState] & 0xc0) === 0x40) return; // Link halted

  // Link, then the arrow, sword and boomerang slots (ItemTakerObjSlots) can take the item:
  // each active weapon lends its position to Link for TryTakeItem. Link himself checks last.
  const takers = table(bus.rom, 'ItemTakerObjSlots');
  ram[0x0d] = 0x04;
  do {
    // @LoopItemTaker
    const savedX = ram[ObjX]; // PHA
    const savedY = ram[ObjY]; // PHA
    const y = ram[0x0d];
    x = takers.byte(y - 1);
    ram[ObjX] = ram[ObjX + x];
    ram[ObjY] = ram[ObjY + x];
    const st = ram[ObjState + x];
    if (x === 0x00 || (st !== 0 && !(st & 0x80))) {
      // @TryToTake
      x = ram[CurObjIndex];
      ram[0x04] = ram[Item_ObjItemId + x];
      TryTakeItem(x);
    }
    // @SkipTaking
    ram[ObjY] = savedY;
    ram[ObjX] = savedX;
    x = ram[CurObjIndex];
    if (ram[Item_ObjItemId + x] === 0xff) return DestroyMonster_Bank4(x); // taken
    ram[0x0d]--;
  } while (ram[0x0d] !== 0);
}
