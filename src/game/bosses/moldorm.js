// P22 — bosses/moldorm (Z_04): Moldorm, two chains of 5 fireball segments (slots 1-5 and 6-$A) whose
// heads (slots 5 and $A) fly with the flyer engine and pass their old directions down the chain.
// X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjDir, ObjMetastate, ObjUninitialized, ObjAttr, ObjHP, ObjType, ObjTimer,
  ObjInvincibilityTimer, Moldorm_ObjBounceDir, Moldorm_ObjOldDir, Flyer_ObjSpeed, Flyer_ObjFlyingState,
  Flyer_ObjTurns, FlyingMaxSpeedFrac, RoomObjCount, Random, InvClock,
} from '../../core/vars.js';
import { MoveFlyer, Flyer_Chase, Flyer_Wander } from '../enemies/flyer.js';
import { Anim_WriteSprite } from '../draw/sprites.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { CheckBossHitReaction } from './aquamentus.js';
import { ResetObjMetastate } from '../objects/slots.js';

/**
 * InitMoldorm (Z_04). Makes the 10 segments in slots 1-$A at ($80, $70), copying slot 1's attributes
 * and HP; random 8-way directions for the heads (slots 5 and $A). Max speed $80, room count 8.
 */
export function InitMoldorm() {
  // InitMoldorm (Z_04)
  for (let y = 9; y >= 0; y--) {
    ram[ObjX + 1 + y] = 0x80;
    ram[ObjY + 1 + y] = 0x70;
    ram[ObjDir + 1 + y] = 0x00;
    ram[Moldorm_ObjBounceDir + 1 + y] = 0x00;
    ram[ObjMetastate + 1 + y] = 0x00;
    ram[ObjUninitialized + 1 + y] = 0x00;
    ram[ObjAttr + 1 + y] = ram[ObjAttr + 1];
    ram[ObjHP + 1 + y] = ram[ObjHP + 1];
    ram[Flyer_ObjSpeed + 1 + y] = 0x80;
    ram[Flyer_ObjFlyingState + 1 + y] = 0x02;
    ram[ObjType + 1 + y] = 0x41; // all segments are Moldorm
  }
  const dirs = table(bus.rom, 'Directions8');
  let a = dirs.byte(ram[Random + 5] & 0x07);
  ram[ObjDir + 5] = a;
  ram[Moldorm_ObjOldDir + 5] = a;
  a = dirs.byte(ram[Random + 10] & 0x07);
  ram[ObjDir + 10] = a;
  ram[Moldorm_ObjOldDir + 10] = a;
  // One turn: the first flight routine call ends its state at once.
  ram[Flyer_ObjTurns + 5] = 0x01;
  ram[Flyer_ObjTurns + 10] = 0x01;
  ram[FlyingMaxSpeedFrac] = 0x80;
  ram[RoomObjCount] = 0x08; // 8: the max kill count that can be saved
}

/**
 * UpdateMoldorm (Z_04). X = segment. Flies (without the clock), draws the fireball tile and checks
 * collisions keeping direction and timer. A dead segment swaps places with its chain's tail.
 */
export function UpdateMoldorm(x) {
  // UpdateMoldorm (Z_04)
  if (ram[ObjDir + x] === 0) return;
  if (ram[InvClock] === 0) {
    ControlMoldormFlight(x);
    MoveFlyer(x);
  }
  ram[0x03] = 0x02; // normal, red palette row
  Anim_WriteSprite(0x44, x); // fireball tile
  const dir = ram[ObjDir + x]; // PHA
  const timer = ram[ObjTimer + x]; // PHA
  CheckMonsterCollisions(x);
  ram[ObjTimer + x] = timer;
  ram[ObjDir + x] = dir;
  if (ram[ObjMetastate + x] === 0) return;
  // Dead segment: HP $20, then swap with the tail of its chain.
  ram[ObjHP + x] = 0x20;
  CheckBossHitReaction(x);
  let y = x < 0x06 ? 0xff : 0x04;
  let n = 0;
  do {
    y = (y + 1) & 0xff;
    // Without any $41 in ObjType+1..+$100 the original loops forever.
    if (++n > 0x100) throw new Error('UpdateMoldorm: did not return (no tail segment)');
  } while (ram[ObjType + 1 + y] !== 0x41);
  ram[ObjTimer + 1 + y] = 0x11;
  ram[ObjInvincibilityTimer + 1 + y] = ram[ObjInvincibilityTimer + x];
  ram[ObjX + 1 + y] = ram[ObjX + x];
  ram[ObjY + 1 + y] = ram[ObjY + x];
  if (y === 0x04 || y === 0x09) return; // the tail is a head: the last segment died
  ram[ObjType + 1 + y] = 0x5d; // dead dummy
  ResetObjMetastate(x);
}

