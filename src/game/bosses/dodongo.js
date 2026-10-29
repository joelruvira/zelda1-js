// P21 — bosses/dodongo (Z_04): Dodongo (levels 2 and 7). X = object slot.
// State 0 walks (Wanderer, the X coordinate shifted $10 when not facing left because the boss is 32
// pixels long); a bomb laid in front of its mouth is eaten (state 1, bloated: wait substates, two bombs
// eaten kill it); a bomb's explosion near it stuns it (state 2), when only the sword hurts it.
import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { tableJump } from '../../core/asm.js';
import {
  ObjX, ObjY, ObjDir, ObjState, ObjStunTimer, ObjTurnRate, ObjInvincibilityTimer, ObjInvincibilityMask,
  SampleRequest, Random, FrameCounter, HelpDropCount, HelpDropValue,
  Dodongo_ObjBloatedSubstate, Dodongo_ObjBombHits, Dodongo_ObjBloatedTimer,
} from '../../core/vars.js';
import { Wanderer_TargetPlayer, PlayBossDeathCry } from '../enemies/common.js';
import { UpdateDeadDummy } from '../objects/metaobject.js';
import { ResetObjState } from '../weapons/sword.js';
import { CheckMonsterCollisions, GetObjectMiddle, CheckMonsterSwordCollision } from '../combat/collisions.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored } from '../draw/anim.js';

/** InitDodongo (Z_04). X = boss: roar, face left or right at random. */
export function InitDodongo(x) {
  // InitDodongo (Z_04)
  ram[SampleRequest] = 0x20; // Dodongo/Gohma roar
  let y = 0x01;
  if (ram[Random + x] >= 0x80) y++;
  ram[ObjDir + x] = y;
  return y;
}

/** UpdateDodongo (Z_04). X = boss. */
export function UpdateDodongo(x) {
  // UpdateDodongo (Z_04)
  UpdateDodongoState(x);
  Dodongo_CheckCollisions(x);
  Dodongo_CheckBombHit(x);
  return Dodongo_Draw(x);
}

/** UpdateDodongoState (Z_04). X = boss: TableJump by ObjState (move, bloated, stunned). */
export function UpdateDodongoState(x) {
  // UpdateDodongoState (Z_04)
  return tableJump(label('UpdateDodongoState_JumpTable').addr, ram[ObjState + x], [
    () => UpdateDodongoState0_Move(x),
    () => UpdateDodongoState1_Bloated(x),
    () => UpdateDodongoState2_Stunned(x),
  ]);
}

/** UpdateDodongoState0_Move (Z_04). X = boss: walk as a wanderer (turn rate $20); face right if X < $20. */
export function UpdateDodongoState0_Move(x) {
  // UpdateDodongoState0_Move (Z_04)
  let y = 0x00;
  if ((ram[ObjDir + x] & 0x0d) !== 0) {
    ram[ObjX + x] = ram[ObjX + x] + 0x10;
    y = 0xf0;
  }
  // @Move
  const offset = y; // TYA / PHA
  ram[ObjTurnRate + x] = 0x20;
  Wanderer_TargetPlayer(x);
  const a = (offset + ram[ObjX + x]) & 0xff; // PLA / CLC / ADC
  ram[ObjX + x] = a;
  if (a < 0x20) ram[ObjDir + x] = 0x01;
}

/** UpdateDodongoState2_Stunned (Z_04). X = boss: stun timer 0 (or >= $81) -> $20; 1 -> back to state 0. */
export function UpdateDodongoState2_Stunned(x) {
  // UpdateDodongoState2_Stunned (Z_04)
  const y = (ram[ObjStunTimer + x] - 1) & 0xff;
  if (y === 0) return UpdateDodongoState1_Bloated_Sub_End(x);
  if (y & 0x80) ram[ObjStunTimer + x] = 0x20;
}

