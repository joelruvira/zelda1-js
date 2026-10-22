// Tile objects: rocks, gravestones, rock walls, trees, the dock (Z_01, Z_04, Z_05). Package P16.
// Routines: CheckTileObjectsBlocking, CheckPassiveTileObjects, ResetRoomTileObjInfo (Z_01);
// UpdateRockOrGravestone, RevealSecretTileObj, UpdateRockWall, UpdateTree, RevealAndFlagSecretStairsObj,
// RevealAndFlagSecretTileObj (+ L10F3E_Exit), CheckTileObjWeaponCollision, IsQuestSecretMismatch,
// UpdateDock (Z_04); SetupTileObjectOW (Z_05). UpdateFluteSecret (Z_07) lives in pond.js.
// Tables read from the ROM: LinkToSquareOffsetsX/Y, RockPushDirections, SecretQuestNumbers, RaftDirections.

import { ram, cpu } from '../../core/ram.js';
import { bus, write } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  RoomTileObjType, RoomTileObjX, RoomTileObjY, RoomId, ObjX, ObjY, ObjType, ObjState, ObjDir, ObjTimer,
  ObjGridOffset, ObjInputDir, ObjCollidedTile, ObjUninitialized, EmptyMonsterSlot, InvBracelet, InvRaft,
  TileObjRoomId, ReturnToBank4, LevelBlockAttrsByteF, CurSaveSlot, QuestNumbers,
} from '../../core/vars.js';
import { Abs, GetOppositeDir } from '../movement/math.js';
import { MoveObject, GoToNextModeFromPlay } from '../movement/walker.js';
import { FindEmptyMonsterSlot, ResetObjMetastate, DestroyMonster_Bank4 } from '../objects/slots.js';
import { ChangeTileObjTiles } from '../world/tilemap.js';
import { GetRoomFlags, MarkRoomVisited } from '../world/roomflags.js';
import { Link_EndMoveAndAnimate_Bank4 } from '../link/anim.js';
import {
  Anim_FetchObjPosForSpriteDescriptor, DrawObjectNotMirrored, AnimateObjectWalking,
} from '../draw/anim.js';
import { Anim_WriteStaticItemSpritesWithAttributes } from '../draw/items.js';
import { GetObjectMiddle, DoObjectsCollide } from '../combat/collisions.js';
import { GetShortcutOrItemXYForRoom } from '../items/roomitem.js';
import { PlaySecretFoundTune } from '../world/secrets.js';

// UpdateFluteSecret (Z_07) is ported in pond.js; re-exported here for the object dispatch.
export { UpdateFluteSecret } from './pond.js';

// ------------------------------------------------------------------ Z_01

/** ResetRoomTileObjInfo (Z_01). @returns A = 0 */
export function ResetRoomTileObjInfo() {
  // ResetRoomTileObjInfo (Z_01)
  ram[RoomTileObjType] = 0x00;
  ram[RoomTileObjX] = 0x00;
  ram[RoomTileObjY] = 0x00;
  return 0x00;
}

/**
 * CheckTileObjectsBlocking (Z_01). [0F] = movement direction; set to 0 when Link is next to an
 * active block, rock or gravestone (objects $C..1). @returns X = 0
 */
export function CheckTileObjectsBlocking() {
  // CheckTileObjectsBlocking (Z_01)
  let x = 0x0c;
  do {
    // @LoopTileObj
    const t = ram[ObjType + x];
    if (t === 0x68 || t === 0x62 || t === 0x65 || t === 0x66) {
      // @Found
      if (ram[ObjState + x] === 0x01
          && Abs((ram[ObjX] - ram[ObjX + x]) & 0xff) < 0x10
          && Abs((ram[ObjY] + 0x03 - ram[ObjY + x]) & 0xff) < 0x10) {
        ram[0x0f] = 0x00;
      }
    }
    // @NextTileObj
    x--;
  } while (x !== 0);
  return x;
}

