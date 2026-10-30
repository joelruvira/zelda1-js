// P05 objects — meta-objects (Z_07): the spawning cloud (metastates 1-4) and the death sparkle
// ($10-$14) drawn instead of the object; at the end the object starts living or becomes a drop.

import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
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
  $pxa('Z_07:5433', ObjMetastate, x);
  if ($br('Z_07:5436', (ram[ObjMetastate + x] & 0x0f) >= 0x04)) return UpdateMetaObjectEnd(x);
  return DoNothing(); // falls through
}

/** DoNothing (Z_07). */
export function DoNothing() {
  // DoNothing (Z_07)
}

/** UpdateMetaObjectEnd (Z_07, label in UpdateMetaObject). X = object, metastate 4 or $14. @returns A = 0 */
export function UpdateMetaObjectEnd(x) {
  // UpdateMetaObjectEnd (Z_07)
  $pxa('Z_07:5446', ObjMetastate, x);
  if (!$br('Z_07:5448', (ram[ObjMetastate + x] & 0x10) === 0)) {
    // Metastate $14: the object dies and becomes a dropped item.
    $pxa('Z_07:5454', ObjType, x);
    const a = ram[ObjType + x];
    ram[Item_ObjMonsterType + x] = a;
    // dead dummy, child gel, red keese
    if (!$br('Z_07:5459', a === 0x5d) && !$br('Z_07:5461', a === 0x14) && !$br('Z_07:5463', a === 0x1c)) {
      let k = (ram[WorldKillCycle] + 1) & 0xff;
      if (!$br('Z_07:5470', k !== 0x0a)) k = 0x00;
      ram[WorldKillCycle] = k;
      $pxa('Z_07:5476', ObjType, x);
      if (!$br('Z_07:5478', ram[ObjType + x] === 0x11)) ram[RoomKillCount]++; // not a zora
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