/** UpdateDodongoState1_Bloated (Z_04). X = boss: TableJump by the bloated substate. */
export function UpdateDodongoState1_Bloated(x) {
  // UpdateDodongoState1_Bloated (Z_04)
  const wait = () => UpdateDodongoState1_Bloated_Sub_Wait(x);
  return tableJump(label('UpdateDodongoState1_Bloated_JumpTable').addr, ram[Dodongo_ObjBloatedSubstate + x], [
    wait, wait, wait,
    () => UpdateDodongoState1_Bloated_Sub_Die(x),
    () => UpdateDodongoState1_Bloated_Sub_End(x),
  ]);
}

/**
 * UpdateDodongoState1_Bloated_Sub_Wait (Z_04). X = boss. Bloated timer 0: set it for the substate (and in
 * substate 0 remove the bomb of slot $10 and count a bomb hit); 1: next substate (from 2 on, with fewer
 * than two bomb hits, go to substate 4 = back to walking). Always decrements the timer.
 */
export function UpdateDodongoState1_Bloated_Sub_Wait(x) {
  // UpdateDodongoState1_Bloated_Sub_Wait (Z_04)
  let y = (ram[Dodongo_ObjBloatedTimer + x] - 1) & 0xff;
  if (y === 0) {
    // @AdvanceSubstate
    ram[Dodongo_ObjBloatedSubstate + x]++;
    if (ram[Dodongo_ObjBloatedSubstate + x] >= 0x02 && ram[Dodongo_ObjBombHits + x] < 0x02) {
      ram[Dodongo_ObjBloatedSubstate + x] = 0x04;
    }
    return L_Dodongo_DecrementBloatedTimer(x);
  }
  if (!(y & 0x80)) return L_Dodongo_DecrementBloatedTimer(x);
  y = ram[Dodongo_ObjBloatedSubstate + x];
  ram[Dodongo_ObjBloatedTimer + x] = table(bus.rom, 'DodongoBloatedWaitTimes').byte(y);
  if (y !== 0x00) return L_Dodongo_DecrementBloatedTimer(x);
  ram[ObjState + 0x10] = 0x00; // deactivate the bomb in slot $10
  ram[Dodongo_ObjBombHits + x] = ram[Dodongo_ObjBombHits + x] + 0x01;
  return L_Dodongo_DecrementBloatedTimer(x);
}

/** L_Dodongo_DecrementBloatedTimer (Z_04). X = boss. */
export function L_Dodongo_DecrementBloatedTimer(x) {
  // L_Dodongo_DecrementBloatedTimer (Z_04)
  ram[Dodongo_ObjBloatedTimer + x]--;
}

/** UpdateDodongoState1_Bloated_Sub_Die (Z_04). X = boss: dead dummy sparkle, death cry; falls into _Sub_End. */
export function UpdateDodongoState1_Bloated_Sub_Die(x) {
  // UpdateDodongoState1_Bloated_Sub_Die (Z_04)
  UpdateDeadDummy(x);
  PlayBossDeathCry();
  return UpdateDodongoState1_Bloated_Sub_End(x); // falls through
}

/** UpdateDodongoState1_Bloated_Sub_End (Z_04). X = boss: state 0, bloated substate 0. @returns A = 0 */
export function UpdateDodongoState1_Bloated_Sub_End(x) {
  // UpdateDodongoState1_Bloated_Sub_End (Z_04)
  const a = ResetObjState(x);
  ram[Dodongo_ObjBloatedSubstate + x] = a;
  return a;
}

/**
 * Dodongo_CheckCollisions (Z_04). X = boss: collisions at its position and, facing horizontally, $10 to
 * the right. Harmed (invincibility timer <> 0) means it dies (a bomb drop helps: HelpDropCount/Value $A).
 */
