// P20 enemyuwb — enemies/wallmaster (Z_04): the hand that comes out of the walls, crosses 7 squares
// along a path from WallmasterDirsAndAttrs* and, if it caught Link, takes him back to the level
// entrance (mode 3). X = object slot in every routine.

import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjState, ObjTimer, ObjX, ObjY, ObjDir, ObjInputDir, ObjQSpeedFrac, ObjAnimCounter, ObjGridOffset,
  ObjAnimFrame, ObjShoveDir, ObjStunTimer, InvClock, ObjCaptureTimer, GameMode, IsUpdatingMode,
  GameSubmode, RollingSpriteIndex, CurObjIndex, Sprites, Wallmaster_ObjStep, Wallmaster_ObjTilesCrossed,
} from '../../core/vars.js';
import { Obj_Shove } from '../movement/shove.js';
import { MoveObject } from '../movement/walker.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import {
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, DrawObjectNotMirrored,
  DrawObjectNotMirroredOverLink,
} from '../draw/anim.js';
import {
  Anim_SetSpriteDescriptorAttributes, HideSpritesOverLink, ShowLinkSpritesBehindHorizontalDoors,
} from '../draw/sprites.js';
import { Link_EndMoveAndAnimate_Bank4 } from '../link/anim.js';

const tbl = (name) => table(bus.rom, name);
// LDA WallmasterDirsAndAttrsLeft, Y: the four 16-byte blocks (left, right, top, bottom) are contiguous.
// ref = asm line of the indexed read (page-cross hint).
const dirsAndAttrs = (y, ref) => {
  const t = tbl('WallmasterDirsAndAttrsLeft');
  $pxa(ref, t.addr, y);
  return t.byte(y);
};

/**
 * UpdateWallmaster (Z_04). X = wallmaster. State 0 waits inside the wall (all wallmasters share
 * ObjTimer[1]) until Link stands next to a wall, then places the hand in front of him and starts
 * state 1 (L_Wallmaster_State1).
 */
export function UpdateWallmaster(x) {
  // UpdateWallmaster (Z_04)
  if (!$br('Z_04:4130', ram[ObjState + x] === 0)) return L_Wallmaster_State1(x);
  if ($br('Z_04:4140', ram[ObjTimer + 1] !== 0)) return; // @Exit
  if (!$br('Z_04:4145', ram[ObjState] !== 0x40)) return; // Link halted
  // @State0
  let a = ram[ObjX];
  if ($br('Z_04:4158', a < 0x29) || !$br('Z_04:4160', a < 0xc8)) {
    a = ram[ObjY];
    if ($br('Z_04:4164', a < 0x6d)) return;
    if ($br('Z_04:4166', a >= 0xb5)) return;
  }
  // @CheckLeftAndRight
  a = ram[ObjX];
  let y;
  if ($br('Z_04:4174', a === 0x20) || !$br('Z_04:4176', a !== 0xd0)) {
    ram[0x00] = ram[ObjY];
    ram[0x01] = ram[ObjX];
    ram[0x02] = 0x08;
    y = Wallmaster_CalcStartPosition(0x00, x, 0x20);
    ram[ObjY + x] = ram[0x04];
    $pxa('Z_04:4197', tbl('WallmasterInitialXs').addr, y);
    a = tbl('WallmasterInitialXs').byte(y);
  } else {
    // @CheckTopAndBottom
    a = ram[ObjY];
    if (!$br('Z_04:4206', a === 0x5d) && $br('Z_04:4208', a !== 0xbd)) return;
    ram[0x00] = ram[ObjX];
    ram[0x01] = ram[ObjY];
    ram[0x02] = 0x02;
    y = Wallmaster_CalcStartPosition(0x20, x, 0x5d);
    $pxa('Z_04:4225', tbl('WallmasterInitialYs').addr, y);
    ram[ObjY + x] = tbl('WallmasterInitialYs').byte(y);
    a = ram[0x04];
  }
  // @SetUpToEmerge
  ram[ObjX + x] = a;
  $pxa('Z_04:4235', Wallmaster_ObjStep, x);
  y = ram[Wallmaster_ObjStep + x];
  ram[ObjDir + x] = dirsAndAttrs(y, 'Z_04:4236') & 0x0f;
  ram[ObjTimer + 1] = 0x60;
  ram[ObjQSpeedFrac + x] = 0x18;
  ram[ObjAnimCounter + x] = 0x08;
  ram[ObjGridOffset + x] = 0x00;
  ram[Wallmaster_ObjTilesCrossed + x] = 0x00;
  ram[ObjAnimFrame + x] = 0x00;
  ram[ObjState + x]++;
}

