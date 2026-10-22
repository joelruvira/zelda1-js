// P08 link — end of Link's movement each frame: ladder set-up, warps, animation and drawing
// (shield tiles). Z_07: Link_EndMoveAndAnimate* / Link_EndMoveAndDraw*, AnimateLinkBase,
// AnimateLinkObjState. Z_05: DrawLinkBetweenRooms.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { switchBank } from '../../core/asm.js';
import {
  WhirlwindTeleportingState, GameMode, ObjGridOffset, UndergroundExitType, CurLevel, RoomId,
  DoorwayDir, InvLadder, ObjState, LadderSlot, ObjDir, ObjInputDir, EmptyMonsterSlot, ObjX, ObjY,
  ObjType, ObjInvincibilityTimer, ObjCollidedTile, InvMagicShield, Sprites, ObjAnimCounter,
  ObjAnimFrame,
} from '../../core/vars.js';
import { GetOppositeDir } from '../movement/math.js';
import { GetCollidingTileMoving } from '../movement/tiles.js';
import { ResetShoveInfo } from '../movement/shove.js';
import { FindEmptyMonsterSlot } from '../objects/slots.js';
import { CheckWarps } from '../world/warps.js';
import { PutLinkBehindBackground } from '../modes/mode10-stairs.js';
import { AnimateObjectWalking, SetUpWalkingSprites, DrawObjectWithAnim } from '../draw/anim.js';
import { ResetCurSpriteIndex } from '../draw/sprites.js';

export function Link_EndMoveAndAnimate_Bank4() {
  // Link_EndMoveAndAnimate_Bank4 (Z_07)
  Link_EndMoveAndAnimate();
  return switchBank(4);
}

export function Link_EndMoveAndDraw_Bank1() {
  // Link_EndMoveAndDraw_Bank1 (Z_07)
  Link_EndMoveAndDraw();
  return switchBank(1);
}

export function Link_EndMoveAndAnimate_Bank1() {
  // Link_EndMoveAndAnimate_Bank1 (Z_07)
  Link_EndMoveAndAnimate();
  return switchBank(1);
}

export function Link_EndMoveAndDraw_Bank4() {
  // Link_EndMoveAndDraw_Bank4 (Z_07)
  Link_EndMoveAndDraw();
  return switchBank(4);
}

/** Draw Link without animating by keeping the animation counter fixed. */
export function Link_EndMoveAndDraw() {
  // Link_EndMoveAndDraw (Z_07): BNE always taken -> Link_EndMoveAndAnimate (skips the UW check)
  ram[ObjAnimCounter] = 0x06;
  return Link_EndMoveAndAnimate();
}

export function Link_EndMoveAndAnimateBetweenRooms() {
  // Link_EndMoveAndAnimateBetweenRooms (Z_07)
  if (ram[CurLevel] !== 0) return; // in UW, return
  return Link_EndMoveAndAnimate();
}

export function Link_EndMoveAndAnimate() {
  // Link_EndMoveAndAnimate (Z_07): switches bank 5 in mode 5
  if (ram[WhirlwindTeleportingState] !== 0) return; // teleporting by whirlwind

  // The branches all end at @CheckWarps; `ladder` = reach @CheckLadderRoom.
  let ladder = false;
  const mode = ram[GameMode];
  if (mode !== 0x06 && mode >= 0x05) {
    const go = ram[ObjGridOffset];
    if (go === 0) {
      ladder = true;
    } else if ((go & 0x07) === 0) {
      // @TruncGridOffset: stepped a whole tile.
      ram[ObjGridOffset] = 0x00;
      if (ram[GameMode] === 0x05) {
        ram[UndergroundExitType] = 0x00; // reset the subroom indicator
        ladder = true;
      }
    }
  }
  if (ladder) CheckLadderRoomAndSetUpLadder();

  // @CheckWarps
  let x = 0x00;
  if (ram[GameMode] === 0x05) {
    const tile = ram[ObjCollidedTile]; // PHA
    switchBank(5);
    CheckWarps();
    x = 0x00;
    ram[ObjCollidedTile] = tile; // PLA
  }

  // @Animate
  let y = AnimateLinkBase(x);
  if (ram[GameMode] === 0x09 || ram[CurLevel] === 0) {
    // @ShiftDown2Pixels: in mode 9 and in OW, draw Link 2 pixels down.
    ram[0x01]++;
    ram[0x01]++;
  }
  // @ChangeLookForState: attacking or using an item uses the "attack/use item" frames.
  const s = ram[ObjState] & 0x30;
  if (s === 0x10 || s === 0x20) y = (y + 0x04) & 0xff;
  // @Draw
  DrawObjectWithAnim(y, x, 0x00);

  let pushed;
  if (ram[InvMagicShield] === 0) {
    // No magic shield.
    if (ram[ObjDir] !== 0x04) return; // not facing down
    x = 0x01;
    const tile = ram[Sprites + 72 + x];
    if (tile >= 0x0b) return; // already has a shield (shieldless tiles are 8 and $A)
    pushed = tile;
    ram[Sprites + 72 + x] = (tile + 0x50) & 0xff; // @ApplyShieldSprite: 8 -> $58, $A -> $5A
  } else {
    // @HandleMagicShield
    x = ram[ObjDir] & 0x01 ? 0x05 : 0x01; // facing right: right tile
    const tile = ram[Sprites + 72 + x];
    pushed = tile;
    const heads = table(bus.rom, 'LinkHeadTiles');
    for (let yy = 3; yy >= 0; yy--) {
      if (tile === heads.byte(yy)) {
        ram[Sprites + 72 + x] = table(bus.rom, 'LinkHeadMagicShieldTiles').byte(yy); // @ApplyShieldSprite
        break;
      }
    }
  }
  // @FixHFlip: only one frame of the downward shield tile: make sure it's not flipped.
  if (pushed !== 0x0a) return;
  ram[Sprites + 73 + x] &= 0x0f;
}

