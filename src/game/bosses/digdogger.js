// P21 — bosses/digdogger (Z_04): Digdogger (levels 5 and 8 / second quest). X = object slot.
// A big 32x32 flyer that speeds up and slows down between target speeds. The recorder (UsedFlute)
// makes it split up into ChildDigdoggerCount little digdoggers (type $18) in the next slots.
import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { tableJump } from '../../core/asm.js';
import {
  ObjX, ObjY, ObjDir, ObjType, ObjTimer, ObjStunTimer, ObjAnimFrame, InvClock, UsedFlute, Random,
  SampleRequest, RoomObjCount, ChildDigdoggerCount,
  Digdogger_ObjSpeedFrac, Digdogger_ObjSpeedWhole, Digdogger_ObjTargetSpeedFrac,
  Digdogger_ObjTargetSpeedWhole, Digdogger_ObjSpeedFlag, Digdogger_ObjIsChild, Digdogger_ObjCurPart,
} from '../../core/vars.js';
import { PlayBossDeathCry } from '../enemies/common.js';
import { BoundFlyer, TurnTowardsPlayer8, TurnRandomlyDir8 } from '../enemies/flyer.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import {
  Anim_FetchObjPosForSpriteDescriptor, Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor,
  DrawObjectMirrored, DrawObjectNotMirrored,
} from '../draw/anim.js';
import { Anim_SetSpriteDescriptorLevelPaletteRow } from './dodongo.js';
import { $br, $pxa } from '../../core/timing.js';

// $0412: the speed accumulator (Manhandla_ObjSpeedAccum); the asm names it by address here.
const SPEED_ACCUM = 0x0412;

/**
 * InitDigdogger1 (Z_04). X = object: roar, random 8-way direction, speed $3F (low byte), target speed $80
 * (low byte), 3 children. @returns A = 3
 */
export function InitDigdogger1(x) {
  // InitDigdogger1 (Z_04)
  ram[SampleRequest] = 0x40; // Digdogger/Manhandla/Patra roar
  const y = ram[Random + x] & 0x07;
  const d8 = table(bus.rom, 'Directions8');
  $pxa('Z_04:4864', d8.addr, y);
  ram[ObjDir + x] = d8.byte(y);
  ram[Digdogger_ObjSpeedFrac + x] = 0x3f;
  ram[Digdogger_ObjTargetSpeedFrac + x] = 0x80;
  ram[ChildDigdoggerCount] = 0x03;
  return 0x03;
}

/** InitDigdogger2 (Z_04). X = object: as InitDigdogger1, type $38, one child. @returns A = 1 */
export function InitDigdogger2(x) {
  // InitDigdogger2 (Z_04)
  InitDigdogger1(x);
  ram[ObjType + x] = 0x38;
  ram[ChildDigdoggerCount] = 0x01;
  return 0x01;
}

/**
 * L_Digdogger_AfterFlute (Z_04, part of UpdateDigdogger). X = object, Y = UsedFlute (<> 0).
 * Flute state 1: a big digdogger sets a $40 timer and goes to state 2 (a child turns and moves as usual).
 * State 2: while the timer runs, alternate big/little every 8 frames; at 0 make the children in the
 * next slots (at slot 1's position), cry, and erase the big one (drawn little one last time).
 */
export function L_Digdogger_AfterFlute(x, y) {
  // L_Digdogger_AfterFlute (Z_04)
  y = (y - 1) & 0xff;
  if (!$br('Z_04:5168', y !== 0)) {
    $pxa('Z_04:5173', Digdogger_ObjIsChild, x);
    if ($br('Z_04:5174', ram[Digdogger_ObjIsChild + x] !== 0)) return L_Digdogger_Turn(x);
    ram[ObjTimer + x] = 0x40;
    ram[UsedFlute]++;
    return CheckBigDigdoggerCollisions(x);
  }
  // @SplitUp
  let a = ram[ObjTimer + x];
  if (!$br('Z_04:5186', a === 0)) {
    // Unverified code 1159D.
    if (!$br('Z_04:5197', (a & 0x07) !== 0)) {
      $pxa('Z_04:5198', Digdogger_ObjIsChild, x);
      a = ram[Digdogger_ObjIsChild + x] ^ 0x01;
      ram[Digdogger_ObjIsChild + x] = a;
      if ($br('Z_04:5201', a === 0)) return CheckBigDigdoggerCollisions(x);
    }
    return L_Digdogger_DrawAsLittle(x);
  }
  // @MakeChildren
  ram[UsedFlute]--;
  a = ram[ChildDigdoggerCount];
  ram[0x00] = a; // loop counter
  ram[RoomObjCount] = a;
  const parent = x; // TXA / PHA
  do {
    // @LoopMakeChild
    x = (x + 1) & 0xff;
    InitDigdogger1(x);
    ram[ObjType + x] = 0x18;
    ram[Digdogger_ObjTargetSpeedWhole + x]++;
    ram[Digdogger_ObjIsChild + x] = 0x01;
    ram[Digdogger_ObjSpeedFlag + x] = 0x00;
    ram[ObjX + x] = ram[ObjX + 1];
    ram[ObjY + x] = ram[ObjY + 1];
    ram[0x00]--;
  } while ($br('Z_04:5245', ram[0x00] !== 0));
  x = parent; // PLA / TAX
  PlayBossDeathCry();
  ram[ObjType + x] = 0x00;
  return L_Digdogger_DrawAsLittle(x);
}

