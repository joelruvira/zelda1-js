// P09 weapons — bombs in slots $10/$11 and their smoke clouds: WieldBomb and UpdateBombFlashEffect
// (Z_01); UpdateBombOrFire (UpdateBomb, Bomb_CheckState4, DrawBomb), DrawBombOrCloudAt,
// DrawBombOrCloudNoFlashing, DrawCloud and DrawOtherBombClouds (Z_07).
// Bomb minor states: 1 set, 2 fuse (drawn as a bomb), 3 blast (sound, flash), 4 clouds (opens a
// bombable UW wall), 5 gone. DrawCloud also draws the spawn cloud of objects (metastates 1..4).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { switchBank } from '../../core/asm.js';
import {
  InvBombs, ObjState, ObjTimer, Tune0Request, CurPpuMask_2001, CurLevel, GameMode, ObjX, ObjY,
  CurOpenedDoors, TriggeredDoorCmd, TriggeredDoorDir, FrameCounter,
} from '../../core/vars.js';
import { PlayEffect } from '../audio/requests.js';
import { Abs, reverseDirections } from '../movement/math.js';
import { Anim_FetchObjPosForSpriteDescriptor } from '../draw/anim.js';
import { Anim_WriteItemSprites } from '../draw/items.js';
import { FindDoorTypeByDoorBit } from '../world/doors.js';
import { PlaceWeaponForPlayerStateAndAnimAndWeaponState } from './wield.js';
import { UpdateFire } from './fire.js';
import { ResetObjState } from './sword.js';

/**
 * WieldBomb (Z_01): sets a bomb (state $11) in slot $10 or $11 (a fire there is replaced), at most
 * one not yet detonating bomb at a time.
 */
export function WieldBomb() {
  // WieldBomb (Z_01)
  if (ram[InvBombs] === 0) return; // no bombs
  let x = 0x10;
  let a = ram[ObjState + x];
  if (a !== 0 && (a & 0xf0) === 0x10) {
    // A bomb in slot $10: look at slot $11.
    x++;
    a = ram[ObjState + x];
    if (a !== 0 && (a & 0xf0) === 0x10) return; // L69AB_Exit: two bombs
  }
  // @FoundSlot: if the other slot has a bomb that's not detonating yet (state < $13), return.
  const y = x ^ 0x01;
  a = ram[ObjState + y];
  if (a !== 0 && a < 0x13) return; // L69AB_Exit
  // @Activate
  ram[InvBombs]--;
  ram[Tune0Request] = 0x20; // "set a bomb" tune
  ram[ObjTimer + x] = 0x00;
  return PlaceWeaponForPlayerStateAndAnimAndWeaponState(0x11, x);
}

/**
 * UpdateBombFlashEffect (Z_01). X = bomb slot. In state $13 the grayscale bit of CurPpuMask_2001
 * is set at timer $16/$11 and cleared at $12/$0D.
 */
export function UpdateBombFlashEffect(x) {
  // UpdateBombFlashEffect (Z_01)
  if (ram[ObjState + x] !== 0x13) return; // @Exit
  let a = ram[CurPpuMask_2001] >> 1; // LSR: drop the grayscale bit
  const y = ram[ObjTimer + x];
  if (y === 0x16 || y === 0x11) {
    a = ((a << 1) | 0x01) & 0xff; // ROL with C = 1 (from CPY equal)
  } else if (y === 0x12 || y === 0x0d) {
    a = (a << 1) & 0xff; // @Clear: ASL
  } else {
    return; // @Exit
  }
  ram[CurPpuMask_2001] = a; // @SetMask
}

/** UpdateBombOrFire (Z_07). X = $10/$11. Bomb (major state $10) or fire (UpdateFire). */
export function UpdateBombOrFire(x) {
  // UpdateBombOrFire (Z_07)
  const a = ram[ObjState + x];
  if (a === 0) return; // L1F95F_Exit
  if ((a & 0xf0) === 0x10) return UpdateBomb(x);
  return UpdateFire(x);
}

/**
 * UpdateBomb (Z_07, label inside UpdateBombOrFire). X = bomb slot. When the timer expires, the next
 * one comes from BombTimes by minor state and the state advances (3: blast sound, 5: gone).
 */