/**
 * CheckPassiveTileObjects (Z_01): Link walking into a gravestone/armos square ($BC-$C3) makes a
 * flying ghini or an armos appear there. @returns X = 0
 */
export function CheckPassiveTileObjects() {
  // CheckPassiveTileObjects (Z_01)
  if (ram[ObjGridOffset] !== 0) return 0; // @ReturnX0
  if (ram[ObjInputDir] === 0) return 0;
  ram[0x02] = 0xbb;
  let x = 0x08;
  const a = ram[ObjCollidedTile];
  for (;;) {
    // @NextTile
    ram[0x02]++;
    x = (x - 1) & 0xff;
    if (x & 0x80) return 0; // @ReturnX0
    if (a === ram[0x02]) break; // @TestTile
  }

  ram[0x00] = ram[ObjX];
  ram[0x01] = ram[ObjY];
  if (ram[ObjDir] & 0x0c) {
    // Facing vertically.
    const y = ram[0x02] & 0x03;
    let v = ram[0x00];
    if (y < 0x02) v = (v + 0x08) & 0xff;
    ram[0x00] = v & 0xf0;
  } else if (!(ram[0x02] & 0x01)) {
    // @CheckHorizontal
    ram[0x01] = (ram[0x01] + 0x08) & 0xff;
  }

  // @FindSlot
  if (FindEmptyMonsterSlot().y === 0) return 0; // @ExitX0
  x = ram[EmptyMonsterSlot];
  let y = GetOppositeDir(ram[ObjDir]).y;
  ram[ObjX + x] = (ram[0x00] + table(bus.rom, 'LinkToSquareOffsetsX').byte(y)) & 0xff;
  ram[ObjY + x] = (ram[0x01] + table(bus.rom, 'LinkToSquareOffsetsY').byte(y)) & 0xff;
  if (ram[ObjUninitialized + x] === 0) return 0; // @ExitX0

  // Don't make another armos/ghini where one is already appearing.
  y = 0x0b;
  ram[0x03] = x;
  do {
    // @FindObjAtLocation
    if (y !== ram[0x03] && ram[ObjX + y] === ram[ObjX + x] && ram[ObjY + y] === ram[ObjY + x]) {
      if (ram[ObjType + y] !== 0) return 0; // @ExitX0
      if (ram[ObjUninitialized + y] === 0) return 0; // @ExitX0
      break; // @ChooseObjType
    }
    // @NextObjAtLocation
    y--;
  } while (y !== 0);

  // @ChooseObjType
  ram[ObjType + x] = ram[0x02] >= 0xc0 ? 0x1e : 0x22; // armos : flying ghini
  ResetObjMetastate(x);
  ram[ObjTimer + x] = 0x3f; // fade in
  return 0; // @ExitX0
}

// ------------------------------------------------------------------ Z_04