// @CheckLadderRoom .. @SetUpLadder (inside Link_EndMoveAndAnimate): wield the ladder in front of water.
function CheckLadderRoomAndSetUpLadder() {
  if (ram[GameMode] !== 0x05) return;
  if (ram[CurLevel] === 0) {
    // In OW, only in the ladder rooms.
    const rooms = table(bus.rom, 'LadderRoomsOW');
    let found = false;
    for (let y = 5; y >= 0; y--) {
      if (ram[RoomId] === rooms.byte(y)) { found = true; break; }
    }
    if (!found) return;
  }
  // @CheckLadder
  if (ram[DoorwayDir] !== 0) return;
  if (ram[InvLadder] === 0) return;
  if ((ram[ObjState] & 0xc0) === 0x40) return; // halted
  if (ram[LadderSlot] !== 0) return; // already using it
  ram[0x0f] = ram[ObjDir];
  const tile = GetCollidingTileMoving(0);
  if (ram[CurLevel] !== 0) {
    if (tile !== 0xf4) return;
  } else if (tile < 0x8d || tile >= 0x99) {
    return; // not water
  }
  // @SetUpLadder
  if (!FindEmptyMonsterSlotFound()) return;
  const a = ram[ObjInputDir];
  if (a === 0) return;
  const x = ram[EmptyMonsterSlot];
  if (a !== ram[ObjDir]) return;
  ram[LadderSlot] = x;
  ram[ObjDir + x] = a;
  const { y } = GetOppositeDir(a);
  ram[ObjX + x] = (ram[ObjX] + table(bus.rom, 'LinkToLadderOffsetsX').byte(y)) & 0xff;
  ram[ObjY + x] = (ram[ObjY] + table(bus.rom, 'LinkToLadderOffsetsY').byte(y)) & 0xff;
  ram[ObjType + x] = 0x5f; // ladder
  ram[ObjInvincibilityTimer + x] = ResetShoveInfo(x);
  ram[ObjState + x] = 0x01;
}

// FindEmptyMonsterSlot's Z flag: set (not found) when Y = 0.
function FindEmptyMonsterSlotFound() {
  const r = FindEmptyMonsterSlot();
  const y = typeof r === 'object' ? r.y : r;
  return y !== 0;
}

/**
 * X object index (0). @returns Y = animation frame; leaves [00]/[01] position, [0F] flip.
 */
export function AnimateLinkBase(x = 0) {
  // AnimateLinkBase (Z_07)
  if (ram[ObjState] !== 0) return AnimateObjectWalking(x);
  const mode = ram[GameMode];
  if (mode === 0x04 || mode === 0x10) return AnimateObjectWalking(x);
  if (ram[ObjInputDir] === 0) return SetUpWalkingSprites(x); // no input: don't animate
  return AnimateObjectWalking(x); // falls through
}

/** Advance Link's attack/item-use state when the walking animation counter expires. */
export function AnimateLinkObjState() {
  // AnimateLinkObjState (Z_07)
  const major = ram[ObjState] & 0x30;
  if (major === 0x10 || major === 0x20) {
    if ((ram[ObjState] & 0x0f) === 0) {
      ram[ObjState]++; // @IncState
    } else {
      ram[ObjState] |= 0x30; // @CombineStateWith30
    }
    // @SetMovementFrame1: switched to 0 (legs apart) right after this.
    ram[ObjAnimFrame] = 0x01;
    return 0x01;
  }
  if (major === 0x30) {
    // Make Link idle, except for halting.
    ram[ObjState] &= 0xc0;
  }
}

export function DrawLinkBetweenRooms() {
  // DrawLinkBetweenRooms (Z_05)
  ResetCurSpriteIndex();
  const mode = ram[GameMode];
  if (mode !== 0x0b && mode !== 0x0c) Link_EndMoveAndAnimateBetweenRooms(); // not in caves
  if (ram[UndergroundExitType] !== 0) PutLinkBehindBackground(); // coming out of a cave or dungeon
}
