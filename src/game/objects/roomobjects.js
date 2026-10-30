// P05 objects — the room item object (slot $13) and push block of a room (Z_05).

import { ram, peek } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjState, CurLevel, RoomId, LevelBlockAttrsD, LevelBlockAttrsE, LevelBlockAttrsF, RoomItemId,
  ObjX, ObjY, GameMode,
} from '../../core/vars.js';
import { GetRoomFlagUWItemState, GetShortcutOrItemXY } from '../items/roomitem.js';
import { FindAndCreatePushBlockObject } from '../worldobj/block.js';

const ITEM = 0x13; // room item object slot

/**
 * CreateRoomObjects (Z_05): set up the room item object (slot $13: RoomItemId, position, active
 * when ObjState[$13] = 0) and the push block. In OW only the heart container of room $5F.
 */
export function CreateRoomObjects() {
  // CreateRoomObjects (Z_05)
  ram[ObjState + ITEM] = 0x00;
  if ($br('Z_05:8198', ram[CurLevel] === 0)) return makeHeartContainerOW();
  let y;
  let deactivate = $br('Z_05:8203', GetRoomFlagUWItemState() !== 0); // already taken
  y = ram[RoomId]; // GetRoomFlagUWItemState leaves Y = RoomId
  if (!deactivate) {
    $pxa('Z_05:8213', LevelBlockAttrsE, y);
    let a = peek(LevelBlockAttrsE + y) & 0x1f; // room item (3 stands for "no item")
    if (!$br('Z_05:8216', a !== 0x03)) ram[ObjState + ITEM]--;
    ram[RoomItemId] = a;
    $pxa('Z_05:8224', LevelBlockAttrsF, y);
    a = peek(LevelBlockAttrsF + y) & 0x07; // secret trigger
    deactivate = $br('Z_05:8227', a === 0x03) || !$br('Z_05:8229', a !== 0x07); // "last boss" / "foes for item"
  }
  if (deactivate) ram[ObjState + ITEM]--; // @Deactivate
  $pxa('Z_05:8236', LevelBlockAttrsD, y);
  if (!$br('Z_05:8238', (peek(LevelBlockAttrsD + y) & 0x40) === 0)) FindAndCreatePushBlockObject();
  const r = GetShortcutOrItemXY();
  return storeLocation(r.a, r.y);
}

function storeLocation(a, y) {
  // CreateRoomObjects@StoreLocation
  ram[ObjX + ITEM] = a;
  ram[ObjY + ITEM] = y;
  // A triforce piece goes 8 pixels left.
  $pxa('Z_05:8251', LevelBlockAttrsE, ram[RoomId]);
  if (!$br('Z_05:8254', (peek(LevelBlockAttrsE + ram[RoomId]) & 0x1f) !== 0x1b)) {
    ram[ObjX + ITEM] = (ram[ObjX + ITEM] - 0x08) & 0xff;
  }
}

function makeHeartContainerOW() {
  // CreateRoomObjects@MakeHeartContainerOW
  ram[RoomItemId] = 0x1a; // heart container
  if (!$br('Z_05:8276', ram[GameMode] !== 0x05) && $br('Z_05:8279', ram[RoomId] === 0x5f)) return storeLocation(0xc0, 0x90);
  ram[ObjState + ITEM]--;
}
