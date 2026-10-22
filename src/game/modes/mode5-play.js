// P05 — mode 5 (play): InitMode5Play (palettes of the room) and the frame of play: pause/menu,
// Link, weapons, the object loop ($B..1), UW/OW room tasks, room item and status bar (Z_07, Z_05).
// Modes 9, $A, $B and $C also run UpdateMode5Play.

import { ram, sram, peek } from '../../core/ram.js';
import { bus, write } from '../../core/bus.js';
import { switchBank } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  CurLevel, ObjType, RoomId, UndergroundExitType, Tune1Request, LevelBlockAttrsA, LevelBlockAttrsB,
  LevelInfo_PalettesTransferBuf, TileBufSelector, FluteTimer, BrighteningRoom, MenuState, Paused,
  ButtonsPressed, ButtonsDown, ObjInputDir, ApuStatus_4015, InvClock, ObjInvincibilityTimer,
  IsUpdatingMode, ChaseOtherTarget, ObjX, ObjY, ChaseTargetX, ChaseTargetY, ChaseLongTimer, Random,
  CurObjIndex, ObjMetastate, ObjAttr, HeartValues, Tune0Request, GameMode, DynTileBufLen,
  StatusBarMapTrigger, ObjState, LinkParalyzed, CurPpuMask_2001,
} from '../../core/vars.js';
import { HideObjectSprites, ShowLinkSpritesBehindHorizontalDoors } from '../draw/sprites.js';
import { AnimateAndDrawObjectWalking } from '../draw/anim.js';
import { PlayEffect } from '../audio/requests.js';
import { Walker_Move } from '../movement/walker.js';
import { EnsureObjectAligned } from '../movement/tiles.js';
import { Link_HandleInput } from '../link/input.js';
import { Link_EndMoveAndAnimate } from '../link/anim.js';
import { UpdateMenuAndMeters } from '../hud/submenu.js';
import { UpdateTriforcePositionMarker, DrawStatusBarItemsAndEnsureItemSelected } from '../hud/statusbar.js';
import { World_FillHearts, World_ChangeRupees } from '../hud/meters.js';
import { DecrementInvincibilityTimer } from '../objects/slots.js';
import { UpdateObject } from '../objects/dispatch.js';
import { RunCrossRoomTasksAndBeginUpdateMode_PlayModesNoCellar } from './crossroom.js';
import { DrawSpritesBetweenRooms } from './mode4-6-enterleave.js';
// Later packages (stubs until they are ported).
import { UpdateCandle } from '../weapons/fire.js';
import { UpdateSwordOrRod } from '../weapons/sword.js';
import { UpdateSwordShotOrMagicShot } from '../weapons/shots.js';
import { UpdateBoomerangOrFood } from '../weapons/boomerang.js';
import { UpdateBombOrFire } from '../weapons/bomb.js';
import { UpdateRodOrArrow } from '../weapons/rod.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { CheckLiftItem, MoveAndDrawRoomItem } from '../items/roomitem.js';
import { TryTakeRoomItem, CheckPowerTriforceFanfare } from '../items/take.js';
import { CheckUnderworldSecrets } from '../world/secrets.js';
import { CheckShutters, UpdateDoors } from '../world/doors.js';
import { UpdateStatues } from '../enemies/statues.js';
import { CheckZora } from '../enemies/zora.js';

/**
 * InitMode5Play (Z_07): sprites between rooms, Link; cue the palette row 7 of the room (special
 * bosses in UW, tile objects with sprites in OW, else the level's); then the cross-room tasks.
 */