/** UpdateRockOrGravestone (Z_04). X = object slot (rock $62 or gravestone $65, also $66). */
export function UpdateRockOrGravestone(x) {
  // UpdateRockOrGravestone (Z_04)
  if (ram[ObjState + x] === 0) {
    // State 0: wait to be pushed.
    if (ram[ObjType + x] !== 0x65 && ram[InvBracelet] === 0) return;
    // @CheckQuest
    if (IsQuestSecretMismatch()) return;
    if (ram[ObjX] !== ram[ObjX + x]) return;
    let y = 0x00;
    let a = (ram[ObjY] + 0x03 - ram[ObjY + x]) & 0xff;
    if (a & 0x80) {
      y++;
      a = ((a ^ 0xff) + 0x01) & 0xff;
    }
    // @CheckDistance
    if (a >= 0x11) return;
    a = ram[ObjInputDir] & 0x0c;
    if (a === 0) return;
    if (a !== table(bus.rom, 'RockPushDirections').byte(y)) return;
    ram[ObjDir + x] = a;
    ram[ObjState + x]++;
    ram[TileObjRoomId + x] = ram[RoomId];
    ram[ReturnToBank4]++;
    ChangeTileObjTiles(0x26, x); // gray floor tile
    return;
  }

  // @State1: move, drawn one pixel up.
  ram[0x0f] = ram[ObjDir + x];
  MoveObject(x);
  const a = Anim_FetchObjPosForSpriteDescriptor(x);
  ram[0x01]--;
  DrawObjectNotMirrored(a, x);
  const g = ram[ObjGridOffset + x];
  if (g !== 0x10 && g !== 0xf0) return;

  // Flag the room visited.
  const savedRoom = ram[RoomId]; // PHA
  ram[RoomId] = ram[TileObjRoomId + x];
  MarkRoomVisited();
  ram[RoomId] = savedRoom; // PLA

  let tile = 0xc8; // rock
  const t = ram[ObjType + x];
  if (t !== 0x62) {
    tile = 0xbc; // gravestone
    if (t !== 0x65) tile = 0xc0; // armos (unverified code 10EC9)
  }
  // @ReplaceTiles
  ram[ReturnToBank4]++;
  ChangeTileObjTiles(tile, x);
  ram[0x00] = 0x70; // stairs tile
  const r = GetShortcutOrItemXYForRoom(ram[TileObjRoomId + x]);
  ram[ObjX + x] = r.a;
  ram[ObjY + x] = r.y;
  return RevealSecretTileObj(ram[0x00], x); // falls through
}

/** RevealSecretTileObj (Z_04). A = first tile of the tile object, X = object slot. */
export function RevealSecretTileObj(a, x) {
  // RevealSecretTileObj (Z_04)
  ram[ReturnToBank4]++;
  ChangeTileObjTiles(a, x);
  DestroyMonster_Bank4(x);
  return PlaySecretFoundTune();
}

/** UpdateRockWall (Z_04). X = object slot: a detonating bomb opens it. */
export function UpdateRockWall(x) {
  // UpdateRockWall (Z_04)
  if (IsQuestSecretMismatch()) return;
  let y = 0x10;
  if (ram[ObjState + y] !== 0x13) {
    y++;
    if (ram[ObjState + y] !== 0x13) return;
  }
  // @FoundBomb
  ram[0x00] = y;
  if (CheckTileObjWeaponCollision(x, y) === 0) return;
  RevealAndFlagSecretTileObj(0x24, x); // black tile
}

/** UpdateTree (Z_04). X = object slot: a standing fire about to go out burns it. */
export function UpdateTree(x) {
  // UpdateTree (Z_04)
  if (IsQuestSecretMismatch()) return; // L10F3E_Exit
  let y = 0x10;
  if (ram[ObjState + y] !== 0x22) {
    y++;
    if (ram[ObjState + y] !== 0x22) return;
  }
  // @FoundFire
  ram[0x00] = y;
  if (ram[ObjTimer + y] >= 0x02) return;
  if (CheckTileObjWeaponCollision(x, y) === 0) return;
  return RevealAndFlagSecretStairsObj(x); // falls through
}

/** RevealAndFlagSecretStairsObj (Z_04). X = tile object slot. */
export function RevealAndFlagSecretStairsObj(x) {
  // RevealAndFlagSecretStairsObj (Z_04)
  return RevealAndFlagSecretTileObj(0x70, x); // first tile of stairs; falls through
}

/** RevealAndFlagSecretTileObj (Z_04). A = first tile, X = object slot. L10F3E_Exit is its RTS. */
export function RevealAndFlagSecretTileObj(a, x) {
  // RevealAndFlagSecretTileObj (Z_04)
  RevealSecretTileObj(a, x);
  a = GetRoomFlags() | 0x80; // secret found/taken
  write((((ram[0x01] << 8) | ram[0x00]) + ram[RoomId]) & 0xffff, a); // STA ($00), Y (Y = RoomId)
}