export function Dodongo_CheckCollisions(x) {
  // Dodongo_CheckCollisions (Z_04)
  Dodongo_CheckCollisionsStandardSize(x);
  if (ram[ObjInvincibilityTimer + x] === 0) {
    if (ram[ObjDir + x] >= 0x04) return; // L11989_Exit
    const savedX = ram[ObjX + x]; // PHA
    ram[ObjX + x] = savedX + 0x10;
    Dodongo_CheckCollisionsStandardSize(x);
    ram[ObjX + x] = savedX; // PLA
    if (ram[ObjInvincibilityTimer + x] === 0) return; // L11989_Exit
  }
  // @Die
  UpdateDodongoState1_Bloated_Sub_Die(x);
  ram[HelpDropCount] = 0x0a;
  ram[HelpDropValue] = 0x0a;
}

/** L11989_Exit (Z_04): RTS. */
export function L11989_Exit() {
  // L11989_Exit (Z_04)
}

/**
 * Dodongo_CheckCollisionsStandardSize (Z_04). X = boss: collisions as a 16x16 monster invincible to
 * everything; when stunned (state 2) the sword (slot $D) can hit it.
 */
export function Dodongo_CheckCollisionsStandardSize(x) {
  // Dodongo_CheckCollisionsStandardSize (Z_04)
  ram[ObjInvincibilityMask + x] = 0xff;
  CheckMonsterCollisions(x);
  if (ram[ObjState + x] !== 0x02) return; // L11989_Exit
  ram[ObjInvincibilityMask + x] = 0xfe;
  GetObjectMiddle(x);
  return CheckMonsterSwordCollision(x, 0x0d);
}

/**
 * Dodongo_CheckBombHit (Z_04). X = boss, walking (state 0). Hotspots in [00]/[01] (boss) and [02]/[03]
 * (bomb of slot $10), through the original carry chain. A live bomb (state $12) may be eaten
 * (Dodongo_TryEatBomb); a blowing one (< $20) in range stuns it (state 2).
 */
export function Dodongo_CheckBombHit(x) {
  // Dodongo_CheckBombHit (Z_04)
  if (ram[ObjState + x] !== 0) return; // @Exit
  cpu.c = 0;
  let a = cpu.adc(ram[ObjX + x], 0x08);
  cpu.cmp(ram[ObjDir + x], 0x04);
  if (!cpu.c) a = cpu.adc(a, 0x08);
  ram[0x00] = a;
  ram[0x01] = cpu.adc(ram[ObjY + x], 0x08);
  ram[0x02] = cpu.adc(ram[ObjX + 0x10], 0x08);
  ram[0x03] = cpu.adc(ram[ObjY + 0x10], 0x08);
  a = ram[ObjState + 0x10];
  if (a === 0) return; // no bomb
  if (a === 0x12) return Dodongo_TryEatBomb(x);
  if (a >= 0x20) return; // it is a fire
  if (Dodongo_IsBombInRange(0x00) !== 0) return;
  ram[ObjState + x] = 0x02; // stunned
}

/**
 * Dodongo_TryEatBomb (Z_04, part of Dodongo_CheckBombHit). X = boss: if the bomb is over the boss and
 * within the mouth limits for its direction (signed compares of [04]/[05]), eat it: state 1, bomb
 * removed, bloated substate 0.
 */
export function Dodongo_TryEatBomb(x) {
  // Dodongo_TryEatBomb (Z_04)
  if (Dodongo_IsBombInRange(0x01) !== 0) return;
  const neg = table(bus.rom, 'DodongoMouthNegativeLimits0');
  const pos = table(bus.rom, 'DodongoMouthPositiveLimits0');
  ram[0x00] = 0x01;
  let y = ram[ObjDir + x] >> 1;
  let a = ram[0x04];
  do {
    // @LoopLimit
    if ((a - neg.byte(y)) & 0x80) return; // CMP / BMI
    if (!((a - pos.byte(y)) & 0x80)) return; // CMP / BPL
    y = (y + 0x0a) & 0xff; // the vertical limits (...Limits1)
    a = ram[0x05];
    ram[0x00] = (ram[0x00] - 1) & 0xff;
  } while (!(ram[0x00] & 0x80));
  ram[ObjState + x]++;
  ram[ObjState + 0x10] = 0x00;
  ram[Dodongo_ObjBloatedSubstate + x] = 0x00;
}