export function InitMode5Play() {
  // InitMode5Play (Z_07)
  DrawSpritesBetweenRooms();
  Link_EndMoveAndAnimate();
  let x;
  if (ram[CurLevel] !== 0) {
    // In UW: bosses and boss-like monsters with their own palette.
    const types = table(bus.rom, 'SpecialBossPaletteObjTypes');
    const sels = table(bus.rom, 'SpecialBossPaletteTransferBufSelectors');
    const a = ram[ObjType + 1];
    for (let y = 0x08; y >= 0; y--) {
      if (a !== types.byte(y)) continue;
      x = sels.byte(y);
      if (x !== 0) break;
      x = undefined;
    }
    if (x === undefined) {
      // @UseLevelPalette: patch the palette row 7 transfer buf with the level's row 7.
      const row7 = label('LevelPaletteRow7TransferBuf').addr - 0x6000;
      for (let y = 0x03; y >= 0; y--) {
        sram[row7 + 3 + y] = peek(LevelInfo_PalettesTransferBuf + 31 + y);
      }
      x = 0x06;
    }
  } else {
    // In OW: room $0F walked into (not from underground): "secret found" tune.
    if (ram[RoomId] === 0x0f && ram[UndergroundExitType] === 0) ram[Tune1Request] = 0x04;
    // @ChooseTileObjPalette: palette of a tile object with sprites.
    x = 0x20; // ghost palette row
    const a = ram[ObjType + 11];
    let checkAttr = false;
    if (a === 0x65) {
      checkAttr = false; // gravestone
    } else if (a === 0x66) {
      checkAttr = true; // Armos1
    } else if (a !== 0x62) {
      x = 0x7a; // Armos2: red Armos palette row
    } else {
      x = 0x24; // rock: brown palette row
      checkAttr = true;
    }
    // @UseXOrGreenPalette: an even inner palette attribute uses the green row.
    if (checkAttr && !(peek(LevelBlockAttrsB + ram[RoomId]) & 0x01)) x = 0x22;
  }
  // @SelectTransferBufAndFinishInitPlay
  ram[TileBufSelector] = x;
  return RunCrossRoomTasksAndBeginUpdateMode_PlayModesNoCellar(); // falls through
}

/** UpdateMode5Play (Z_07): flute, candle, pause (Select), submenu (Start), else update the world. */
export function UpdateMode5Play() {
  // UpdateMode5Play (Z_07)
  if (ram[FluteTimer] !== 0) return; // L1EBF8_Exit
  if (ram[BrighteningRoom] !== 0) {
    switchBank(4);
    return UpdateCandle();
  }
  // @CheckMenuAndPause
  if (ram[MenuState] === 0) {
    if (ram[Paused] !== 0x02 && (ram[ButtonsPressed] & 0x20)) {
      // Select toggles the pause; unpausing enables the sound again.
      ram[Paused] ^= 0x01;
      if (ram[Paused] === 0) write(ApuStatus_4015, 0x0f);
    }
    // @CheckPaused
    if (ram[Paused] !== 0) {
      switchBank(5);
      MaskCurPpuMaskGrayscale();
      return UpdateHeartsAndRupees(); // JMP
    }
  }
  // @CheckMenu
  HideObjectSprites();
  ram[ObjInputDir] = ram[ButtonsDown] & 0x0f;
  if (ram[MenuState] !== 0) {
    switchBank(5);
    MaskCurPpuMaskGrayscale();
    return UpdateMenuAndMeters(); // JMP
  }
  // @NotInMenu
  if (ram[ButtonsPressed] & 0x10) {
    ram[MenuState]++; // start scrolling the submenu
    return;
  }
  return BeginUpdateWorld();
}

