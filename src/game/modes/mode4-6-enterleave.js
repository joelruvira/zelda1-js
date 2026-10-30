// Modes 4 and 6: Link enters a room (or steps out of a cave/dungeon/cellar) and leaves an UW room
// through a door. InitMode_EnterRoom (common room entry for modes 4, 9, $B, $C) also lives here.
// Z_05: InitMode4, InitMode_EnterRoom, InitMode6, ResetInvObjState, GetPassedDoorType.
// Z_07: UpdateMode4and6EnterLeave, GoToNextMode*, DrawSpritesBetweenRooms, ResetPlayerState. Package P13.

import { ram, peek, word } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { switchBank } from '../../core/asm.js';
import { table } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  GameSubmode, GameMode, CurRow, RoomId, ObjDir, CandleState, FadeCycle, TriggeredDoorCmd,
  TriggeredDoorDir, LevelBlockAttrsA, LevelBlockAttrsC, LevelBlockAttrsD, LevelBlockAttrsF,
  LevelBlockAttrsByteF, UndergroundExitType, CurLevel, ObjX, ObjY, UndergroundEntranceTile,
  StairsTargetY, EffectRequest, DoorwayDir, CurOpenedDoors, ObjGridOffset, CurObjIndex,
  ObjUninitialized, ObjState, ObjStunTimer, ObjAnimCounter, ObjMetastate, ObjQSpeedFrac,
  LevelInfo_FoeCounts, ObjType, RoomObjCount, RoomObjTemplateType, ObjShoveDir, ObjShoveDistance,
  Tune1Request, LadderSlot, InvClock, ObjInputDir, FrameCounter, SongRequest,
} from '../../core/vars.js';
import { HideAllSprites, ClearRam0300UpTo } from '../boot.js';
import { GoToNextMode } from './dispatch.js';
import { IsDarkRoom_Bank5 } from '../world/layout.js';
import { CopyNextRowToTransferBuf } from '../world/tilemap.js';
import { CalcNextRoomByDir } from '../world/nextroom.js';
import { FindDoorTypeByDoorBit } from '../world/doors.js';
import { SaveKillCount } from '../world/roomflags.js';
import { Negate, GetOppositeDir } from '../movement/math.js';
import { SetupObjRoomBounds } from '../movement/bounds.js';
import { ResetShoveInfo } from '../movement/shove.js';
import { MoveObject } from '../movement/walker.js';
import { AnimateWorldFading } from '../ppu/fade.js';
import { ModifyObjCountByHistoryOW, ModifyObjCountByHistoryUW } from '../objects/killcounts.js';
import { AssignObjSpawnPositions } from '../objects/spawnpos.js';
import { SetupTileObjectOW } from '../worldobj/tileobjects.js';
import {
  UpdatePlayerPositionMarker, UpdateTriforcePositionMarker, DrawStatusBarItemsAndEnsureItemSelected,
} from '../hud/statusbar.js';
import { InitLinkSpeed } from '../link/move.js';
import { DrawLinkBetweenRooms, Link_EndMoveAndAnimateBetweenRooms } from '../link/anim.js';
import { WriteBlankPrioritySprites } from '../draw/sprites.js';
import {
  RunCrossRoomTasksAndBeginUpdateMode, RunCrossRoomTasksAndBeginUpdateMode_EnterPlayModes,
} from './crossroom.js';
import { Link_EndMoveAndAnimateInRoom } from './mode5-play.js';
import { AnimateAndDrawLinkBehindBackground } from './mode10-stairs.js';

// ------------------------------------------------------------------ mode 4 init

