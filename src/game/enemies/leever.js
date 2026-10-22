// P18 enemyow — enemies/leever (Z_04): blue and red leevers and the "burrower" cycle they share with
// the zora (states 0-5: hidden, mound, surfacing, out, sinking, mound). X = object slot in every routine.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  RedLeeverLongTimer, ObjTurnRate, ObjTimer, ObjType, ObjState, ObjY, ObjDir, ObjQSpeedFrac, ObjAnimFrame,
  ObjMetastate, ActiveRedLeeverCount, Random, ObjX, ObjectFirstUnwalkableTile, ObjAnimCounter,
  ObjShoveDir, InvClock, ObjStunTimer, ObjGridOffset,
} from '../../core/vars.js';
import { ResetObjMetastateAndTimer } from '../objects/slots.js';
import { InitSlowOctorockOrGhini } from './octorok.js';
import { Wanderer_TargetPlayer } from './common.js';
import { Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, DrawObjectMirrored } from '../draw/anim.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { ReverseObjDir, MoveObject } from '../movement/walker.js';
import { GetCollidableTileStill, GetCollidingTileMoving } from '../movement/tiles.js';
import { BoundByRoom } from '../movement/bounds.js';
import { Obj_Shove } from '../movement/shove.js';

const tbl = (name) => table(bus.rom, name);

/** InitLeever (Z_04). X = leever: red leever long timer 5, no spawn cloud, then as a slow octorock. */
export function InitLeever(x) {
  // InitLeever (Z_04)
  ram[RedLeeverLongTimer] = 0x05;
  ResetObjMetastateAndTimer(x);
  return InitSlowOctorockOrGhini(x); // falls through
}

/** UpdateBlueLeever (Z_04). X = leever: turn rate $A0, wander, then the burrower cycle. */
export function UpdateBlueLeever(x) {
  // UpdateBlueLeever (Z_04)
  ram[ObjTurnRate + x] = 0xa0;
  Wanderer_TargetPlayer(x);
  return UpdateBurrower(x); // falls through
}

/**
 * UpdateBurrower (Z_04). X = blue leever or zora: when the timer expires, go to the next state
 * (speed and time from the BlueLeeverState* tables); a zora about to surface faces Link (frame 2/3
 * kept in ObjDir). Then animate, draw and check collisions.
 */
export function UpdateBurrower(x) {
  // UpdateBurrower (Z_04)
  if (ram[ObjTimer + x] === 0) {
    if (ram[ObjType + x] === 0x11 && ram[ObjState + x] === 0x01) {
      let y = 0x03;
      if (ram[ObjY + x] < ram[ObjY]) y--;
      ram[ObjDir + x] = y;
    }
    // @CycleState
    let a = (ram[ObjState + x] + 1) & 0xff;
    if (a >= 0x06) a = 0x00;
    ram[ObjState + x] = a;
    ram[ObjQSpeedFrac + x] = tbl('BlueLeeverStateQSpeeds').byte(a);
    ram[ObjTimer + x] = tbl('BlueLeeverStateTimes').byte(a);
  }
  // @Animate
  const y = ram[ObjState + x];
  return Burrower_AnimateDrawAndCheckCollisions(tbl('BlueLeeverStateAnimTimes').byte(y), x); // falls through
}

/**
 * Burrower_AnimateDrawAndCheckCollisions (Z_04). A = animation counter reload, X = burrower.
 * Draws nothing in state 0; collisions only while out of the ground (state 3; zora 2-4).
 */
export function Burrower_AnimateDrawAndCheckCollisions(a, x) {
  // Burrower_AnimateDrawAndCheckCollisions (Z_04)
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(a, x);
  a = ram[ObjState + x];
  if (a === 0) return; // @Exit
  let draw = false;
  if (ram[ObjType + x] === 0x11) {
    const y = ram[ObjState + x];
    if (y >= 0x02 && y < 0x05) {
      a = ram[ObjDir + x];
      if (a !== 0) draw = true; // BNE @Draw
    }
  }
  if (!draw) {
    // @CalcFrameImage: ((A - 1) * 2) + movement frame
    a = ((((a - 1) & 0xff) << 1) + ram[ObjAnimFrame + x]) & 0xff;
  }
  // @Draw
  DrawObjectMirrored(a, x);
  let check = false;
  if (ram[ObjType + x] === 0x11) {
    const s = ram[ObjState + x];
    if (s === 0x02 || s === 0x04) check = true;
  }
  // @NoState3Collisions
  if (!check && ram[ObjState + x] !== 0x03) return;
  // @CheckCollisions
  CheckMonsterCollisions(x);
  if (ram[ObjMetastate + x] === 0) return;
  if (ram[ObjType + x] !== 0x10) return;
  ram[ActiveRedLeeverCount]--;
}

