// Tile objects (rocks, gravestones, trees, ...) (Z_01, Z_04, Z_05). Package P16.
// Early port (published by P24, whose InitMode1_Sub1 calls it in wave 2): ResetRoomTileObjInfo.
// The rest of P16's tile-object routines go here later.

import { ram } from '../../core/ram.js';
import { RoomTileObjType, RoomTileObjX, RoomTileObjY } from '../../core/vars.js';

/** ResetRoomTileObjInfo (Z_01). @returns A = 0 */
export function ResetRoomTileObjInfo() {
  // ResetRoomTileObjInfo (Z_01)
  ram[RoomTileObjType] = 0x00;
  ram[RoomTileObjX] = 0x00;
  ram[RoomTileObjY] = 0x00;
  return 0x00;
}
