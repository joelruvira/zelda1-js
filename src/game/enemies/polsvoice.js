// P19 — enemies/polsvoice (Z_04): Pols Voice walks every other frame and jumps over blocks.
// X = object slot in every routine.
import { ram, cpu } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  InvClock, ObjStunTimer, FrameCounter, ObjState, ObjRemDistance, ObjY, ObjX, ObjDir, PolsVoice_ObjLastTile,
  PolsVoice_ObjSpeedWhole, PolsVoice_ObjSpeedFrac, PolsVoice_ObjTargetY, ObjAnimFrame, ObjInvincibilityMask,
  Random, ObjCollidedTile, ObjectFirstUnwalkableTile,
} from '../../core/vars.js';
import { Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, DrawObjectMirrored } from '../draw/anim.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { GetCollidableTile } from '../movement/tiles.js';

/**
 * UpdatePolsVoice (Z_04). X = Pols Voice. On even frames (no clock, not stunned): move horizontally;
 * state 0 walks a distance (ObjRemDistance) and then jumps; state 1 jumps (UpdatePolsVoiceState1_Jumping).
 * Blocks and tiles >= $F4 make it jump; other unwalkable tiles turn it around. Then draw and collide.
 */
export function UpdatePolsVoice(x) {
  // UpdatePolsVoice (Z_04)
  // CPX #$01 / BNE :+ (a no-op branch to the next instruction).
  $br('Z_04:6535', x !== 0x01);
  if ($br('Z_04:6541', (ram[InvClock] | ram[ObjStunTimer + x]) !== 0)) return L_PolsVoice_DrawAndCheckCollisions(x);
  if ($br('Z_04:6547', (ram[FrameCounter] & 0x01) !== 0)) return L_PolsVoice_DrawAndCheckCollisions(x); // LSR / BCS
  const y = PolsVoice_MoveX(x);
  if (!$br('Z_04:6555', ram[ObjState + x] === 0)) {
    UpdatePolsVoiceState1_Jumping(x);
  } else {
    // @State0
    $pxa('Z_04:6564', ObjRemDistance, x);
    if ($br('Z_04:6565', ram[ObjRemDistance + x] === 0)) return setState1(x);
    ram[ObjRemDistance + x]--;
    $pxa('Z_04:6574', table(bus.rom, 'PolsVoiceWalkSpeedsY').addr, y);
    ram[ObjY + x] = ram[ObjY + x] + table(bus.rom, 'PolsVoiceWalkSpeedsY').byte(y);
  }
  // @CheckWalkability
  if ($br('Z_04:6581', !PolsVoice_IsSquareWalkable(x))) return L_PolsVoice_DrawAndCheckCollisions(x);
  $pxa('Z_04:6585', PolsVoice_ObjLastTile, x);
  const t = ram[PolsVoice_ObjLastTile + x] & 0xfc;
  if ($br('Z_04:6588', t === 0xb0) || $br('Z_04:6590', t >= 0xf4)) return setState1(x);
  let a = ram[ObjDir + x] & 0x03;
  if (!$br('Z_04:6597', a !== 0)) {
    ram[ObjDir + x] = ram[ObjDir + x] ^ 0x0c;
    return L_PolsVoice_DrawAndCheckCollisions(x);
  }
  // @FlipHorizontally
  ram[ObjDir + x] = a ^ 0x03;
  PolsVoice_MoveX(x);
  PolsVoice_MoveX(x);
  return L_PolsVoice_DrawAndCheckCollisions(x); // @DrawAndCheckCollisions
}

/** UpdatePolsVoice@SetState1: start a jump (state 1) in the facing direction (down/up near the edges). */
function setState1(x) {
  if ($br('Z_04:6620', ram[ObjState + x] !== 0)) return L_PolsVoice_DrawAndCheckCollisions(x);
  ram[ObjState + x]++;
  let y = (ram[ObjDir + x] - 1) & 0xff;
  const a = ram[ObjY + x];
  if (!$br('Z_04:6632', a >= 0x78)) y = 0x03;
  if (!$br('Z_04:6637', a < 0xa8)) y = 0x07;
  $pxa('Z_04:6641', table(bus.rom, 'PolsVoiceInitialJumpSpeeds').addr, y);
  ram[PolsVoice_ObjSpeedWhole + x] = table(bus.rom, 'PolsVoiceInitialJumpSpeeds').byte(y);
  $pxa('Z_04:6648', table(bus.rom, 'PolsVoiceDestinationYOffsets').addr, y);
  ram[PolsVoice_ObjTargetY + x] = ram[ObjY + x] + table(bus.rom, 'PolsVoiceDestinationYOffsets').byte(y);
  ram[ObjDir + x] = (y + 1) & 0xff;
  return L_PolsVoice_DrawAndCheckCollisions(x); // falls through
}