/**
 * UpdateRedLeever (Z_04). X = red leever. State 0: when the long timer allows (at most 2 out), pop up
 * $28 pixels ahead of or behind Link on a walkable square. State 3: walk until blocked. Other states
 * advance with the timer (RedLeeverState* tables).
 */
export function UpdateRedLeever(x) {
  // UpdateRedLeever (Z_04)
  if (ram[ObjState + x] === 0) {
    // State 0: decide whether to burst out of the ground.
    if (ram[RedLeeverLongTimer] !== 0) return; // @Exit
    if (ram[ActiveRedLeeverCount] >= 0x02) return;
    ram[ObjDir + x] = ram[ObjDir];
    if (ram[Random + 1 + x] >= 0xc0) ReverseObjDir(x);
    let a;
    if (ram[ObjDir + x] & 0x0c) {
      ram[ObjX + x] = ram[ObjX];
      ram[0x00] = (ram[ObjDir + x] & 0x08) ? 0xd8 : 0x28;
      a = (((ram[ObjY] + ram[0x00]) & 0xf0) | 0x0d) & 0xff;
      ram[ObjY + x] = a;
      if (a < 0x5d) return; // @Exit
    } else {
      // @PlaceHorizontally
      a = ram[ObjY];
      ram[ObjY + x] = a;
      if (a < 0x5d) return;
      ram[0x00] = (ram[ObjDir + x] & 0x02) ? 0xd8 : 0x28;
      ram[0x01] = ram[ObjX];
      a = (ram[ObjX] + ram[0x00]) & 0xf8;
      ram[ObjX + x] = a;
      ram[0x02] = a;
      if (a >= ram[0x01]) {
        const pushed = a; // PHA
        ram[0x02] = ram[0x01];
        ram[0x01] = pushed; // PLA
      }
      // @Subtract: a wrapped X is too far.
      if (((ram[0x01] - ram[0x02]) & 0xff) >= 0x30) return;
    }
    // @CheckSafeToSpawn
    if (GetCollidableTileStill(x) >= ram[ObjectFirstUnwalkableTile]) return;
    ram[ActiveRedLeeverCount]++;
    ram[ObjAnimCounter + x] = 0x01;
    ram[RedLeeverLongTimer] = 0x02;
    RedLeever_CycleStateDrawAndCheckCollisions(x);
    ReverseObjDir(x);
  }
  // @CheckOtherStates
  if (ram[ObjState + x] === 0x03) {
    if (ram[ObjShoveDir + x] !== 0) {
      Obj_Shove(x);
      return RedLeever_AnimateAndCheckCollisions(x);
    }
    // @CheckStunned
    if ((ram[InvClock] | ram[ObjStunTimer + x]) !== 0) return RedLeever_AnimateAndCheckCollisions(x);
    ram[0x0f] = ram[ObjDir + x];
    if (GetCollidingTileMoving(x) >= ram[ObjectFirstUnwalkableTile]) {
      return RedLeever_CycleStateDrawAndCheckCollisions(x);
    }
    if (BoundByRoom(x) === 0) return RedLeever_CycleStateDrawAndCheckCollisions(x);
    MoveObject(x);
    const g = ram[ObjGridOffset + x] & 0x0f;
    if (g === 0) ram[ObjGridOffset + x] = g;
    ram[ObjTimer + x] = 0xff;
  }
  // @AnimateIfTime
  if (ram[ObjTimer + x] !== 0) return RedLeever_AnimateAndCheckCollisions(x);
  return RedLeever_CycleStateDrawAndCheckCollisions(x); // falls through
}

/**
 * RedLeever_CycleStateDrawAndCheckCollisions (Z_04). X = red leever: next state (0-5; a completed
 * cycle frees one of the 2 places), its speed and time, then animate, draw and check collisions.
 */
export function RedLeever_CycleStateDrawAndCheckCollisions(x) {
  // RedLeever_CycleStateDrawAndCheckCollisions (Z_04)
  let a = (ram[ObjState + x] + 1) & 0xff;
  if (a >= 0x06) {
    ram[ActiveRedLeeverCount]--;
    a = 0x00;
  }
  ram[ObjState + x] = a;
  ram[ObjQSpeedFrac + x] = tbl('RedLeeverStateQSpeeds').byte(a);
  ram[ObjTimer + x] = tbl('RedLeeverStateTimes').byte(a);
  return RedLeever_AnimateAndCheckCollisions(x); // falls through
}

/** RedLeever_AnimateAndCheckCollisions (Z_04). X = red leever. */
export function RedLeever_AnimateAndCheckCollisions(x) {
  // RedLeever_AnimateAndCheckCollisions (Z_04)
  const y = ram[ObjState + x];
  return Burrower_AnimateDrawAndCheckCollisions(tbl('RedLeeverStateAnimTimes').byte(y), x); // JMP
}