export function InitMode4() {
  // InitMode4 (Z_05)
  const x = ram[GameSubmode];
  if ($br('Z_05:1452', x === 0)) return InitMode_EnterRoom();
  if (!$br('Z_05:1454', x !== 1)) {
    // Submode 1: copies the whole play area to NT 0, one row a frame (only when CurRow >= 0, set
    // by mode 7 after scrolling from a dark room).
    if (!$br('Z_05:1473', (ram[CurRow] & 0x80) !== 0)) {
      if ($br('Z_05:1475', !CopyNextRowToTransferBuf())) return; // @Exit: not the last row yet
    }
    ram[GameSubmode]++;
    return;
  }
  if (!$br('Z_05:1484', x !== 2)) {
    // Submode 2.
    if ($br('Z_05:1489', IsDarkRoom_Bank5(ram[RoomId]) !== 0)) return InitMode4_GoToSub0(); // dark: nothing else to do
    // Light room: brighten it if we came from a dark one. Previous room = RoomId - offset of ObjDir.
    let a = CalcNextRoomByDir(ram[ObjDir]);
    a = (a - ram[RoomId]) & 0xff; // SEC / SBC RoomId
    a = Negate(a);
    a = (a + ram[RoomId]) & 0xff; // CLC / ADC RoomId
    if ($br('Z_05:1505', IsDarkRoom_Bank5(a) === 0)) return InitMode4_GoToSub0(); // previous room was light
    if ($br('Z_05:1509', ram[CandleState] !== 0)) return InitMode4_GoToSub0(); // it was lit up
    return SetFadeCycleAndAdvanceSubmode(0xc0); // fade-to-light (reverse of cycle $40)
  }
  return InitMode4_Sub3();
}

/** SetFadeCycleAndAdvanceSubmode (Z_05). A = start index of the fade cycle. */
export function SetFadeCycleAndAdvanceSubmode(a) {
  // SetFadeCycleAndAdvanceSubmode (Z_05)
  ram[FadeCycle] = a;
  ram[GameSubmode]++;
}

/** InitMode4_Sub3 (Z_05, part of InitMode4) */
function InitMode4_Sub3() {
  if ($br('Z_05:1524', AnimateWorldFading() !== 0)) return; // not done animating
  return InitMode4_GoToSub0();
}

/** InitMode4_GoToSub0 (Z_05, part of InitMode4) */
function InitMode4_GoToSub0() {
  ram[GameSubmode] = 0x00;
  ram[CandleState] = 0x00;
}

// ------------------------------------------------------------------ entering a room

/**
 * InitMode_EnterRoom (Z_05): clears intraroom data, sets up Link to walk into the room, decodes and
 * lays out the room's objects and switches from initializing the mode to updating it (modes 4, 9,
 * $B, $C). Falls into DrawLinkBetweenRooms.
 */
