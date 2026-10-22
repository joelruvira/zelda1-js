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

/** SetUpDroppedItem (Z_04): X = object slot. Picks the dropped item or destroys the object. */
export function SetUpDroppedItem(x) {
  // SetUpDroppedItem (Z_04)
  const rom = bus.rom;
  ram[0x01] = 0x00; // [01] row of DropItemTable
  const a = ram[Item_ObjMonsterType + x];
  const noDrop = table(rom, 'NoDropMonsterTypes');
  for (let y = 0x06; y >= 0; y--) {
    if (a === noDrop.byte(y)) return DestroyMonster_Bank4(x); // @DestroyMonster
  }
  found: {
    const t0 = table(rom, 'DropItemMonsterTypes0');
    for (let y = 0x05; y >= 0; y--) if (a === t0.byte(y)) break found;
    ram[0x01]++;
    const t1 = table(rom, 'DropItemMonsterTypes1');
    for (let y = 0x08; y >= 0; y--) if (a === t1.byte(y)) break found;
    ram[0x01]++;
    const t2 = table(rom, 'DropItemMonsterTypes2');
    for (let y = 0x08; y >= 0; y--) if (a === t2.byte(y)) break found;
    ram[0x01]++;
  }
  // @Found: slot 1 stalfos/gibdo may be carrying the room item.
  if (x === 0x01 && (a === 0x2a || a === 0x30)) return DestroyMonster_Bank4(x);

  // @LookUpItem
  let y = (table(rom, 'DropItemSetBaseOffsets').byte(ram[0x01]) + ram[WorldKillCycle]) & 0xff;
  ram[0x00] = table(rom, 'DropItemTable').byte(y); // [00] dropped item ID

  let help = -1; // item forced by the help counters (@SetHelpItem), or -1
  if (ram[WorldKillCount] === 0x10) help = 0x23; // fairy
  else if (ram[HelpDropCount] >= 0x0a) help = ram[HelpDropValue] === 0 ? 0x0f : 0x00; // 5 rupees / bomb
  if (help >= 0) {
    // @SetHelpItem
    ram[0x00] = help;
    ram[HelpDropCount] = 0x00;
    ram[HelpDropValue] = 0x00;
  } else {
    // @RandomlyCancel
    y = ram[0x01];
    if (ram[Random + x] >= table(rom, 'DropItemRates').byte(y)) return DestroyMonster_Bank4(x);
  }
  // @Commit
  ram[Item_ObjItemLifetime + x] = 0xff;
  ram[Item_ObjItemId + x] = ram[0x00];
  if (ram[0x00] === 0x23) return SetUpFairyObject(x);
}
