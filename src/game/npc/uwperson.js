// P15 npc — underworld people (Z_01): old men with hints, the "more bombs" offer, "life or money",
// the level 9 entrance man; their collisions (hitting them enables the bonfires' fireballs),
// drawing, and CheckPersonBlocking (Link cannot walk up past a person).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { tableJump } from '../../core/asm.js';
import {
  ObjX, ObjY, ObjType, ObjState, ObjTimer, ObjMetastate, PersonTextSelector, PersonTextIndex, PersonTextPtr,
  CurLevel, InvTriforce, ShutterTrigger, PersonFireballsEnabled, FrameCounter, InvRupees, RupeesToSubtract,
  Tune0Request, MaxBombs, InvBombs, HeartValues, HeartPartial, TileBufSelector,
} from '../../core/vars.js';
import { GetRoomFlagUWItemState, SetRoomFlagUWItemState, AnimateItemObject } from '../items/roomitem.js';
import { DestroyMonster } from '../objects/slots.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored } from '../draw/anim.js';
import { Abs } from '../movement/math.js';
import { ResetMovingDir } from '../movement/walker.js';
import { SetUpCommonCaveObjects } from './cave.js';
import {
  UpdatePersonState_Textbox, UpdatePersonState_CueTransferBlankPersonWares, CueTransferBufAndAdvanceState,
  PlayCharacterSfx,
} from './textbox.js';
import { $br, $pxa } from '../../core/timing.js';

// ------------------------------------------------------------------ init

/** InitUnderworldPerson_Full (Z_01): X = object slot. Dispatches by level. */
export function InitUnderworldPerson_Full(x) {
  // InitUnderworldPerson_Full (Z_01)
  ram[PersonTextPtr] = table(bus.rom, 'TextboxLineAddrsLo').byte(2);
  const a = () => InitUnderworldPersonA(x);
  const b = () => InitUnderworldPersonB(x);
  return tableJump(label('InitUnderworldPerson_Full_JumpTable').addr, ram[CurLevel], [
    InitUnderworldPerson_DoNothing, a, a, b, b, a, b, a, b, () => InitUnderworldPersonC(x),
  ]);
}

/** InitUnderworldPersonA (Z_01): X = object slot. Levels 1, 2, 5, 7. */
export function InitUnderworldPersonA(x) {
  // InitUnderworldPersonA (Z_01)
  SetUpCommonCaveObjects(0x78, x, 0x80);
  $pxa('Z_01:1040', ObjType, x);
  const y = (ram[ObjType + x] - 0x4b) & 0xff;
  $pxa('Z_01:1046', label('UnderworldPersonTextSelectorsA').addr, y);
  ram[PersonTextSelector] = table(bus.rom, 'UnderworldPersonTextSelectorsA').byte(y);
  // The "more bombs" man is gone once his offer was taken.
  if ($br('Z_01:1053', ram[ObjType + 1] !== 0x4f)) return L_PlayCharacterSfx();
  $br('Z_01:1054', true);
  return UnderworldPerson_DestroyIfTaken(x);
}

/** InitUnderworldPersonLifeOrMoney_Full (Z_01): X = object slot. Falls into UnderworldPerson_DestroyIfTaken. */
export function InitUnderworldPersonLifeOrMoney_Full(x) {
  // InitUnderworldPersonLifeOrMoney_Full (Z_01)
  SetUpCommonCaveObjects(0x78, x, 0x80);
  ram[PersonTextSelector] = 0x36; // "life or money"
  ram[PersonTextPtr] = table(bus.rom, 'TextboxLineAddrsLo').byte(2);
  return UnderworldPerson_DestroyIfTaken(x);
}

/** UnderworldPerson_DestroyIfTaken (Z_01, part of InitUnderworldPersonLifeOrMoney_Full). */
function UnderworldPerson_DestroyIfTaken(x) {
  // UnderworldPerson_DestroyIfTaken (Z_01)
  if ($br('Z_01:1073', GetRoomFlagUWItemState() === 0)) return L_PlayCharacterSfx();
  ram[ObjState] = 0x00;
  return DestroyMonster(x);
}

/** L_PlayCharacterSfx (Z_01, part of InitUnderworldPersonA): JMP PlayCharacterSfx. */
function L_PlayCharacterSfx() {
  // L_PlayCharacterSfx (Z_01)
  return PlayCharacterSfx();
}

