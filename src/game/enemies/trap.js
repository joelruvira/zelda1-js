// P20 — enemies/trap (Z_01, BANK_01_CODE). The blade traps were advanced by the wave-4 integrator (level 1
// rooms in the cellar/level movies have them). X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjAttr, ObjType, CurObjIndex, ObjX, ObjY, ObjState, ObjMovingLimit, ObjDir, ObjQSpeedFrac,
  ObjGridOffset,
} from '../../core/vars.js';
import { InitOneSimpleObject } from '../worldobj/rupeestash.js';
import { Abs, GetOppositeDir } from '../movement/math.js';
import { MoveObject } from '../movement/walker.js';
import { CheckLinkCollision } from '../combat/collisions.js';
import { Person_DrawAndCheckCollisions_Common } from '../npc/uwperson.js';

/**
 * InitTrap_Full (Z_01). X = trap generator object: makes 6 traps (type $49) or 4 (type $4A) in the slots
 * CurObjIndex + 5/3 down to CurObjIndex, at TrapXs/TrapYs, with the generator's attributes.
 */
export function InitTrap_Full(x) {
  // InitTrap_Full (Z_01)
  ram[0x01] = ram[ObjAttr + x];
  let y = 0x05;
  ram[0x00] = 0x49;
  if (ram[ObjType + x] !== 0x49) y = 0x03;
  const xs = table(bus.rom, 'TrapXs');
  const ys = table(bus.rom, 'TrapYs');
  do {
    // @LoopTrap
    x = (y + ram[CurObjIndex]) & 0xff;
    ram[ObjX + x] = xs.byte(y);
    ram[ObjY + x] = ys.byte(y);
    InitOneSimpleObject(x);
    x = (x - 1) & 0xff;
    y = (y - 1) & 0xff;
  } while (!(y & 0x80));
}

/**
 * UpdateTrap_Full (Z_01). X = trap. State 0 senses Link within $E pixels on one axis and charges along
 * the other (if TrapAllowedDirs lets it); state 1 moves fast until 5 pixels from the middle ($78/$90),
 * state 2 returns slowly to the original coordinate.
 */
export function UpdateTrap_Full(x) {
  // UpdateTrap_Full (Z_01)
  if (ram[ObjState + x] === 0) {
    let y;
    let a;
    let charge = false;
    if (Abs((ram[ObjY] - ram[ObjY + x]) & 0xff) < 0x0e && ram[ObjX] !== ram[ObjX + x]) {
      y = ram[ObjX] >= ram[ObjX + x] ? 0x01 : 0x02;
      a = ram[ObjX + x];
      charge = true;
    } else {
      // @CheckHorizontal
      if (Abs((ram[ObjX] - ram[ObjX + x]) & 0xff) >= 0x0e) return L_Trap_DrawAndCheckCollisions(x);
      if (ram[ObjY] === ram[ObjY + x]) return L_Trap_DrawAndCheckCollisions(x);
      y = ram[ObjY] >= ram[ObjY + x] ? 0x04 : 0x08;
      a = ram[ObjY + x];
      if (a !== 0) charge = true; // BNE @GoToState1
      else return UpdateMovingStates(x); // BNE not taken: falls into @UpdateMovingStates
    }
    if (charge) {
      // @GoToState1
      ram[ObjMovingLimit + x] = a;
      ram[ObjDir + x] = y;
      if ((y & table(bus.rom, 'TrapAllowedDirs').byte(x - 1)) !== 0) {
        ram[ObjState + x]++;
        ram[ObjQSpeedFrac + x] = 0x70;
      }
      return L_Trap_DrawAndCheckCollisions(x);
    }
  }
  return UpdateMovingStates(x);
}

/** UpdateTrap_Full@UpdateMovingStates: states 1 and 2 (and the Y = 0 fall-through of state 0). */
function UpdateMovingStates(x) {
  ram[0x0f] = ram[ObjDir + x];
  MoveObject(x);
  const g = ram[ObjGridOffset + x] & 0x0f;
  if (g === 0) ram[ObjGridOffset + x] = g;
  CheckLinkCollision(x);
  let y = ram[ObjX + x];
  ram[0x00] = 0x78;
  if (ram[ObjDir + x] & 0x0c) {
    y = ram[ObjY + x];
    ram[0x00] = 0x90;
  }
  // @Finish
  if (ram[ObjState + x] & 0x01) {
    if (Abs((y - ram[0x00]) & 0xff) >= 0x05) return L_Trap_DrawAndCheckCollisions(x); // @Draw
    ram[ObjDir + x] = GetOppositeDir(ram[ObjDir + x]).a;
    ram[ObjQSpeedFrac + x] = 0x20;
    ram[ObjState + x]++;
    return L_Trap_DrawAndCheckCollisions(x);
  }
  // @FinishState2
  if (y !== ram[ObjMovingLimit + x]) return L_Trap_DrawAndCheckCollisions(x);
  ram[ObjState + x] = 0x00;
  return L_Trap_DrawAndCheckCollisions(x); // falls through
}

/** L_Trap_DrawAndCheckCollisions (Z_01): JMP Person_DrawAndCheckCollisions_Common. */
export function L_Trap_DrawAndCheckCollisions(x) {
  // L_Trap_DrawAndCheckCollisions (Z_01)
  return Person_DrawAndCheckCollisions_Common(x);
}
