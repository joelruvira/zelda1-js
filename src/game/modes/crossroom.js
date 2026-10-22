// P05 — cross-room tasks run when the play modes (4, 5, 6, 9, $B, $C) begin updating (Z_07):
// object bounds, UW room visited, room objects, room history, boss sounds / whirlwind.

import { ram } from '../../core/ram.js';
import { switchBank } from '../../core/asm.js';
import {
  CurLevel, RoomId, RoomHistory, CurRoomHistoryIndex, GameMode,
} from '../../core/vars.js';
import { SetupObjRoomBounds } from '../movement/bounds.js';
import { WriteBlankPrioritySprites } from '../draw/sprites.js';
import { BeginUpdateMode } from './dispatch.js';
import { CreateRoomObjects } from '../objects/roomobjects.js';
// Later packages (stubs until they are ported).
import { MarkRoomVisited } from '../world/roomflags.js';
import { CheckBossSoundEffectUW } from '../bosses/aquamentus.js';
import { CheckInitWhirlwindAndBeginUpdate } from '../worldobj/whirlwind.js';

/** RunCrossRoomTasksAndBeginUpdateMode_PlayModesNoCellar (Z_07): modes 5, $B, $C. */
export function RunCrossRoomTasksAndBeginUpdateMode_PlayModesNoCellar() {
  // RunCrossRoomTasksAndBeginUpdateMode_PlayModesNoCellar (Z_07)
  switchBank(5);
  SetupObjRoomBounds();
  return RunCrossRoomTasksAndBeginUpdateMode_EnterPlayModes(); // falls through
}

/** RunCrossRoomTasksAndBeginUpdateMode_EnterPlayModes (Z_07): modes 4, 5, 9, $B, $C. */
export function RunCrossRoomTasksAndBeginUpdateMode_EnterPlayModes() {
  // RunCrossRoomTasksAndBeginUpdateMode_EnterPlayModes (Z_07)
  if (ram[CurLevel] !== 0) {
    MarkRoomVisited();
    WriteBlankPrioritySprites();
  }
  return RunCrossRoomTasksAndBeginUpdateMode(); // falls through
}

/** RunCrossRoomTasksAndBeginUpdateMode (Z_07): modes 4, 5, 6, 9, $B, $C. */
export function RunCrossRoomTasksAndBeginUpdateMode() {
  // RunCrossRoomTasksAndBeginUpdateMode (Z_07)
  switchBank(5);
  CreateRoomObjects();
  // Look for the current room in the room history.
  let y = 0;
  const a = ram[RoomId];
  for (let x = 0x05; x >= 0; x--) if (ram[RoomHistory + x] === a) y++;
  // Not found: store it at the cycling history index.
  if (y === 0) {
    ram[RoomHistory + ram[CurRoomHistoryIndex]] = a;
    ram[CurRoomHistoryIndex]++;
    if (ram[CurRoomHistoryIndex] >= 0x06) ram[CurRoomHistoryIndex] = 0x00;
  }
  // @RunTasksMode5
  if (ram[GameMode] === 0x05) {
    if (ram[CurLevel] === 0) {
      // @CheckWhirlwind
      switchBank(1);
      return CheckInitWhirlwindAndBeginUpdate(); // JMP
    }
    switchBank(5);
    CheckBossSoundEffectUW();
  }
  // @BeginUpdate
  return BeginUpdateMode(); // JMP
}
