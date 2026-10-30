// UW secrets (Z_05): the room's secret trigger (LevelBlockAttrsByteF & 7) and its conditions
// (all dead, ringleader, last boss, pushed block, money-or-life man), plus PlaySecretFoundTune
// (Z_04). Package P14.
// Contracts:
//   CheckUnderworldSecrets():  no parameters.
//   CheckSecretTrigger(a):     A = secret trigger; returns C (also left in cpu.c) = condition met.
//   CheckSecretTrigger*():     return C (cpu.c), like the original's SEC/CLC.
//   CheckHasLivingMonsters():  no parameters.
import { ram, cpu } from '../../core/ram.js';
import { label } from '../../core/rom.js';
import { tableJump } from '../../core/asm.js';
import {
  LevelBlockAttrsByteF, ObjState, Tune1Request, CurObjIndex, ObjType, LinkParalyzed, RoomAllDead,
  ShutterTrigger, ObjMetastate, BlockPushComplete, ObjX, ObjY, LastBossDefeated,
} from '../../core/vars.js';
import { GetRoomFlagUWItemState } from '../items/roomitem.js';
import { ChangeTileObjTiles } from './tilemap.js';
import { $br, $pxa } from '../../core/timing.js';

const regA = (r) => (typeof r === 'object' && r !== null ? r.a : r);

/** CheckUnderworldSecrets (Z_05): checks the room's secret; "foes for an item" shows the item. */
export function CheckUnderworldSecrets() {
  // CheckUnderworldSecrets (Z_05)
  CheckHasLivingMonsters();
  if ($br('Z_05:2343', (ram[LevelBlockAttrsByteF] & 0x07) === 0)) return CheckSecretTriggerNone();
  if ($br('Z_05:2347', !CheckSecretTrigger(ram[LevelBlockAttrsByteF] & 0x07))) return CheckSecretTriggerNone();
  if ($br('Z_05:2353', (ram[LevelBlockAttrsByteF] & 0x07) !== 0x07)) return CheckSecretTriggerNone();
  if ($br('Z_05:2358', ram[ObjState + 19] === 0)) return CheckSecretTriggerNone();
  if ($br('Z_05:2360', (regA(GetRoomFlagUWItemState()) & 0xff) !== 0)) return CheckSecretTriggerNone();
  ram[ObjState + 19] = 0x00; // activate the room item
  ram[Tune1Request] = 0x02; // "item appears" tune
  return CheckSecretTriggerNone(); // falls through
}

/** CheckSecretTriggerNone (Z_05): RTS (carry untouched). */
export function CheckSecretTriggerNone() {
  // CheckSecretTriggerNone (Z_05)
  return cpu.c === 1;
}

let triggerHandlers;
/** CheckSecretTrigger (Z_05). A = secret trigger. @returns C = 1 if the condition was met (cpu.c) */
export function CheckSecretTrigger(a) {
  // CheckSecretTrigger (Z_05)
  triggerHandlers ??= [CheckSecretTriggerNone, CheckSecretTriggerAllDead,
    CheckSecretTriggerRingleader, CheckSecretTriggerLastBoss, CheckSecretTriggerBlockDoor,
    CheckSecretTriggerBlockStairs, CheckSecretTriggerMoneyOrLife, CheckSecretTriggerAllDead];
  tableJump(label('CheckSecretTrigger_JumpTable').addr, a, triggerHandlers);
  return cpu.c === 1;
}

/**
 * CheckHasLivingMonsters (Z_05): looks from slot CurObjIndex+1 down to 1 for a monster that is not
 * a bubble ($2B-$2D) nor a type >= $49; with none, LinkParalyzed = 0 and INC RoomAllDead.
 */
export function CheckHasLivingMonsters() {
  // CheckHasLivingMonsters (Z_05)
  let y = ram[CurObjIndex];
  do {
    $pxa('Z_05:2396', ObjType + 1, y);
    const t = ram[ObjType + 1 + y];
    if (!$br('Z_05:2397', t === 0)) {
      if ($br('Z_05:2399', t < 0x2b)) return; // @Exit
      if (!$br('Z_05:2401', t < 0x2e) && $br('Z_05:2403', t < 0x49)) return; // @Exit
    }
    y = (y - 1) & 0xff; // @Next
  } while ($br('Z_05:2407', !(y & 0x80)));
  ram[LinkParalyzed] = 0x00;
  ram[RoomAllDead]++;
}

