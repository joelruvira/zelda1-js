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
import { $br, $pxa } from '../../core/timing.js';

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
  if ($br('Z_04:3379', a !== 0)) return PondFairy_HandleOtherStates(a, x);
  // State 0: wait for Link at the edge of the pond.
  if ($br('Z_04:3386', ram[ObjY] !== 0xad)) return;
  if ($br('Z_04:3391', ram[ObjX] < 0x70) || $br('Z_04:3393', ram[ObjX] >= 0x81)) return;
  ram[ObjState + 1]++;
  ram[ObjState] = 0x40;
  ram[World_IsFillingHearts] = 0x40;
}

// PondFairy_HandleOtherStates (Z_04, label inside UpdatePondFairy). A = fairy state.
// @returns X = CurObjIndex when it draws.
function PondFairy_HandleOtherStates(a, x) {
  let draw = false;
  if (!$br('Z_04:3407', a !== 0x01)) {
    // State 1: flying and filling hearts.
    if ($br('Z_04:3413', ram[World_IsFillingHearts] !== 0)) {
      draw = true;
    } else {
      ram[ObjState + 1]++;
      a = 0x50;
      ram[ObjTimer + 1] = a;
    }
  }
  if (!draw) {
    // @CheckState2 (from state 1 with A = $50: returns)
    if ($br('Z_04:3429', a !== 0x02)) return;
    if (!$br('Z_04:3435', ram[ObjTimer + 1] !== 0)) {
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
    if (!$br('Z_04:3479', ram[ObjState + x] !== 0)) {
      let setUp = true;
      if (!$br('Z_04:3486', x === 0x02)) {
        // The heart in slot 2 is set up first; while its state is 0 this loops (as the original).
        if ($br('Z_04:3494', ram[ObjState + 2] === 0)) continue;
        $pxa('Z_04:3504', startAngles.addr, x - 3);
        if ($br('Z_04:3505', ram[ObjAngleWhole + 2] !== startAngles.byte(x - 3))) {
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
    if (!$br('Z_04:3562', x !== 0x0a)) return x;
  }
}

/** UpdateFluteSecret (Z_07). X = object slot: cycles the pond colors, then reveals the stairs. */
export function UpdateFluteSecret(x) {
  // UpdateFluteSecret (Z_07)
  const y = ram[SecretColorCycle];
  if ($br('Z_07:5881', y >= 0x0c)) return; // L1FF28_Exit
  if ($br('Z_07:5887', (ram[FrameCounter] & 0x07) !== 0x04)) return;
  ram[SecretColorCycle]++;
  if ($br('Z_07:5896', y === 0x0b)) return RevealPondStairs(x);
  return CueTransferPondPaletteRow(y); // falls through
}

/** CueTransferPondPaletteRow (Z_07). Y = point in the cycle (0..$B). L1FF28_Exit is its RTS. */
export function CueTransferPondPaletteRow(y) {
  // CueTransferPondPaletteRow (Z_07)
  const saved = y; // TYA / PHA
  const template = table(bus.rom, 'WaterPaletteTransferBufTemplate');
  for (y = 0x07; ; y--) { // @CopyBytes
    $pxa('Z_07:5909', template.addr, y);
    ram[DynTileBuf + y] = template.byte(y);
    if (!$br('Z_07:5912', y - 1 >= 0)) break;
  }
  y = saved; // PLA / TAY
  const colors = table(bus.rom, 'PondCycleColors');
  $pxa('Z_07:5915', colors.addr, y);
  ram[DynTileBuf + 6] = colors.byte(y);
  if ($br('Z_07:5918', y !== 0x0a)) return;
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
  if ($br('Z_07:5940', (ram[FrameCounter] & 0x04) === 0)) return; // L1FF28_Exit
  ram[SecretColorCycle]--;
  return CueTransferPondPaletteRow(ram[SecretColorCycle]);
}
