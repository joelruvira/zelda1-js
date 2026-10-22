// P08 link — Link's input handling (Z_05): buttons, border filtering, doorways and the
// direction choice at grid points. Link_HandleInput, Link_FilterInput, MaskInputInBorder,
// Link_ModifyDirInDoorway.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjState, ObjDir, ObjX, ObjY, ObjInputDir, ObjShoveDir, ObjGridOffset, CurLevel, ButtonsPressed,
  SwordBlockedLongTimer, SwordBlocked, DoorwayDir, Link_GoStraight, Link_GoStraightWhenDiagInput,
  ObjectFirstUnwalkableTile,
} from '../../core/vars.js';
import { GetOppositeDir } from '../movement/math.js';
import { GetCollidingTileMoving } from '../movement/tiles.js';
import { WieldSword } from '../weapons/sword.js';
import { WieldItem } from '../weapons/wield.js';
import { InitLinkSpeed, Link_ModifyDirOnGridLine, SetObjDirAndInputDir, SetLinkInputDir } from './move.js';

/** Link's per-frame input: A/B buttons (state 0) and direction on the movement grid. */
export function Link_HandleInput() {
  // Link_HandleInput (Z_05)
  if (ram[ObjState] === 0) {
    Link_FilterInput();
    // Handle the sword if it's not blocked and A is pressed.
    if ((ram[SwordBlockedLongTimer] | ram[SwordBlocked]) === 0 && (ram[ButtonsPressed] & 0x80)) {
      WieldSword();
    }
    if (ram[ButtonsPressed] & 0x40) WieldItem();
  }
  // @CheckMovement: if Link was shoved, return.
  if (ram[ObjShoveDir] !== 0) return;
  if (ram[CurLevel] !== 0) Link_ModifyDirInDoorway();
  if (ram[ObjGridOffset] === 0) return Link_ModifyDirAtGridPoint();
  return Link_ModifyDirOnGridLine();
}

// Link_ModifyDirAtGridPoint + HaveInput (labels inside Link_HandleInput, Z_05).
// Grid offset = 0: choose among the walkable input directions.
function Link_ModifyDirAtGridPoint() {
  ram[0x0b] = 0; // input direction count
  ram[0x0c] = 0; // walkable direction count
  ram[Link_GoStraight] = 0;
  const reverseDirs = table(bus.rom, 'ReverseDirections');
  for (let y = 3; y >= 0; y--) {
    const dir = ram[ObjInputDir] & reverseDirs.byte(y);
    if (dir === 0) continue;
    ram[0x0f] = dir; // last input direction found
    ram[0x0b]++;
    const tile = GetCollidingTileMoving(0);
    if (tile < ram[ObjectFirstUnwalkableTile]) {
      ram[0x0d] = ram[0x0f]; // last walkable direction found
      ram[0x0c]++;
    }
  }
  if (ram[0x0b] === 0) return; // L172FC_Exit

  // HaveInput
  let a = ram[0x0f];
  let x = 0;
  if (ram[0x0b] !== 0x01) {
    // More than one input direction. If none was walkable, input direction = 0.
    if (ram[0x0c] === 0) return SetLinkInputDir(ram[0x0c]);
    // At least one walkable: go straight in one direction on the next grid line.
    const walkable = ram[0x0c];
    ram[Link_GoStraight]++;
    x = 0;
    a = ram[0x0d];
    if (walkable !== 0x01 && ram[CurLevel] !== 0) {
      a = HaveInput_TwoWalkableUW();
      x = a.x;
      a = a.a;
    }
  }
  // @SetLinkDirAndSpeed
  ram[Link_GoStraightWhenDiagInput] = x;
  SetObjDirAndInputDir(a);
  return InitLinkSpeed();
}