export function InitMode_EnterRoom() {
  // InitMode_EnterRoom (Z_05)
  DrawSpritesBetweenRooms();
  ResetPlayerState();
  ClearRam0300UpTo(0x05, 0x1f); // reset [0300] to [051F]
  ram[TriggeredDoorCmd] = 0x00;
  ram[TriggeredDoorDir] = 0x00;
  $pxa('Z_05:1556', LevelBlockAttrsF, ram[RoomId]);
  ram[LevelBlockAttrsByteF] = peek(LevelBlockAttrsF + ram[RoomId]);
  ResetInvObjState();

  let a;
  if (!$br('Z_05:1569', ram[UndergroundExitType] === 0)) {
    // Enter method 1: out of a cave, dungeon or cellar.
    if (!$br('Z_05:1571', ram[CurLevel] !== 0)) {
      const y = ram[RoomId];
      $pxa('Z_05:1577', LevelBlockAttrsA, y);
      ram[ObjX] = peek(LevelBlockAttrsA + y) & 0xf0; // X where Link comes out
      // Square row (from row 1) * $10 + $4D ($50 - 3). The ASLs leave C = 0.
      $pxa('Z_05:1580', LevelBlockAttrsF, y);
      a = (((peek(LevelBlockAttrsF + y) & 0x07) << 4) + 0x4d) & 0xff;
      ram[ObjY] = a;
      if (!$br('Z_05:1596', ram[UndergroundEntranceTile] !== 0x24)) {
        // Method 1-a (cave entrance, not stairs): walk out from $10 pixels below.
        ram[StairsTargetY] = a;
        ram[ObjY] = (a + 0x10) & 0xff;
        ram[EffectRequest] = 0x08; // walking sound effect
      }
    }
    ram[ObjDir] = 0x04; // Link faces down coming out
    a = 0x00;
    ram[DoorwayDir] = a;
  } else {
    // @Method2: room to room.
    ram[DoorwayDir] = ram[ObjDir];
    a = GetOppositeDir(ram[ObjDir]).a & ram[CurOpenedDoors];
    ram[TriggeredDoorDir] = a; // entering through an opened door: "close" command
    if (!$br('Z_05:1629', a === 0)) {
      a = 0x02;
      ram[TriggeredDoorCmd] = a;
    }
    a = ram[CurLevel];
    if (!$br('Z_05:1635', a === 0)) {
      // UW: right -> X = 0 (left edge); left -> X = $F0 (right edge).
      let y = 0x00;
      if (!$br('Z_05:1642', (ram[ObjDir] & 0x03) === 0)) {
        if (!$br('Z_05:1644', (ram[ObjDir] & 0x01) !== 0)) y = 0xf0;
        ram[ObjX] = y;
      }
      // @ChooseWalkDistance: "open", "key" and "key 2" doors are shorter walks (indexes 0/1).
      const r = GetPassedDoorType();
      y = r.y;
      const t = r.a & 0x07;
      if (!$br('Z_05:1663', t === 0) && !$br('Z_05:1665', t === 0x05) && !$br('Z_05:1667', t === 0x06)) y += 2;
      $pxa('Z_05:1671', table(bus.rom, 'EnteringRoomRelativePositions').addr, y);
      a = table(bus.rom, 'EnteringRoomRelativePositions').byte(y);
    }
  }

  // @PlaceObjects
  ram[ObjGridOffset] = a;
  SetupObjRoomBounds();
  // Begin mode 5 updating objects at slot $B; reset common state of objects $B to 1.
  let x = 0x0b;
  ram[CurObjIndex] = x;
  do {
    ram[ObjUninitialized + x]--;
    a = ResetShoveInfo(x);
    ram[ObjState + x] = a;
    ram[ObjDir + x] = a;
    ram[ObjStunTimer + x] = a;
    ram[ObjAnimCounter + x]++;
    ram[ObjMetastate + x]++; // objects start in metastate 1 (first cloud state)
    ram[ObjQSpeedFrac + x] = 0x20; // default speed
    x--;
  } while ($br('Z_05:1694', x !== 0));

  // Monster list ID in [02]: low 6 bits from attributes C, bit 6 from the high bit of attributes D.
  let y = ram[RoomId];
  $pxa('Z_05:1698', LevelBlockAttrsC, y);
  const attrC = peek(LevelBlockAttrsC + y); // PHA
  ram[0x02] = attrC & 0x3f;
  $pxa('Z_05:1702', LevelBlockAttrsD, y);
  if (!$br('Z_05:1704', (peek(LevelBlockAttrsD + y) & 0x80) === 0)) ram[0x02] = (ram[0x02] + 0x40) & 0xff;
  // Index of the monster count: high 2 bits of attributes C (AND #$C0 / CLC / ROL x3).
  y = (attrC & 0xc0) >> 6;
  $pxa('Z_05:1721', LevelInfo_FoeCounts, y);
  a = peek(LevelInfo_FoeCounts + y);
  // Count 1 for object list IDs in [$32, $62): bosses and other non-recurring objects.
  y = ram[0x02];
  if (!$br('Z_05:1727', y >= 0x62) && !$br('Z_05:1729', y < 0x32)) a = 0x01;
  ram[0x03] = a;

  // Modify the number of objects by the room history.
  if (!$br('Z_05:1736', ram[CurLevel] !== 0)) {
    ModifyObjCountByHistoryOW();
  } else {
    ModifyObjCountByHistoryUW();
    if (!$br('Z_05:1746', ram[GameMode] !== 0x09)) {
      // Mode 9 (cellars): no objects.
      ram[0x02] = 0x00;
      ram[0x03] = 0x00;
    }
  }

  // @StoreObjCount
  a = ram[0x03];
  ram[RoomObjCount] = a;
  if (!$br('Z_05:1757', a === 0) && !$br('Z_05:1759', ram[0x02] === 0)) {
    if ($br('Z_05:1764', ram[0x02] >= 0x62)) {
      // @PlaceList: [04:05] = ObjListAddrs[ID - $62]; copy up to the object count.
      y = ((ram[0x02] - 0x62) << 1) & 0xff;
      const addrs = table(bus.rom, 'ObjListAddrs');
      $pxa('Z_05:1791', addrs.addr, y);
      ram[0x04] = addrs.byte(y);
      y = (y + 1) & 0xff;
      $pxa('Z_05:1794', addrs.addr, y);
      ram[0x05] = addrs.byte(y);
      y = 0;
      do {
        $pxa('Z_05:1800', ram[0x04], y);
        ram[ObjType + 1 + y] = read((word(0x04) + y) & 0xffff); // LDA ($04),Y (bank 5)
        y = (y + 1) & 0xff;
      } while ($br('Z_05:1804', y !== ram[0x03]));
    } else {
      // A repeated object: ObjType[1..count] = template ID.
      x = 0;
      do {
        ram[ObjType + 1 + x] = ram[0x02];
        x++;
        ram[0x03]--;
      } while ($br('Z_05:1777', ram[0x03] !== 0));
    }
    // @StoreObjTemplate
    ram[RoomObjTemplateType] = ram[ObjType + 1];
  }

  // @SkipObjects
  AssignObjSpawnPositions();
  if (!$br('Z_05:1814', ram[CurLevel] !== 0)) SetupTileObjectOW();
  UpdatePlayerPositionMarker();
  ram[ObjStunTimer] = 0x00;
  ram[ObjShoveDir] = 0x00;
  ram[ObjShoveDistance] = 0x00;
  ram[ObjAnimCounter] = 0x04;
  InitLinkSpeed();
  RunCrossRoomTasksAndBeginUpdateMode_EnterPlayModes();
  return DrawLinkBetweenRooms(); // falls through
}

