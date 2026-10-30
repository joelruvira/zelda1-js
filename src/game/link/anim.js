// P08 link — end of Link's movement each frame: ladder set-up, warps, animation and drawing
// (shield tiles). Z_07: Link_EndMoveAndAnimate* / Link_EndMoveAndDraw*, AnimateLinkBase,
// AnimateLinkObjState. Z_05: DrawLinkBetweenRooms.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
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
  $br('Z_07:3204', true);
  return Link_EndMoveAndAnimate();
}

export function Link_EndMoveAndAnimateBetweenRooms() {
  // Link_EndMoveAndAnimateBetweenRooms (Z_07)
  if ($br('Z_07:3208', ram[CurLevel] !== 0)) return; // in UW, return
  return Link_EndMoveAndAnimate();
}

export function Link_EndMoveAndAnimate() {
  // Link_EndMoveAndAnimate (Z_07): switches bank 5 in mode 5
  if ($br('Z_07:3215', ram[WhirlwindTeleportingState] !== 0)) return; // teleporting by whirlwind

  // The branches all end at @CheckWarps; `ladder` = reach @CheckLadderRoom.
  let ladder = false;
  const mode = ram[GameMode];
  if (!$br('Z_07:3221', mode === 0x06) && !$br('Z_07:3223', mode < 0x05)) {
    const go = ram[ObjGridOffset];
    if ($br('Z_07:3228', go === 0)) {
      ladder = true;
    } else if ($br('Z_07:3230', (go & 0x07) === 0)) {
      // @TruncGridOffset: stepped a whole tile.
      ram[ObjGridOffset] = 0x00;
      if (!$br('Z_07:3242', ram[GameMode] !== 0x05)) {
        ram[UndergroundExitType] = 0x00; // reset the subroom indicator
        ladder = true;
      }
    }
  }
  if (ladder) CheckLadderRoomAndSetUpLadder();

  // @CheckWarps
  let x = 0x00;
  if (!$br('Z_07:3349', ram[GameMode] !== 0x05)) {
    const tile = ram[ObjCollidedTile]; // PHA
    switchBank(5);
    CheckWarps();
    x = 0x00;
    ram[ObjCollidedTile] = tile; // PLA
  }

  // @Animate
  let y = AnimateLinkBase(x);
  if ($br('Z_07:3364', ram[GameMode] === 0x09) || !$br('Z_07:3366', ram[CurLevel] !== 0)) {
    // @ShiftDown2Pixels: in mode 9 and in OW, draw Link 2 pixels down.
    ram[0x01]++;
    ram[0x01]++;
  }
  // @ChangeLookForState: attacking or using an item uses the "attack/use item" frames.
  const s = ram[ObjState] & 0x30;
  if ($br('Z_07:3380', s === 0x10) || !$br('Z_07:3382', s !== 0x20)) y = (y + 0x04) & 0xff;
  // @Draw
  DrawObjectWithAnim(y, x, 0x00);

  let pushed;
  if (!$br('Z_07:3397', ram[InvMagicShield] !== 0)) {
    // No magic shield.
    if ($br('Z_07:3402', ram[ObjDir] !== 0x04)) return; // not facing down
    x = 0x01;
    $pxa('Z_07:3404', Sprites + 72, x);
    const tile = ram[Sprites + 72 + x];
    if ($br('Z_07:3406', tile >= 0x0b)) return; // already has a shield (shieldless tiles are 8 and $A)
    pushed = tile;
    ram[Sprites + 72 + x] = (tile + 0x50) & 0xff; // @ApplyShieldSprite: 8 -> $58, $A -> $5A
  } else {
    // @HandleMagicShield
    x = !$br('Z_07:3417', (ram[ObjDir] & 0x01) === 0) ? 0x05 : 0x01; // facing right: right tile
    $pxa('Z_07:3421', Sprites + 72, x);
    const tile = ram[Sprites + 72 + x];
    pushed = tile;
    const heads = table(bus.rom, 'LinkHeadTiles');
    for (let yy = 4; ;) {
      // @LoopHeadTile
      yy--;
      if ($br('Z_07:3427', yy < 0)) break; // @FixHFlip
      $pxa('Z_07:3428', heads.addr, yy);
      if ($br('Z_07:3429', tile !== heads.byte(yy))) continue;
      const shields = table(bus.rom, 'LinkHeadMagicShieldTiles');
      $pxa('Z_07:3430', shields.addr, yy);
      ram[Sprites + 72 + x] = shields.byte(yy); // @ApplyShieldSprite
      break;
    }
  }
  // @FixHFlip: only one frame of the downward shield tile: make sure it's not flipped.
  if ($br('Z_07:3439', pushed !== 0x0a)) return;
  $pxa('Z_07:3443', Sprites + 73, x);
  ram[Sprites + 73 + x] &= 0x0f;
}