// HaveInput, UW case with two walkable input directions (doors are special).
// Returns {a, x} for @SetLinkDirAndSpeed.
function HaveInput_TwoWalkableUW() {
  let x = 0;
  let a;
  let label;
  // 1. Link at horizontal doors (X = $20 or $D0).
  const ox = ram[ObjX];
  if (ox === 0x20 || ox === 0xd0) {
    label = ram[ObjY] === 0x85 && (ram[ObjDir] & 0x04) ? 'toObjDir' : 'perpendicular';
  } else {
    label = 'allowedToTurn';
  }
  for (;;) {
    if (label === 'toObjDir') {
      // @SetLinkDirToObjDir
      a = ram[ObjDir];
      if (a !== 0) return { a, x };
      label = 'allowedToTurn';
    }
    if (label === 'allowedToTurn') {
      a = ram[ObjDir];
      x = ram[Link_GoStraightWhenDiagInput];
      if (x !== 0) {
        // 2. Link at the top door.
        if (ram[CurLevel] === 0) return { a, x };
        if (ram[ObjX] !== 0x78) return { a, x };
        if (ram[ObjY] !== 0x5d) return { a, x };
        a &= 0x03;
        if (a === 0) { label = 'toObjDir'; continue; }
      }
      label = 'perpendicular';
    }
    // Find the input direction that's perpendicular to the object's direction.
    x = (x + 1) & 0xff; // make sure to set Link_GoStraightWhenDiagInput
    const { y } = GetOppositeDir(ram[ObjDir]);
    const input = ram[ObjInputDir]; // PHA
    ram[0x0c] = input & table(bus.rom, 'AxisMasks').byte(y);
    a = input ^ ram[0x0c];
    return { a, x };
  }
}

/** Mask A and directions when Link is past the inner border, directions past the outer one. */
export function Link_FilterInput() {
  // Link_FilterInput (Z_05)
  ram[0x00] = GetOppositeDir(ram[ObjDir]).a; // opposite of Link's facing direction
  let { y } = GetOppositeDir(ram[0x00]); // index: 1 2 4 8 -> 2 3 0 1
  ram[0x02] = y >= 0x02 ? ram[ObjX] : ram[ObjY];
  const saved = y; // PHA
  MaskInputInBorder(0x80, (y + 0x08) & 0xff); // inner border: mask button A
  y = saved;
  if (ram[0x01] === 0xff) {
    // Inner border not crossed: check the outer one with the facing direction.
    ram[0x00] = ram[ObjDir];
    y = GetOppositeDir(ram[ObjDir]).y;
  }
  if (ram[CurLevel] !== 0) y = (y + 0x04) & 0xff; // UW bounds
  return MaskInputInBorder(0x00, y); // falls through: only directions
}

/**
 * A mask of buttons to keep, Y offset into BorderBounds; [00] direction, [02] coordinate.
 * Leaves [01] = mask used, or $FF if the boundary was not crossed.
 */
export function MaskInputInBorder(a, y) {
  // MaskInputInBorder (Z_05)
  ram[0x01] = a;
  const bound = table(bus.rom, 'BorderBounds').byte(y);
  let crossed;
  if ((ram[0x00] & 0x0a) === 0) {
    crossed = ram[0x02] < bound; // positive direction (right or down)
  } else {
    crossed = !(ram[0x02] < bound); // negative direction (left or up)
  }
  if (!crossed) {
    // @ExcludeNone
    ram[0x01] = 0xff;
    return;
  }
  // @MaskButtons
  ram[ButtonsPressed] &= ram[0x01];
  if (ram[CurLevel] === 0) return;
  if (ram[0x01] !== 0) return;
  // Mask off input directions perpendicular to Link's facing.
  const mask = ram[ObjDir] & 0x0c ? 0x0c : 0x03;
  ram[ObjInputDir] &= mask;
}

/** In a UW doorway Link can only move in the direction he entered it or the opposite. */
export function Link_ModifyDirInDoorway() {
  // Link_ModifyDirInDoorway (Z_05)
  if (ram[DoorwayDir] === 0) return;
  if (ram[ObjInputDir] === 0) return;
  let a = ram[ObjDir] & ram[ObjInputDir];
  if (a === 0) {
    a = GetOppositeDir(ram[ObjDir]).a & ram[ObjInputDir];
    if (a === 0) a = ram[ObjDir];
  }
  ram[ObjInputDir] = a;
}