/** L_Digdogger_TurnTowardLink (Z_04, part of L_Digdogger_Turn). X = object. */
export function L_Digdogger_TurnTowardLink(x) {
  // L_Digdogger_TurnTowardLink (Z_04)
  TurnTowardsPlayer8(x);
  return L_Digdogger_Move(x);
}

/**
 * UpdateDigdogger (Z_04). X = object. With the clock or stunned: only bounds, collisions and drawing.
 * After the flute: L_Digdogger_AfterFlute. Else change speed, turn every $10 frames, move.
 */
export function UpdateDigdogger(x) {
  // UpdateDigdogger (Z_04)
  if ($br('Z_04:5272', (ram[InvClock] | ram[ObjStunTimer + x]) !== 0)) return L_Digdogger_DrawAndCheckCollisions(x);
  const y = ram[UsedFlute];
  if ($br('Z_04:5277', y !== 0)) return L_Digdogger_AfterFlute(x, y);
  return L_Digdogger_Turn(x); // falls through
}

/** L_Digdogger_Turn (Z_04, part of UpdateDigdogger). X = object. */
export function L_Digdogger_Turn(x) {
  // L_Digdogger_Turn (Z_04)
  Digdogger_ChangeSpeed(x);
  if (!$br('Z_04:5285', ram[ObjTimer + x] !== 0)) {
    ram[ObjTimer + x] = 0x10;
    if ($br('Z_04:5290', ram[Random + x] >= 0x80)) return L_Digdogger_TurnTowardLink(x);
    TurnRandomlyDir8(x);
  }
  return L_Digdogger_Move(x); // falls through
}

/** L_Digdogger_Move (Z_04). X = object: move, then L_Digdogger_DrawAndCheckCollisions. */
export function L_Digdogger_Move(x) {
  // L_Digdogger_Move (Z_04)
  Digdogger_Move(x);
  return L_Digdogger_DrawAndCheckCollisions(x); // falls through
}

/** L_Digdogger_DrawAndCheckCollisions (Z_04, part of L_Digdogger_Move). X = object. */
export function L_Digdogger_DrawAndCheckCollisions(x) {
  // L_Digdogger_DrawAndCheckCollisions (Z_04)
  $pxa('Z_04:5298', Digdogger_ObjIsChild, x);
  if ($br('Z_04:5299', ram[Digdogger_ObjIsChild + x] === 0)) return CheckBigDigdoggerCollisions(x);
  BoundFlyer(x);
  CheckMonsterCollisions(x);
  return Digdogger_Draw(x);
}

/**
 * CheckBigDigdoggerCollisions (Z_04). X = object: bounds and collisions at four corners (cumulative
 * DigdoggerCornerOffsets, part index in Digdogger_ObjCurPart), position restored, drawn big, then the
 * little digdogger in the middle (falls into L_Digdogger_DrawAsLittle).
 */
export function CheckBigDigdoggerCollisions(x) {
  // CheckBigDigdoggerCollisions (Z_04)
  const savedX = ram[ObjX + x]; // PHA
  const savedY = ram[ObjY + x]; // PHA
  ram[Digdogger_ObjCurPart + x] = 0x00;
  const offX = table(bus.rom, 'DigdoggerCornerOffsetsX');
  const offY = table(bus.rom, 'DigdoggerCornerOffsetsY');
  do {
    // @LoopCornerCollision
    $pxa('Z_04:5322', Digdogger_ObjCurPart, x);
    const y = ram[Digdogger_ObjCurPart + x];
    $pxa('Z_04:5327', offX.addr, y);
    ram[ObjX + x] = ram[ObjX + x] + offX.byte(y);
    $pxa('Z_04:5331', offY.addr, y);
    ram[ObjY + x] = ram[ObjY + x] + offY.byte(y);
    BoundFlyer(x);
    CheckMonsterCollisions(x);
    ram[Digdogger_ObjCurPart + x]++;
    $pxa('Z_04:5340', Digdogger_ObjCurPart, x);
  } while ($br('Z_04:5342', ram[Digdogger_ObjCurPart + x] < 0x04));
  ram[ObjY + x] = savedY; // PLA
  ram[ObjX + x] = savedX; // PLA
  Digdogger_Draw(x);
  return L_Digdogger_DrawAsLittle(x); // falls through
}

