// P08 link — Link's speed and direction on the movement grid (Z_05).
// InitLinkSpeed, Link_ModifyDirOnGridLine, SetObjDirAndInputDir, SetLinkInputDir.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  CurLevel, ObjCollidedTile, ObjQSpeedFrac, ObjPosFrac, ObjInputDir, ObjDir, ObjGridOffset,
  Link_GoStraight,
} from '../../core/vars.js';
import { GetOppositeDir, Abs, Negate } from '../movement/math.js';

/** X = 0 (Link). Sets Link's quarter speed ($60, or $30 on OW mountain stairs). @returns A */
export function InitLinkSpeed() {
  // InitLinkSpeed (Z_05)
  ram[0x00] = 0x60; // 1.5 pixels a frame by default
  if (!$br('Z_05:7127', ram[CurLevel] !== 0)) {
    // In OW: standing on mountain stairs ($74/$75) uses a lower quarter speed of $30.
    const tile = ram[ObjCollidedTile];
    if ($br('Z_05:7133', tile === 0x74) || !$br('Z_05:7135', tile !== 0x75)) {
      ram[0x00] = 0x30;
      if (!$br('Z_05:7140', ram[ObjQSpeedFrac] === 0x30)) ram[ObjPosFrac] = 0x00; // reset the position fraction
    }
  }
  const a = ram[0x00];
  ram[ObjQSpeedFrac] = a;
  return a;
}

/** Grid offset <> 0: change direction while between grid points. */
export function Link_ModifyDirOnGridLine() {
  // Link_ModifyDirOnGridLine (Z_05)
  if ($br('Z_05:7154', ram[ObjInputDir] === 0)) return; // not moving
  // Take a single component of the input direction; Y = its reverse index.
  const { y } = GetOppositeDir(ram[ObjInputDir]);
  const rdAddr = label('ReverseDirections').addr; // bank 1 data (run from WRAM)
  $pxa('Z_05:7161', rdAddr, y);
  const single = table(bus.rom, 'ReverseDirections').byte(y);
  if ($br('Z_05:7166', single === ram[ObjDir])) return InitLinkSpeed(); // keep going this way
  const both = single | ram[ObjDir];
  if ($br('Z_05:7172', both === 0x03) || !$br('Z_05:7174', both !== 0x0c)) {
    // Opposite of the facing direction: turn around.
    $pxa('Z_05:7176', rdAddr, y);
    return SetObjDirAndInputDir(single);
  }
  // Perpendicular.
  if ($br('Z_05:7192', ram[Link_GoStraight] !== 0)) return InitLinkSpeed();
  const dist = Abs(ram[ObjGridOffset]); // PHA
  ram[0x01] = GetOppositeDir(ram[ObjDir]).a; // [01] opposite of facing direction
  if ($br('Z_05:7204', dist >= 0x04)) return; // moved half a cell or more
  // If Link turned back and faces the grid point he started walking from, return.
  if (!$br('Z_05:7210', (ram[ObjDir] & 0x0a) === 0)) {
    if ($br('Z_05:7212', (ram[ObjGridOffset] & 0x80) === 0)) return;
    $br('Z_05:7213', true); // BMI @ReverseDir (always)
  } else if ($br('Z_05:7216', (ram[ObjGridOffset] & 0x80) !== 0)) {
    return;
  }
  // @ReverseDir: reverse Link's direction and the grid offset (-1 => 7, 3 => -5).
  ram[ObjDir] = ram[0x01];
  const go = ram[ObjGridOffset];
  const base = $br('Z_05:7232', (go & 0x80) !== 0) ? 0x08 : 0xf8; // PHA
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
