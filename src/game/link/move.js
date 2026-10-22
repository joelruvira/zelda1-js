// P08 link — Link's speed and direction on the movement grid (Z_05).
// InitLinkSpeed, Link_ModifyDirOnGridLine, SetObjDirAndInputDir, SetLinkInputDir.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  CurLevel, ObjCollidedTile, ObjQSpeedFrac, ObjPosFrac, ObjInputDir, ObjDir, ObjGridOffset,
  Link_GoStraight,
} from '../../core/vars.js';
import { GetOppositeDir, Abs, Negate } from '../movement/math.js';

/** X = 0 (Link). Sets Link's quarter speed ($60, or $30 on OW mountain stairs). @returns A */
export function InitLinkSpeed() {
  // InitLinkSpeed (Z_05)
  ram[0x00] = 0x60; // 1.5 pixels a frame by default
  if (ram[CurLevel] === 0) {
    // In OW: standing on mountain stairs ($74/$75) uses a lower quarter speed of $30.
    const tile = ram[ObjCollidedTile];
    if (tile === 0x74 || tile === 0x75) {
      ram[0x00] = 0x30;
      if (ram[ObjQSpeedFrac] !== 0x30) ram[ObjPosFrac] = 0x00; // reset the position fraction
    }
  }
  const a = ram[0x00];
  ram[ObjQSpeedFrac] = a;
  return a;
}

/** Grid offset <> 0: change direction while between grid points. */
export function Link_ModifyDirOnGridLine() {
  // Link_ModifyDirOnGridLine (Z_05)
  if (ram[ObjInputDir] === 0) return; // not moving
  // Take a single component of the input direction; Y = its reverse index.
  const { y } = GetOppositeDir(ram[ObjInputDir]);
  const single = table(bus.rom, 'ReverseDirections').byte(y);
  if (single === ram[ObjDir]) return InitLinkSpeed(); // keep going this way
  const both = single | ram[ObjDir];
  if (both === 0x03 || both === 0x0c) {
    // Opposite of the facing direction: turn around.
    return SetObjDirAndInputDir(single);
  }
  // Perpendicular.
  if (ram[Link_GoStraight] !== 0) return InitLinkSpeed();
  const dist = Abs(ram[ObjGridOffset]); // PHA
  ram[0x01] = GetOppositeDir(ram[ObjDir]).a; // [01] opposite of facing direction
  if (dist >= 0x04) return; // moved half a cell or more
  // If Link turned back and faces the grid point he started walking from, return.
  if (ram[ObjDir] & 0x0a) {
    if ((ram[ObjGridOffset] & 0x80) === 0) return;
  } else if (ram[ObjGridOffset] & 0x80) {
    return;
  }
  // @ReverseDir: reverse Link's direction and the grid offset (-1 => 7, 3 => -5).
  ram[ObjDir] = ram[0x01];
  const go = ram[ObjGridOffset];
  const base = go & 0x80 ? 0x08 : 0xf8; // PHA
  ram[0x01] = Negate(go);
  ram[ObjGridOffset] = (base - ram[0x01]) & 0xff;
}

/** A direction: ObjDir = ObjInputDir = A. @returns A */
export function SetObjDirAndInputDir(a) {
  // SetObjDirAndInputDir (Z_05)
  ram[ObjDir] = a;
  return SetLinkInputDir(a); // falls through
}

/** A direction: ObjInputDir = A. @returns A */
export function SetLinkInputDir(a) {
  // SetLinkInputDir (Z_05)
  ram[ObjInputDir] = a;
  return a;
}
