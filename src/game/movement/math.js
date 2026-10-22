// P06 movement — direction and arithmetic helpers (Z_01, copied to WRAM by CopyCommonCodeToRam):
// quarter-speed position fractions, opposite directions, Abs/Negate, distances and directions to a
// target, diagonal speed index, boomerang speed.
//
// Bank 1 data (OppositeDirs, ReverseDirections) is read where the original reads it: in WRAM
// (RAM_01_CODE at $6C90+), through the bus.

import { ram, cpu } from '../../core/ram.js';
import { read } from '../../core/bus.js';
import { label } from '../../core/rom.js';
import {
  ObjPosFrac, ObjQSpeedFrac, ObjGridOffset, PositiveGridCellSize, NegativeGridCellSize,
  ObjX, ObjY, ObjState, ObjMovingLimit,
} from '../../core/vars.js';

/** LDA OppositeDirs, Y (Y may be $FF: the 6502 reads past the table, so do we). */
function oppositeDirs(y) {
  return read((label('OppositeDirs').addr + y) & 0xffff);
}

/** LDA ReverseDirections, Y (bank 1 data in WRAM). */
export function reverseDirections(y) {
  return read((label('ReverseDirections').addr + y) & 0xffff);
}

/**
 * AddQSpeedToPositionFraction (Z_01). X = object.
 * [010E]/[010F]: PositiveGridCellSize / NegativeGridCellSize.
 * @returns C (also left in cpu.c): 1 if the fraction reached a whole pixel (0 at a grid limit).
 */
export function AddQSpeedToPositionFraction(x) {
  // AddQSpeedToPositionFraction (Z_01)
  const sum = ram[ObjPosFrac + x] + ram[ObjQSpeedFrac + x];
  ram[ObjPosFrac + x] = sum;
  let c = sum >> 8; // PHP
  const g = ram[ObjGridOffset + x];
  if (g === ram[PositiveGridCellSize] || g === ram[NegativeGridCellSize]) c = 0; // @ClearCarry
  ram[ObjGridOffset + x] = g + c; // ADC #$00
  cpu.c = c; // PLP
  return c;
}

/**
 * SubQSpeedFromPositionFraction (Z_01). X = object.
 * @returns C (also left in cpu.c): 0 if the fraction reached a whole pixel (1 at a grid limit).
 */
export function SubQSpeedFromPositionFraction(x) {
  // SubQSpeedFromPositionFraction (Z_01)
  const diff = ram[ObjPosFrac + x] - ram[ObjQSpeedFrac + x];
  ram[ObjPosFrac + x] = diff;
  let c = diff >= 0 ? 1 : 0; // PHP
  const g = ram[ObjGridOffset + x];
  if (g === ram[PositiveGridCellSize] || g === ram[NegativeGridCellSize]) c = 1; // @SetCarry
  ram[ObjGridOffset + x] = g - (1 - c); // SBC #$00
  cpu.c = c; // PLP
  return c;
}

/**
 * GetOppositeDir (Z_01). A = direction.
 * @returns {{a:number, y:number}} A = opposite direction; Y = reverse direction index
 *   (dir 1 2 4 8 -> 3 2 1 0; $FF when A has no bit in its low nibble).
 */
export function GetOppositeDir(a) {
  // GetOppositeDir (Z_01)
  a &= 0xff;
  let y = 3;
  for (;;) {
    const c = a & 1; // LSR
    a >>= 1;
    if (c) break;
    y = (y - 1) & 0xff; // DEY
    if (y & 0x80) break; // BPL
  }
  return { a: oppositeDirs(y), y };
}

/** Abs (Z_01). A = value (its N flag selects the negation). @returns A = |value| */
export function Abs(a) {
  // Abs (Z_01)
  a &= 0xff;
  if (!(a & 0x80)) return a; // BPL
  return Negate(a); // falls through
}

/** Negate (Z_01). @returns A = -value (two's complement) */
export function Negate(a) {
  // Negate (Z_01)
  return ((a ^ 0xff) + 1) & 0xff;
}

/**
 * GetDirectionsAndDistancesToTarget (Z_01). A = target object, X = origin object, [00] = 0.
 * Leaves [00] = axes with distance <= 8, [03]/[04] = X/Y distances, [0A]/[0B] = vertical/horizontal
 * directions to the target. @returns A = Y distance
 */
export function GetDirectionsAndDistancesToTarget(a, x) {
  // GetDirectionsAndDistancesToTarget (Z_01)
  const target = a & 0xff; // PHA / TAY
  ram[0x0a] = 0x02;
  ram[0x03] = GetOneDirectionAndDistanceToTarget(ram[ObjX + target], ram[ObjX + x]);
  ram[0x0b] = ram[0x0a];
  ram[0x0a] = 0x08; // PLA / TAY
  const d = GetOneDirectionAndDistanceToTarget(ram[ObjY + target], ram[ObjY + x]);
  ram[0x04] = d;
  return d;
}

/**
 * _CalcDiagonalSpeedIndex (Z_01). Y = middle speed index; [03]/[04] = horizontal/vertical distance.
 * Uses [00] (index), [01] (step) and may swap/reduce [03]/[04]. @returns Y = speed index (0..8)
 */
export function _CalcDiagonalSpeedIndex(y) {
  // _CalcDiagonalSpeedIndex (Z_01)
  ram[0x00] = y;
  ram[0x01] = 0xff;
  if (ram[0x03] < ram[0x04]) {
    const t = ram[0x03]; // PHA
    ram[0x03] = ram[0x04];
    ram[0x04] = t; // PLA
    ram[0x01] = 0x01;
  }
  // @Swap
  if (((ram[0x03] - ram[0x04]) & 0xff) >= 0x08) {
    let a;
    do {
      // @Turn
      a = (ram[0x00] + ram[0x01]) & 0xff;
      ram[0x00] = a;
      if (a === 0x00 || a === 0x08) break;
      a = (ram[0x03] - ram[0x04]) & 0xff;
      ram[0x03] = a;
    } while (a >= ram[0x04]);
  }
  return ram[0x00]; // @Return: LDY $00
}

/** SetBoomerangSpeed (Z_01). A = q-speed fraction, X = object. */
export function SetBoomerangSpeed(a, x) {
  // SetBoomerangSpeed (Z_01)
  ram[ObjQSpeedFrac + x] = a;
  if ((ram[ObjState + x] & 0xf0) !== 0x40) return;
  ram[ObjQSpeedFrac + x] >>= 1; // LSR: half speed in major state $40
  ram[ObjMovingLimit + x]--;
  if (ram[ObjMovingLimit + x] !== 0) return;
  ram[ObjState + x] = 0x50;
}

/**
 * GetOneDirectionAndDistanceToTarget (Z_01). A = target coordinate, Y = origin coordinate,
 * [0A] = decreasing direction (2 or 8). Leaves [01] <= [02], [0A] = direction to the target,
 * [00] += 1 if distance < 9. @returns A = distance
 */
export function GetOneDirectionAndDistanceToTarget(a, y) {
  // GetOneDirectionAndDistanceToTarget (Z_01)
  ram[0x01] = a;
  ram[0x02] = y;
  if (y < ram[0x01]) {
    ram[0x02] = a;
    ram[0x01] = y;
    ram[0x0a] >>= 1;
  }
  const d = (ram[0x02] - ram[0x01]) & 0xff;
  if (d < 0x09) ram[0x00]++;
  return d;
}
