// Tile objects: rocks, gravestones, rock walls, trees, the dock (Z_01, Z_04, Z_05). Package P16.
// Routines: CheckTileObjectsBlocking, CheckPassiveTileObjects, ResetRoomTileObjInfo (Z_01);
// UpdateRockOrGravestone, RevealSecretTileObj, UpdateRockWall, UpdateTree, RevealAndFlagSecretStairsObj,
// RevealAndFlagSecretTileObj (+ L10F3E_Exit), CheckTileObjWeaponCollision, IsQuestSecretMismatch,
// UpdateDock (Z_04); SetupTileObjectOW (Z_05). UpdateFluteSecret (Z_07) lives in pond.js.
// Tables read from the ROM: LinkToSquareOffsetsX/Y, RockPushDirections, SecretQuestNumbers, RaftDirections.

import { ram, cpu } from '../../core/ram.js';
import { bus, write } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
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
import { $br, $pxa } from '../../core/timing.js';

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
    $pxa('Z_01:2024', ObjType, x);
    const t = ram[ObjType + x];
    if ($br('Z_01:2026', t === 0x68) || $br('Z_01:2028', t === 0x62) || $br('Z_01:2030', t === 0x65)
        || !$br('Z_01:2032', t !== 0x66)) {
      // @Found
      if (!$br('Z_01:2037', ram[ObjState + x] !== 0x01)
          && !$br('Z_01:2045', Abs((ram[ObjX] - ram[ObjX + x]) & 0xff) >= 0x10)
          && !$br('Z_01:2055', Abs((ram[ObjY] + 0x03 - ram[ObjY + x]) & 0xff) >= 0x10)) {
        ram[0x0f] = 0x00;
      }
    }
    // @NextTileObj
    x--;
  } while ($br('Z_01:2063', x !== 0));
  return x;
}

/**
 * CheckPassiveTileObjects (Z_01): Link walking into a gravestone/armos square ($BC-$C3) makes a
 * flying ghini or an armos appear there. @returns X = 0
 */
export function CheckPassiveTileObjects() {
  // CheckPassiveTileObjects (Z_01)
  if ($br('Z_01:2226', ram[ObjGridOffset] !== 0)) return 0; // @ReturnX0
  if ($br('Z_01:2228', ram[ObjInputDir] === 0)) return 0;
  ram[0x02] = 0xbb;
  let x = 0x08;
  const a = ram[ObjCollidedTile];
  for (;;) {
    // @NextTile
    ram[0x02]++;
    x = (x - 1) & 0xff;
    if (!$br('Z_01:2240', !(x & 0x80))) return 0; // @ReturnX0
    if (!$br('Z_01:2248', a !== ram[0x02])) break; // @TestTile
  }

  ram[0x00] = ram[ObjX];
  ram[0x01] = ram[ObjY];
  if (!$br('Z_01:2258', (ram[ObjDir] & 0x0c) === 0)) {
    // Facing vertically.
    const y = ram[0x02] & 0x03;
    let v = ram[0x00];
    if (!$br('Z_01:2272', y >= 0x02)) v = (v + 0x08) & 0xff;
    ram[0x00] = v & 0xf0;
  } else if (!$br('Z_01:2287', (ram[0x02] & 0x01) !== 0)) {
    // @CheckHorizontal
    ram[0x01] = (ram[0x01] + 0x08) & 0xff;
  }

  // @FindSlot
  if ($br('Z_01:2297', FindEmptyMonsterSlot().y === 0)) return 0; // @ExitX0
  x = ram[EmptyMonsterSlot];
  let y = GetOppositeDir(ram[ObjDir]).y;
  $pxa('Z_01:2311', label('LinkToSquareOffsetsX').addr, y);
  ram[ObjX + x] = (ram[0x00] + table(bus.rom, 'LinkToSquareOffsetsX').byte(y)) & 0xff;
  $pxa('Z_01:2315', label('LinkToSquareOffsetsY').addr, y);
  ram[ObjY + x] = (ram[0x01] + table(bus.rom, 'LinkToSquareOffsetsY').byte(y)) & 0xff;
  $pxa('Z_01:2321', ObjUninitialized, x);
  if ($br('Z_01:2322', ram[ObjUninitialized + x] === 0)) return 0; // @ExitX0

  // Don't make another armos/ghini where one is already appearing.
  y = 0x0b;
  ram[0x03] = x;
  do {
    // @FindObjAtLocation
    if (!$br('Z_01:2332', y === ram[0x03])) {
      $pxa('Z_01:2333', ObjX, y);
      if (!$br('Z_01:2335', ram[ObjX + y] !== ram[ObjX + x])) {
        $pxa('Z_01:2336', ObjY, y);
        if (!$br('Z_01:2338', ram[ObjY + y] !== ram[ObjY + x])) {
          $pxa('Z_01:2339', ObjType, y);
          if ($br('Z_01:2340', ram[ObjType + y] !== 0)) return 0; // @ExitX0
          $pxa('Z_01:2341', ObjUninitialized, y);
          if ($br('Z_01:2342', ram[ObjUninitialized + y] === 0)) return 0; // @ExitX0
          $br('Z_01:2343', true);
          break; // @ChooseObjType
        }
      }
    }
    // @NextObjAtLocation
    y--;
  } while ($br('Z_01:2347', y !== 0));

  // @ChooseObjType
  ram[ObjType + x] = $br('Z_01:2354', ram[0x02] >= 0xc0) ? 0x1e : 0x22; // armos : flying ghini
  ResetObjMetastate(x);
  ram[ObjTimer + x] = 0x3f; // fade in
  return 0; // @ExitX0
}