/** L_PolsVoice_DrawAndCheckCollisions (Z_04). X = Pols Voice: animate, draw, mask $FE, collide. */
export function L_PolsVoice_DrawAndCheckCollisions(x) {
  // L_PolsVoice_DrawAndCheckCollisions (Z_04)
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x08, x);
  $pxa('Z_04:6659', ObjAnimFrame, x);
  DrawObjectMirrored(ram[ObjAnimFrame + x], x);
  ram[ObjInvincibilityMask + x] = 0xfe;
  CheckMonsterCollisions(x);
}

/**
 * UpdatePolsVoiceState1_Jumping (Z_04). X = Pols Voice: accelerate down ($38 per frame); on landing
 * (falling and Y >= target) go to state 0 with a random direction, a distance of $31 or $71 (the carry
 * of the CMP is still set for the ADC #$30) and snap to the square grid.
 */
export function UpdatePolsVoiceState1_Jumping(x) {
  // UpdatePolsVoiceState1_Jumping (Z_04)
  cpu.c = 0;
  $pxa('Z_04:6673', PolsVoice_ObjSpeedFrac, x);
  ram[PolsVoice_ObjSpeedFrac + x] = cpu.adc(ram[PolsVoice_ObjSpeedFrac + x], 0x38);
  $pxa('Z_04:6679', PolsVoice_ObjSpeedWhole, x);
  let a = cpu.adc(ram[PolsVoice_ObjSpeedWhole + x], 0x00);
  ram[PolsVoice_ObjSpeedWhole + x] = a;
  cpu.c = 0;
  ram[ObjY + x] = cpu.adc(a, ram[ObjY + x]);
  $pxa('Z_04:6689', PolsVoice_ObjSpeedWhole, x);
  if ($br('Z_04:6690', (ram[PolsVoice_ObjSpeedWhole + x] & 0x80) !== 0)) return; // @Exit
  $pxa('Z_04:6694', PolsVoice_ObjTargetY, x);
  cpu.cmp(ram[ObjY + x], ram[PolsVoice_ObjTargetY + x]);
  if ($br('Z_04:6695', !cpu.c)) return; // @Exit
  ram[ObjState + x] = 0x00;
  ram[PolsVoice_ObjSpeedFrac + x] = 0x00;
  ram[PolsVoice_ObjSpeedWhole + x] = 0x00;
  const y = ram[Random + x] & 0x03;
  $pxa('Z_04:6709', table(bus.rom, 'PolsVoiceDirections').addr, y);
  ram[ObjDir + x] = table(bus.rom, 'PolsVoiceDirections').byte(y);
  ram[ObjRemDistance + x] = cpu.adc(ram[Random + x] & 0x40, 0x30); // C = 1 from the CMP
  cpu.c = 0;
  ram[ObjX + x] = cpu.adc(ram[ObjX + x], 0x08) & 0xf0;
  cpu.c = 0;
  a = cpu.adc(ram[ObjY + x], 0x08) & 0xf0;
  cpu.c = 1;
  ram[ObjY + x] = cpu.sbc(a, 0x03);
}

/**
 * PolsVoice_IsSquareWalkable (Z_04). X = Pols Voice: check the tile at the hotspot and at ($E, $6) more.
 * @returns C (also cpu.c) = 0 if walkable; PolsVoice_ObjLastTile = last tile checked
 */
export function PolsVoice_IsSquareWalkable(x) {
  // PolsVoice_IsSquareWalkable (Z_04)
  if ($br('Z_04:6753', PolsVoice_GetCollidingTile(x) !== 0)) return 1; // @Exit
  const savedX = ram[ObjX + x]; // PHA
  ram[ObjX + x] = savedX + 0x0e;
  const savedY = ram[ObjY + x]; // PHA
  ram[ObjY + x] = savedY + 0x06;
  const c = PolsVoice_GetCollidingTile(x);
  ram[ObjY + x] = savedY; // PLA
  ram[ObjX + x] = savedX; // PLA
  return c;
}

/**
 * PolsVoice_GetCollidingTile (Z_04). X = Pols Voice: GetCollidableTile with offset 0 ([0F] as left by
 * the caller). @returns C (also cpu.c) = 1 if unwalkable; PolsVoice_ObjLastTile = tile
 */
export function PolsVoice_GetCollidingTile(x) {
  // PolsVoice_GetCollidingTile (Z_04)
  GetCollidableTile(x, 0x00);
  $pxa('Z_04:6793', ObjCollidedTile, x);
  const a = ram[ObjCollidedTile + x];
  cpu.cmp(a, ram[ObjectFirstUnwalkableTile]);
  ram[PolsVoice_ObjLastTile + x] = a;
  return cpu.c;
}

/** PolsVoice_MoveX (Z_04). X = Pols Voice: X += PolsVoiceWalkSpeedsX[dir-1]. @returns Y = dir - 1 */
export function PolsVoice_MoveX(x) {
  // PolsVoice_MoveX (Z_04)
  const y = (ram[ObjDir + x] - 1) & 0xff;
  $pxa('Z_04:6812', table(bus.rom, 'PolsVoiceWalkSpeedsX').addr, y);
  ram[ObjX + x] = ram[ObjX + x] + table(bus.rom, 'PolsVoiceWalkSpeedsX').byte(y);
  return y;
}