/** InitUnderworldPersonB (Z_01): X = object slot. Levels 3, 4, 6, 8. */
export function InitUnderworldPersonB(x) {
  // InitUnderworldPersonB (Z_01)
  SetUpCommonCaveObjects(0x78, x, 0x80);
  $pxa('Z_01:1091', ObjType, x);
  const y = (ram[ObjType + x] - 0x4b) & 0xff;
  $pxa('Z_01:1097', label('UnderworldPersonTextSelectorsB').addr, y);
  ram[PersonTextSelector] = table(bus.rom, 'UnderworldPersonTextSelectorsB').byte(y);
  return PlayCharacterSfx();
}

/** InitUnderworldPersonC (Z_01): X = object slot. Level 9; the entrance man leaves with 8 triforces. */
export function InitUnderworldPersonC(x) {
  // InitUnderworldPersonC (Z_01)
  SetUpCommonCaveObjects(0x78, x, 0x80);
  PlayCharacterSfx();
  $pxa('Z_01:1110', ObjType, x);
  const a = ram[ObjType + x]; // PHA
  const y = (a - 0x4b) & 0xff;
  $pxa('Z_01:1119', label('UnderworldPersonTextSelectorsC').addr, y);
  ram[PersonTextSelector] = table(bus.rom, 'UnderworldPersonTextSelectorsC').byte(y);
  if ($br('Z_01:1126', a !== 0x4b)) return;
  if ($br('Z_01:1129', ram[InvTriforce] !== 0xff)) return;
  // Open the shutters and destroy this object.
  ram[ShutterTrigger] = 0x01;
  ram[ObjState] = 0x00; // LSR
  DestroyMonster(x);
}

/** InitUnderworldPerson_DoNothing (Z_01): level 0 entry; also the RTS of UpdateGrumble1/3. */
export function InitUnderworldPerson_DoNothing() {
  // InitUnderworldPerson_DoNothing (Z_01)
}

// ------------------------------------------------------------------ update

/** UpdateUnderworldPerson_Full (Z_01): X = object slot. */
export function UpdateUnderworldPerson_Full(x) {
  // UpdateUnderworldPerson_Full (Z_01): levels other than 3, 4, 6, 8, 9 do more than talk.
  const lvl = ram[CurLevel];
  if ($br('Z_01:1175', lvl < 0x03) || $br('Z_01:1177', lvl === 0x05) || !$br('Z_01:1179', lvl !== 0x07)) return UpdateUnderworldPersonComplex(x);
  // @DrawAndCheckCollisions
  Person_DrawAndCheckCollisions(x);
  return tableJump(label('UpdateUnderworldPerson_Full_JumpTable').addr, ram[ObjState + 1], [
    UpdatePersonState_ResetCharOffset, UpdatePersonState_Textbox, UpdatePersonState_DoNothing,
  ]);
}

/** UpdatePersonState_ResetCharOffset (Z_01): falls into UpdatePersonState_DoNothing. */
export function UpdatePersonState_ResetCharOffset() {
  // UpdatePersonState_ResetCharOffset (Z_01)
  ram[PersonTextIndex] = 0x00;
  ram[ObjState + 1]++;
}

/** UpdatePersonState_DoNothing (Z_01) */
export function UpdatePersonState_DoNothing() {
  // UpdatePersonState_DoNothing (Z_01)
}

/** Person_CheckCollisions (Z_01): X = object slot. Hitting the person enables the fireballs. */
export function Person_CheckCollisions(x) {
  // Person_CheckCollisions (Z_01)
  CheckMonsterCollisions(x);
  const a = ram[ObjMetastate + 1];
  if ($br('Z_01:1208', a === 0)) return;
  ram[PersonFireballsEnabled] = a;
  ram[ObjMetastate + 1] = 0x00;
}

/** UpdateUnderworldPersonComplex (Z_01): X = object slot. Levels 1, 2, 5, 7 (and 0). */
export function UpdateUnderworldPersonComplex(x) {
  // UpdateUnderworldPersonComplex (Z_01): in state 4 shown every other frame.
  if (!(!$br('Z_01:1219', ram[ObjState + 1] !== 0x04) && $br('Z_01:1222', (ram[FrameCounter] & 0x01) !== 0))) {
    Person_DrawAndCheckCollisions(x);
    if (!$br('Z_01:1230', ram[ObjType + 1] !== 0x4f)) {
      // "More bombs" man: a rupee at ($78, $98) in the room item slot.
      ram[ObjX + 19] = 0x78;
      ram[ObjY + 19] = 0x98;
      AnimateItemObject(0x18, 0x13);
    }
  }
  // @HandleState
  return tableJump(label('UpdateUnderworldPersonComplex_JumpTable').addr, ram[ObjState + 1], [
    UpdateUnderworldPersonComplexState_Begin, UpdatePersonState_Textbox,
    UpdateUnderworldPersonComplexState_SenseLink, UpdatePersonState_CueTransferBlankPersonWares,
    UpdateUnderworldPersonComplexState_DelayAndQuit,
  ]);
}

