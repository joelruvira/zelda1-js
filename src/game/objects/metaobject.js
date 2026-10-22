// P05 objects — meta-objects (Z_07): the spawning cloud (metastates 1-4) and the death sparkle
// ($10-$14) drawn instead of the object; at the end the object starts living or becomes a drop.

import { ram } from '../../core/ram.js';
import {
  ObjMetastate, ObjType, Item_ObjMonsterType, WorldKillCycle, RoomKillCount, ObjUninitialized, ObjAttr,
  Tune1Request,
} from '../../core/vars.js';
import { AnimateAndDrawMetaObject } from '../draw/anim.js';
import { SetUpDroppedItem } from '../items/drops.js';
import { ResetObjMetastate } from './slots.js';

/** UpdateMetaObject (Z_07). X = object. */
export function UpdateMetaObject(x) {
  // UpdateMetaObject (Z_07)
  AnimateAndDrawMetaObject(x);
  // Go handle the end metastates (4 and $14) specially.
  if ((ram[ObjMetastate + x] & 0x0f) >= 0x04) return UpdateMetaObjectEnd(x);
  return DoNothing(); // falls through
}

/** DoNothing (Z_07). */
export function DoNothing() {
  // DoNothing (Z_07)
}

/** UpdateMetaObjectEnd (Z_07, label in UpdateMetaObject). X = object, metastate 4 or $14. @returns A = 0 */
export function UpdateMetaObjectEnd(x) {
  // UpdateMetaObjectEnd (Z_07)
  if (ram[ObjMetastate + x] & 0x10) {
    // Metastate $14: the object dies and becomes a dropped item.
    const a = ram[ObjType + x];
    ram[Item_ObjMonsterType + x] = a;
    if (a !== 0x5d && a !== 0x14 && a !== 0x1c) { // dead dummy, child gel, red keese
      let k = (ram[WorldKillCycle] + 1) & 0xff;
      if (k === 0x0a) k = 0x00;
      ram[WorldKillCycle] = k;
      if (ram[ObjType + x] !== 0x11) ram[RoomKillCount]++; // not a zora
    }
    // @DropItem
    ram[ObjType + x] = 0x60;
    ram[ObjUninitialized + x] = 0x60;
    ram[ObjAttr + x] = 0x81; // custom collision check and drawing + reverse after hitting Link
    SetUpDroppedItem(x);
  }
  // @Reset
  return ResetObjMetastate(x);
}

/** UpdateDeadDummy (Z_07). X = object: start the death sparkle. */
export function UpdateDeadDummy(x) {
  // UpdateDeadDummy (Z_07)
  ram[Tune1Request] = 0x20; // monster died
  ram[ObjMetastate + x] = 0x10;
}
