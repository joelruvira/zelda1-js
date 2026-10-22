// P21 — bosses/aquamentus. Stubs created by P05 (docs/PORT_MAP.md rule 5); P21 replaces them.
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
// CheckBossSoundEffectUW was advanced by the wave-4 integrator: every underworld room entry runs it
// (RunCrossRoomTasksAndBeginUpdateMode), so the pure port needs it before the rest of P21.
import { ram, cpu, peek } from '../../core/ram.js';
import { read, bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { LevelInfo_BossRoomId, RoomId, LevelBlockAttrsE, SampleRequest } from '../../core/vars.js';
import { GetRoomFlags } from '../world/roomflags.js';
import { PlayEffect } from '../audio/requests.js';
import { stubX } from '../stub.js';

export const InitAquamentus = stubX('InitAquamentus');
export const UpdateAquamentus = stubX('UpdateAquamentus');

/**
 * CheckBossSoundEffectUW (Z_05). Requests the room's repeating boss sample (BossSoundEffects indexed by
 * LevelBlockAttrsE bits 5-6), or silences sample and tune 1 if the room has none or the level's boss was
 * already beaten.
 */
export function CheckBossSoundEffectUW() {
  // CheckBossSoundEffectUW (Z_05)
  GetRoomFlags();
  let y = peek(LevelInfo_BossRoomId);
  let a = read((((ram[0x01] << 8) | ram[0x00]) + y) & 0xffff) & 0xc0;
  if (a !== 0xc0) {
    y = ram[RoomId];
    a = peek(LevelBlockAttrsE + y) & 0x60;
    a = cpu.asl(a);
    a = cpu.rol(a);
    a = cpu.rol(a);
    a = cpu.rol(a);
    a = table(bus.rom, 'BossSoundEffects').byte(a);
    if (a !== 0) {
      ram[SampleRequest] = a | 0x80;
      return;
    }
  }
  return PlayEffect(0x80);
}
