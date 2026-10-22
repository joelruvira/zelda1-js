// Mode 7: scroll to the neighbouring room (Z_05: InitMode7Submodes, UpdateMode7ScrollSubmode and helpers;
// InitMode7/UpdateMode7Scroll are P01 wrappers in dispatch.js). Package P13.

import { ram, peek } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  GameSubmode, GameMode, IsUpdatingMode, WhirlwindTeleportingState, WhirlwindPrevRoomId, RoomId,
  SecretColorCycle, CurOpenedDoors, PrevOpenedDoors, PrevRow, CurRow, NextRoomId, ObjDir, CurLevel,
  DynTileBuf, FadeCycle, TileBufSelector, CandleState, IsSprite0CheckActive, Sprites, LevelBlockAttrsA,
  LevelBlockAttrsB, PlayAreaAttrs, VScrollAddrLo, VScrollAddrHi, CurHScroll, CurColumn, FrameCounter,
  VScrollStartFrame, OddBaseNameTableOverride,
} from '../../core/vars.js';
import { BeginUpdateMode } from './dispatch.js';
import { DrawSpritesBetweenRooms } from './mode4-6-enterleave.js';
import { Link_EndMoveAndAnimateBetweenRooms } from '../link/anim.js';
import { CalculateNextRoom } from '../world/nextroom.js';
import { LayOutRoom, IsDarkRoom_Bank5 } from '../world/layout.js';
import { LayOutDoors } from '../world/doors-draw.js';
import { CopyRowToTileBuf, CopyColumnToTileBuf } from '../world/tilemap.js';
import { AnimatePond } from '../worldobj/pond.js';
import { AnimateWorldFading } from '../ppu/fade.js';
import { ScrollWorld } from '../hud/submenu.js';
import {
  CueTransferPlayAreaAttrsHalfAndAdvanceSubmode, CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2,
} from './mode11-death.js';

// ------------------------------------------------------------------ init (7 submodes)

let initHandlers;
export function InitMode7Submodes() {
  // InitMode7Submodes (Z_05)
  initHandlers ??= [InitMode7_Sub0, InitMode7_Sub1, InitMode7_Sub2,
    InitMode7_Sub3And4_TransferPlayAreaAttrsToNT2, InitMode7_Sub3And4_TransferPlayAreaAttrsToNT2,
    InitMode7_Sub5, InitMode7_Sub6];
  return tableJump(label('InitMode7Submodes_JumpTable').addr, ram[GameSubmode], initHandlers);
}

export function InitMode7_Sub1() {
  // InitMode7_Sub1 (Z_05)
  DrawSpritesBetweenRooms();
  Link_EndMoveAndAnimateBetweenRooms();
  ram[PrevOpenedDoors] = ram[CurOpenedDoors];
  // A doorway that is not a true door is cleared by LayOutDoors (from LayOutRoom).
  SetEnteringDoorwayAsCurOpenedDoors();
  ram[PrevRow]--; // TODO in the asm: ?
  ram[GameSubmode]++;
  CalculateNextRoom();
  if (ram[NextRoomId] & 0x80) return; // @Exit: invalid, the mode was changed to load the OW
  const saved = ram[RoomId]; // PHA
  // Only when going up is the current room drawn in NT 2; otherwise lay out the next room.
  if (ram[ObjDir] !== 0x08) ram[RoomId] = ram[NextRoomId];
  FillPlayAreaAttrs(ram[RoomId]);
  ram[CurRow] = 0x15; // start at the bottom row
  if (ram[ObjDir] === 0x08) LayOutDoorsPrev();
  else LayOutRoom();
  ram[RoomId] = saved; // @RestoreRoomId
}

/** LayOutDoorsPrev (Z_05): in UW, lay out the doors with PrevOpenedDoors as the opened doors. */
export function LayOutDoorsPrev() {
  // LayOutDoorsPrev (Z_05)
  if (ram[CurLevel] === 0) return; // OW
  const saved = ram[CurOpenedDoors];
  ram[CurOpenedDoors] = ram[PrevOpenedDoors];
  LayOutDoors();
  ram[CurOpenedDoors] = saved;
}

export function InitMode7_Sub0() {
  // InitMode7_Sub0 (Z_05)
  // Teleporting: use the room that makes it look like we scrolled to a dungeon entrance.
  if (ram[WhirlwindTeleportingState] !== 0) ram[RoomId] = ram[WhirlwindPrevRoomId];
  if (ram[SecretColorCycle] === 0) return L1433A_IncSubmode();
  return AnimatePond(); // reverse the flute secret (pond colors)
}

