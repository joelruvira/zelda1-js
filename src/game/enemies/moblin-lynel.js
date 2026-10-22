// P18 enemyow — enemies/moblin-lynel (Z_04): moblins (wanderers that shoot arrows) and lynels
// (goriya-style walkers that shoot sword shots). Both end in _TryShooting with q-speed $20.

import { ram } from '../../core/ram.js';
import { ObjTurnRate } from '../../core/vars.js';
import { Wanderer_TargetPlayer } from './common.js';
import { _TryShooting } from './shots.js';
import { UpdateGoriya } from './goriya.js';

/** UpdateMoblin (Z_04). X = moblin: turn rate $A0, wander, try shooting an arrow ($5B). */
export function UpdateMoblin(x) {
  // UpdateMoblin (Z_04)
  ram[ObjTurnRate + x] = 0xa0;
  Wanderer_TargetPlayer(x);
  return _TryShooting(0x20, x, 0x5b); // JMP :+ (UpdateLynel's LDA #$20)
}

/** UpdateLynel (Z_04). X = lynel: goriya movement, try shooting a sword shot ($57). */
export function UpdateLynel(x) {
  // UpdateLynel (Z_04)
  UpdateGoriya(x);
  return _TryShooting(0x20, x, 0x57); // falls through
}
