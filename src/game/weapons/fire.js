// P09 weapons — the candle's fire in slots $10/$11: WieldCandle (Z_01), UpdateFire and
// GetWideObjectMiddle (Z_07), and the brightening of a dark room by the fire: UpdateCandle and
// IsDarkRoom_Bank4 (Z_04).

import { ram, peek } from '../../core/ram.js';
import { label } from '../../core/rom.js';
import { switchBank, tableJump } from '../../core/asm.js';
import {
  ObjState, InvCandle, UsedCandle, ObjGridOffset, ObjPosFrac, ObjQSpeedFrac, ObjAnimCounter, ObjDir,
  ObjTimer, ObjX, ObjY, ObjInvincibilityTimer, CurLevel, CandleState, RoomId, FadeCycle,
  BrighteningRoom, LevelBlockAttrsE,
} from '../../core/vars.js';
import { PlayEffect } from '../audio/requests.js';
import { Abs } from '../movement/math.js';
import { MoveObject } from '../movement/walker.js';
import {
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, Anim_SetObjHFlipForSpriteDescriptor,
  DrawObjectWithType,
} from '../draw/anim.js';
import { Anim_SetSpriteDescriptorRedPaletteRow } from '../draw/sprites.js';
import { DoObjectsCollide } from '../combat/collisions.js';
import { BeginShove, Link_BeHarmed } from '../combat/link-harm.js';
import { AnimateWorldFading } from '../ppu/fade.js';
import { PlaceWeaponForPlayerState } from './wield.js';
import { ResetObjState } from './sword.js';

/**
 * WieldCandle (Z_01): a moving fire (state $21, q-speed $20) in the first free slot of $10/$11,
 * unless the blue candle was already used in this room.
 * @returns X = the last slot tested (it may be occupied when no slot was free)
 */
export function WieldCandle() {
  // WieldCandle (Z_01)
  let x = 0x10;
  if (ram[ObjState + x] !== 0) {
    x++;
    if (ram[ObjState + x] !== 0) return x; // L69BE_Exit
  }
  // @NotInUse
  if (ram[InvCandle] === 0x01 && ram[UsedCandle] !== 0) return x; // blue candle already used
  ram[UsedCandle] = 0x01;
  ram[ObjGridOffset + x] = 0x00;
  ram[ObjPosFrac + x] = 0x00;
  ram[ObjQSpeedFrac + x] = 0x20; // half a pixel a frame
  ram[ObjState + x] = 0x21; // moving fire
  PlayEffect(0x04); // flame sound effect
  ram[ObjAnimCounter + x] = 0x04;
  PlaceWeaponForPlayerState(x);
  return x;
}

/**
 * UpdateFire (Z_07). X = $10/$11. A moving fire (state $21) walks $10 pixels, then stands (state
 * $22) for $3F frames; in UW it brightens a dark room (UpdateCandle). It hurts Link ($80) on contact.
 */
export function UpdateFire(x) {
  // UpdateFire (Z_07)
  let standing = true;
  if (ram[ObjState + x] === 0x21) {
    // Move as if the grid offset were 0, then add the move to it (distance traveled).
    const g = ram[ObjGridOffset + x]; // PHA
    ram[ObjGridOffset + x] = 0x00;
    ram[0x0f] = ram[ObjDir + x];
    MoveObject(x);
    ram[ObjGridOffset + x] = g + ram[ObjGridOffset + x]; // PLA / CLC / ADC
    if (Abs(ram[ObjGridOffset + x]) !== 0x10) {
      standing = false; // @DrawAndCheckCollisions
    } else {
      ram[ObjTimer + x] = 0x3f;
      ram[ObjState + x]++; // $22: standing fire
    }
  }
  if (standing) {
    // @StandingFie
    if (ram[ObjTimer + x] === 0) return ResetObjState(x);
    if (ram[CurLevel] !== 0) {
      switchBank(4); // TXA / PHA ... PLA / TAX keep X
      UpdateCandle();
    }
  }
  // @DrawAndCheckCollisions: 4 frames per animation cycle, red palette, animation index $40 (+1).
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x04, x);
  Anim_SetObjHFlipForSpriteDescriptor(x);
  Anim_SetSpriteDescriptorRedPaletteRow();
  ram[0x0c] = 0x00; // not mirrored
  DrawObjectWithType(0x00, x, 0x40);

  // Collision with Link.
  if (ram[ObjInvincibilityTimer] !== 0) return; // L1F91D_Exit
  ram[0x00] = x;
  GetWideObjectMiddle(0x00, 0x02); // Link's middle in [04]/[05]
  GetWideObjectMiddle(ram[0x00], 0x00); // the fire's middle in [02]/[03]
  if (DoObjectsCollide(0x0e) === 0) return; // L1F91D_Exit
  x = ram[0x00];
  ram[0x00] = 0x00; // Link is the defender
  BeginShove(x);
  ram[0x0d] = 0x00; // $0080 damage points
  ram[0x0e] = 0x80;
  return Link_BeHarmed(x);
}

/**
 * GetWideObjectMiddle (Z_07). X = object, Y = offset from [02]. [02+Y] = X + 8, [03+Y] = Y + 8.
 * @returns A = [03+Y]
 */
export function GetWideObjectMiddle(x, y) {
  // GetWideObjectMiddle (Z_07)
  ram[0x02 + y] = ram[ObjX + x] + 0x08;
  ram[0x03 + y] = ram[ObjY + x] + 0x08;
  return ram[0x03 + y];
}

/** UpdateCandle (Z_04): CandleState 0 begin, 1 brightening, 2 done. Bank 4 must be mapped. */
export function UpdateCandle() {
  // UpdateCandle (Z_04)
  return tableJump(label('UpdateCandle_JumpTable').addr, ram[CandleState], [
    UpdateCandle_Begin, UpdateCandle_Brightening, UpdateCandle_Done,
  ]);
}

/** UpdateCandle_Begin (Z_04): in a dark room, start a fade-to-light cycle ($C0). */
export function UpdateCandle_Begin() {
  // UpdateCandle_Begin (Z_04)
  if (IsDarkRoom_Bank4(ram[RoomId]) === 0) return UpdateCandle_Done();
  ram[FadeCycle] = 0xc0; // reverse of $40
  ram[BrighteningRoom]++;
  ram[CandleState]++; // L_Candle_IncState
  return UpdateCandle_Done(); // falls through
}

/** UpdateCandle_Done (Z_04): RTS. */
export function UpdateCandle_Done() {
  // UpdateCandle_Done (Z_04)
}

/** UpdateCandle_Brightening (Z_04): fade; when done, stop brightening and go to state "done". */
export function UpdateCandle_Brightening() {
  // UpdateCandle_Brightening (Z_04)
  if (AnimateWorldFading() !== 0) return;
  // L_Candle_StopBrightening
  ram[BrighteningRoom] = 0x00;
  ram[CandleState]++; // L_Candle_IncState
  return UpdateCandle_Done();
}

/** IsDarkRoom_Bank4 (Z_04). Y = room. @returns A = $80 if dark (UW only), else 0 */
export function IsDarkRoom_Bank4(y) {
  // IsDarkRoom_Bank4 (Z_04)
  const a = ram[CurLevel];
  if (a === 0) return a;
  return peek(LevelBlockAttrsE + y) & 0x80;
}
