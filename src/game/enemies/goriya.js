// P19 — enemies/goriya (Z_04). UpdateGoriya and L_Walker_SetInputDirAndTryShootingBoomerang were advanced by
// the wave-4 integrator: every wandering overworld monster (octorok, moblin, lynel, armos via
// Wanderer_TargetPlayer / UpdateGoriya) runs them, so the pure port needs them before the rest of P19.
// X = object slot in every routine.
import { ram } from '../../core/ram.js';
import {
  ObjType, ObjState, ObjShoveDir, ObjQSpeedFrac, ObjGridOffset, ChaseTargetX, ChaseTargetY, ObjX, ObjY,
  ObjWantsToShoot, ObjDir, ObjInputDir, Random, ObjTimer, InvClock, ObjStunTimer, ObjRefId,
  ObjMovingLimit, ObjMetastate, ObjAnimCounter,
} from '../../core/vars.js';
import { Walker_Move } from '../movement/walker.js';
import { _ShootIfWanted } from './shots.js';

/**
 * UpdateGoriya (Z_04). X = monster. Walks; at whole squares turns to face the chase target along the
 * longer axis and "wants to shoot" when it is closer than $51; then falls through to
 * L_Walker_SetInputDirAndTryShootingBoomerang.
 */
export function UpdateGoriya(x) {
  // UpdateGoriya (Z_04)
  // Note: the asm reads ObjType+1,X here (not ObjType,X).
  if (ram[ObjType + 1 + x] !== 0x1e) {
    if (ram[ObjState + x] & 0x80) return; // @Exit
  }
  Walker_Move(x);
  if (ram[ObjShoveDir + x] !== 0) return; // @Exit
  // @AfterMove
  if (ram[ObjQSpeedFrac + x] === 0) return L_Walker_SetInputDirAndTryShootingBoomerang(x);
  let a = ram[ObjGridOffset + x] & 0x0f;
  if (a !== 0) return L_Walker_SetInputDirAndTryShootingBoomerang(x);
  ram[ObjGridOffset + x] = a;
  if (ram[ObjState] === 0xff) return L_Walker_SetInputDirAndTryShootingBoomerang(x);
  // Vertical distance in [00], direction in [02].
  ram[0x02] = 0x04;
  a = ram[ChaseTargetY];
  let y = ram[ObjY + x];
  if (a < ram[ObjY + x]) {
    a = ram[ObjY + x];
    y = ram[ChaseTargetY];
    ram[0x02] = (ram[0x02] << 1) & 0xff;
  }
  ram[0x0e] = y;
  ram[0x00] = (a - ram[0x0e]) & 0xff;
  // Horizontal distance in [01], direction in [03].
  ram[0x03] = 0x01;
  a = ram[ChaseTargetX];
  y = ram[ObjX + x];
  if (a < ram[ObjX + x]) {
    a = ram[ObjX + x];
    y = ram[ChaseTargetX];
    ram[0x03] = (ram[0x03] << 1) & 0xff;
  }
  ram[0x0e] = y;
  ram[0x01] = (a - ram[0x0e]) & 0xff;
  y = ram[0x00] >= ram[0x01] ? 0 : 1;
  ram[ObjWantsToShoot + x] = 0x00;
  if (ram[0x00 + y] >= 0x51) return L_Walker_SetInputDirAndTryShootingBoomerang(x);
  ram[ObjWantsToShoot + x]++;
  ram[ObjDir + x] = ram[0x02 + y];
  return L_Walker_SetInputDirAndTryShootingBoomerang(x); // falls through
}

/**
 * L_Walker_SetInputDirAndTryShootingBoomerang (Z_04). X = monster. Input direction = facing direction;
 * blue goriyas (and red ones on Random $23/$77) throw a boomerang ($5C) when their timer is 0.
 */
export function L_Walker_SetInputDirAndTryShootingBoomerang(x) {
  // L_Walker_SetInputDirAndTryShootingBoomerang (Z_04)
  ram[ObjInputDir + x] = ram[ObjDir + x];
  let a = 0x5c;
  const t = ram[ObjType + x];
  if (t !== 0x05) {
    if (t !== 0x06) return; // @Exit
    a = ram[Random + x];
    if (a !== 0x23 && a !== 0x77) return; // @Exit
    a = 0x5c; // @CheckTimerToShootBoomerang
  }
  // @CheckTimerToShoot
  if (ram[ObjTimer + x] !== 0) return;
  ram[0x00] = a;
  if ((ram[InvClock] | ram[ObjStunTimer + x]) !== 0) return;
  // Y = ObjTimer,X (LDY ObjTimer, X above) = 0, passed through on failure.
  const r = _ShootIfWanted(ram[0x00], x, 0x00);
  if (!r.c) return;
  x = r.x;
  const y = r.y;
  ram[ObjState + x] = 0x80;
  ram[ObjWantsToShoot + x] = 0x00;
  ram[ObjRefId + y] = x;
  ram[ObjRefId + x] = y;
  ram[ObjState + y] = 0x10;
  ram[ObjQSpeedFrac + y] = 0xa0;
  ram[ObjMovingLimit + y] = 0x51;
  ram[ObjMetastate + y] = 0x00;
  ram[ObjAnimCounter + y] = 0x03;
  ram[ObjTimer + x] = ram[Random + x] & 0x3f;
}
