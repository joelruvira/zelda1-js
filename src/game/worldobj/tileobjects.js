// Tile objects (rocks, gravestones, trees, ...) (Z_01, Z_04, Z_05). Package P16.
// Early port (published by P24, whose InitMode1_Sub1 calls it in wave 2): ResetRoomTileObjInfo.
// The rest of P16's tile-object routines go here later.

import { ram } from '../../core/ram.js';
import { RoomTileObjType, RoomTileObjX, RoomTileObjY, RoomId, ObjX, ObjY, ObjType, ObjState } from '../../core/vars.js';

/** ResetRoomTileObjInfo (Z_01). @returns A = 0 */
export function ResetRoomTileObjInfo() {
  // ResetRoomTileObjInfo (Z_01)
  ram[RoomTileObjType] = 0x00;
  ram[RoomTileObjX] = 0x00;
  ram[RoomTileObjY] = 0x00;
  return 0x00;
}

// Stubs added by P06 (Walker_Move calls them) until P16 ports them (docs/PORT_MAP.md rule 5).
// Both take no parameters and return with X = 0 in the original.
import { stub } from '../stub.js';

export const CheckTileObjectsBlocking = stub('CheckTileObjectsBlocking');
export const CheckPassiveTileObjects = stub('CheckPassiveTileObjects');

/**
 * SetupTileObjectOW (Z_05). Early port by the wave-3 integrator (InitMode_EnterRoom calls it in every
 * OW room). Puts the dock ($61, rooms $3F/$55) or the tile object found by the layout in slot $B.
 */
export function SetupTileObjectOW() {
  // SetupTileObjectOW (Z_05)
  let a = ram[RoomId];
  if (a === 0x3f || a === 0x55) {
    a = 0x61;
  } else {
    // @PlaceTileObj
    ram[ObjX + 11] = ram[RoomTileObjX];
    ram[ObjY + 11] = ram[RoomTileObjY];
    a = ram[RoomTileObjType];
  }
  // @SetType
  ram[ObjType + 11] = a;
  ram[ObjState + 11] = ResetRoomTileObjInfo(); // activate room tile object (A = 0)
}

// Stubs added by P05 (object dispatch / mode 5 loop) until P16 ports them (docs/PORT_MAP.md rule 5).
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
import { stubX } from '../stub.js';
export const UpdateDock = stubX('UpdateDock');
export const UpdateRockOrGravestone = stubX('UpdateRockOrGravestone');
export const UpdateRockWall = stubX('UpdateRockWall');
export const UpdateTree = stubX('UpdateTree');
export const UpdateFluteSecret = stubX('UpdateFluteSecret');
