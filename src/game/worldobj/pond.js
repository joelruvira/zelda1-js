// Pond fairy (Z_04) and the recorder's pond secret / pond color cycle (Z_07). Package P16.
// Routines: InitPondFairy (+ L10797_Exit), UpdatePondFairy (+ PondFairy_HandleOtherStates),
// PondFairy_MoveHearts, UpdateFluteSecret (+ RevealPondStairs), CueTransferPondPaletteRow
// (+ L1FF28_Exit), AnimatePond.
// Tables read from the ROM: PondHeartStartAngles, WaterPaletteTransferBufTemplate, PondCycleColors.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjDir, ObjState, ObjTimer, ObjInputDir, ObjAngleWhole, CurObjIndex, Tune1Request,
  World_IsFillingHearts, SecretColorCycle, FrameCounter, DynTileBuf, ObjectFirstUnwalkableTile,
} from '../../core/vars.js';
import { Link_EndMoveAndAnimate_Bank4 } from '../link/anim.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';
import { Anim_SetSpriteDescriptorRedPaletteRow } from '../draw/sprites.js';
import { RevealAndFlagSecretStairsObj } from './tileobjects.js';
import { DrawFairy } from '../items/fairy.js';
import { DecreaseObjectAngle, RotateObjectLocation } from '../enemies/common.js';

/** InitPondFairy (Z_04). X = fairy slot: "item taken" tune, position ($78, $7D). L10797_Exit is its RTS. */
export function InitPondFairy(x) {
  // InitPondFairy (Z_04)
  ram[Tune1Request] = 0x08;
  ram[ObjX + x] = 0x78;
  ram[ObjY + x] = 0x7d;
}

/** UpdatePondFairy (Z_04). X = fairy slot (slot 1; its state and timer are read as ObjState+1/ObjTimer+1). */
export function UpdatePondFairy(x) {
  // UpdatePondFairy (Z_04)
  DrawFairy(x);
  const a = ram[ObjState + 1];
  if (a !== 0) return PondFairy_HandleOtherStates(a, x);
  // State 0: wait for Link at the edge of the pond.
  if (ram[ObjY] !== 0xad) return;
  if (ram[ObjX] < 0x70 || ram[ObjX] >= 0x81) return;
  ram[ObjState + 1]++;
  ram[ObjState] = 0x40;
  ram[World_IsFillingHearts] = 0x40;
}

// PondFairy_HandleOtherStates (Z_04, label inside UpdatePondFairy). A = fairy state.
// @returns X = CurObjIndex when it draws.
function PondFairy_HandleOtherStates(a, x) {
  let draw = false;
  if (a === 0x01) {
    // State 1: flying and filling hearts.
    if (ram[World_IsFillingHearts] !== 0) {
      draw = true;
    } else {
      ram[ObjState + 1]++;
      a = 0x50;
      ram[ObjTimer + 1] = a;
    }
  }
  if (!draw) {
    // @CheckState2 (from state 1 with A = $50: returns)
    if (a !== 0x02) return;
    if (ram[ObjTimer + 1] === 0) {
      ram[ObjState + 1]++;
      ram[ObjState] = 0x00;
    }
  }
  // @DrawLinkAndHearts
  const y = 0x00;
  ram[ObjInputDir] = y;
  const saved = ram[ObjState]; // PHA
  ram[ObjState] = y;
  Link_EndMoveAndAnimate_Bank4();
  ram[ObjState] = saved; // PLA
  PondFairy_MoveHearts();
  x = ram[CurObjIndex];
  return x;
}

/** PondFairy_MoveHearts (Z_04): hearts orbiting the fairy, stored in object slots 2..9. @returns X = $0A */
export function PondFairy_MoveHearts() {
  // PondFairy_MoveHearts (Z_04)
  const startAngles = table(bus.rom, 'PondHeartStartAngles');
  let x = 0x02;
  for (;;) {
    // @LoopHeart
    let move = true;
    if (ram[ObjState + x] === 0) {
      let setUp = true;
      if (x !== 0x02) {
        // The heart in slot 2 is set up first; while its state is 0 this loops (as the original).
        if (ram[ObjState + 2] === 0) continue;
        if (ram[ObjAngleWhole + 2] !== startAngles.byte(x - 3)) {
          setUp = false;
          move = false; // @NextLoopHeart
        }
      }
      if (setUp) {
        // @SetUpHeart
        ram[ObjState + x]++;
        ram[ObjDir + x] = 0x80;
        ram[ObjAngleWhole + x] = 0x18;
        ram[ObjX + x] = ram[ObjX + 1];
        ram[ObjY + x] = (ram[ObjY + 1] - 0x1c) & 0xff;
      }
    }
    if (move) {
      // @MoveHeart
      ram[0x0b] = 0x00;
      DecreaseObjectAngle(0x60, x);
      ram[ObjY + x] = RotateObjectLocation(0x06, x, 0x06);
      const saved = x; // TXA / PHA
      Anim_SetSpriteDescriptorRedPaletteRow();
      const a = Anim_FetchObjPosForSpriteDescriptor(x);
      DrawObjectNotMirrored(a, ram[CurObjIndex]);
      x = saved; // PLA / TAX
    }
    // @NextLoopHeart
    x++;
    if (x === 0x0a) return x;
  }
}

/** UpdateFluteSecret (Z_07). X = object slot: cycles the pond colors, then reveals the stairs. */
export function UpdateFluteSecret(x) {
  // UpdateFluteSecret (Z_07)
  const y = ram[SecretColorCycle];
  if (y >= 0x0c) return; // L1FF28_Exit
  if ((ram[FrameCounter] & 0x07) !== 0x04) return;
  ram[SecretColorCycle]++;
  if (y === 0x0b) return RevealPondStairs(x);
  return CueTransferPondPaletteRow(y); // falls through
}

/** CueTransferPondPaletteRow (Z_07). Y = point in the cycle (0..$B). L1FF28_Exit is its RTS. */
export function CueTransferPondPaletteRow(y) {
  // CueTransferPondPaletteRow (Z_07)
  const saved = y; // TYA / PHA
  const template = table(bus.rom, 'WaterPaletteTransferBufTemplate');
  for (y = 0x07; y >= 0; y--) ram[DynTileBuf + y] = template.byte(y); // @CopyBytes
  y = saved; // PLA / TAY
  ram[DynTileBuf + 6] = table(bus.rom, 'PondCycleColors').byte(y);
  if (y !== 0x0a) return;
  ram[ObjectFirstUnwalkableTile] = 0x99; // most water tiles become walkable
}

// RevealPondStairs (Z_07, label inside UpdateFluteSecret). X = object slot.
function RevealPondStairs(x) {
  ram[ObjX + x] = 0x60;
  ram[ObjY + x] = 0x90;
  return RevealAndFlagSecretStairsObj(x);
}

/** AnimatePond (Z_07): reverses the pond color cycle (one step every other 4 frames). */
export function AnimatePond() {
  // AnimatePond (Z_07)
  if ((ram[FrameCounter] & 0x04) === 0) return; // L1FF28_Exit
  ram[SecretColorCycle]--;
  return CueTransferPondPaletteRow(ram[SecretColorCycle]);
}
