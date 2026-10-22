// Mode $12: end of level (Z_05). Package P25.
// Early port by the wave-3 integrator: EndGameMode12 (CalculateNextRoomForDoor of P13 falls into it
// when Link leaves a level). The rest is still a stub (docs/PORT_MAP.md rule 5).
import { ram } from '../../core/ram.js';
import { GameMode, CurLevel, UndergroundExitType, Tune0Request } from '../../core/vars.js';
import { stub } from '../stub.js';
import { EndGameMode } from './dispatch.js';
import { MaskCurPpuMaskGrayscale } from './mode5-play.js';

export const InitMode12 = stub('InitMode12');
export const UpdateMode12EndLevel_Full = stub('UpdateMode12EndLevel_Full');

/** EndGameMode12 (Z_05): back to the OW through mode 2 (dungeon exit), then MaskCurPpuMaskGrayscale. */
export function EndGameMode12() {
  // EndGameMode12 (Z_05)
  const a = EndGameMode();
  ram[0xe7] = a; // UNKNOWN in the asm: mode 2 does not depend on [E7]
  ram[CurLevel] = a; // OW (level 0)
  ram[GameMode] = 0x02;
  ram[UndergroundExitType] = 0x02; // type 2: dungeon level
  ram[Tune0Request] = 0x80; // silence the song
  return MaskCurPpuMaskGrayscale(); // falls through
}
