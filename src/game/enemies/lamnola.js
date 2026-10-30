// P20 — enemies/lamnola (Z_04): the two five-segment centipedes (slots 1-5 and 6-$A; heads in 5 and $A).
// The segments follow the head by passing directions down the chain whenever the head is on the 8-pixel
// grid; the head turns (randomly or toward Link) on the 16-pixel grid. A killed segment swaps places with
// the tail, which becomes a dead dummy. X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjX, ObjY, ObjDir, ObjMetastate, ObjUninitialized, ObjAttr, ObjHP, ObjType, ObjTimer,
  ObjInvincibilityTimer, Lamnola_Type, Lamnola_Speed, RoomObjCount, InvClock, LamnolaViableDirMask,
  Random, ObjectFirstUnwalkableTile,
} from '../../core/vars.js';
import { Anim_WriteSprite } from '../draw/sprites.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { ResetShoveInfo } from '../movement/shove.js';
import { ResetObjMetastate } from '../objects/slots.js';
import { BoundByRoom } from '../movement/bounds.js';
import { GetCollidingTileMoving } from '../movement/tiles.js';

/**
 * InitLamnola (Z_04). Called for the lamnola in slot 1: makes $A segments in slots 1-$A at ($40,$8D),
 * copying slot 1's attributes, HP and type; only the heads (5, $A) get a direction (up). Speed =
 * type - $39 (1 or 2). @returns A = 8 (RoomObjCount)
 */
export function InitLamnola(x) {
  // InitLamnola (Z_04)
  let y = 0x09;
  for (;;) {
    ram[ObjX + 1 + y] = 0x40;
    ram[ObjY + 1 + y] = 0x8d;
    ram[ObjDir + 1 + y] = 0x00;
    ram[ObjMetastate + 1 + y] = 0x00;
    ram[ObjUninitialized + 1 + y] = 0x00;
    ram[ObjAttr + 1 + y] = ram[ObjAttr + 1];
    ram[ObjHP + 1 + y] = ram[ObjHP + 1];
    ram[ObjType + 1 + y] = ram[ObjType + 1];
    y = (y - 1) & 0xff;
    if (!$br('Z_04:9506', !(y & 0x80))) break; // BPL
  }
  ram[ObjDir + 5] = 0x08;
  ram[0x0385] = 0x08;
  ram[ObjDir + 10] = 0x08;
  ram[0x038a] = 0x08;
  ram[Lamnola_Type] = ram[ObjType + 1];
  ram[Lamnola_Speed] = (ram[ObjType + 1] - 0x39) & 0xff;
  ram[RoomObjCount] = 0x08; // 8 instead of 10: the max kill count to save
  return 0x08;
}

/**
 * UpdateLamnola (Z_04). X = segment. Moves it (and turns the heads) unless the clock is held, draws it as
 * a narrow sprite centred 4 pixels right, checks collisions; a killed segment is revived in place of the
 * tail (which becomes a dead dummy), unless that tail is the head (the whole lamnola died).
 */
export function UpdateLamnola(x) {
  // UpdateLamnola (Z_04)
  if ($br('Z_04:9675', ram[ObjDir + x] === 0)) return; // L129EA_Exit: not moving yet
  if (!$br('Z_04:9679', ram[InvClock] !== 0)) {
    Lamnola_Move(x);
    if ($br('Z_04:9684', x === 0x05) || !$br('Z_04:9686', x !== 0x0a)) Lamnola_UpdateHead(x);
  }
  // @DrawAndCheckCollisions
  const savedX = ram[ObjX + x]; // PHA
  ram[ObjX + x] = (savedX + 0x04) & 0xff;
  ram[0x03] = ram[Lamnola_Speed] ^ 0x03;
  const tile = $br('Z_04:9709', x === 0x05) || $br('Z_04:9711', x === 0x0a) ? 0x9e : 0xa0;
  // @Draw
  Anim_WriteSprite(tile, x);
  ram[ObjX + x] = savedX; // PLA
  const dir = ram[ObjDir + x]; // PHA
  CheckMonsterCollisions(x);
  ram[ObjDir + x] = dir; // PLA
  $pxa('Z_04:9725', ObjMetastate, x);
  if ($br('Z_04:9726', ram[ObjMetastate + x] === 0)) return; // L129EA_Exit
  // The segment is dead.
  ResetShoveInfo(x);
  ram[ObjHP + x] = 0x20;
  // @FindTail: from the lowest slot of this lamnola, the first one with the original type.
  let y = $br('Z_04:9744', x < 0x06) ? 0xff : 0x04;
  for (;;) {
    y = (y + 1) & 0xff;
    $pxa('Z_04:9749', ObjType + 1, y);
    if (!$br('Z_04:9751', ram[ObjType + 1 + y] !== ram[Lamnola_Type])) break;
  }
  ram[ObjTimer + 1 + y] = 0x11;
  $pxa('Z_04:9759', ObjInvincibilityTimer, x);
  ram[ObjInvincibilityTimer + 1 + y] = ram[ObjInvincibilityTimer + x];
  ram[ObjX + 1 + y] = ram[ObjX + x];
  ram[ObjY + 1 + y] = ram[ObjY + x];
  if ($br('Z_04:9769', y === 0x04) || $br('Z_04:9771', y === 0x09)) return; // the tail is the head: the whole lamnola died
  ram[ObjType + 1 + y] = 0x5d; // dead dummy
  return ResetObjMetastate(x);
}

/** L12A6F_Exit (Z_04): RTS. */
export function L12A6F_Exit() {
  // L12A6F_Exit (Z_04)
}

