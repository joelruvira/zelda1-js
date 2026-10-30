// P10 items — the dropped fairy (Z_04). X = object slot in every routine.

import { ram } from '../../core/ram.js';
import { tableJump } from '../../core/asm.js';
import { label } from '../../core/rom.js';
import {
  Tune1Request, ObjDir, Flyer_ObjSpeed, FlyingMaxSpeedFrac, Flyer_ObjSpeedFrac, Flyer_ObjTurns,
  Flyer_ObjDistTraveled, Flyer_ObjFlyingState, ObjInvincibilityTimer, FrameCounter,
} from '../../core/vars.js';
import { Anim_FetchObjPosForSpriteDescriptor } from '../draw/anim.js';
import { Anim_SetSpriteDescriptorRedPaletteRow } from '../draw/sprites.js';
import { Anim_WriteItemSprites } from '../draw/items.js';
import { MoveFlyer, Flyer_SpeedUp, Flyer_DoNothing, Flyer_Wander } from '../enemies/flyer.js';
import { $pxa } from '../../core/timing.js';

/** SetUpFairyObject (Z_04): X = object slot. */
export function SetUpFairyObject(x) {
  // SetUpFairyObject (Z_04)
  ram[Tune1Request] = 0x08; // "fairy appears" (also "item taken")
  ResetFlyerState(x);
  ram[ObjDir + x] = 0x08; // face up
  ram[Flyer_ObjSpeed + x] = 0x7f;
  ram[FlyingMaxSpeedFrac] = 0xa0;
}

/** ResetFlyerState (Z_04): X = object slot. @returns A = 0 */
export function ResetFlyerState(x) {
  // ResetFlyerState (Z_04)
  ram[Flyer_ObjSpeedFrac + x] = 0x00;
  ram[Flyer_ObjTurns + x] = 0x00;
  ram[Flyer_ObjDistTraveled + x] = 0x00;
  ram[Flyer_ObjFlyingState + x] = 0x00;
  ram[ObjInvincibilityTimer + x] = 0x00;
  return 0x00;
}

/** UpdateFairyObject (Z_04): X = object slot. */
export function UpdateFairyObject(x) {
  // UpdateFairyObject (Z_04)
  ControlFairyFlight(x);
  MoveFlyer(x);
  return DrawFairy(x); // falls through
}

/** DrawFairy (Z_04): X = object slot. @returns X = [08] */
export function DrawFairy(x) {
  // DrawFairy (Z_04)
  Anim_FetchObjPosForSpriteDescriptor(x);
  let a = Anim_SetSpriteDescriptorRedPaletteRow(); // A = 2
  a = ((a << 1) & ram[FrameCounter]) >> 2; // every 4 frames, switch sprite frames
  ram[0x0c] = a;
  return Anim_WriteItemSprites(x, 0x14);
}

/** ControlFairyFlight (Z_04): X = object slot; ControlFairyFlight_JumpTable by flying state. */
export function ControlFairyFlight(x) {
  // ControlFairyFlight (Z_04)
  $pxa('Z_04:11493', Flyer_ObjFlyingState, x);
  return tableJump(label('ControlFairyFlight_JumpTable').addr, ram[Flyer_ObjFlyingState + x], [
    () => Flyer_SpeedUp(x),
    () => Flyer_FairyDecideState(x),
    () => Flyer_DoNothing(x),
    () => Flyer_Wander(x),
  ]);
}

/** Flyer_FairyDecideState (Z_04): 6 turns, then flying state 3. */
export function Flyer_FairyDecideState(x) {
  // Flyer_FairyDecideState (Z_04)
  ram[Flyer_ObjFlyingState + x] = 0x03;
  ram[Flyer_ObjTurns + x] = 0x06;
  return Flyer_DoNothing(x); // falls through
}