/**
 * Dodongo_IsBombInRange (Z_04). Y = 0 (dust cloud) or 1 (bomb); [00]/[01] boss hotspot, [02]/[03] bomb.
 * Writes [06]/[07] limits, [04]/[05] distances in range, [08].
 * @returns A = [08]: 0 (Z) if in range on both axes
 */
export function Dodongo_IsBombInRange(y) {
  // Dodongo_IsBombInRange (Z_04)
  ram[0x06] = table(bus.rom, 'DodongoBombPositiveLimits').byte(y);
  ram[0x07] = table(bus.rom, 'DodongoBombNegativeLimits').byte(y);
  ram[0x08] = 0x03;
  for (y = 0x01; y >= 0; y--) {
    // @LoopAxis
    const a = (ram[0x00 + y] - ram[0x02 + y]) & 0xff;
    if (!((a - ram[0x06]) & 0x80)) continue; // BPL
    if ((a - ram[0x07]) & 0x80) continue; // BMI
    ram[0x04 + y] = a;
    ram[0x08] >>= 1;
  }
  return ram[0x08];
}

/**
 * Dodongo_Draw (Z_04). X = boss: frame image index from the 5-way direction ([00] = dir >> 1), the state
 * and the animation; bloated substates 2-3 flicker; horizontal bodies draw a second (right) half $10 to
 * the right with the left/right frame swapped.
 */
export function Dodongo_Draw(x) {
  // Dodongo_Draw (Z_04)
  Anim_SetSpriteDescriptorLevelPaletteRow();
  ram[0x00] = ram[ObjDir + x] >> 1;
  let y = ram[ObjState + x];
  let a;
  let walking = true;
  if (y === 0) {
    a = 0x08; // @DrawWalkingFast
  } else {
    a = 0x20;
    y = (y - 1) & 0xff;
    if (y === 0) {
      // Bloated.
      y = ram[Dodongo_ObjBloatedSubstate + x];
      if (y === 0) {
        a = 0x08; // @DrawWalkingFast
      } else if (y === 0x02 || y === 0x03) {
        // @DrawFaded
        if ((ram[FrameCounter] & 0x02) === 0) return; // L11B00_Exit
        y = ram[0x00];
        walking = false;
      } else {
        y = (ram[0x00] + 0x14) & 0xff; // bloated frame images / H-flips
        walking = false;
      }
    }
  }
  if (walking) {
    // @DrawWalking
    y = ram[0x00];
    if ((a & ram[FrameCounter]) !== 0) y = (y + 0x05) & 0xff;
  }
  // @PrepareToDraw
  const images = table(bus.rom, 'DodongoFrameImages');
  Anim_FetchObjPosForSpriteDescriptor(x);
  const index = y; // TYA / PHA
  ram[0x0f] = table(bus.rom, 'DodongoFrameHFlips').byte(y);
  a = images.byte(y);
  if (a === 0x07 || a === 0x09) DrawObjectMirrored(a, x);
  else DrawObjectNotMirrored(a, x); // @DrawLeftSide
  // @DrawRightSide
  y = index;
  if ((ram[ObjDir + x] & 0x03) === 0) return; // L11B00_Exit
  ram[0x00] = ram[ObjX + x] + 0x10;
  Anim_SetSpriteDescriptorLevelPaletteRow();
  return DrawObjectNotMirrored(images.byte(y) ^ 0x01, x);
}

/** Anim_SetSpriteDescriptorLevelPaletteRow (Z_04): [04] = [05] = 3. @returns A = 3 */
export function Anim_SetSpriteDescriptorLevelPaletteRow() {
  // Anim_SetSpriteDescriptorLevelPaletteRow (Z_04)
  return Anim_SetSpriteDescriptorAttributes(0x03);
}

/** L11B00_Exit (Z_04): RTS. */
export function L11B00_Exit() {
  // L11B00_Exit (Z_04)
}