/**
 * Lamnola_UpdateHead (Z_04). X = head (5 or $A). On the 8-pixel grid: pass the directions down the
 * chain. On the 16-pixel grid: choose a new direction (not the opposite one): 50% toward Link, else
 * straight or perpendicular; then look for one not blocked by the room bounds or tiles.
 */
export function Lamnola_UpdateHead(x) {
  // Lamnola_UpdateHead (Z_04)
  if ($br('Z_04:9786', (ram[ObjX + x] & 0x07) !== 0)) return; // L12A6F_Exit
  if ($br('Z_04:9794', ((ram[ObjY + x] + 0x03) & 0x07) !== 0)) return;
  ram[0x00] = 0x04;
  let y = $br('Z_04:9804', x === 0x05) ? 0x00 : 0x05;
  for (;;) {
    // @PropagateDirs
    $pxa('Z_04:9810', ObjDir + 2, y);
    ram[ObjDir + 1 + y] = ram[ObjDir + 2 + y];
    y = (y + 1) & 0xff;
    ram[0x00] = (ram[0x00] - 1) & 0xff;
    if (!$br('Z_04:9814', ram[0x00] !== 0)) break;
  }
  if ($br('Z_04:9819', (ram[ObjX + x] & 0x0f) !== 0)) return; // @Exit
  if ($br('Z_04:9827', ((ram[ObjY + x] + 0x03) & 0x0f) !== 0)) return;
  // Opposite of the facing direction, then the mask of the other three.
  ram[0x00] = (ram[ObjDir + x] >> 1) & 0x05;
  let a = ((ram[ObjDir + x] << 1) & 0x0a) | ram[0x00];
  ram[LamnolaViableDirMask] = a ^ 0x0f;
  // Rotate the direction bit right (bit 0 wraps around to 8): LSR / BCC :+ / LDA #$08.
  const rotate = (v, ref) => ($br(ref, !(v & 0x01)) ? v >> 1 : 0x08);
  if ($br('Z_04:9846', ram[Random + x] < 0x80)) {
    // @TurnTowardLink
    ram[0x02] = 0x01;
    if (!$br('Z_04:9945', ram[ObjX] >= ram[ObjX + x])) ram[0x02] = (ram[0x02] << 1) & 0xff;
    ram[0x03] = 0x04;
    if (!$br('Z_04:9954', ram[ObjY] >= ram[ObjY + x])) ram[0x03] = (ram[0x03] << 1) & 0xff;
    a = ram[0x02];
    if ($br('Z_04:9961', (a & ram[LamnolaViableDirMask]) === 0)
      || !$br('Z_04:9966', (a & ram[ObjDir]) !== 0)) a = ram[0x03]; // @SetVertical
  } else {
    a = ram[ObjDir + x];
    y = ram[Random + 1 + x];
    if (!$br('Z_04:9858', y >= 0x80)) {
      // @LoopFindPerpendicular
      for (;;) {
        a = rotate(a, 'Z_04:9868');
        if ($br('Z_04:9874', (a & ram[LamnolaViableDirMask]) === 0)) continue;
        if ($br('Z_04:9879', y >= 0x40)) break;
        y = 0x40;
        $br('Z_04:9885', true); // BCC @LoopFindPerpendicular
      }
    }
  }
  for (;;) {
    // @SetDirAndCheckTiles
    ram[ObjDir + x] = a;
    ram[0x0f] = a;
    BoundByRoom(x);
    if ($br('Z_04:9897', ram[0x0f] !== 0)) {
      // @CheckTileCollision
      if (!$br('Z_04:9923', GetCollidingTileMoving(x) >= ram[ObjectFirstUnwalkableTile])) return; // @Exit
    }
    // @FindNonOpposite
    a = ram[ObjDir + x];
    for (;;) {
      a = rotate(a, 'Z_04:9908'); // @LoopFindNonOpposite
      if ($br('Z_04:9915', (a & ram[LamnolaViableDirMask]) !== 0)) break;
      $br('Z_04:9916', true); // BEQ @LoopFindNonOpposite
    }
  }
}

/**
 * Lamnola_Move (Z_04). X = segment: moves Lamnola_Speed pixels along each component of its direction
 * (the carries come from shifting the mask $A1 in [02], so each add/subtract is exact).
 */
export function Lamnola_Move(x) {
  // Lamnola_Move (Z_04)
  ram[0x02] = 0xa1;
  const speed = ram[Lamnola_Speed];
  if (!$br('Z_04:9990', (ram[ObjDir + x] & ram[0x02]) === 0)) ram[ObjX + x] = (ram[ObjX + x] + speed) & 0xff;
  // @Left: ASL [02] sets C (bit 7 of $A1), so SBC subtracts exactly.
  ram[0x02] = (ram[0x02] << 1) & 0xff;
  if (!$br('Z_04:10001', (ram[ObjDir + x] & ram[0x02]) === 0)) ram[ObjX + x] = (ram[ObjX + x] - speed) & 0xff;
  // @Down: ASL clears C.
  ram[0x02] = (ram[0x02] << 1) & 0xff;
  if (!$br('Z_04:10011', (ram[ObjDir + x] & ram[0x02]) === 0)) ram[ObjY + x] = (ram[ObjY + x] + speed) & 0xff;
  // @Up: ASL sets C.
  ram[0x02] = (ram[0x02] << 1) & 0xff;
  if (!$br('Z_04:10021', (ram[ObjDir + x] & ram[0x02]) === 0)) ram[ObjY + x] = (ram[ObjY + x] - speed) & 0xff;
}
