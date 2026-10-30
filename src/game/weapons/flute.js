// P09 weapons — the recorder (flute): WieldFlute (Z_07).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { switchBank } from '../../core/asm.js';
import {
  Tune1Request, FluteTimer, CurLevel, GameMode, CurSaveSlot, QuestNumbers, RoomId, SecretColorCycle,
  ObjType, UsedFlute,
} from '../../core/vars.js';
import { SummonWhirlwind } from '../worldobj/whirlwind.js';
import { $br, $pxa } from '../../core/timing.js';

/**
 * WieldFlute (Z_07): plays the flute tune ($98 frames of FluteTimer). In UW it flags UsedFlute; in
 * the OW (mode 5) it reveals the flute secret of the room (a $5E object in a free slot 9..1), or else
 * summons the whirlwind. Room $42 (first in FluteRoomSecretsOW) is a secret only in quest 1.
 */
export function WieldFlute() {
  // WieldFlute (Z_07)
  ram[Tune1Request] = 0x10;
  ram[FluteTimer] = 0x98;
  if ($br('Z_07:2511', ram[CurLevel] !== 0)) {
    // @FlagFluteUsed
    if ($br('Z_07:2594', ram[UsedFlute] !== 0)) return; // L1EFCF_Exit
    ram[UsedFlute]++;
    return;
  }
  if ($br('Z_07:2516', ram[GameMode] !== 0x05)) return; // @Exit
  $pxa('Z_07:2520', QuestNumbers, ram[CurSaveSlot]);
  const quest = ram[QuestNumbers + ram[CurSaveSlot]]; // PHA
  const a = ram[RoomId];
  const rooms = table(bus.rom, 'FluteRoomSecretsOW');
  let y = 0x0a;
  const roomsAddr = label('FluteRoomSecretsOW').addr;
  for (;;) {
    // @FindSecretRoom
    $pxa('Z_07:2528', roomsAddr, y);
    if ($br('Z_07:2529', a === rooms.byte(y))) break;
    y--;
    if (!$br('Z_07:2531', y >= 0)) break;
  }
  let reveal;
  if (y < 0) {
    $br('Z_07:2532', true);
    reveal = false; // @FluteSecretNotFound (PLA)
  } else if (!$br('Z_07:2544', y !== 0)) {
    // first room: secret in Q1, whirlwind in Q2
    reveal = !$br('Z_07:2546', quest !== 0) && $br('Z_07:2547', true);
  } else {
    reveal = !$br('Z_07:2554', quest === 0); // @Normal: whirlwind in Q1, secret in Q2
  }
  if (!reveal) {
    // @SummonWhirlwind
    switchBank(1);
    SummonWhirlwind();
    switchBank(5); // restore the bank of the caller
    return;
  }
  // @RevealSecret
  if ($br('Z_07:2559', ram[SecretColorCycle] !== 0)) return; // @Exit: already revealed or in progress
  for (let i = 0x08; ; i--) {
    // @FindEmptySlot (slots 9..1)
    if ($br('Z_07:2566', i < 0)) return;
    $pxa('Z_07:2567', ObjType + 1, i);
    if (!$br('Z_07:2568', ram[ObjType + 1 + i] !== 0)) {
      ram[ObjType + 1 + i] = 0x5e; // flute secret object
      return;
    }
  }
}