/** UpdateUnderworldPersonComplexState_Begin (Z_01): state 0. */
export function UpdateUnderworldPersonComplexState_Begin() {
  // UpdateUnderworldPersonComplexState_Begin (Z_01)
  if (!$br('Z_01:1254', ram[ObjType + 1] !== 0x4f)) ram[TileBufSelector] = 0x6c; // "-100"
  ram[ObjTimer + 1] = 0x0a;
  ram[ObjState + 1]++;
}

/** UpdateUnderworldPersonComplexState_SenseLink (Z_01): state 2. The "more bombs" purchase. */
export function UpdateUnderworldPersonComplexState_SenseLink() {
  // UpdateUnderworldPersonComplexState_SenseLink (Z_01)
  if ($br('Z_01:1269', ram[ObjType + 1] !== 0x4f)) return;
  if ($br('Z_01:1274', ram[ObjX] !== 0x78)) return;
  if (!$br('Z_01:1284', Abs((ram[ObjY] - 0x98) & 0xff) < 0x06)) return;
  // @CheckCanPay
  const a = 0x64;
  if (!$br('Z_01:1293', a === ram[InvRupees]) && $br('Z_01:1294', a >= ram[InvRupees])) return;
  ram[RupeesToSubtract] = a + ram[RupeesToSubtract];
  ram[Tune0Request] = 0x08; // "key taken"
  ram[MaxBombs] = ram[MaxBombs] + 0x04;
  ram[InvBombs] = ram[MaxBombs];
  return L_Person_FlagItemTakenAndAdvanceState();
}

/** UpdateUnderworldPersonComplexState_DelayAndQuit (Z_01): state 4. Destroy when the timer expires. */
export function UpdateUnderworldPersonComplexState_DelayAndQuit() {
  // UpdateUnderworldPersonComplexState_DelayAndQuit (Z_01)
  const a = ram[ObjTimer + 1];
  if (!$br('Z_01:1318', a !== 0)) ram[ObjType + 1] = a;
}

/** Person_DrawAndCheckCollisions (Z_01): X = object slot. */
export function Person_DrawAndCheckCollisions(x) {
  // Person_DrawAndCheckCollisions (Z_01)
  Person_CheckCollisions(x);
  const a = Anim_FetchObjPosForSpriteDescriptor(x);
  return DrawObjectMirrored(a, x);
}

/** UpdateUnderworldPersonLifeOrMoney_Full (Z_01): X = object slot. */
export function UpdateUnderworldPersonLifeOrMoney_Full(x) {
  // UpdateUnderworldPersonLifeOrMoney_Full (Z_01): in state 4 drawn every other frame.
  if (!(!$br('Z_01:1332', ram[ObjState + 1] !== 0x04) && $br('Z_01:1335', (ram[FrameCounter] & 0x01) !== 0))) {
    // @Draw
    Person_DrawAndCheckCollisions(x);
    DrawLifeOrMoneyItems();
  }
  return tableJump(label('UpdateUnderworldPersonLifeOrMoney_Full_JumpTable').addr, ram[ObjState + 1], [
    UpdateUnderworldPersonLifeOrMoneyState_0, UpdatePersonState_Textbox,
    UpdateUnderworldPersonLifeOrMoneyState_2, UpdatePersonState_CueTransferBlankPersonWares,
    UpdateUnderworldPersonComplexState_DelayAndQuit,
  ]);
}

/** DrawLifeOrMoneyItems (Z_01): heart container and rupee in the room item slot. */
export function DrawLifeOrMoneyItems() {
  // DrawLifeOrMoneyItems (Z_01)
  const xs = table(bus.rom, 'LifeOrMoneyItemXs');
  const types = table(bus.rom, 'LifeOrMoneyItemTypes');
  for (let x = 0x01; ; x--) {
    $pxa('Z_01:1366', xs.addr, x);
    ram[ObjX + 19] = xs.byte(x);
    ram[ObjY + 19] = 0x98;
    $pxa('Z_01:1372', types.addr, x);
    AnimateItemObject(types.byte(x), 0x13);
    if (!$br('Z_01:1380', x - 1 >= 0)) break;
  }
}