/**
 * L_Digdogger_DrawAsLittle (Z_04). X = object: draw as a little digdogger (type $18, child) 8 pixels
 * right and down, then restore type, child flag and position.
 */
export function L_Digdogger_DrawAsLittle(x) {
  // L_Digdogger_DrawAsLittle (Z_04)
  const savedX = ram[ObjX + x]; // PHA
  const savedY = ram[ObjY + x]; // PHA
  ram[ObjY + x] = savedY + 0x08;
  ram[ObjX + x] = ram[ObjX + x] + 0x08;
  $pxa('Z_04:5368', Digdogger_ObjIsChild, x);
  const isChild = ram[Digdogger_ObjIsChild + x]; // PHA
  $pxa('Z_04:5370', ObjType, x);
  const type = ram[ObjType + x]; // PHA
  ram[ObjType + x] = 0x18;
  ram[Digdogger_ObjIsChild + x] = 0x01;
  Digdogger_Draw(x);
  ram[ObjType + x] = type; // PLA
  ram[Digdogger_ObjIsChild + x] = isChild; // PLA
  ram[ObjY + x] = savedY; // PLA
  ram[ObjX + x] = savedX; // PLA
  return savedX;
}

/** Digdogger_ChangeSpeed (Z_04). X = object: TableJump by the speed flag (speed up, slow down). */
export function Digdogger_ChangeSpeed(x) {
  // Digdogger_ChangeSpeed (Z_04)
  $pxa('Z_04:5395', Digdogger_ObjSpeedFlag, x);
  return tableJump(label('Digdogger_ChangeSpeed_JumpTable').addr, ram[Digdogger_ObjSpeedFlag + x], [
    () => Digdogger_SpeedUp(x),
    () => Digdogger_SlowDown(x),
  ]);
}

/** Digdogger_SpeedUp (Z_04). X = object: speed + 1; at the target, decelerate toward $0040 ($0140 child). */
export function Digdogger_SpeedUp(x) {
  // Digdogger_SpeedUp (Z_04)
  ram[Digdogger_ObjSpeedFrac + x]++;
  if (!$br('Z_04:5405', ram[Digdogger_ObjSpeedFrac + x] !== 0)) ram[Digdogger_ObjSpeedWhole + x]++;
  $pxa('Z_04:5409', Digdogger_ObjSpeedFrac, x); $pxa('Z_04:5410', Digdogger_ObjTargetSpeedFrac, x);
  if ($br('Z_04:5411', ram[Digdogger_ObjSpeedFrac + x] !== ram[Digdogger_ObjTargetSpeedFrac + x])) return; // L116EA_Exit
  $pxa('Z_04:5412', Digdogger_ObjSpeedWhole, x); $pxa('Z_04:5413', Digdogger_ObjTargetSpeedWhole, x);
  if ($br('Z_04:5414', ram[Digdogger_ObjSpeedWhole + x] !== ram[Digdogger_ObjTargetSpeedWhole + x])) return;
  ram[Digdogger_ObjSpeedFlag + x]++;
  return SetTargetSpeed(0x40, x);
}

/** Digdogger_SlowDown (Z_04). X = object: speed - 1; at the target, accelerate toward $0080 ($0180 child). */
export function Digdogger_SlowDown(x) {
  // Digdogger_SlowDown (Z_04)
  ram[Digdogger_ObjSpeedFrac + x]--;
  $pxa('Z_04:5426', Digdogger_ObjSpeedFrac, x);
  if (!$br('Z_04:5428', ram[Digdogger_ObjSpeedFrac + x] !== 0xff)) ram[Digdogger_ObjSpeedWhole + x]--; // unverified 116C2
  $pxa('Z_04:5434', Digdogger_ObjSpeedFrac, x); $pxa('Z_04:5435', Digdogger_ObjTargetSpeedFrac, x);
  if ($br('Z_04:5436', ram[Digdogger_ObjSpeedFrac + x] !== ram[Digdogger_ObjTargetSpeedFrac + x])) return; // L116EA_Exit
  $pxa('Z_04:5437', Digdogger_ObjSpeedWhole, x); $pxa('Z_04:5438', Digdogger_ObjTargetSpeedWhole, x);
  if ($br('Z_04:5439', ram[Digdogger_ObjSpeedWhole + x] !== ram[Digdogger_ObjTargetSpeedWhole + x])) return;
  ram[Digdogger_ObjSpeedFlag + x]--;
  return SetTargetSpeed(0x80, x); // falls through
}

