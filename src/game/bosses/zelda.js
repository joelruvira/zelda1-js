// P22 — bosses/zelda (Z_04): Zelda and the four guard fires around her, and the hand-over to mode $13.
// X = object slot in every routine.
import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjDir, ObjType, ObjState, ObjTimer, ObjMetastate, SongRequest, IsUpdatingMode,
  GameSubmode, GameMode, WhirlwindTeleportingState, InvMagicShield,
} from '../../core/vars.js';
import { Person_Draw } from '../npc/uwperson.js';
import { Link_EndMoveAndDraw_Bank4 } from '../link/anim.js';
import { FillTileMap } from '../world/tilemap.js';
import { AnimateAndDrawCommonObject } from '../enemies/keese-bubble.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { $br, $pxa } from '../../core/timing.js';

/** InitZelda (Z_04). Guard fires ($3F) in slots 5..1 at GuardFireXs/Ys; slot 1 becomes Zelda ($37). */
export function InitZelda() {
  // InitZelda (Z_04)
  const xs = table(bus.rom, 'GuardFireXs');
  const ys = table(bus.rom, 'GuardFireYs');
  for (let x = 5; ;) {
    $pxa('Z_04:9467', xs.addr - 1, x);
    ram[ObjX + x] = xs.byte(x - 1);
    $pxa('Z_04:9469', ys.addr - 1, x);
    ram[ObjY + x] = ys.byte(x - 1);
    ram[ObjType + x] = 0x3f;
    x--;
    if (!$br('Z_04:9474', x !== 0)) break;
  }
  ram[ObjType + 1] = 0x37;
}

/**
 * UpdateZelda (Z_04). X = Zelda. State 0: when Link stands in front of her (X $70-$80, Y $95), halt
 * him at ($88, $88) facing left, play the Zelda fanfare and wait $80 frames (state 1).
 */
export function UpdateZelda(x) {
  // UpdateZelda (Z_04)
  Person_Draw(x);
  if ($br('Z_04:9590', ram[ObjState + x] !== 0)) return UpdateZelda_State1(x);
  const lx = ram[ObjX];
  if ($br('Z_04:9597', lx < 0x70) || $br('Z_04:9599', lx >= 0x81)) return L129B7_Exit();
  if ($br('Z_04:9602', ram[ObjY] !== 0x95)) return L129B7_Exit();
  ram[ObjState + x]++;
  ram[ObjState] = 0x40;
  ram[ObjX] = 0x88;
  ram[ObjY] = 0x88;
  ram[ObjDir] = 0x02;
  ram[SongRequest] = 0x06;
  ram[ObjTimer + x] = 0x80;
  return L129B7_Exit();
}

/** L129B7_Exit (Z_04, part of UpdateZelda): RTS. */
export function L129B7_Exit() {}

/**
 * UpdateZelda_State1 (Z_04, part of UpdateZelda). Draw Link; when the timer expires go to mode $13
 * with the curtain columns ($20 and 1) and the tile map filled with blank tile $24.
 */
export function UpdateZelda_State1(x) {
  Link_EndMoveAndDraw_Bank4();
  x = xAfterLinkEndMoveAndDraw(x);
  const a = ram[ObjTimer + x]; // LDA ObjTimer, X with the X the drawing of Link leaves
  if ($br('Z_04:9634', a !== 0)) return L129B7_Exit();
  ram[IsUpdatingMode] = a;
  ram[GameSubmode] = a;
  ram[ObjState] = a;
  ram[GameMode] = 0x13;
  ram[ObjX + 12] = 0x20;
  ram[ObjX + 13] = 0x01;
  ram[0x0a] = 0x24;
  return FillTileMap();
}

/**
 * X as Link_EndMoveAndDraw (Z_07) leaves it (its port does not return X): unchanged when it returns at
 * once (whirlwind teleporting); else 0 (Link) after drawing him, except for the shield tile fix-up:
 * without the magic shield and facing down X = 1; with it X = 1, or 5 when facing right.
 */
function xAfterLinkEndMoveAndDraw(x) {
  if (ram[WhirlwindTeleportingState] !== 0) return x;
  if (ram[InvMagicShield] === 0) return ram[ObjDir] === 0x04 ? 0x01 : 0x00;
  return ram[ObjDir] & 0x01 ? 0x05 : 0x01;
}

/** UpdateGuardFire (Z_04). X = fire: animate (counter 6), draw, collide; when killed, dead dummy. */
export function UpdateGuardFire(x) {
  // UpdateGuardFire (Z_04)
  AnimateAndDrawCommonObject(0x06, x);
  CheckMonsterCollisions(x);
  $pxa('Z_04:9661', ObjMetastate, x);
  if ($br('Z_04:9662', ram[ObjMetastate + x] === 0)) return L129EA_Exit();
  return SetDeadDummyObjType(x); // falls through
}

/** SetDeadDummyObjType (Z_04). X = object: type $5D (dead dummy). @returns A = $5D */
export function SetDeadDummyObjType(x) {
  // SetDeadDummyObjType (Z_04)
  ram[ObjType + x] = 0x5d;
  return 0x5d;
}

/** L129EA_Exit (Z_04, part of SetDeadDummyObjType): RTS. */
export function L129EA_Exit() {}