/** CheckSecretTriggerAllDead (Z_05): with no monsters left (RoomAllDead), trigger the shutters. */
export function CheckSecretTriggerAllDead() {
  // CheckSecretTriggerAllDead (Z_05)
  if ($br('Z_05:2418', ram[RoomAllDead] === 0)) return ReturnFalse();
  return TriggerShutters(); // falls through
}

// TriggerShutters (Z_05, label in CheckSecretTriggerAllDead): ShutterTrigger = 1, C = 1.
function TriggerShutters() {
  ram[ShutterTrigger] = 0x01;
  cpu.c = 1;
  return true;
}

// ReturnFalse (Z_05, label in CheckSecretTriggerAllDead): C = 0.
function ReturnFalse() {
  cpu.c = 0;
  return false;
}

/** CheckSecretTriggerRingleader (Z_05): with the first monster gone, all monsters die. */
export function CheckSecretTriggerRingleader() {
  // CheckSecretTriggerRingleader (Z_05)
  const first = ram[ObjType + 1];
  if (!$br('Z_05:2434', first === 0) && $br('Z_05:2439', first < 0x53)) return ReturnFalse();
  // @KillMonsters
  let y = ram[CurObjIndex];
  do {
    $pxa('Z_05:2449', ObjType + 1, y);
    const t = ram[ObjType + 1 + y];
    if (!$br('Z_05:2450', t === 0) && !$br('Z_05:2452', t >= 0x53)) {
      $pxa('Z_05:2453', ObjMetastate + 1, y);
      if (!$br('Z_05:2454', ram[ObjMetastate + 1 + y] !== 0)) ram[ObjMetastate + 1 + y] = 0x10; // die
    }
    y = (y - 1) & 0xff; // @Next
  } while ($br('Z_05:2462', !(y & 0x80)));
  cpu.c = 1;
  return true;
}

/** CheckSecretTriggerBlockDoor (Z_05): a pushed block triggers the shutters. */
export function CheckSecretTriggerBlockDoor() {
  // CheckSecretTriggerBlockDoor (Z_05)
  if ($br('Z_05:2471', ram[BlockPushComplete] === 0)) return ReturnFalse();
  $br('Z_05:2474', true);
  return TriggerShutters();
}

/** CheckSecretTriggerBlockStairs (Z_05): the first time the block is pushed, stairs at ($D0, $60). */
export function CheckSecretTriggerBlockStairs() {
  // CheckSecretTriggerBlockStairs (Z_05)
  const a = ram[BlockPushComplete];
  if ($br('Z_05:2479', a === 0)) return ReturnFalse();
  if ($br('Z_05:2484', (a & 0x01) === 0)) return ReturnFalse(); // LSR / BCC: already handled (2)
  ram[BlockPushComplete]++;
  const x = 0x0b; // tile object slot
  ram[ObjX + x] = 0xd0;
  ram[ObjY + x] = 0x60;
  ChangeTileObjTiles(0x70, x); // stairs tile
  cpu.c = 1;
  return true;
}

/** CheckSecretTriggerLastBoss (Z_05): the last boss defeated triggers the shutters. */
export function CheckSecretTriggerLastBoss() {
  // CheckSecretTriggerLastBoss (Z_05)
  if ($br('Z_05:2507', ram[LastBossDefeated] !== 0)) return TriggerShutters();
  cpu.c = 0;
  return false;
}

/** CheckSecretTriggerMoneyOrLife (Z_05): the money-or-life man gone triggers the shutters. */
export function CheckSecretTriggerMoneyOrLife() {
  // CheckSecretTriggerMoneyOrLife (Z_05)
  if ($br('Z_05:2517', ram[ObjType + 1] === 0)) return TriggerShutters();
  cpu.c = 0;
  return false;
}

/** PlaySecretFoundTune (Z_04): Tune1Request = 4. */
export function PlaySecretFoundTune() {
  // PlaySecretFoundTune (Z_04)
  ram[Tune1Request] = 0x04;
  return 0x04;
}