// ------------------------------------------------------------------ Z_04

/** UpdateRockOrGravestone (Z_04). X = object slot (rock $62 or gravestone $65, also $66). */
export function UpdateRockOrGravestone(x) {
  // UpdateRockOrGravestone (Z_04)
  if (!$br('Z_04:3571', ram[ObjState + x] !== 0)) {
    // State 0: wait to be pushed.
    $pxa('Z_04:3577', ObjType, x);
    if (!$br('Z_04:3579', ram[ObjType + x] === 0x65) && $br('Z_04:3581', ram[InvBracelet] === 0)) return;
    // @CheckQuest
    if ($br('Z_04:3587', IsQuestSecretMismatch() !== 0)) return;
    if ($br('Z_04:3593', ram[ObjX] !== ram[ObjX + x])) return;
    let y = 0x00;
    let a = (ram[ObjY] + 0x03 - ram[ObjY + x]) & 0xff;
    if (!$br('Z_04:3604', !(a & 0x80))) {
      y++;
      a = ((a ^ 0xff) + 0x01) & 0xff;
    }
    // @CheckDistance
    if ($br('Z_04:3615', a >= 0x11)) return;
    a = ram[ObjInputDir] & 0x0c;
    if ($br('Z_04:3620', a === 0)) return;
    $pxa('Z_04:3624', label('RockPushDirections').addr, y);
    if ($br('Z_04:3625', a !== table(bus.rom, 'RockPushDirections').byte(y))) return;
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
  $pxa('Z_04:3659', ObjGridOffset, x);
  const g = ram[ObjGridOffset + x];
  if (!$br('Z_04:3661', g === 0x10) && $br('Z_04:3663', g !== 0xf0)) return;

  // Flag the room visited.
  const savedRoom = ram[RoomId]; // PHA
  $pxa('Z_04:3668', TileObjRoomId, x);
  ram[RoomId] = ram[TileObjRoomId + x];
  MarkRoomVisited();
  ram[RoomId] = savedRoom; // PLA

  let tile = 0xc8; // rock
  $pxa('Z_04:3676', ObjType, x);
  const t = ram[ObjType + x];
  if (!$br('Z_04:3678', t === 0x62)) {
    tile = 0xbc; // gravestone
    if (!$br('Z_04:3683', t === 0x65)) tile = 0xc0; // armos (unverified code 10EC9)
  }
  // @ReplaceTiles
  ram[ReturnToBank4]++;
  ChangeTileObjTiles(tile, x);
  ram[0x00] = 0x70; // stairs tile
  $pxa('Z_04:3700', TileObjRoomId, x);
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
  if ($br('Z_04:3720', IsQuestSecretMismatch() !== 0)) return;
  let y = 0x10;
  $pxa('Z_04:3725', ObjState, y);
  if (!$br('Z_04:3727', ram[ObjState + y] === 0x13)) {
    y++;
    $pxa('Z_04:3729', ObjState, y);
    if ($br('Z_04:3731', ram[ObjState + y] !== 0x13)) return;
  }
  // @FoundBomb
  ram[0x00] = y;
  if ($br('Z_04:3739', CheckTileObjWeaponCollision(x, y) === 0)) return;
  RevealAndFlagSecretTileObj(0x24, x); // black tile
}

/** UpdateTree (Z_04). X = object slot: a standing fire about to go out burns it. */
export function UpdateTree(x) {
  // UpdateTree (Z_04)
  if ($br('Z_04:3750', IsQuestSecretMismatch() !== 0)) return; // L10F3E_Exit
  let y = 0x10;
  $pxa('Z_04:3755', ObjState, y);
  if (!$br('Z_04:3757', ram[ObjState + y] === 0x22)) {
    y++;
    $pxa('Z_04:3759', ObjState, y);
    if ($br('Z_04:3761', ram[ObjState + y] !== 0x22)) return;
  }
  // @FoundFire
  ram[0x00] = y;
  $pxa('Z_04:3768', ObjTimer, y);
  if ($br('Z_04:3770', ram[ObjTimer + y] >= 0x02)) return;
  if ($br('Z_04:3774', CheckTileObjWeaponCollision(x, y) === 0)) return;
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
  $pxa('Z_04:3808', ObjX, y);
  ram[0x04] = (ram[ObjX + y] + 0x08) & 0xff;
  $pxa('Z_04:3812', ObjY, y);
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
  if (!$br('Z_04:3840', q === 0)) {
    $pxa('Z_04:3844', label('SecretQuestNumbers').addr, q);
    const a = table(bus.rom, 'SecretQuestNumbers').byte(q);
    $pxa('Z_04:3849', QuestNumbers, ram[CurSaveSlot]);
    if (!$br('Z_04:3850', a === ram[QuestNumbers + ram[CurSaveSlot]])) c = 1;
  }
  cpu.c = c;
  return c;
}

/** UpdateDock (Z_04). X = dock slot: the raft goes up or down between the dock and the next room. */
export function UpdateDock(x) {
  // UpdateDock (Z_04)
  if ($br('Z_04:3866', ram[InvRaft] === 0)) return;
  if (!$br('Z_04:3868', ram[ObjState + x] !== 0)) {
    // State 0
    const dockX = $br('Z_04:3878', ram[RoomId] === 0x55) ? 0x80 : 0x60;
    if ($br('Z_04:3883', dockX !== ram[ObjX])) return;
    ram[ObjX + x] = dockX;
    let y = 0x01;
    const a = ram[ObjY];
    if (!$br('Z_04:3893', a === 0x3d)) {
      y++;
      if ($br('Z_04:3899', a !== 0x7d)) return;
    }
    // @SetState
    ram[ObjState + x] = y;
    ram[ObjY + x] = (a + 0x06) & 0xff;
    PlaySecretFoundTune();
    ram[ObjState] = 0x40;
    $pxa('Z_04:3915', label('RaftDirections').addr - 1, y);
    ram[ObjDir] = table(bus.rom, 'RaftDirections').byte(y - 1);
    return;
  }

  // @HandleOtherStates
  let reset = false;
  if (!$br('Z_04:3925', ram[ObjState + x] - 1 === 0)) {
    // State 2: up.
    ram[ObjY + x]--;
    ram[ObjY]--;
    if (!$br('Z_04:3935', ram[ObjY] !== 0x3d)) {
      GoToNextModeFromPlay(); // TXA/PHA ... PLA/TAX
      reset = true;
    }
  } else {
    // @State1: down.
    ram[ObjY + x]++;
    ram[ObjY]++;
    if (!$br('Z_04:3952', ram[ObjY] !== 0x7f)) {
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
  if ($br('Z_05:1847', a === 0x3f) || !$br('Z_05:1849', a !== 0x55)) {
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