/** BeginUpdateWorld (Z_07, label in UpdateMode5Play): Link, weapons, objects, room tasks. */
export function BeginUpdateWorld() {
  // BeginUpdateWorld (Z_07)
  // With the clock, Link stays invincible.
  if (ram[InvClock] !== 0) ram[ObjInvincibilityTimer] = (ram[ObjInvincibilityTimer] + 0x10) & 0xff;
  UpdatePlayer();
  if (ram[IsUpdatingMode] === 0) return finishUpdatePlay(); // the mode changed

  // @CheckChaseTarget
  if (ram[ChaseOtherTarget] === 0) {
    ram[ChaseTargetX] = ram[ObjX];
    ram[ChaseTargetY] = ram[ObjY];
  }
  // @UpdateWeapons
  UpdateSwordOrRod(0x0d);
  UpdateSwordShotOrMagicShot(0x0e);
  UpdateBoomerangOrFood(0x0f);
  UpdateBombOrFire(0x10);
  UpdateBombOrFire(0x11);
  UpdateRodOrArrow(0x12);

  if (ram[ChaseLongTimer] === 0) {
    ram[ChaseLongTimer] = ram[Random + 1] & 0x07;
    ram[ChaseOtherTarget] ^= 0x01;
    // Chasing the other target: if Link has not moved horizontally, reflect his last position.
    if (ram[ChaseOtherTarget] !== 0 && ram[ChaseTargetX] === ram[ObjX]) {
      ram[ChaseTargetX] ^= 0xff;
      ram[ChaseTargetY] ^= 0xff;
    }
  }

  // @LoopObject: objects $B down to 1.
  do {
    let x = ram[CurObjIndex];
    DecrementInvincibilityTimer(x);
    if (ram[ObjType + x] !== 0) {
      UpdateObject(ram[ObjType + x], x);
      // Autonomous objects that don't check collisions and draw themselves: do it for them.
      x = ram[CurObjIndex];
      if (ram[ObjMetastate + x] === 0 && !(ram[ObjAttr + x] & 0x01)) {
        if (!(ram[ObjAttr + x] & 0x04)) AnimateAndDrawObjectWalking(x);
        x = ram[CurObjIndex];
        CheckMonsterCollisions(x);
      }
    }
    // @NextObject
    ram[CurObjIndex]--;
  } while (ram[CurObjIndex] !== 0);
  ram[CurObjIndex] = 0x0b;

  // Only a partial heart left: heart warning.
  if ((ram[HeartValues] & 0x0f) === 0) ram[Tune0Request] |= 0x40;

  if (ram[CurLevel] !== 0) {
    // @CheckUW
    switchBank(4);
    UpdateStatues();
    UpdateTriforcePositionMarker();
    switchBank(5);
    CheckUnderworldSecrets();
    CheckShutters();
    UpdateDoors();
    switchBank(1);
    CheckPowerTriforceFanfare();
  } else {
    // @CheckOW: sea sound effect in mode 5 if the room calls for it.
    if (ram[GameMode] === 0x05) {
      PlayEffect(((peek(LevelBlockAttrsA + ram[RoomId]) & 0x04) << 3) & 0xff);
    }
    // @CheckZora
    switchBank(4);
    CheckZora();
  }
  // @TransferStatusBarMap
  if (ram[DynTileBufLen] === 0 && ram[StatusBarMapTrigger] !== 0) {
    ram[StatusBarMapTrigger] = 0x00;
    ram[TileBufSelector] = 0x44; // the level's status bar map
  }
  return finishUpdatePlay();
}

function finishUpdatePlay() {
  // BeginUpdateWorld@FinishUpdatePlay: done after Link, whether or not the objects were updated.
  CheckLiftItem();
  MoveAndDrawRoomItem();
  TryTakeRoomItem();
  DrawStatusBarItemsAndEnsureItemSelected();
  return UpdateHeartsAndRupees(); // falls through
}

/** UpdateHeartsAndRupees (Z_07). */
export function UpdateHeartsAndRupees() {
  // UpdateHeartsAndRupees (Z_07)
  switchBank(5);
  World_FillHearts();
  return World_ChangeRupees(); // JMP
}

/** UpdatePlayer (Z_07): Link (slot 0) unless halted; input, movement, animation. */
export function UpdatePlayer() {
  // UpdatePlayer (Z_07)
  DecrementInvincibilityTimer(0x00);
  if ((ram[ObjState] & 0xc0) === 0x40) return; // halted (L1EDEA_Exit)
  // Paralyzed by a like-like: no input direction.
  if (ram[LinkParalyzed] !== 0) ram[ObjInputDir] &= 0xf0;
  switchBank(5);
  Link_HandleInput();
  Walker_Move(0x00); // Link_HandleInput leaves X = 0
  return Link_EndMoveAndAnimateInRoom(); // falls through
}

/** Link_EndMoveAndAnimateInRoom (Z_07): not in mode $A; in UW, Link behind horizontal doors. */
export function Link_EndMoveAndAnimateInRoom() {
  // Link_EndMoveAndAnimateInRoom (Z_07)
  if (ram[GameMode] === 0x0a) return; // L1EDEA_Exit
  Link_EndMoveAndAnimate();
  if (ram[CurLevel] !== 0) ShowLinkSpritesBehindHorizontalDoors();
  // @Exit
  return EnsureObjectAligned(0x00); // falls through with X = 0
}

/** MaskCurPpuMaskGrayscale (Z_05): CurPpuMask_2001 &= $FE. @returns A */
export function MaskCurPpuMaskGrayscale() {
  // MaskCurPpuMaskGrayscale (Z_05)
  const a = ram[CurPpuMask_2001] & 0xfe;
  ram[CurPpuMask_2001] = a;
  return a;
}