// ------------------------------------------------------------------ mode 6 init

export function InitMode6() {
  // InitMode6 (Z_05)
  ResetPlayerState();
  DrawSpritesBetweenRooms();
  if (!$br('Z_05:6470', ram[CurLevel] === 0)) WriteBlankPrioritySprites(); // UW: clear the sprites above all the rest
  Link_EndMoveAndAnimateBetweenRooms();
  SaveKillCount();
  let y = 0x02; // @SetWalkDistance0
  if (!$br('Z_05:6476', ram[CurLevel] === 0)) {
    const r = GetPassedDoorType(); // door type in the direction we're facing
    if (!$br('Z_05:6484', (r.a & 0x07) !== 0x02)) ram[Tune1Request] = 0x04; // false wall: "found secret" tune
    const t = r.a & 0x07;
    // "open", "key" or "shutter" doors: Link is at the edge (index 2, position 0); otherwise he
    // walks $28 (or -$28) to the edge.
    if (!$br('Z_05:6505', t < 0x02) && $br('Z_05:6507', t < 0x05)) y = r.y;
  }
  $pxa('Z_05:6512', table(bus.rom, 'LeavingRoomRelativePositions').addr, y);
  ram[ObjGridOffset] = table(bus.rom, 'LeavingRoomRelativePositions').byte(y);
  RunCrossRoomTasksAndBeginUpdateMode();
  return ResetInvObjState(); // falls through
}

/** ResetInvObjState (Z_05): LadderSlot = 0 and the ObjState of the weapon slots $D-$12. @returns A = 0 */
export function ResetInvObjState() {
  // ResetInvObjState (Z_05)
  const a = 0x00;
  ram[LadderSlot] = a;
  for (let y = 5; ;) { ram[ObjState + 13 + y] = a; y--; if (!$br('Z_05:6526', y >= 0)) break; }
  return a;
}