export function InitMode7_Sub2() {
  // InitMode7_Sub2 (Z_05): transfers the room's play area tiles to nametable 2, from the bottom row
  CopyRowToTileBuf();
  // Target NT 2 instead of NT 0 ($2100 -> $2800, +7 on the high byte).
  ram[DynTileBuf] = ((ram[DynTileBuf] & 0x0f) + 0x27) & 0xff;
  // Horizontal scroll: account for the status bar (+$100) so the play areas line up.
  if (ram[ObjDir] < 0x04) ram[DynTileBuf]++;
  ram[CurRow]--;
  if (ram[CurRow] & 0x80) return L1433A_IncSubmode();
}

/** L1433A_IncSubmode (Z_05, label in InitMode7_Sub2) */
function L1433A_IncSubmode() {
  ram[GameSubmode]++;
}

export function InitMode7_Sub3And4_TransferPlayAreaAttrsToNT2() {
  // InitMode7_Sub3And4_TransferPlayAreaAttrsToNT2 (Z_05): top half in submode 3, bottom half in 4
  // Vertical: $2BC0; horizontal: $2BD0 (64 pixels down).
  let a = (ram[ObjDir] & 0x08) || (ram[ObjDir] & 0x04) ? 0xc0 : 0xd0;
  let y = 0x17; // @TransferHalfPlayAreaAttrs
  const x = ram[GameSubmode];
  if (x !== 0x03) ({ a, y } = GetPlayAreaAttrsBottomHalfInfo(a));
  return CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2(a, x, y);
}

export function InitMode7_Sub5() {
  // InitMode7_Sub5 (Z_05)
  ram[FadeCycle] = 0x00; // in case we don't need to fade
  const dir = ram[ObjDir];
  // Horizontal: cue a row of blanks above the play area.
  if (dir < 0x04) ram[TileBufSelector] = 0x4e;
  if (dir === 0x08) {
    // @Vertical, up: lay out the next room now (the current one was drawn to NT 2).
    const saved = ram[RoomId];
    ram[RoomId] = ram[NextRoomId];
    LayOutRoom();
    ram[RoomId] = saved;
  }
  // @CheckDark
  if (IsDarkRoom_Bank5(ram[NextRoomId]) === 0) return InitMode7_Finish();
  if (IsDarkRoom_Bank5(ram[RoomId]) !== 0) {
    // @CheckIfLit: dark to dark, nothing to do unless it was lit.
    if (ram[CandleState] === 0) return InitMode7_Finish();
  }
  // @DarkenRoom: start a fade-to-black cycle.
  ram[CandleState] = 0x00;
  ram[FadeCycle] = 0x40;
  ram[GameSubmode]++;
}

export function InitMode7_Sub6() {
  // InitMode7_Sub6 (Z_05)
  if (AnimateWorldFading() !== 0) return; // L143AD_Exit: still fading
  return InitMode7_Finish();
}

/** InitMode7_Finish (Z_05, label in InitMode7_Sub6): RoomId = NextRoomId, sprite 0, start updating. */
function InitMode7_Finish() {
  ram[RoomId] = ram[NextRoomId];
  WriteAndEnableSprite0();
  BeginUpdateMode();
}

/** WriteAndEnableSprite0 (Z_05): IsSprite0CheckActive = 1; Sprites[0..3] = Sprite0Descriptor. */
export function WriteAndEnableSprite0() {
  // WriteAndEnableSprite0 (Z_05)
  ram[IsSprite0CheckActive] = 0x01;
  const desc = table(bus.rom, 'Sprite0Descriptor');
  for (let y = 3; y >= 0; y--) ram[Sprites + y] = desc.byte(y);
}

/** SetEnteringDoorwayAsCurOpenedDoors (Z_05): CurOpenedDoors = opposite of Link's direction. Uses [00]. */
export function SetEnteringDoorwayAsCurOpenedDoors() {
  // SetEnteringDoorwayAsCurOpenedDoors (Z_05)
  ram[0x00] = (ram[ObjDir] >> 1) & 0x05;
  const a = ((ram[ObjDir] << 1) & 0x0a) | ram[0x00];
  ram[CurOpenedDoors] = a;
  return a;
}

/**
 * FillPlayAreaAttrs (Z_05). A = room ID. Fills PlayAreaAttrs with the outer palette (attributes A)
 * and the inner one (attributes B). Uses [00].
 */
