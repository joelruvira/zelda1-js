// P10 items — items dropped by dead monsters (Z_04).
// Contract: SetUpDroppedItem(x), X = object slot of the dead monster (already turned into type $60).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  Item_ObjMonsterType, Item_ObjItemLifetime, Item_ObjItemId, WorldKillCycle, WorldKillCount,
  HelpDropCount, HelpDropValue, Random,
} from '../../core/vars.js';
import { DestroyMonster_Bank4 } from '../objects/slots.js';
import { SetUpFairyObject } from './fairy.js';
import { $br, $pxa } from '../../core/timing.js';

/** SetUpDroppedItem (Z_04): X = object slot. Picks the dropped item or destroys the object. */
export function SetUpDroppedItem(x) {
  // SetUpDroppedItem (Z_04)
  const rom = bus.rom;
  ram[0x01] = 0x00; // [01] row of DropItemTable
  $pxa('Z_04:11077', Item_ObjMonsterType, x);
  const a = ram[Item_ObjMonsterType + x];
  // Searches a type table from `y` down to 0 (CMP Table, Y / BEQ / DEY / BPL).
  const find = (t, y, rPx, rEq, rLoop) => {
    for (;; y--) {
      $pxa(rPx, t.addr, y);
      if ($br(rEq, a === t.byte(y))) return true;
      if (!$br(rLoop, y - 1 >= 0)) return false;
    }
  };
  if (find(table(rom, 'NoDropMonsterTypes'), 0x06, 'Z_04:11081', 'Z_04:11082', 'Z_04:11084')) {
    return DestroyMonster_Bank4(x); // @DestroyMonster
  }
  found: {
    if (find(table(rom, 'DropItemMonsterTypes0'), 0x05, 'Z_04:11090', 'Z_04:11091', 'Z_04:11093')) break found;
    ram[0x01]++;
    if (find(table(rom, 'DropItemMonsterTypes1'), 0x08, 'Z_04:11102', 'Z_04:11103', 'Z_04:11105')) break found;
    ram[0x01]++;
    if (find(table(rom, 'DropItemMonsterTypes2'), 0x08, 'Z_04:11114', 'Z_04:11115', 'Z_04:11117')) break found;
    ram[0x01]++;
  }
  // @Found: slot 1 stalfos/gibdo may be carrying the room item.
  if (!$br('Z_04:11127', x !== 0x01) && ($br('Z_04:11129', a === 0x2a) || $br('Z_04:11131', a === 0x30))) {
    return DestroyMonster_Bank4(x);
  }

  // @LookUpItem
  const base = table(rom, 'DropItemSetBaseOffsets');
  $pxa('Z_04:11138', base.addr, ram[0x01]);
  let y = (base.byte(ram[0x01]) + ram[WorldKillCycle]) & 0xff;
  const items = table(rom, 'DropItemTable');
  $pxa('Z_04:11142', items.addr, y);
  ram[0x00] = items.byte(y); // [00] dropped item ID

  let help = -1; // item forced by the help counters (@SetHelpItem), or -1
  if ($br('Z_04:11149', ram[WorldKillCount] === 0x10)) help = 0x23; // fairy
  else if (!$br('Z_04:11155', ram[HelpDropCount] < 0x0a)) help = $br('Z_04:11163', ram[HelpDropValue] === 0) ? 0x0f : 0x00; // 5 rupees / bomb
  if (help >= 0) {
    // @SetHelpItem
    ram[0x00] = help;
    ram[HelpDropCount] = 0x00;
    ram[HelpDropValue] = 0x00;
    $br('Z_04:11174', true);
  } else {
    // @RandomlyCancel
    y = ram[0x01];
    const rates = table(rom, 'DropItemRates');
    $pxa('Z_04:11181', rates.addr, y);
    if ($br('Z_04:11182', ram[Random + x] >= rates.byte(y))) return DestroyMonster_Bank4(x);
  }
  // @Commit
  ram[Item_ObjItemLifetime + x] = 0xff;
  ram[Item_ObjItemId + x] = ram[0x00];
  if (!$br('Z_04:11195', ram[0x00] !== 0x23)) return SetUpFairyObject(x);
}
