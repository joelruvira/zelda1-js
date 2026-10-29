// P19 — enemies/keese-bubble (Z_04): bubbles, keeses and AnimateAndDrawCommonObject. The keese routines
// were advanced by the wave-4 integrator. X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  Random, ObjDir, FlyingMaxSpeedFrac, Flyer_ObjSpeed, InvClock, ItemLiftTimer, Flyer_ObjDistTraveled,
  Flyer_ObjFlyingState, Flyer_ObjTurns, ObjQSpeedFrac, ObjType, FrameCounter, SwordBlockedLongTimer,
  SwordBlocked,
} from '../../core/vars.js';
import { ResetFlyerState } from '../items/fairy.js';
import {
  MoveFlyer, Flyer_SpeedUp, Flyer_Chase, Flyer_Wander, Flyer_SlowDown, Flyer_Delay,
} from './flyer.js';
import {
  Anim_FetchObjPosForSpriteDescriptor, Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor,
  Anim_SetObjHFlipForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored,
} from '../draw/anim.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { CheckMonsterCollisions, CheckLinkCollision } from '../combat/collisions.js';
import { ResetShoveInfo } from '../movement/shove.js';
import { InitWalker, UpdateCommonWanderer } from './common.js';

/** InitBubble (Z_04). X = bubble: q-speed $40 (1 pixel a frame), then InitWalker. */
export function InitBubble(x) {
  // InitBubble (Z_04)
  ram[ObjQSpeedFrac + x] = 0x40;
  return InitWalker(x);
}

/**
 * UpdateBubble (Z_04). X = bubble ($2B flashing, $2C blue, $2D red): wander (turn rate $40), draw with
 * palette row type-$2B (or cycling for $2B), and on touching Link block the sword: $2B for $A0 frames
 * (SwordBlockedLongTimer = $10), $2C/$2D set SwordBlocked = type-$2C (blue unblocks, red blocks).
 */
export function UpdateBubble(x) {
  // UpdateBubble (Z_04)
  UpdateCommonWanderer(0x40, x);
  let a = ram[ObjType + x];
  if (a !== 0x2b) a = (a - 0x2b) & 0xff; // SEC / SBC #$2B
  else a = ram[FrameCounter] & 0x03; // @Flash
  // @Animate
  Anim_SetSpriteDescriptorAttributes(a);
  AnimateAndDrawCommonObject(0x01, x);
  CheckLinkCollision(x);
  if (ram[0x06] === 0) return; // @Exit
  a = ram[ObjType + x];
  if (a !== 0x2b) {
    // @BlockOrUnblock
    ram[SwordBlocked] = (a - 0x2c) & 0xff;
    return;
  }
  ram[SwordBlockedLongTimer] = 0x10;
}

/** InitBlueKeese (Z_04). X = keese: random one of 8 directions; max speed $C0, speed $1F. */
export function InitBlueKeese(x) {
  // InitBlueKeese (Z_04)
  const y = ram[Random + x] & 0x07;
  ram[ObjDir + x] = table(bus.rom, 'Directions8').byte(y);
  ResetFlyerState(x);
  ram[FlyingMaxSpeedFrac] = 0xc0;
  ram[Flyer_ObjSpeed + x] = 0x1f;
  return 0x1f;
}

/** InitRedOrBlackKeese (Z_04). X = keese: a blue keese with speed $7F. */
export function InitRedOrBlackKeese(x) {
  // InitRedOrBlackKeese (Z_04)
  InitBlueKeese(x);
  ram[Flyer_ObjSpeed + x] = 0x7f;
  return 0x7f;
}

/**
 * AnimateAndDrawCommonObject (Z_04). A = new animation counter, X = object: advance the animation, set
 * the h-flip from the animation frame and draw frame image 0 not mirrored.
 */
export function AnimateAndDrawCommonObject(a, x) {
  // AnimateAndDrawCommonObject (Z_04)
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(a, x);
  Anim_SetObjHFlipForSpriteDescriptor(x);
  return DrawObjectNotMirrored(0x00, x);
}

/** UpdateKeese (Z_04). X = keese: fly (no clock, no item lifted), draw, collide, reset the shove. */
export function UpdateKeese(x) {
  // UpdateKeese (Z_04)
  if ((ram[InvClock] | ram[ItemLiftTimer]) === 0) {
    ControlKeeseFlight(x);
    MoveFlyer(x);
  }
  Anim_FetchObjPosForSpriteDescriptor(x);
  DrawObjectMirrored((ram[Flyer_ObjDistTraveled + x] & 0x02) >> 1, x);
  CheckMonsterCollisions(x);
  return ResetShoveInfo(x);
}

/** ControlKeeseFlight (Z_04). X = keese: ControlKeeseFlight_JumpTable by flying state. */
export function ControlKeeseFlight(x) {
  // ControlKeeseFlight (Z_04)
  return tableJump(label('ControlKeeseFlight_JumpTable').addr, ram[Flyer_ObjFlyingState + x], [
    () => Flyer_SpeedUp(x),
    () => Flyer_KeeseDecideState(x),
    () => Flyer_Chase(x),
    () => Flyer_Wander(x),
    () => Flyer_SlowDown(x),
    () => Flyer_Delay(x),
  ]);
}

/** Flyer_KeeseDecideState (Z_04). X = keese: next state 2 (Random+1 >= $A0), 3 (>= $20) or 4. */
export function Flyer_KeeseDecideState(x) {
  // Flyer_KeeseDecideState (Z_04)
  let y = 0x02;
  const a = ram[Random + 1 + x];
  if (a < 0xa0) {
    y++;
    if (a < 0x20) y++;
  }
  return Flyer_SetStateAndTurns(x, y); // falls through
}

/** Flyer_SetStateAndTurns (Z_04). X = flyer, Y = flying state; 6 turns. @returns A = 6 */
export function Flyer_SetStateAndTurns(x, y) {
  // Flyer_SetStateAndTurns (Z_04)
  ram[Flyer_ObjFlyingState + x] = y;
  ram[Flyer_ObjTurns + x] = 0x06;
  return 0x06;
}