export function FillPlayAreaAttrs(a) {
  // FillPlayAreaAttrs (Z_05)
  const sel = table(bus.rom, 'RoomPaletteSelectorToNTAttr');
  let y = a & 0xff;
  let x = peek(LevelBlockAttrsA + y) & 0x03; // outer palette selector
  a = sel.byte(x);
  for (x = 0x2f; x >= 0; x--) ram[PlayAreaAttrs + x] = a;
  x = peek(LevelBlockAttrsB + y) & 0x03; // inner palette selector
  // Inner attributes: offsets 9 to $26, skipping the left and right edges.
  y = 0x09;
  do {
    // @LoopRow
    const col = y & 0x07;
    if (col !== 0 && col !== 0x07) {
      if (y >= 0x21) {
        // @CombineInnerOuter: inner attributes only affect the top half of the bottom row.
        ram[0x00] = sel.byte(x) & 0x0f;
        ram[PlayAreaAttrs + y] = (ram[PlayAreaAttrs + y] & 0xf0) | ram[0x00];
      } else {
        ram[PlayAreaAttrs + y] = sel.byte(x);
      }
    }
    y++; // @NextLoopRow
  } while (y < 0x27);
}

// ------------------------------------------------------------------ update (8 submodes)

export function UpdateMode7SubmodeAndDrawLink() {
  // UpdateMode7SubmodeAndDrawLink (Z_05)
  UpdateMode7ScrollSubmode();
  return Link_EndMoveAndAnimateBetweenRooms();
}

let updateHandlers;
export function UpdateMode7ScrollSubmode() {
  // UpdateMode7ScrollSubmode (Z_05)
  updateHandlers ??= [UpdateMode7Scroll_Sub0, UpdateMode7Scroll_Sub1, UpdateMode7Scroll_Sub2,
    UpdateMode7Scroll_Sub3, UpdateMode7Scroll_Sub4, UpdateMode7Scroll_Sub4And5_TransferNTAttrs,
    UpdateMode7Scroll_Sub6, UpdateMode7Scroll_Sub7];
  return tableJump(label('UpdateMode7ScrollSubmode_JumpTable').addr, ram[GameSubmode], updateHandlers);
}

export function UpdateMode7Scroll_Sub0() {
  // UpdateMode7Scroll_Sub0 (Z_05)
  ram[VScrollAddrLo] = 0x00;
  ram[CurHScroll] = 0x00;
  if (ram[ObjDir] & 0x08) return ScrollUp();
  if (!(ram[ObjDir] & 0x04)) return ScrollHorizontal();
  // Scrolling down: from $2100, the top of the play area in NT 0 (current room).
  ram[VScrollAddrHi] = 0x21;
  ram[CurRow] = 0xff; // the scrolling first increments it
  return Inc2Submodes();
}

/** Inc2Submodes (Z_05): GameSubmode += 2. */
export function Inc2Submodes() {
  // Inc2Submodes (Z_05)
  ram[GameSubmode]++;
  ram[GameSubmode]++;
}

/** ScrollHorizontal (Z_05, part of UpdateMode7Scroll_Sub0): a starting column out of the play area. */
function ScrollHorizontal() {
  let y = ram[CurLevel] !== 0 ? 0xa0 : 0xe0;
  if (ram[ObjDir] & 0x02) y = ram[CurLevel] !== 0 ? 0x81 : 0x41; // scrolling left
  ram[CurColumn] = y; // @SetColumn
  return Inc2Submodes();
}

/** ScrollUp (Z_05, part of UpdateMode7Scroll_Sub0): from $2800 (NT 2, current room); falls into Sub1. */
function ScrollUp() {
  ram[VScrollAddrHi] = 0x28;
  ram[CurRow] = 0x16; // the scrolling first decrements it
  FillPlayAreaAttrs(ram[RoomId]);
  return UpdateMode7Scroll_Sub1();
}

export function UpdateMode7Scroll_Sub1() {
  // UpdateMode7Scroll_Sub1 (Z_05)
  const { a, y } = ChooseAttrSourceAndDestForSubmode();
  return CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0(a, y);
}

/**
 * ChooseAttrSourceAndDestForSubmode (Z_05): submode 0 -> top half, else bottom half.
 * @returns {{a:number, y:number}} A = low PPU address, Y = end offset in PlayAreaAttrs
 */
export function ChooseAttrSourceAndDestForSubmode() {
  // ChooseAttrSourceAndDestForSubmode (Z_05)
  if (ram[GameSubmode] === 0) return { a: 0xd0, y: 0x17 };
  return GetPlayAreaAttrsBottomHalfInfo(0xd0); // falls through
}

/**
 * GetPlayAreaAttrsBottomHalfInfo (Z_05). A = low PPU address.
 * @returns {{a:number, y:number}} A + $18, Y = $2F (end of the second half of PlayAreaAttrs)
 */