function UpdateBomb(x) {
  if (ram[ObjTimer + x] !== 0) return DrawBomb(x);
  const y = ram[ObjState + x] & 0x0f;
  ram[ObjTimer + x] = table(bus.rom, 'BombTimes').byte(y - 1); // BombTimes-1, Y
  ram[ObjState + x]++;
  let a = ram[ObjState + x] & 0x0f; // PHA
  if (a === 0x03) PlayEffect(0x10); // blast
  // @CheckState5 (PLA)
  if (a !== 0x05) return Bomb_CheckState4(a, x);
  a = ResetObjState(x);
  ram[ObjTimer + x] = a;
  // L1F95F_Exit
}

/**
 * Bomb_CheckState4 (Z_07, label inside UpdateBombOrFire). A = minor state, X = bomb slot. In minor
 * state 4, in UW (not in a cellar), a bomb within $18 pixels of a door hotspot triggers that
 * bombable wall (TriggeredDoorCmd 6). Then draws (DrawBomb).
 */
function Bomb_CheckState4(a, x) {
  if (a !== 0x04) return DrawBomb(x);
  if (ram[CurLevel] === 0) return DrawBomb(x); // OW: rock walls have their own tile object
  if (ram[GameMode] === 0x09) return DrawBomb(x); // not in cellars
  const hotX = table(bus.rom, 'BombableWallHotspotsX');
  const hotY = table(bus.rom, 'BombableWallHotspotsY');
  for (let y = 0x03; y >= 0; y--) {
    // @LoopHotspot
    if (Abs((hotX.byte(y) - ram[ObjX + x]) & 0xff) >= 0x18) continue;
    if (Abs((hotY.byte(y) - ram[ObjY + x]) & 0xff) >= 0x18) continue;
    a = reverseDirections(y);
    ram[0x02] = a; // the hotspot's direction
    if (a & ram[CurOpenedDoors]) return DrawBomb(x); // already opened
    if (ram[TriggeredDoorCmd] !== 0) return DrawBomb(x); // already triggered
    switchBank(5);
    if (FindDoorTypeByDoorBit() !== 0x04) return DrawBomb(x); // not a bombable wall
    ram[TriggeredDoorCmd] = 0x06;
    ram[TriggeredDoorDir] = ram[0x02];
    return DrawBomb(x); // falls through
  }
  return DrawBomb(x); // BMI DrawBomb: no hotspot near
}

/**
 * DrawBomb (Z_07, label inside UpdateBombOrFire). X = bomb slot. Draws the bomb or the first dust
 * cloud, and the other clouds unless it is a bomb (minor state 2).
 */
function DrawBomb(x) {
  Anim_FetchObjPosForSpriteDescriptor(x);
  DrawBombOrCloudAt(x);
  if ((ram[ObjState + x] & 0x0f) === 0x02) return; // a bomb: L1F95F_Exit
  return DrawOtherBombClouds(x);
}

/** DrawBombOrCloudAt (Z_07). X = bomb slot, [00]/[01] = position. Flash effect, then draw. */
export function DrawBombOrCloudAt(x) {
  // DrawBombOrCloudAt (Z_07)
  UpdateBombFlashEffect(x);
  return DrawBombOrCloudNoFlashing(x); // falls through
}

/** DrawBombOrCloudNoFlashing (Z_07). X = bomb slot. Frame image = minor state - 2. */
export function DrawBombOrCloudNoFlashing(x) {
  // DrawBombOrCloudNoFlashing (Z_07)
  return DrawCloud(((ram[ObjState + x] & 0x0f) - 0x02) & 0xff, x); // falls through
}

/**
 * DrawCloud (Z_07). A = frame image, X = object, [00]/[01] = position. Bomb item slot, palette
 * row 5 (attribute 1), not flipped. @returns X = [08]
 */
export function DrawCloud(a, x) {
  // DrawCloud (Z_07)
  ram[0x0c] = a;
  let y = 0x00;
  ram[0x0f] = y;
  y++;
  ram[0x04] = y;
  ram[0x05] = y;
  return Anim_WriteItemSprites(x, 0x01);
}

/** DrawOtherBombClouds (Z_07). X = bomb slot. 3 more clouds; the offsets alternate every frame. */
export function DrawOtherBombClouds(x) {
  // DrawOtherBombClouds (Z_07)
  const offY = table(bus.rom, 'BombCloudOffsetsY1');
  const offX = table(bus.rom, 'BombCloudOffsetsX1');
  for (let y = 0x02; y >= 0; y--) {
    // @LoopCloud: odd frames use the second set (6 bytes further).
    const i = ram[FrameCounter] & 0x01 ? y + 0x06 : y;
    ram[0x01] = ram[ObjY + x] + offY.byte(i);
    ram[0x00] = ram[ObjX + x] + offX.byte(i);
    DrawBombOrCloudNoFlashing(x);
  }
}
