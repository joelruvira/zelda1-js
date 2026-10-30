// Rupee stash: the ring of rupees in secret caves (Z_01, BANK_01_CODE). Package P16.
// Routines: InitRupeeStash_Full, InitOneSimpleObject (also used by InitTrap_Full), UpdateRupeeStash_Full.
// Tables read from the ROM: RupeeStashXs, RupeeStashYs.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { ObjX, ObjY, ObjType, ObjUninitialized, ObjAttr, RoomObjCount } from '../../core/vars.js';
import { Abs } from '../movement/math.js';
import { DestroyMonster } from '../objects/slots.js';
import { Anim_FetchObjPosForSpriteDescriptor } from '../draw/anim.js';
import { DrawItemInInventory } from '../hud/statusbar.js';
import { TakeOneRupee } from '../items/take.js';
import { $br, $pxa } from '../../core/timing.js';

/** InitRupeeStash_Full (Z_01). X = object slot: makes $A rupee objects in slots $A..1. @returns X = 0 */
export function InitRupeeStash_Full(x) {
  // InitRupeeStash_Full (Z_01)
  $pxa('Z_01:2377', ObjAttr, x);
  ram[0x01] = ram[ObjAttr + x];
  ram[0x00] = 0x35; // rupee stash type
  const xs = table(bus.rom, 'RupeeStashXs');
  const ys = table(bus.rom, 'RupeeStashYs');
  for (x = 0x0a; ;) {
    // @LoopRupee
    InitOneSimpleObject(x);
    $pxa('Z_01:2390', xs.addr - 1, x);
    ram[ObjX + x] = xs.byte(x - 1); // RupeeStashXs-1, X
    $pxa('Z_01:2392', ys.addr - 1, x);
    ram[ObjY + x] = ys.byte(x - 1);
    x--;
    if (!$br('Z_01:2395', x !== 0)) break;
  }
  return x;
}

/** InitOneSimpleObject (Z_01). X = slot, [00] = type, [01] = attributes. @returns A = [01] */
export function InitOneSimpleObject(x) {
  // InitOneSimpleObject (Z_01)
  ram[ObjType + x] = ram[0x00];
  ram[ObjUninitialized + x] = 0x00;
  const a = ram[0x01];
  ram[ObjAttr + x] = a;
  return a;
}

/** UpdateRupeeStash_Full (Z_01). X = object slot (preserved). */
export function UpdateRupeeStash_Full(x) {
  // UpdateRupeeStash_Full (Z_01)
  const saved = x; // TXA / PHA
  if (!$br('Z_01:2619', Abs((ram[ObjY] - ram[ObjY + x]) & 0xff) >= 0x09)
      && !$br('Z_01:2625', Abs((ram[ObjX] - ram[ObjX + x]) & 0xff) >= 0x09)) {
    TakeOneRupee();
    DestroyMonster(x);
    ram[RoomObjCount] = 0x00;
    return saved; // @ExitRestoreX
  }
  // @DrawRupee
  Anim_FetchObjPosForSpriteDescriptor(x);
  DrawItemInInventory(0x16, 0x16); // rupee item slot
  return saved; // PLA / TAX
}
