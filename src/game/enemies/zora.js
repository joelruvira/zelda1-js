// P18 enemyow — enemies/zora (Z_04): spawning the zora in a water tile (CheckZora, called from the
// mode 5 loop in OW rooms) and its update (a burrower that shoots a fireball when it surfaces).

import { ram, peek } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
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
  $pxa('Z_04:1760', LevelBlockAttrsA, y);
  if ($br('Z_04:1762', (peek(LevelBlockAttrsA + y) & 0x08) === 0)) return; // @Exit
  if ($br('Z_04:1766', ram[ZoraActive] !== 0)) return;
  if ($br('Z_04:1770', FindEmptyMonsterSlot().y === 0)) return;
  ram[0x0d] = 0x0d;
  const x = ram[EmptyMonsterSlot];
  for (;;) {
    // @LoopTileCandidate
    y = ram[0x0d];
    $pxa('Z_04:1784', Random, y);
    let a = ram[Random + y] & 0xf0;
    ram[ObjX + x] = a;
    if (!$br('Z_04:1787', a === 0) && !$br('Z_04:1789', a === 0xf0)) {
      $pxa('Z_04:1793', Random, y);
      a = (ram[Random + y] << 4) & 0xff;
      if (!$br('Z_04:1799', a < 0x50) && !$br('Z_04:1801', a >= 0xe0)) {
        ram[ObjY + x] = a | 0x0d;
        a = GetCollidableTileStill(x);
        if (!$br('Z_04:1811', a < 0x8d) && !$br('Z_04:1813', a >= 0x99)) {
          ram[ZoraActive]++;
          return SetTypeAndClearObject(0x11, x); // JMP
        }
      }
    }
    // @NextLoopTileCandidate
    ram[0x0d]--;
    if (!$br('Z_04:1823', ram[0x0d] !== 0)) break;
  }
}

/** UpdateZora (Z_04). X = zora. Without the clock: burrower cycle, fireball at state 3. */
export function UpdateZora(x) {
  // UpdateZora (Z_04)
  if ($br('Z_04:1918', ram[InvClock] !== 0)) return; // L10797_Exit
  UpdateBurrower(x);
  // A zora killed above died in states 2-4, so it never reaches state 0 here (it does not come back).
  if (!$br('Z_04:1930', ram[ObjState + x] !== 0x03) && !$br('Z_04:1933', ram[ObjTimer + x] !== 0xfd)) {
    ShootFireball(0x55, x);
    ram[ObjTimer + x] = 0x20;
  }
  // @DestroyWhenDone
  if ($br('Z_04:1946', ram[ObjState + x] !== 0)) return;
  ram[ZoraActive]--;
  return DestroyMonster(x);
}