/** SetTargetSpeed (Z_04). A = low byte, X = object: target speed $00xx ($01xx for a child). */
export function SetTargetSpeed(a, x) {
  // SetTargetSpeed (Z_04)
  ram[Digdogger_ObjTargetSpeedFrac + x] = a;
  ram[Digdogger_ObjTargetSpeedWhole + x] = 0x00;
  $pxa('Z_04:5453', Digdogger_ObjIsChild, x);
  if ($br('Z_04:5454', ram[Digdogger_ObjIsChild + x] === 0)) return; // L116EA_Exit
  ram[Digdogger_ObjTargetSpeedWhole + x]++;
}

/** L116EA_Exit (Z_04): RTS. */
export function L116EA_Exit() {
  // L116EA_Exit (Z_04)
}

/**
 * Digdogger_Move (Z_04). X = object: accumulator ($0412) += speed low & $E0, [03] = speed high + carry;
 * move [03] pixels along each component of the 8-way direction (mask in [02] shifted by ASL, whose
 * carry feeds the SBC/ADC as in the original). @returns A = 0 (Anim_FetchObjPosForSpriteDescriptor)
 */
export function Digdogger_Move(x) {
  // Digdogger_Move (Z_04)
  moveBySpeedAccum(x, Digdogger_ObjSpeedFrac, Digdogger_ObjSpeedWhole, SPEED_ACCUM,
    ['Z_04:5472', 'Z_04:5475', 'Z_04:5479', 'Z_04:5495', 'Z_04:5506', 'Z_04:5516', 'Z_04:5526']);
  return Anim_FetchObjPosForSpriteDescriptor(x); // @End
}

/**
 * The movement shared by Digdogger_Move and Manhandla_Move (the asm has two identical copies, on the
 * same arrays): from the accumulator to the @Up step. Leaves [02], [03] and the carry as the original.
 */
export function moveBySpeedAccum(x, frac, whole, accum, refs) {
  cpu.c = 0;
  $pxa(refs[0], frac, x); $pxa(refs[1], accum, x);
  ram[accum + x] = cpu.adc(ram[frac + x] & 0xe0, ram[accum + x]);
  $pxa(refs[2], whole, x);
  ram[0x03] = cpu.adc(ram[whole + x], 0x00);
  ram[0x02] = 0xa1;
  if (!$br(refs[3], (ram[ObjDir + x] & ram[0x02]) === 0)) {
    cpu.c = 0;
    ram[ObjX + x] = cpu.adc(ram[ObjX + x], ram[0x03]);
  }
  // @Left
  cpu.aslMem(0x02); // bit 7 of $A1 sets carry
  if (!$br(refs[4], (ram[ObjDir + x] & ram[0x02]) === 0)) ram[ObjX + x] = cpu.sbc(ram[ObjX + x], ram[0x03]);
  // @Down
  cpu.aslMem(0x02); // clears carry
  if (!$br(refs[5], (ram[ObjDir + x] & ram[0x02]) === 0)) ram[ObjY + x] = cpu.adc(ram[ObjY + x], ram[0x03]);
  // @Up
  cpu.aslMem(0x02); // sets carry
  if (!$br(refs[6], (ram[ObjDir + x] & ram[0x02]) === 0)) ram[ObjY + x] = cpu.sbc(ram[ObjY + x], ram[0x03]);
}

/**
 * Digdogger_Draw (Z_04). X = object: advance the animation (6); a child is one mirrored level-palette
 * object; the big one is four 16x16 quarters (frame image 0, flips from DigdoggerSpriteAttrs / odd index).
 */
export function Digdogger_Draw(x) {
  // Digdogger_Draw (Z_04)
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x06, x);
  $pxa('Z_04:5548', Digdogger_ObjIsChild, x);
  if ($br('Z_04:5549', ram[Digdogger_ObjIsChild + x] !== 0)) {
    // @DrawLittle
    Anim_SetSpriteDescriptorLevelPaletteRow();
    $pxa('Z_04:5593', ObjAnimFrame, x);
    return DrawObjectMirrored(ram[ObjAnimFrame + x], x);
  }
  const offX = table(bus.rom, 'DigdoggerSpriteOffsetsX');
  const offY = table(bus.rom, 'DigdoggerSpriteOffsetsY');
  const attrs = table(bus.rom, 'DigdoggerSpriteAttrs');
  for (let y = 0x00; ;) {
    // @LoopPart
    $pxa('Z_04:5559', offX.addr, y);
    ram[0x00] = ram[ObjX + x] + offX.byte(y);
    $pxa('Z_04:5565', offY.addr, y);
    ram[0x01] = ram[ObjY + x] + offY.byte(y);
    $pxa('Z_04:5570', attrs.addr, y);
    Anim_SetSpriteDescriptorAttributes(attrs.byte(y));
    ram[0x0f] = y & 0x01;
    DrawObjectNotMirrored(0x00, x);
    y++;
    if (!$br('Z_04:5587', y !== 0x04)) break;
  }
}