/**
 * GetPassedDoorType (Z_05): door type in Link's direction (mode 6) or the opposite one (other modes).
 * Uses [02] and [0F].
 * @returns {{a:number, y:number}} A = door type; Y = 1 if Link faces right or down, else 0
 */
export function GetPassedDoorType() {
  // GetPassedDoorType (Z_05)
  let y = !$br('Z_05:6542', (ram[ObjDir] & 0x05) === 0) ? 1 : 0;
  ram[0x0f] = y;
  let a = ram[ObjDir];
  if (!$br('Z_05:6552', ram[GameMode] === 0x06)) a = GetOppositeDir(a).a;
  ram[0x02] = a;
  a = FindDoorTypeByDoorBit();
  y = ram[0x0f];
  return { a, y };
}

// ------------------------------------------------------------------ modes 4 and 6 update (Z_07)

export function UpdateMode4and6EnterLeave() {
  // UpdateMode4and6EnterLeave (Z_07)
  if ($br('Z_07:1748', ram[UndergroundExitType] !== 0)) return StepOutside();
  // Room to room (entering in mode 4, method 2; leaving in mode 6): stop at 0, 8 or -8.
  const g = ram[ObjGridOffset];
  if ($br('Z_07:1754', g === 0) || $br('Z_07:1756', g === 0x08) || $br('Z_07:1758', g === 0xf8)) return GoToNextModeResetGridOffset();
  const d = ram[ObjDir];
  ram[ObjInputDir] = d;
  ram[0x0f] = d; // direction for MoveObject
  MoveObject(0x00);
  return Link_EndMoveAndAnimateInRoom();
}

/** StepOutside (Z_07, part of UpdateMode4and6EnterLeave): out of underground or a cellar. */
function StepOutside() {
  if ($br('Z_07:1786', ram[CurLevel] !== 0)) return GoToNextModePlayLevelSong(); // UW
  if ($br('Z_07:1792', ram[UndergroundEntranceTile] !== 0x24)) return GoToNextModePlayLevelSong(); // stairs
  // Entering the OW room from a cave or dungeon: walk up one pixel every 4 frames.
  switchBank(5);
  AnimateAndDrawLinkBehindBackground();
  if ($br('Z_07:1802', (ram[FrameCounter] & 0x03) !== 0)) return; // @Exit
  ram[ObjY]--;
  if ($br('Z_07:1806', ram[ObjY] === ram[StairsTargetY])) return GoToNextModePlayLevelSong();
}

export function GoToNextModePlayLevelSong() {
  // GoToNextModePlayLevelSong (Z_07)
  const y = ram[CurLevel];
  $pxa('Z_07:1772', table(bus.rom, 'LevelSongIds').addr, y);
  ram[SongRequest] = table(bus.rom, 'LevelSongIds').byte(y); // the level's song
  return GoToNextModeResetGridOffset(); // falls through
}

export function GoToNextModeResetGridOffset() {
  // GoToNextModeResetGridOffset (Z_07)
  ram[ObjGridOffset] = GoToNextMode();
}

// ------------------------------------------------------------------ shared helpers (Z_07)

/** DrawSpritesBetweenRooms (Z_07): hides sprites, position markers, Link and the status bar items. */
export function DrawSpritesBetweenRooms() {
  // DrawSpritesBetweenRooms (Z_07)
  HideAllSprites();
  UpdatePlayerPositionMarker();
  UpdateTriforcePositionMarker();
  switchBank(5);
  DrawLinkBetweenRooms();
  return DrawStatusBarItemsAndEnsureItemSelected();
}

/** ResetPlayerState (Z_07): ObjState[0] = 0, InvClock = 0. @returns A = 0 */
export function ResetPlayerState() {
  // ResetPlayerState (Z_07)
  ram[ObjState] = 0x00;
  ram[InvClock] = 0x00;
  return 0x00;
}
