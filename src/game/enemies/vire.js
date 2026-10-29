// P19 — enemies/vire (Z_04): vires hop sideways and split into two red keeses when hurt.
// X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  ObjState, RoomObjCount, InvClock, ObjStunTimer, ObjDir, ObjGridOffset, ObjY, ObjMetastate,
  ObjInvincibilityTimer, ObjAnimFrame,
} from '../../core/vars.js';
import { DestroyMonster, FindEmptyMonsterSlot } from '../objects/slots.js';
import { Shoot } from './shots.js';
import { UpdateCommonWanderer } from './common.js';
import { UpdateZolState1_Shove } from './zol-gel.js';
import { Abs } from '../movement/math.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, DrawObjectMirrored } from '../draw/anim.js';

/**
 * UpdateVire (Z_04). X = vire: run its state; at state >= 2 destroy it and "shoot" up to two red
 * keeses ($1C) into empty slots; otherwise collide and draw.
 */
export function UpdateVire(x) {
  // UpdateVire (Z_04)
  UpdateVireState(x);
  if (ram[ObjState + x] < 0x02) {
    CheckVireCollisions(x);
    return DrawVire(x);
  }
  // @SplitUp
  ram[RoomObjCount]++;
  DestroyMonster(x);
  for (let y = 0x01; !(y & 0x80); y = (y - 1) & 0xff) {
    // @LoopMakeKeese (Y saved with PHA / PLA)
    const f = FindEmptyMonsterSlot();
    if (f.y === 0) continue; // BEQ @NextLoopMakeKeese
    ram[0x00] = 0x1c;
    Shoot();
  }
}

/** UpdateVireState (Z_04). X = vire: UpdateVireState_JumpTable by ObjState. */
export function UpdateVireState(x) {
  // UpdateVireState (Z_04)
  return tableJump(label('UpdateVireState_JumpTable').addr, ram[ObjState + x], [
    () => UpdateVireState0(x),
    () => UpdateZolState1_Shove(x),
  ]);
}

/** UpdateVireState0 (Z_04). X = vire: wander (turn rate $80); hop (VireJumpOffsets) moving sideways. */
export function UpdateVireState0(x) {
  // UpdateVireState0 (Z_04)
  UpdateCommonWanderer(0x80, x);
  if ((ram[InvClock] | ram[ObjStunTimer + x]) !== 0) return; // @Exit
  if ((ram[ObjDir + x] & 0x03) === 0) return; // @Exit
  const y = Abs(ram[ObjGridOffset + x]);
  ram[ObjY + x] = ram[ObjY + x] + table(bus.rom, 'VireJumpOffsets').byte(y);
}

/** CheckVireCollisions (Z_04). X = vire in state 0: collide; when hurt (not killed), go to state 1. */
export function CheckVireCollisions(x) {
  // CheckVireCollisions (Z_04)
  if (ram[ObjState + x] !== 0) return; // @Exit
  CheckMonsterCollisions(x);
  if (ram[ObjMetastate + x] !== 0) return;
  if (ram[ObjInvincibilityTimer + x] === 0) return;
  ram[ObjState + x]++;
}

/** DrawVire (Z_04). X = vire: frame image = movement frame (+2 facing up), mirrored. */
export function DrawVire(x) {
  // DrawVire (Z_04)
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x0a, x);
  const a = ((ram[ObjDir + x] & 0x08) >> 2) + ram[ObjAnimFrame + x];
  return DrawObjectMirrored(a & 0xff, x);
}
