// P19 — enemies/zol-gel (Z_04): zols (split into two gels when hurt) and gels. The gel routines were
// advanced by the wave-4 integrator. X = object slot in every routine.
import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjState, ObjX, ObjY, FrameCounter, ObjTimer, ObjGridOffset, ObjQSpeedFrac, ObjTurnRate, Random,
  ObjType, ObjDir, ObjectFirstUnwalkableTile, RoomObjCount, ObjMetastate, ObjInvincibilityTimer,
} from '../../core/vars.js';
import { tableJump } from '../../core/asm.js';
import { label } from '../../core/rom.js';
import { DestroyMonster } from '../objects/slots.js';
import { ShootLimited } from './shots.js';
import { DrawObjectMirrored } from '../draw/anim.js';
import { InitWalker, Wanderer_TargetPlayer } from './common.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { GetCollidingTileMoving } from '../movement/tiles.js';
import { BoundByRoom } from '../movement/bounds.js';
import { MoveObject } from '../movement/walker.js';

/** UpdateZol (Z_04). X = zol: run its state, collide, draw (frame image flips every 8 frames). */
export function UpdateZol(x) {
  // UpdateZol (Z_04)
  UpdateZolState(x);
  Zol_CheckCollisions(x);
  Anim_FetchObjPosForSpriteDescriptor(x);
  let y = 0x00;
  if ((ram[FrameCounter] & 0x08) === 0) y++;
  return DrawObjectMirrored(y, x);
}

/** UpdateZolState (Z_04). X = zol: UpdateZolState_JumpTable by ObjState. */
export function UpdateZolState(x) {
  // UpdateZolState (Z_04)
  return tableJump(label('UpdateZolState_JumpTable').addr, ram[ObjState + x], [
    () => UpdateZolState0_Wander(x),
    () => UpdateZolState1_Shove(x),
    () => UpdateZolState2_Split(x),
  ]);
}

/** UpdateZolState0_Wander (Z_04). X = zol: UpdateNormalZolOrGel with q-speed $18. */
export function UpdateZolState0_Wander(x) {
  // UpdateZolState0_Wander (Z_04)
  return UpdateNormalZolOrGel(0x18, x);
}

/** UpdateZolState1_Shove (Z_04). X = zol or vire: move straight and fast; when blocked, next state. */
export function UpdateZolState1_Shove(x) {
  // UpdateZolState1_Shove (Z_04)
  Gel_MoveSplitting(x);
  if (cpu.c) ram[ObjState + x]++;
}

/**
 * UpdateZolState2_Split (Z_04). X = zol: destroy it and create two child gels, the first going left
 * (zol facing vertically) or up, the second the opposite (direction >> 1).
 */
export function UpdateZolState2_Split(x) {
  // UpdateZolState2_Split (Z_04)
  ram[RoomObjCount]++;
  DestroyMonster(x);
  let r = CreateChildGel(x);
  x = r.x;
  const a = ram[ObjDir + x] >= 0x04 ? 0x02 : 0x08;
  ram[ObjDir + r.y] = a;
  const pushed = a; // PHA
  r = CreateChildGel(x);
  ram[ObjDir + r.y] = pushed >> 1; // PLA / LSR
}

/**
 * CreateChildGel (Z_04). X = zol: "shoot" a child gel ($14) in state 0 with the zol's grid offset.
 * When there is no empty slot, Y = 0 and the writes land on Link's slot, as in the original.
 * @returns {{x:number, y:number}} X = CurObjIndex after a shot, Y = gel slot (or 0)
 */
export function CreateChildGel(x) {
  // CreateChildGel (Z_04)
  ram[0x00] = 0x14;
  const r = ShootLimited(x);
  ram[ObjState + r.y] = 0x00;
  ram[ObjGridOffset + r.y] = ram[ObjGridOffset + r.x];
  return { x: r.x, y: r.y };
}

/**
 * Zol_CheckCollisions (Z_04). X = zol in state 0: collide; when hurt (not killed), go to state 1 (a big
 * shove) if Link's facing direction is aligned with the grid for the zol's position, else state 2.
 */
export function Zol_CheckCollisions(x) {
  // Zol_CheckCollisions (Z_04)
  if (ram[ObjState + x] !== 0) return; // @Exit
  Gel_CheckCollisions(x);
  if (ram[ObjMetastate + x] !== 0) return;
  if (ram[ObjInvincibilityTimer + x] === 0) return;
  let y = 0x00;
  if ((ram[ObjY + x] & 0x0f) === 0x0d) y = 0x03;
  ram[0x00] = y;
  y = 0x00;
  if ((ram[ObjX + x] & 0x0f) === 0) y = 0x0c;
  // AND ObjDir: the asm reads Link's direction (slot 0), not ObjDir, X.
  if (((y | ram[0x00]) & ram[ObjDir]) === 0) ram[ObjState + x]++;
  ram[ObjState + x]++;
}

