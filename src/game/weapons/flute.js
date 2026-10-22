// P09 weapons — the recorder (flute): WieldFlute (Z_07).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { switchBank } from '../../core/asm.js';
import {
  Tune1Request, FluteTimer, CurLevel, GameMode, CurSaveSlot, QuestNumbers, RoomId, SecretColorCycle,
  ObjType, UsedFlute,
} from '../../core/vars.js';
import { SummonWhirlwind } from '../worldobj/whirlwind.js';

/**
 * WieldFlute (Z_07): plays the flute tune ($98 frames of FluteTimer). In UW it flags UsedFlute; in
 * the OW (mode 5) it reveals the flute secret of the room (a $5E object in a free slot 9..1), or else
 * summons the whirlwind. Room $42 (first in FluteRoomSecretsOW) is a secret only in quest 1.
 */
export function WieldFlute() {
  // WieldFlute (Z_07)
  ram[Tune1Request] = 0x10;
  ram[FluteTimer] = 0x98;
  if (ram[CurLevel] !== 0) {
    // @FlagFluteUsed
    if (ram[UsedFlute] !== 0) return; // L1EFCF_Exit
    ram[UsedFlute]++;
    return;
  }
  if (ram[GameMode] !== 0x05) return; // @Exit
  const quest = ram[QuestNumbers + ram[CurSaveSlot]]; // PHA
  const a = ram[RoomId];
  const rooms = table(bus.rom, 'FluteRoomSecretsOW');
  let y = 0x0a;
  for (; y >= 0; y--) {
    // @FindSecretRoom
    if (a === rooms.byte(y)) break;
  }
  let reveal;
  if (y < 0) {
    reveal = false; // @FluteSecretNotFound (PLA)
  } else if (y === 0) {
    reveal = quest === 0; // first room: secret in Q1, whirlwind in Q2
  } else {
    reveal = quest !== 0; // @Normal: whirlwind in Q1, secret in Q2
  }
  if (!reveal) {
    // @SummonWhirlwind
    switchBank(1);
    SummonWhirlwind();
    switchBank(5); // restore the bank of the caller
    return;
  }
  // @RevealSecret
  if (ram[SecretColorCycle] !== 0) return; // @Exit: already revealed or in progress
  for (let i = 0x08; i >= 0; i--) {
    // @FindEmptySlot (slots 9..1)
    if (ram[ObjType + 1 + i] === 0) {
      ram[ObjType + 1 + i] = 0x5e; // flute secret object
      return;
    }
  }
}
