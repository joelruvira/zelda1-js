// P19 — enemies/zol-gel (Z_04). The gel routines (and UpdateNormalZolOrGel, shared with the zol) were
// advanced by the wave-4 integrator: level 1 has gels. UpdateZol is still a stub for P19.
// X = object slot in every routine.
import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjState, ObjX, ObjY, FrameCounter, ObjTimer, ObjGridOffset, ObjQSpeedFrac, ObjTurnRate, Random,
  ObjType, ObjDir, ObjectFirstUnwalkableTile,
} from '../../core/vars.js';
import { InitWalker, Wanderer_TargetPlayer } from './common.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { GetCollidingTileMoving } from '../movement/tiles.js';
import { BoundByRoom } from '../movement/bounds.js';
import { MoveObject } from '../movement/walker.js';
import { stubX } from '../stub.js';

export const UpdateZol = stubX('UpdateZol');

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