/** InitGel (Z_04). X = gel: gels not split from a zol start in state 2. */
export function InitGel(x) {
  // InitGel (Z_04)
  ram[ObjState + x] = 0x02;
  return InitWalker(x);
}

/** UpdateGel (Z_04). X = gel: move, collide, draw 4 pixels to the right (frame flips every 2 frames). */
export function UpdateGel(x) {
  // UpdateGel (Z_04)
  Gel_Move(x);
  Gel_CheckCollisions(x);
  const saved = ram[ObjX + x]; // PHA
  ram[ObjX + x] = saved + 0x04;
  Anim_FetchObjPosForSpriteDescriptor(x);
  let y = 0x00;
  if ((ram[FrameCounter] & 0x02) === 0) y++;
  Anim_SetSpriteDescriptorAttributes(0x03);
  DrawObjectNotMirrored(y, x);
  ram[ObjX + x] = saved; // PLA
}

/**
 * Gel_Move (Z_04). X = gel. State 0: speed $20, 5-frame timer, state 1. State 1: fly out of the zol
 * (Gel_MoveSplitting) until blocked or the timer expires, then snap to the grid and go to state 2.
 * State 2: UpdateNormalZolOrGel with speed $40.
 */
export function Gel_Move(x) {
  // Gel_Move (Z_04)
  let y = ram[ObjState + x];
  if (y === 0) {
    // @State0
    ram[ObjQSpeedFrac + x] = 0x20;
    ram[ObjTimer + x] = 0x05;
    ram[ObjState + x]++;
    return;
  }
  y = (y - 1) & 0xff;
  if (y !== 0) return UpdateNormalZolOrGel(0x40, x); // @State2 falls through
  // State 1.
  if (ram[ObjTimer + x] !== 0) {
    Gel_MoveSplitting(x);
    if (!cpu.c) return; // @Exit
  }
  // @Move
  cpu.c = 0;
  let a = cpu.adc(ram[ObjX + x], 0x08) & 0xf0;
  ram[ObjX + x] = a;
  a = cpu.adc(ram[ObjY + x], 0x08);
  ram[ObjY + x] = (a & 0xf0) | 0x0d;
  ram[ObjGridOffset + x] = 0x00;
  ram[ObjState + x]++;
}

/**
 * UpdateNormalZolOrGel (Z_04). A = q-speed, X = zol or gel: when its timer < 5, wander towards Link
 * (turn rate $20); at a square with the timer expired, wait a random ZolGelDelays time.
 */
export function UpdateNormalZolOrGel(a, x) {
  // UpdateNormalZolOrGel (Z_04)
  ram[ObjQSpeedFrac + x] = a;
  if (ram[ObjTimer + x] >= 0x05) return;
  ram[ObjTurnRate + x] = 0x20;
  Wanderer_TargetPlayer(x);
  if ((ram[ObjGridOffset + x] | ram[ObjTimer + x]) !== 0) return;
  let y = ram[Random + x] & 0x03;
  if (ram[ObjType + x] !== 0x13) y += 4;
  ram[ObjTimer + x] = table(bus.rom, 'ZolGelDelays').byte(y);
}

/**
 * Gel_MoveSplitting (Z_04). X = gel: move at maximum speed in its facing direction.
 * @returns C (also cpu.c) = 1 if blocked by a tile or the room bounds
 */
export function Gel_MoveSplitting(x) {
  // Gel_MoveSplitting (Z_04)
  ram[ObjQSpeedFrac + x] = 0xff;
  ram[0x0f] = ram[ObjDir + x];
  if (ram[ObjGridOffset + x] === 0) {
    const t = GetCollidingTileMoving(x);
    if (t >= ram[ObjectFirstUnwalkableTile]) return (cpu.c = 1);
  }
  // @CheckRoomBoundary
  if (BoundByRoom(x) === 0) return (cpu.c = 1);
  MoveObject(x);
  const a = ram[ObjGridOffset + x] & 0x0f;
  if (a !== 0) return (cpu.c = 0);
  ram[ObjGridOffset + x] = a;
  return (cpu.c = 0);
}

/** Gel_CheckCollisions (Z_04). X = gel: [02]/[03] = position, then CheckMonsterCollisions. */
export function Gel_CheckCollisions(x) {
  // Gel_CheckCollisions (Z_04)
  ram[0x02] = ram[ObjX + x];
  ram[0x03] = ram[ObjY + x];
  return CheckMonsterCollisions(x);
}
