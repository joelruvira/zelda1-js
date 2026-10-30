// P08 link — Link's input handling (Z_05): buttons, border filtering, doorways and the
// direction choice at grid points. Link_HandleInput, Link_FilterInput, MaskInputInBorder,
// Link_ModifyDirInDoorway.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
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
  if (!$br('Z_05:6924', ram[ObjState] !== 0)) {
    Link_FilterInput();
    // Handle the sword if it's not blocked and A is pressed.
    if (!$br('Z_05:6930', (ram[SwordBlockedLongTimer] | ram[SwordBlocked]) !== 0)
      && !$br('Z_05:6933', (ram[ButtonsPressed] & 0x80) === 0)) {
      WieldSword();
    }
    if (!$br('Z_05:6939', (ram[ButtonsPressed] & 0x40) === 0)) WieldItem();
  }
  // @CheckMovement: if Link was shoved, return.
  if ($br('Z_05:6946', ram[ObjShoveDir] !== 0)) return;
  if (!$br('Z_05:6950', ram[CurLevel] === 0)) Link_ModifyDirInDoorway();
  if ($br('Z_05:6956', ram[ObjGridOffset] === 0)) return Link_ModifyDirAtGridPoint();
  return Link_ModifyDirOnGridLine();
}

// Link_ModifyDirAtGridPoint + HaveInput (labels inside Link_HandleInput, Z_05).
// Grid offset = 0: choose among the walkable input directions.
function Link_ModifyDirAtGridPoint() {
  ram[0x0b] = 0; // input direction count
  ram[0x0c] = 0; // walkable direction count
  ram[Link_GoStraight] = 0;
  const reverseDirs = table(bus.rom, 'ReverseDirections'); // bank 1 data (run from WRAM)
  const rdAddr = label('ReverseDirections').addr;
  for (let y = 3; ;) {
    // @LoopDir
    $pxa('Z_05:6976', rdAddr, y);
    const dir = ram[ObjInputDir] & reverseDirs.byte(y);
    if (!$br('Z_05:6977', dir === 0)) {
      ram[0x0f] = dir; // last input direction found
      ram[0x0b]++;
      const tile = GetCollidingTileMoving(0);
      if (!$br('Z_05:6984', tile >= ram[ObjectFirstUnwalkableTile])) {
        ram[0x0d] = ram[0x0f]; // last walkable direction found
        ram[0x0c]++;
      }
    }
    // @NextLoopDir
    y--;
    if (!$br('Z_05:6994', y >= 0)) break;
  }
  if (!$br('Z_05:6998', ram[0x0b] !== 0)) return; // L172FC_Exit

  // HaveInput
  let a = ram[0x0f];
  let x = 0;
  if (!$br('Z_05:7013', ram[0x0b] === 0x01)) {
    // More than one input direction. If none was walkable, input direction = 0.
    if (!$br('Z_05:7019', ram[0x0c] !== 0)) return SetLinkInputDir(ram[0x0c]);
    // At least one walkable: go straight in one direction on the next grid line.
    const walkable = ram[0x0c];
    ram[Link_GoStraight]++;
    x = 0;
    a = ram[0x0d];
    if (!$br('Z_05:7036', walkable === 0x01) && !$br('Z_05:7038', ram[CurLevel] === 0)) {
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
  let lbl;
  // 1. Link at horizontal doors (X = $20 or $D0).
  const ox = ram[ObjX];
  if ($br('Z_05:7059', ox === 0x20) || !$br('Z_05:7061', ox !== 0xd0)) {
    lbl = !$br('Z_05:7065', ram[ObjY] !== 0x85) && !$br('Z_05:7068', (ram[ObjDir] & 0x04) === 0)
      ? 'toObjDir' : 'perpendicular';
  } else {
    lbl = 'allowedToTurn';
  }
  for (;;) {
    if (lbl === 'toObjDir') {
      // @SetLinkDirToObjDir
      a = ram[ObjDir];
      if ($br('Z_05:7072', a !== 0)) return { a, x };
      lbl = 'allowedToTurn';
    }
    if (lbl === 'allowedToTurn') {
      a = ram[ObjDir];
      x = ram[Link_GoStraightWhenDiagInput];
      if (!$br('Z_05:7078', x === 0)) {
        // 2. Link at the top door.
        if ($br('Z_05:7089', ram[CurLevel] === 0)) return { a, x };
        if ($br('Z_05:7092', ram[ObjX] !== 0x78)) return { a, x };
        if ($br('Z_05:7095', ram[ObjY] !== 0x5d)) return { a, x };
        a &= 0x03;
        if ($br('Z_05:7102', a === 0)) { lbl = 'toObjDir'; continue; }
      }
      lbl = 'perpendicular';
    }
    // Find the input direction that's perpendicular to the object's direction.
    x = (x + 1) & 0xff; // make sure to set Link_GoStraightWhenDiagInput
    const { y } = GetOppositeDir(ram[ObjDir]);
    const input = ram[ObjInputDir]; // PHA
    const axis = table(bus.rom, 'AxisMasks');
    $pxa('Z_05:7111', axis.addr, y);
    ram[0x0c] = input & axis.byte(y);
    a = input ^ ram[0x0c];
    return { a, x };
  }
}

/** Mask A and directions when Link is past the inner border, directions past the outer one. */
export function Link_FilterInput() {
  // Link_FilterInput (Z_05)
  ram[0x00] = GetOppositeDir(ram[ObjDir]).a; // opposite of Link's facing direction
  let { y } = GetOppositeDir(ram[0x00]); // index: 1 2 4 8 -> 2 3 0 1
  ram[0x02] = $br('Z_05:2749', y >= 0x02) ? ram[ObjX] : ram[ObjY];
  const saved = y; // PHA
  MaskInputInBorder(0x80, (y + 0x08) & 0xff); // inner border: mask button A
  y = saved;
  if (!$br('Z_05:2769', ram[0x01] !== 0xff)) {
    // Inner border not crossed: check the outer one with the facing direction.
    ram[0x00] = ram[ObjDir];
    y = GetOppositeDir(ram[ObjDir]).y;
  }
  if (!$br('Z_05:2779', ram[CurLevel] === 0)) y = (y + 0x04) & 0xff; // UW bounds
  return MaskInputInBorder(0x00, y); // falls through: only directions
}

/**
 * A mask of buttons to keep, Y offset into BorderBounds; [00] direction, [02] coordinate.
 * Leaves [01] = mask used, or $FF if the boundary was not crossed.
 */
export function MaskInputInBorder(a, y) {
  // MaskInputInBorder (Z_05)
  ram[0x01] = a;
  const bb = table(bus.rom, 'BorderBounds');
  const bound = bb.byte(y);
  let crossed;
  if ($br('Z_05:2804', (ram[0x00] & 0x0a) === 0)) {
    $pxa('Z_05:2846', bb.addr, y);
    crossed = $br('Z_05:2847', ram[0x02] < bound); // positive direction (right or down)
  } else {
    $pxa('Z_05:2811', bb.addr, y);
    crossed = !$br('Z_05:2812', ram[0x02] < bound); // negative direction (left or up)
  }
  if (!crossed) {
    // @ExcludeNone
    ram[0x01] = 0xff;
    return;
  }
  // @MaskButtons
  ram[ButtonsPressed] &= ram[0x01];
  if ($br('Z_05:2822', ram[CurLevel] === 0)) return;
  if ($br('Z_05:2824', ram[0x01] !== 0)) return;
  // Mask off input directions perpendicular to Link's facing.
  const mask = $br('Z_05:2830', (ram[ObjDir] & 0x0c) !== 0) ? 0x0c : 0x03;
  ram[ObjInputDir] &= mask;
}

/** In a UW doorway Link can only move in the direction he entered it or the opposite. */
export function Link_ModifyDirInDoorway() {
  // Link_ModifyDirInDoorway (Z_05)
  if ($br('Z_05:3655', ram[DoorwayDir] === 0)) return;
  if ($br('Z_05:3657', ram[ObjInputDir] === 0)) return;
  let a = ram[ObjDir] & ram[ObjInputDir];
  if (!$br('Z_05:3663', a !== 0)) {
    a = GetOppositeDir(ram[ObjDir]).a & ram[ObjInputDir];
    if (!$br('Z_05:3673', a !== 0)) a = ram[ObjDir];
  }
  ram[ObjInputDir] = a;
}