/**
 * CheckTileObjWeaponCollision (Z_04). X = tile object, Y = weapon slot, [00] = weapon slot.
 * @returns A = 1 if they collide (DoObjectsCollide)
 */
export function CheckTileObjWeaponCollision(x, y) {
  // CheckTileObjWeaponCollision (Z_04)
  ram[0x04] = (ram[ObjX + y] + 0x08) & 0xff;
  ram[0x05] = (ram[ObjY + y] + 0x08) & 0xff;
  GetObjectMiddle(x);
  return DoObjectsCollide(0x10); // JMP
}

/**
 * IsQuestSecretMismatch (Z_04). @returns C (also in cpu.c): 1 if the room's secret is for the other
 * quest.
 */
export function IsQuestSecretMismatch() {
  // IsQuestSecretMismatch (Z_04)
  const q = ram[LevelBlockAttrsByteF] >> 6;
  let c = 0;
  if (q !== 0) {
    const a = table(bus.rom, 'SecretQuestNumbers').byte(q);
    if (a !== ram[QuestNumbers + ram[CurSaveSlot]]) c = 1;
  }
  cpu.c = c;
  return c;
}

/** UpdateDock (Z_04). X = dock slot: the raft goes up or down between the dock and the next room. */
export function UpdateDock(x) {
  // UpdateDock (Z_04)
  if (ram[InvRaft] === 0) return;
  if (ram[ObjState + x] === 0) {
    // State 0
    const dockX = ram[RoomId] === 0x55 ? 0x80 : 0x60;
    if (dockX !== ram[ObjX]) return;
    ram[ObjX + x] = dockX;
    let y = 0x01;
    const a = ram[ObjY];
    if (a !== 0x3d) {
      y++;
      if (a !== 0x7d) return;
    }
    // @SetState
    ram[ObjState + x] = y;
    ram[ObjY + x] = (a + 0x06) & 0xff;
    PlaySecretFoundTune();
    ram[ObjState] = 0x40;
    ram[ObjDir] = table(bus.rom, 'RaftDirections').byte(y - 1);
    return;
  }

  // @HandleOtherStates
  let reset = false;
  if (ram[ObjState + x] - 1 !== 0) {
    // State 2: up.
    ram[ObjY + x]--;
    ram[ObjY]--;
    if (ram[ObjY] === 0x3d) {
      GoToNextModeFromPlay(); // TXA/PHA ... PLA/TAX
      reset = true;
    }
  } else {
    // @State1: down.
    ram[ObjY + x]++;
    ram[ObjY]++;
    if (ram[ObjY] === 0x7f) {
      ram[ObjGridOffset] = 0x02;
      reset = true;
    }
  }
  if (reset) {
    // @ResetLinkAndRaftStateAndDraw
    ram[ObjState] = 0x00;
    ram[ObjState + x] = 0x00;
  }
  // @Draw
  Link_EndMoveAndAnimate_Bank4();
  AnimateObjectWalking(x);
  return Anim_WriteStaticItemSpritesWithAttributes(0x00, x, 0x09); // raft item slot
}

// ------------------------------------------------------------------ Z_05

/**
 * SetupTileObjectOW (Z_05). Puts the dock ($61, rooms $3F/$55) or the tile object found by the
 * layout in slot $B.
 */
export function SetupTileObjectOW() {
  // SetupTileObjectOW (Z_05)
  let a = ram[RoomId];
  if (a === 0x3f || a === 0x55) {
    a = 0x61;
  } else {
    // @PlaceTileObj
    ram[ObjX + 11] = ram[RoomTileObjX];
    ram[ObjY + 11] = ram[RoomTileObjY];
    a = ram[RoomTileObjType];
  }
  // @SetType
  ram[ObjType + 11] = a;
  ram[ObjState + 11] = ResetRoomTileObjInfo(); // activate room tile object (A = 0)
}