/**
 * L_Wallmaster_State1 (Z_04). X = wallmaster. Moves along its path one square at a time; after 7
 * squares it goes back into the wall (state 0) or, holding Link, sends him to mode 3. Draws the
 * hand (over Link when he is captured) and patches the sprites.
 */
export function L_Wallmaster_State1(x) {
  // L_Wallmaster_State1 (Z_04)
  if (!$br('Z_04:4262', ram[ObjShoveDir + x] === 0)) {
    Obj_Shove(x);
    return drawAndCheckCollisions(x);
  }
  // @CheckStunned
  if ($br('Z_04:4273', (ram[InvClock] | ram[ObjStunTimer + x]) !== 0)) return drawAndCheckCollisions(x);
  ram[0x0f] = ram[ObjDir + x];
  MoveObject(x);
  $pxa('Z_04:4280', ObjGridOffset, x);
  const g = ram[ObjGridOffset + x];
  if (!$br('Z_04:4282', g === 0x10) && $br('Z_04:4284', g !== 0xf0)) return drawAndCheckCollisions(x);
  ram[ObjGridOffset + x] = 0x00;
  ram[Wallmaster_ObjStep + x]++;
  $pxa('Z_04:4294', Wallmaster_ObjStep, x);
  ram[ObjDir + x] = dirsAndAttrs(ram[Wallmaster_ObjStep + x], 'Z_04:4295') & 0x0f;
  ram[Wallmaster_ObjTilesCrossed + x]++;
  $pxa('Z_04:4304', Wallmaster_ObjTilesCrossed, x);
  if ($br('Z_04:4306', ram[Wallmaster_ObjTilesCrossed + x] < 0x07)) return drawAndCheckCollisions(x);
  $pxa('Z_04:4311', ObjCaptureTimer, x);
  let a = ram[ObjCaptureTimer + x];
  if (!$br('Z_04:4312', a === 0)) {
    HideSpritesOverLink();
    ram[GameMode] = 0x03;
    a = 0x00;
    ram[ObjState] = a;
    ram[IsUpdatingMode] = a;
    ram[GameSubmode] = a;
  }
  // @SetState
  ram[ObjState + x] = a;
}

/** L_Wallmaster_State1@Wallmaster_DrawAndCheckCollisions. */
function drawAndCheckCollisions(x) {
  $pxa('Z_04:4332', ObjCaptureTimer, x);
  if ($br('Z_04:4333', ram[ObjCaptureTimer + x] !== 0)) return drawWithCapturedLink(x);
  CheckMonsterCollisions(x);
  $pxa('Z_04:4338', ObjCaptureTimer, x);
  if (!$br('Z_04:4339', ram[ObjCaptureTimer + x] === 0)) {
    ram[ObjState] = 0x40;
    ram[ObjShoveDir] = 0x00;
  }
  const saved = ram[RollingSpriteIndex]; // PHA
  Wallmaster_PrepareToDraw(x);
  $pxa('Z_04:4350', ObjAnimFrame, x);
  DrawObjectNotMirrored(ram[ObjAnimFrame + x], x);
  const y = saved; // PLA / TAY
  const offsets = tbl('SpriteOffsets');
  $pxa('Z_04:4357', offsets.addr, y);
  ram[0x00] = offsets.byte(y);
  $pxa('Z_04:4359', offsets.addr + 1, y);
  return patchSprites(offsets.byte(y + 1));
}

/** L_Wallmaster_State1@PatchSprites: A = offset of the right sprite record. */
function patchSprites(a) {
  ram[0x01] = a;
  Wallmaster_PutSpritesBehindBgIfNeeded();
  const x = ram[CurObjIndex];
  $pxa('Z_04:4368', ObjAnimFrame, x);
  if ($br('Z_04:4369', ram[ObjAnimFrame + x] === 0)) return; // @Exit
  // Frame 1 (closed hand): the left half uses Keese tiles $9C/$9D; patch it to $AC.
  let y = ram[0x00];
  $pxa('Z_04:4379', Sprites + 1, y);
  if (!$br('Z_04:4381', ram[Sprites + 1 + y] === 0x9c)) y = ram[0x01];
  ram[Sprites + 1 + y] = 0xac;
}

