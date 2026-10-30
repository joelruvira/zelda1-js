// Push block (Z_04, Z_05). Package P16.
// Routines: UpdateBlock (UpdateBlock_JumpTable), UpdateBlock0Idle (+ ResetPushTimer, L10262_Exit),
// DrawBlock, UpdateBlock1Moving, UpdateBlock2Done, FindAndCreatePushBlockObject (Z_05).
// Tables read from the ROM: BlockPushDirections, UpdateBlock_JumpTable, PlayAreaColumnAddrs (Z_07).

import { ram, word } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjDir, ObjState, ObjType, ObjInputDir, ObjPushTimer, ObjGridOffset, RoomAllDead,
  ReturnToBank4, Tune1Request, BlockPushComplete,
} from '../../core/vars.js';
import { Negate } from '../movement/math.js';
import { MoveObject } from '../movement/walker.js';
import { ChangeTileObjTiles } from '../world/tilemap.js';
import { GetUniqueRoomId } from '../world/roomflags.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';
import { $br, $pxa } from '../../core/timing.js';

/** UpdateBlock (Z_04). X = block slot: dispatches on ObjState & 3. */
export function UpdateBlock(x) {
  // UpdateBlock (Z_04)
  return tableJump(label('UpdateBlock_JumpTable').addr, ram[ObjState + x] & 0x03, [
    () => UpdateBlock0Idle(x),
    () => UpdateBlock1Moving(x),
    () => UpdateBlock2Done(x),
  ]);
}

/** UpdateBlock0Idle (Z_04). X = block slot: waits until Link pushes the block $10 frames. */
export function UpdateBlock0Idle(x) {
  // UpdateBlock0Idle (Z_04)
  if ($br('Z_04:642', ram[RoomAllDead] === 0)) return ResetPushTimer(x);
  let y;
  let a;
  if (!$br('Z_04:649', ram[ObjX] !== ram[ObjX + x])) {
    y = 0x00;
    a = (ram[ObjY] + 0x03 - ram[ObjY + x]) & 0xff;
  } else {
    // @CheckAlignedY
    if ($br('Z_04:665', ((ram[ObjY] + 0x03) & 0xff) !== ram[ObjY + x])) return ResetPushTimer(x);
    y = 0x02;
    a = (ram[ObjX] - ram[ObjX + x]) & 0xff;
  }
  // @TestDifference
  if (!$br('Z_04:681', !(a & 0x80))) {
    y++;
    a = Negate(a);
  }
  if ($br('Z_04:687', a >= 0x11)) return ResetPushTimer(x);
  a = ram[ObjInputDir];
  $pxa('Z_04:694', label('BlockPushDirections').addr, y);
  if ($br('Z_04:695', a !== table(bus.rom, 'BlockPushDirections').byte(y))) return ResetPushTimer(x);
  ram[ObjPushTimer + x]++;
  $pxa('Z_04:703', ObjPushTimer, x);
  if ($br('Z_04:705', ram[ObjPushTimer + x] < 0x10)) return; // L10262_Exit
  ram[ObjDir + x] = a;
  ram[ObjState + x]++;
  ram[ReturnToBank4]++;
  ChangeTileObjTiles(0x74, x); // floor tile
  return DrawBlock(x); // falls through
}

/** DrawBlock (Z_04). X = block slot: drawn one pixel up (at the object's true Y). @returns X */
export function DrawBlock(x) {
  // DrawBlock (Z_04)
  Anim_FetchObjPosForSpriteDescriptor(x);
  ram[0x01]--;
  return DrawObjectNotMirrored(0x00, x);
}

// ResetPushTimer (Z_04, label inside UpdateBlock0Idle); falls into L10262_Exit (RTS).
function ResetPushTimer(x) {
  ram[ObjPushTimer + x] = 0x00;
}

/** UpdateBlock1Moving (Z_04). X = block slot: moves $10 pixels, then puts the block tile. */
export function UpdateBlock1Moving(x) {
  // UpdateBlock1Moving (Z_04)
  ram[0x0f] = ram[ObjDir + x];
  MoveObject(x);
  DrawBlock(x);
  $pxa('Z_04:738', ObjGridOffset, x);
  const a = ram[ObjGridOffset + x];
  if (!$br('Z_04:740', a === 0x10) && $br('Z_04:742', a !== 0xf0)) return UpdateBlock2Done(x);
  ram[Tune1Request] = 0x04; // "secret revealed" tune
  ram[ReturnToBank4]++;
  ChangeTileObjTiles(0xb0, x); // block tile
  ram[ObjState + x]++;
  ram[BlockPushComplete]++;
  return UpdateBlock2Done(x); // falls through
}

/** UpdateBlock2Done (Z_04): RTS. */
export function UpdateBlock2Done(_x) {
  // UpdateBlock2Done (Z_04)
}

/** FindAndCreatePushBlockObject (Z_05): puts the push block ($68) in slot $B. */
export function FindAndCreatePushBlockObject() {
  // FindAndCreatePushBlockObject (Z_05)
  ram[ObjState + 11] = 0x00;
  ram[ObjDir + 11] = 0x00;
  if (!$br('Z_05:5484', GetUniqueRoomId() !== 0x21)) {
    // Unverified code 167FE
    ram[ObjX + 11] = 0x40;
    ram[ObjY + 11] = 0x80; // ASL
  } else {
    const cols = table(bus.rom, 'PlayAreaColumnAddrs');
    let x = 0x08;
    const y = 0x0a;
    // @LoopColumn: look for a block tile in row $A from column 4.
    for (;;) {
      ram[0x00] = cols.byte(x);
      $pxa('Z_05:5500', cols.addr + 1, x);
      ram[0x01] = cols.byte(x + 1);
      $pxa('Z_05:5502', ram[0x00], y);
      if ($br('Z_05:5504', read((word(0x00) + y) & 0xffff) === 0xb0)) break; // @Found
      x = (x + 4) & 0xff;
      if (!$br('Z_05:5510', x !== 0x34)) break;
    }
    // @Found
    ram[ObjX + 11] = (x << 2) & 0xff;
    ram[ObjY + 11] = 0x90;
  }
  // @SetType
  ram[ObjType + 11] = 0x68;
}