export function GetPlayAreaAttrsBottomHalfInfo(a) {
  // GetPlayAreaAttrsBottomHalfInfo (Z_05)
  return { a: (a + 0x18) & 0xff, y: 0x2f };
}

export function UpdateMode7Scroll_Sub2() {
  // UpdateMode7Scroll_Sub2 (Z_05): VScrollStartFrame so that vertical scrolling starts next frame
  ram[GameSubmode]++;
  let a = (ram[FrameCounter] + 1) & 0x03;
  if (ram[CurLevel] === 0) a &= 0x01;
  ram[VScrollStartFrame] = a;
}

export function UpdateMode7Scroll_Sub3() {
  // UpdateMode7Scroll_Sub3 (Z_05)
  ScrollWorld();
  CopyColumnOrRowToTileBuf();
  if (ram[GameSubmode] !== 0x03) {
    // The submode advanced: invalidate current and previous row, reset the column.
    ram[CurRow] = 0xff;
    ram[PrevRow] = 0xff;
    ram[CurColumn] = 0x00;
  }
}

export function UpdateMode7Scroll_Sub6() {
  // UpdateMode7Scroll_Sub6 (Z_05)
  if (ram[CurLevel] === 0) return UpdateMode7Scroll_Sub7();
  if (IsDarkRoom_Bank5(ram[RoomId]) === 0) return UpdateMode7Scroll_Sub7();
  // CurRow = 0 tells mode 4 it may have to brighten the room (scrolled from a dark one).
  ram[CurRow] = 0x00;
  ram[GameSubmode]++;
}

export function UpdateMode7Scroll_Sub7() {
  // UpdateMode7Scroll_Sub7 (Z_05): go to mode 4 submode 1
  ram[GameSubmode] = 0x01;
  const a = 0x00; // LSR
  ram[IsUpdatingMode] = a;
  ram[0x010c] = a; // UNKNOWN in the asm: no longer used
  ram[0xe7] = a; // UNKNOWN in the asm: used for NextRoomId
  ram[IsSprite0CheckActive] = a;
  ram[GameMode] = 0x04;
}

export function UpdateMode7Scroll_Sub4() {
  // UpdateMode7Scroll_Sub4 (Z_05)
  if (!(ram[ObjDir] & 0x08)) return UpdateMode7Scroll_Sub4And5_TransferNTAttrs();
  return Inc2Submodes(); // up: go to submode 6
}

export function UpdateMode7Scroll_Sub4And5_TransferNTAttrs() {
  // UpdateMode7Scroll_Sub4And5_TransferNTAttrs (Z_05): new room's attributes to NT 0 ($23D0)
  let a = 0xd0;
  let y = 0x17;
  if (ram[GameSubmode] === 0x04) return CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0(a, y);
  // Bottom half.
  if (ram[ObjDir] < 0x04) ram[OddBaseNameTableOverride] = 0x00; // horizontal: stop using NT 1
  ({ a, y } = GetPlayAreaAttrsBottomHalfInfo(a));
  return CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0(a, y);
}

/** CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0 (Z_05). A = low PPU address, Y = end offset. */
export function CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0(a, y) {
  // CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0 (Z_05)
  return CueTransferPlayAreaAttrsHalfAndAdvanceSubmode(a, 0x23, y);
}

/** CopyColumnOrRowToTileBuf (Z_05): a row if CurRow is valid and new, else a column if 0 < CurColumn < $21. */
export function CopyColumnOrRowToTileBuf() {
  // CopyColumnOrRowToTileBuf (Z_05)
  let a = ram[CurRow];
  if (a < 0x16) {
    if (a === ram[PrevRow]) return; // don't repeat
    ram[PrevRow] = a;
    return CopyRowToTileBuf();
  }
  // @CheckColumn
  a = ram[CurColumn];
  if (a === 0 || a >= 0x21) return;
  return CopyColumnToTileBuf();
}

/**
 * CopyPlayAreaAttrsHalfToDynTransferBuf (Z_05). X = high PPU address, A = low, Y = end offset in
 * PlayAreaAttrs. Writes a $18-byte record (and its end marker) at the start of DynTileBuf.
 */
export function CopyPlayAreaAttrsHalfToDynTransferBuf(a, x, y) {
  // CopyPlayAreaAttrsHalfToDynTransferBuf (Z_05)
  ram[DynTileBuf] = x;
  ram[DynTileBuf + 1] = a;
  x = 0x18;
  ram[DynTileBuf + 2] = x;
  ram[DynTileBuf + 3 + x] = 0xff;
  y &= 0xff;
  do {
    ram[DynTileBuf + 2 + x] = ram[PlayAreaAttrs + y];
    y = (y - 1) & 0xff;
    x--;
  } while (x !== 0);
}