/** L_Wallmaster_State1@DrawWithCapturedLink. */
function drawWithCapturedLink(x) {
  ram[ObjX] = ram[ObjX + x];
  ram[ObjY] = ram[ObjY + x];
  Link_EndMoveAndAnimate_Bank4();
  ShowLinkSpritesBehindHorizontalDoors();
  x = ram[CurObjIndex];
  Wallmaster_PrepareToDraw(x);
  ram[ObjAnimFrame + x] = 0x01;
  DrawObjectNotMirroredOverLink(0x01, x);
  ram[0x00] = 0x40;
  return patchSprites(0x44);
}

/**
 * Wallmaster_PrepareToDraw (Z_04). X = wallmaster. Advances the animation (8 frames), sets the
 * sprite attributes of the current step (palette row 5) and, for steps flipped horizontally, uses
 * [0F] instead of the attribute bit.
 */
export function Wallmaster_PrepareToDraw(x) {
  // Wallmaster_PrepareToDraw (Z_04)
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x08, x);
  $pxa('Z_04:4422', Wallmaster_ObjStep, x);
  const y = ram[Wallmaster_ObjStep + x];
  let a = (dirsAndAttrs(y, 'Z_04:4423') & 0xf0) | 0x01;
  a = Anim_SetSpriteDescriptorAttributes(a);
  if ($br('Z_04:4431', (a & 0x40) === 0)) return;
  Anim_SetSpriteDescriptorAttributes(ram[0x04] & 0x8f);
  ram[0x0f]++;
}

/**
 * Wallmaster_CalcStartPosition (Z_04). A = first step offset (0 left wall, $20 top wall),
 * X = wallmaster, Y = Link's minimum major coordinate; [00] Link's minor coordinate, [01] his major
 * coordinate, [02] the decreasing direction along the wall. [04] = initial minor coordinate.
 * @returns Y = index of the initial major coordinate (0 or 1)
 */
export function Wallmaster_CalcStartPosition(a, x, y) {
  // Wallmaster_CalcStartPosition (Z_04)
  ram[Wallmaster_ObjStep + x] = a;
  ram[0x03] = y;
  a = 0x24;
  if (!$br('Z_04:4460', ram[ObjInputDir] === 0)) a = 0x32;
  if (!$br('Z_04:4469', ram[ObjDir] !== ram[0x02])) {
    $pxa('Z_04:4471', Wallmaster_ObjStep, x);
    ram[Wallmaster_ObjStep + x] = ram[Wallmaster_ObjStep + x] + 0x08;
    a = ((a ^ 0xff) + 0x01) & 0xff;
  }
  ram[0x04] = a + ram[0x00];
  y = 0x00;
  if (!$br('Z_04:4498', ram[0x01] === ram[0x03])) {
    $pxa('Z_04:4499', Wallmaster_ObjStep, x);
    ram[Wallmaster_ObjStep + x] = ram[Wallmaster_ObjStep + x] + 0x10;
    y++;
  }
  return y;
}

/** Wallmaster_PutSpritesBehindBgIfNeeded (Z_04). [00]/[01] = the two OAM record offsets. */
export function Wallmaster_PutSpritesBehindBgIfNeeded() {
  // Wallmaster_PutSpritesBehindBgIfNeeded (Z_04)
  Wallmaster_PutSpriteBehindBgIfNeeded(ram[0x00]);
  return Wallmaster_PutSpriteBehindBgIfNeeded(ram[0x01]); // falls through
}

/**
 * Wallmaster_PutSpriteBehindBgIfNeeded (Z_04). Y = OAM record offset: the sprite goes behind the
 * background when its left or right extent is at the room's edge (>= $E9 or < $18).
 * @returns X = $FF
 */
export function Wallmaster_PutSpriteBehindBgIfNeeded(y) {
  // Wallmaster_PutSpriteBehindBgIfNeeded (Z_04)
  const ext = tbl('SpriteRelativeExtents');
  let x = 0x01;
  for (;;) {
    // @LoopExtent
    $pxa('Z_04:4520', Sprites + 3, y);
    $pxa('Z_04:4522', ext.addr, x);
    const a = (ram[Sprites + 3 + y] + ext.byte(x)) & 0xff;
    if ($br('Z_04:4524', a >= 0xe9) || !$br('Z_04:4526', a >= 0x18)) {
      // @AddPriorityBit
      $pxa('Z_04:4529', Sprites + 2, y);
      ram[Sprites + 2 + y] = ram[Sprites + 2 + y] | 0x20;
    }
    x = (x - 1) & 0xff;
    if (!$br('Z_04:4534', !(x & 0x80))) break;
  }
  return x;
}