/** UpdateUnderworldPersonLifeOrMoneyState_0 (Z_01): state 0. */
export function UpdateUnderworldPersonLifeOrMoneyState_0() {
  // UpdateUnderworldPersonLifeOrMoneyState_0 (Z_01)
  ram[ObjTimer + 1] = 0x0a;
  return CueTransferBufAndAdvanceState(0x76); // "-1   -50"
}

/** UpdateUnderworldPersonLifeOrMoneyState_2 (Z_01): state 2. Pay with a heart container or 50 rupees. */
export function UpdateUnderworldPersonLifeOrMoneyState_2() {
  // UpdateUnderworldPersonLifeOrMoneyState_2 (Z_01)
  const xs = table(bus.rom, 'LifeOrMoneyItemXs');
  let x;
  for (x = 0x01; ; x--) {
    $pxa('Z_01:1397', xs.addr, x);
    if (!$br('Z_01:1398', ram[ObjX] !== xs.byte(x))) {
      if ($br('Z_01:1407', Abs((ram[ObjY] - 0x98) & 0xff) < 0x06)) break;
    }
    if (!$br('Z_01:1411', x - 1 >= 0)) return;
  }
  // @Pay
  if (!$br('Z_01:1419', x === 0x00)) {
    const a = 0x32;
    if (!$br('Z_01:1425', a === ram[InvRupees]) && $br('Z_01:1426', a >= ram[InvRupees])) return;
    // @PayWithMoney
    ram[RupeesToSubtract] = a + ram[RupeesToSubtract];
  } else {
    // @PayWithHeartContainer
    let a = ram[HeartValues] & 0xf0;
    if (!$br('Z_01:1446', a >= 0x30)) {
      ram[HeartValues] = a;
      ram[HeartPartial] = 0x00;
    } else {
      // @Reduce
      const hv = ram[HeartValues]; // PHA
      ram[0x00] = ((hv & 0xf0) - 0x10) & 0xff;
      a = ((hv & 0x0f) - 0x01) & 0xff;
      if (!$br('Z_01:1468', (a & 0x80) === 0)) a = 0x00;
      ram[HeartValues] = a | ram[0x00];
    }
  }
  // @EndLifeOrMoney
  ram[Tune0Request] = 0x08; // "key taken"
  ram[ShutterTrigger] = 0x01;
  return L_Person_FlagItemTakenAndAdvanceState();
}

/** L_Person_FlagItemTakenAndAdvanceState (Z_01): flag the room item taken, timer $40, blank the text. */
export function L_Person_FlagItemTakenAndAdvanceState() {
  // L_Person_FlagItemTakenAndAdvanceState (Z_01)
  SetRoomFlagUWItemState();
  ram[ObjTimer + 1] = 0x40;
  return CueTransferBufAndAdvanceState(0x1e);
}

// ------------------------------------------------------------------ shared with other packages

/**
 * CheckPersonBlocking (Z_01, RAM code). [0F] = movement direction; stops Link moving up when he
 * is above the person line (Y < $8E). Leaves [0F] untouched or 0.
 */
export function CheckPersonBlocking() {
  // CheckPersonBlocking (Z_01)
  if ($br('Z_01:3147', ram[ObjY] >= 0x8e)) return;
  if ($br('Z_01:3150', (ram[0x0f] & 0x08) === 0)) return;
  return ResetMovingDir();
}

/** Person_DrawAndCheckCollisions_Common (Z_01, RAM code): X = object slot. Falls into Person_Draw. */
export function Person_DrawAndCheckCollisions_Common(x) {
  // Person_DrawAndCheckCollisions_Common (Z_01)
  CheckMonsterCollisions(x);
  const a = ram[ObjMetastate + 1];
  if (!$br('Z_01:5459', a === 0)) {
    ram[PersonFireballsEnabled] = a;
    ram[ObjMetastate + 1] = 0x00;
  }
  return Person_Draw(x);
}

/** Person_Draw (Z_01, RAM code): X = object slot. */
export function Person_Draw(x) {
  // Person_Draw (Z_01)
  const a = Anim_FetchObjPosForSpriteDescriptor(x);
  return DrawObjectMirrored(a, x);
}
