// P15 npc — Grumble, the hungry goriya (Z_01): talks, waits for food in slot $0F, then leaves.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { tableJump } from '../../core/asm.js';
import {
  ObjState, ObjType, ObjTimer, PersonTextSelector, PersonTextPtr, FrameCounter, Tune1Request, InvFood,
} from '../../core/vars.js';
import { GetRoomFlagUWItemState } from '../items/roomitem.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';
import { Link_EndMoveAndAnimate_Bank1 } from '../link/anim.js';
import { SetUpCommonCaveObjects } from './cave.js';
import {
  UpdatePersonState_Textbox, UpdatePersonState_CueTransferBlankPersonWares, PlayCharacterSfx,
} from './textbox.js';
import {
  Person_CheckCollisions, L_Person_FlagItemTakenAndAdvanceState, InitUnderworldPerson_DoNothing,
} from './uwperson.js';

/** InitGrumble_Full (Z_01): X = object slot. */
export function InitGrumble_Full(x) {
  // InitGrumble_Full (Z_01): Grumble goes at ($78, $80).
  SetUpCommonCaveObjects(0x78, x, 0x80);
  ram[PersonTextSelector] = 0x24;
  ram[PersonTextPtr] = table(bus.rom, 'TextboxLineAddrsLo').byte(2);
  // Already fed: get rid of him.
  if (GetRoomFlagUWItemState() === 0) return PlayCharacterSfx();
  ram[ObjState] = 0x00;
  ram[ObjType + 1] = 0x00;
}

/** UpdateGrumble_Full (Z_01): X = object slot. */
export function UpdateGrumble_Full(x) {
  // UpdateGrumble_Full (Z_01): in state 3 translucent (drawn every other frame).
  if (ram[ObjState + 1] !== 0x03 || (ram[FrameCounter] & 0x01) === 0) {
    // @DrawAndCheckCollisions
    Person_CheckCollisions(x);
    const a = Anim_FetchObjPosForSpriteDescriptor(x);
    DrawObjectNotMirrored(a, x);
  }
  return tableJump(label('UpdateGrumble_Full_JumpTable').addr, ram[ObjState + 1], [
    UpdatePersonState_Textbox, UpdateGrumble1, UpdatePersonState_CueTransferBlankPersonWares, UpdateGrumble3,
  ]);
}

/** UpdateGrumble1 (Z_01): state 1. Wait for the food in slot $0F. */
export function UpdateGrumble1() {
  // UpdateGrumble1 (Z_01)
  if (!(ram[ObjState + 0x0f] & 0x80)) return InitUnderworldPerson_DoNothing();
  ram[ObjState] = 0x40; // halt Link
  ram[Tune1Request] = 0x04; // "secret found"
  return L_Person_FlagItemTakenAndAdvanceState();
}

/** UpdateGrumble3 (Z_01): state 3. After the delay, remove the food and Grumble. */
export function UpdateGrumble3() {
  // UpdateGrumble3 (Z_01)
  Link_EndMoveAndAnimate_Bank1();
  const a = ram[ObjTimer + 1];
  if (a !== 0) return InitUnderworldPerson_DoNothing();
  ram[ObjState + 0x0f] = a;
  ram[InvFood] = a;
  ram[ObjState] = a;
  ram[ObjType + 1] = a;
  return InitUnderworldPerson_DoNothing(); // falls through
}
