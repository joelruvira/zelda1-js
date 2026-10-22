// P18 enemyow — enemies/zora (Z_04): spawning the zora in a water tile (CheckZora, called from the
// mode 5 loop in OW rooms) and its update (a burrower that shoots a fireball when it surfaces).

import { ram, peek } from '../../core/ram.js';
import {
  RoomId, LevelBlockAttrsA, ZoraActive, EmptyMonsterSlot, Random, ObjX, ObjY, ObjState, ObjTimer, InvClock,
} from '../../core/vars.js';
import { FindEmptyMonsterSlot, SetTypeAndClearObject, DestroyMonster } from '../objects/slots.js';
import { GetCollidableTileStill } from '../movement/tiles.js';
import { ShootFireball } from './shots.js';
import { UpdateBurrower } from './leever.js';

/**
 * CheckZora (Z_04). In a room with the zora attribute and no active zora, try $D random water
 * squares for a new zora (type $11). Uses [0D] (loop index) and the tile temporaries.
 */
export function CheckZora() {
  // CheckZora (Z_04)
  let y = ram[RoomId];
  if ((peek(LevelBlockAttrsA + y) & 0x08) === 0) return; // @Exit
  if (ram[ZoraActive] !== 0) return;
  if (FindEmptyMonsterSlot().y === 0) return;
  ram[0x0d] = 0x0d;
  const x = ram[EmptyMonsterSlot];
  do {
    // @LoopTileCandidate
    y = ram[0x0d];
    let a = ram[Random + y] & 0xf0;
    ram[ObjX + x] = a;
    if (a !== 0 && a !== 0xf0) {
      a = (ram[Random + y] << 4) & 0xff;
      if (a >= 0x50 && a < 0xe0) {
        ram[ObjY + x] = a | 0x0d;
        a = GetCollidableTileStill(x);
        if (a >= 0x8d && a < 0x99) {
          ram[ZoraActive]++;
          return SetTypeAndClearObject(0x11, x); // JMP
        }
      }
    }
    // @NextLoopTileCandidate
    ram[0x0d]--;
  } while (ram[0x0d] !== 0);
}

/** UpdateZora (Z_04). X = zora. Without the clock: burrower cycle, fireball at state 3. */
export function UpdateZora(x) {
  // UpdateZora (Z_04)
  if (ram[InvClock] !== 0) return; // L10797_Exit
  UpdateBurrower(x);
  // A zora killed above died in states 2-4, so it never reaches state 0 here (it does not come back).
  if (ram[ObjState + x] === 0x03 && ram[ObjTimer + x] === 0xfd) {
    ShootFireball(0x55, x);
    ram[ObjTimer + x] = 0x20;
  }
  // @DestroyWhenDone
  if (ram[ObjState + x] !== 0) return;
  ram[ZoraActive]--;
  return DestroyMonster(x);
}
