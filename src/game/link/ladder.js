// P08 link — the ladder while Link walks on it (Z_05): CheckLadder, SetMovingDirAndSwitchToPlayerSlot.
// (The ladder is set up in Link_EndMoveAndAnimate, link/anim.js.)

import { ram } from '../../core/ram.js';
import { $br } from '../../core/timing.js';
import {
  LadderSlot, ObjState, ObjDir, ObjX, ObjY, ObjInputDir, ObjCollidedTile, ObjectFirstUnwalkableTile,
} from '../../core/vars.js';
import { GetOppositeDir, Abs } from '../movement/math.js';
import { GetCollidingTileMoving } from '../movement/tiles.js';
import { DestroyMonster } from '../objects/slots.js';
import { Anim_FetchObjPosForSpriteDescriptor } from '../draw/anim.js';
import { Anim_WriteStaticItemSpritesWithAttributes } from '../draw/items.js';

/**
 * [0F] movement direction (called by Walker_Move for Link, X = 0).
 * Leaves [0F] = movement direction or 0.
 * @returns X register at the RTS: 0, except when the ladder is put away (`@StashLadder`), where the
 *   original returns with X = the ladder's slot and Walker_Move then falls into MoveObject with it.
 */
export function CheckLadder() {
  // CheckLadder (Z_05)
  let x = ram[LadderSlot];
  if ($br('Z_05:3220', x === 0)) return x; // ladder not in use

  let stash = false;
  let handle = false; // go to @HandleInput without changing the state
  if ($br('Z_05:3224', ram[(ObjState + x) & 0xff] === 0)) {
    stash = true; // ladder done
  } else {
    let d;
    if (!$br('Z_05:3231', (ram[(ObjDir + x) & 0xff] & 0x0c) === 0)) {
      // Vertical ladder: vertical distance; Link's X must match.
      if ($br('Z_05:3234', ram[ObjX] !== ram[(ObjX + x) & 0xff])) stash = true;
      else d = (ram[ObjY] + 0x03 - ram[(ObjY + x) & 0xff]) & 0xff;
    } else {
      // Horizontal ladder: horizontal distance; Link's Y must match.
      if ($br('Z_05:3249', ((ram[ObjY] + 0x03) & 0xff) !== ram[(ObjY + x) & 0xff])) stash = true;
      else d = (ram[ObjX] - ram[(ObjX + x) & 0xff]) & 0xff;
    }
    if (!stash) {
      // @CheckDistanceToLadder
      d = Abs(d);
      ram[0x00] = d; // absolute distance between Link and the ladder
      if ($br('Z_05:3260', d < 0x10)) {
        ram[(ObjState + x) & 0xff] = 0x02; // @SetState2: on the ladder
        handle = true;
      } else if ($br('Z_05:3262', d !== 0x10)) {
        stash = true;
      } else if ($br('Z_05:3268', ram[ObjDir] !== ram[(ObjDir + x) & 0xff])) {
        stash = true;
      } else if ($br('Z_05:3281', ram[(ObjState + x) & 0xff] === 0x01)) {
        handle = true; // facing the ladder, not stepped onto it yet
      } else {
        stash = true; // stepped completely off the ladder
      }
    }
  }
  if (!handle) {
    // @StashLadder
    ram[LadderSlot] = 0x00;
    DestroyMonster(x);
    return x;
  }

  // @HandleInput
  let a;
  for (;;) {
    if ($br('Z_05:3300', ram[ObjInputDir] === 0)) { a = ram[ObjInputDir]; break; }
    // A. Distance <> 0 and Link faces the ladder's way: move in Link's direction.
    a = ram[ObjDir];
    if (!$br('Z_05:3315', ram[0x00] === 0) && $br('Z_05:3317', a === ram[(ObjDir + x) & 0xff])) break;
    // B. Ladder's direction = Link's moving direction.
    a = ram[(ObjDir + x) & 0xff];
    if ($br('Z_05:3333', a === ram[0x0f])) break;
    // C. Opposite of the ladder's direction = Link's facing: step off where he came from.
    a = GetOppositeDir(a).a;
    if ($br('Z_05:3341', a === ram[ObjDir])) break;
    // D. Unless the ladder points up and input is up, reset the moving direction.
    if ($br('Z_05:3351', a !== 0x04) || $br('Z_05:3354', ram[ObjInputDir] !== 0x08)) { a = 0x00; break; }
    // E. Ladder up and input up: check the tile 8 pixels above Link.
    x = SetMovingDirAndSwitchToPlayerSlot(ram[ObjInputDir]);
    const savedY = ram[ObjY]; // PHA
    ram[ObjY] = (savedY - 0x08) & 0xff;
    GetCollidingTileMoving(x);
    ram[ObjY] = savedY; // PLA
    a = ram[0x0f];
    if ($br('Z_05:3384', ram[ObjCollidedTile] < ram[ObjectFirstUnwalkableTile])) continue; // BCC @HandleInput (X = 0 now)
    a = 0x00;
    break;
  }

  // @DrawLadder
  const pushed = a; // PHA
  x = ram[LadderSlot];
  Anim_FetchObjPosForSpriteDescriptor(x);
  Anim_WriteStaticItemSpritesWithAttributes(0x00, x, 0x0c);
  return SetMovingDirAndSwitchToPlayerSlot(pushed); // PLA, falls through
}

/** A direction: [0F] = A, X = 0. @returns X = 0 */
export function SetMovingDirAndSwitchToPlayerSlot(a) {
  // SetMovingDirAndSwitchToPlayerSlot (Z_05)
  ram[0x0f] = a;
  return 0;
}