// @CheckLadderRoom .. @SetUpLadder (inside Link_EndMoveAndAnimate): wield the ladder in front of water.
function CheckLadderRoomAndSetUpLadder() {
  if ($br('Z_07:3254', ram[GameMode] !== 0x05)) return;
  if (!$br('Z_07:3258', ram[CurLevel] !== 0)) {
    // In OW, only in the ladder rooms.
    const rooms = table(bus.rom, 'LadderRoomsOW');
    let found = false;
    for (let y = 5; ;) {
      // @LoopLadderRoom
      $pxa('Z_07:3263', rooms.addr, y);
      if ($br('Z_07:3264', ram[RoomId] === rooms.byte(y))) { found = true; break; }
      y--;
      if (!$br('Z_07:3266', y >= 0)) break;
    }
    if (!found) { $br('Z_07:3267', true); return; } // BMI @CheckWarps (always)
  }
  // @CheckLadder
  if ($br('Z_07:3272', ram[DoorwayDir] !== 0)) return;
  if ($br('Z_07:3274', ram[InvLadder] === 0)) return;
  if ($br('Z_07:3280', (ram[ObjState] & 0xc0) === 0x40)) return; // halted
  if ($br('Z_07:3282', ram[LadderSlot] !== 0)) return; // already using it
  ram[0x0f] = ram[ObjDir];
  const tile = GetCollidingTileMoving(0);
  if (!$br('Z_07:3294', ram[CurLevel] === 0)) {
    if (!$br('Z_07:3296', tile === 0xf4)) { $br('Z_07:3297', true); return; } // BNE @CheckWarps (always)
  } else if ($br('Z_07:3301', tile < 0x8d) || $br('Z_07:3303', tile >= 0x99)) {
    return; // not water
  }
  // @SetUpLadder
  if ($br('Z_07:3310', !FindEmptyMonsterSlotFound())) return;
  const a = ram[ObjInputDir];
  if ($br('Z_07:3312', a === 0)) return;
  const x = ram[EmptyMonsterSlot];
  if ($br('Z_07:3315', a !== ram[ObjDir])) return;
  ram[LadderSlot] = x;
  ram[(ObjDir + x) & 0xff] = a;
  const { y } = GetOppositeDir(a);
  const offX = table(bus.rom, 'LinkToLadderOffsetsX');
  $pxa('Z_07:3327', offX.addr, y);
  ram[(ObjX + x) & 0xff] = (ram[ObjX] + offX.byte(y)) & 0xff;
  const offY = table(bus.rom, 'LinkToLadderOffsetsY');
  $pxa('Z_07:3331', offY.addr, y);
  ram[(ObjY + x) & 0xff] = (ram[ObjY] + offY.byte(y)) & 0xff;
  ram[ObjType + x] = 0x5f; // ladder
  ram[ObjInvincibilityTimer + x] = ResetShoveInfo(x);
  ram[(ObjState + x) & 0xff] = 0x01;
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
  if ($br('Z_07:5058', ram[ObjState] !== 0)) return AnimateObjectWalking(x);
  const mode = ram[GameMode];
  if ($br('Z_07:5061', mode === 0x04) || $br('Z_07:5063', mode === 0x10)) return AnimateObjectWalking(x);
  if ($br('Z_07:5065', ram[ObjInputDir] === 0)) return SetUpWalkingSprites(x); // no input: don't animate
  return AnimateObjectWalking(x); // falls through
}

/** Advance Link's attack/item-use state when the walking animation counter expires. */
export function AnimateLinkObjState() {
  // AnimateLinkObjState (Z_07)
  const major = ram[ObjState] & 0x30;
  let s10 = false;
  if ((s10 = !$br('Z_07:5190', major !== 0x10)) || !$br('Z_07:5202', major !== 0x20)) {
    if ($br(s10 ? 'Z_07:5193' : 'Z_07:5205', (ram[ObjState] & 0x0f) !== 0)) {
      ram[ObjState] |= 0x30; // @CombineStateWith30
    } else {
      if (s10) $br('Z_07:5194', true); // BEQ @IncState (always)
      ram[ObjState]++; // @IncState
    }
    // @SetMovementFrame1: switched to 0 (legs apart) right after this.
    ram[ObjAnimFrame] = 0x01;
    return 0x01;
  }
  if (!$br('Z_07:5231', major !== 0x30)) {
    // Make Link idle, except for halting.
    ram[ObjState] &= 0xc0;
  }
}

export function DrawLinkBetweenRooms() {
  // DrawLinkBetweenRooms (Z_05)
  ResetCurSpriteIndex();
  const mode = ram[GameMode];
  if (!$br('Z_05:1831', mode === 0x0b) && !$br('Z_05:1833', mode === 0x0c)) Link_EndMoveAndAnimateBetweenRooms(); // not in caves
  if (!$br('Z_05:1837', ram[UndergroundExitType] === 0)) PutLinkBehindBackground(); // coming out of a cave or dungeon
}