/** ControlMoldormFlight (Z_04). X = segment: dispatch on the flying state. */
export function ControlMoldormFlight(x) {
  // ControlMoldormFlight (Z_04)
  const f = () => Moldorm_Chase(x);
  return tableJump(label('ControlMoldormFlight_JumpTable').addr, ram[Flyer_ObjFlyingState + x], [
    f, f, f, () => Moldorm_Wander(x),
  ]);
}

/** Moldorm_Chase (Z_04). Only heads: chase, then new flying state on timeout / propagate directions. */
export function Moldorm_Chase(x) {
  // Moldorm_Chase (Z_04)
  if (x !== 0x05 && x !== 0x0a) return L1156B_Exit();
  Flyer_Chase(x);
  if (ram[ObjTimer + x] !== 0) return Moldorm_PropagateDirs(x);
  return Moldorm_ChangeFlyingState(x);
}

/** Moldorm_ChangeFlyingState (Z_04, part of Moldorm_Chase): new state, timer $10, maybe propagate. */
export function Moldorm_ChangeFlyingState(x) {
  Flyer_MoldormDecideState(x);
  ram[ObjTimer + x] = 0x10;
  if (ram[ObjDir - 1 + x] !== 0) return Moldorm_PropagateDirs(x);
}

/** Moldorm_Wander (Z_04). Only heads: wander; on timeout change flying state, then propagate. */
export function Moldorm_Wander(x) {
  // Moldorm_Wander (Z_04)
  if (x !== 0x05 && x !== 0x0a) return L1156B_Exit();
  Flyer_Wander(x);
  if (ram[ObjTimer + x] === 0) return Moldorm_ChangeFlyingState(x);
  return Moldorm_PropagateDirs(x); // falls through
}

/**
 * Moldorm_PropagateDirs (Z_04, part of Moldorm_Wander). When the timer was just rearmed ($10): apply
 * the deferred bounce, shift old directions down the chain and remember the head's direction.
 */
export function Moldorm_PropagateDirs(x) {
  if (ram[ObjTimer + x] !== 0x10) return L1156B_Exit();
  const bounce = ram[Moldorm_ObjBounceDir + x];
  if (bounce !== 0) {
    ram[ObjDir + x] = bounce;
    ram[Moldorm_ObjBounceDir + x] = 0x00;
  }
  ram[0x00] = 0x04;
  let y = x === 0x05 ? 0x00 : 0x05;
  do {
    const a = ram[Moldorm_ObjOldDir + 2 + y];
    ram[Moldorm_ObjOldDir + 1 + y] = a;
    ram[ObjDir + 1 + y] = a;
    y++;
    ram[0x00]--;
  } while (ram[0x00] !== 0);
  ram[Moldorm_ObjOldDir + x] = ram[ObjDir + x];
  return L1156B_Exit();
}

/** L1156B_Exit (Z_04, part of Moldorm_Wander): RTS. */
export function L1156B_Exit() {}

/** Flyer_MoldormDecideState (Z_04). X = head: state 2 (Random >= $40) or 3, with 8 turns. @returns A */
export function Flyer_MoldormDecideState(x) {
  // Flyer_MoldormDecideState (Z_04)
  let y = 0x02;
  if (ram[Random + x] < 0x40) y++;
  ram[Flyer_ObjFlyingState + x] = y;
  ram[Flyer_ObjTurns + x] = 0x08;
  return 0x08;
}
