// Mode $11: Link's death (Z_05). Package P25.
// Init: Link flashes ($21 frames), then the doors are laid out again and the fade/turn sequence starts.
// Update (13 submodes): attributes and tiles of the play area are copied to nametable 2 (so the status
// bar can be dropped), palettes, Link spins 4 times, the world fades, the spark, "GAME OVER", mode 8.
// CueTransferPlayAreaAttrsHalfAndAdvanceSubmode(NT2) and UpdateMode11Death_Sub8_AnimateFade are also
// used by modes 3, 7, 9, A and B.
import { ram } from '../../core/ram.js';
import { tableJump } from '../../core/asm.js';
import { label } from '../../core/rom.js';
import {
  GameSubmode, GameMode, Paused, HeartPartial, ObjInvincibilityTimer, ObjTimer, CurOpenedDoors,
  PrevOpenedDoors, FadeCycle, CurRow, ObjState, DeathModeCounter, ObjDir, IsUpdatingMode, Tune0Request,
  EffectRequest, Tune1Request, DynTileBuf, IsSprite0CheckActive, CurPpuControl_2000, TileBufSelector,
  ObjX, ObjY, Sprites, CurSaveSlot, DeathCounts,
} from '../../core/vars.js';
import { HideAllSprites } from '../boot.js';
import { EndGameMode } from './dispatch.js';
import {
  CopyPlayAreaAttrsHalfToDynTransferBuf, ChooseAttrSourceAndDestForSubmode, LayOutDoorsPrev,
  WriteAndEnableSprite0,
} from './mode7-scroll.js';
import { L1712E_SelectTransferBufAndAdvanceSubmode } from './modeA-B-C-cave.js';
import { MaskCurPpuMaskGrayscale } from './mode5-play.js';
import { AnimateWorldFading } from '../ppu/fade.js';
import { DecrementInvincibilityTimer } from '../objects/slots.js';
import { Link_EndMoveAndAnimate, DrawLinkBetweenRooms } from '../link/anim.js';
import { UpdateTriforcePositionMarker, DrawStatusBarItemsAndEnsureItemSelected } from '../hud/statusbar.js';
import { FormatStatusBarText } from '../text/format.js';
import { GetUniqueRoomId } from '../world/roomflags.js';
import { CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone } from '../world/tilemap.js';

// ------------------------------------------------------------------ init

/** InitMode11 (Z_05): submode 0 = freeze the scene and make Link flash; submode 1 = start updating. */
export function InitMode11() {
  // InitMode11 (Z_05)
  DecrementInvincibilityTimer(0x00); // needed in submode 1
  Link_EndMoveAndAnimate();
  if (ram[GameSubmode] !== 0) return InitMode11_Sub1();
  // Submode 0.
  HideAllSprites();
  UpdateTriforcePositionMarker();
  DrawLinkBetweenRooms();
  DrawStatusBarItemsAndEnsureItemSelected();
  MaskCurPpuMaskGrayscale();
  ram[Paused] = 0x00;
  ram[HeartPartial] = 0x00;
  FormatStatusBarText();
  ram[GameSubmode]++;
  ram[ObjInvincibilityTimer] = 0x10; // Link flashes for a fixed time
  ram[ObjTimer] = 0x21;
}

/** InitMode11_Sub1 (Z_05, internal label of InitMode11): falls into SilenceSound. */
function InitMode11_Sub1() {
  // InitMode11_Sub1 (Z_05)
  if (ram[ObjTimer] !== 0) return; // L14A96_Exit
  if ((GetUniqueRoomId() & 0x3e) !== 0x3e) {
    // Not in a cellar: lay out the doors again (seems redundant).
    ram[PrevOpenedDoors] = ram[CurOpenedDoors];
    LayOutDoorsPrev();
  }
  ram[FadeCycle] = 0x60; // DeathPaletteCycle
  ram[ObjTimer + 10] = 0x02; // nobody waits for it
  ram[GameSubmode] = 0x00;
  ram[CurRow] = 0x00;
  ram[ObjState] = 0x00;
  ram[DeathModeCounter] = 0x04; // 4 turns starting from down
  ram[ObjDir] = 0x04;
  ram[IsUpdatingMode]++;
  return SilenceSound(); // falls through
}

/** SilenceSound (Z_05): Tune0Request = EffectRequest = $80. @returns A = $80 */
export function SilenceSound() {
  // SilenceSound (Z_05)
  ram[Tune0Request] = 0x80;
  ram[EffectRequest] = 0x80;
  return 0x80;
}

// ------------------------------------------------------------------ update

let handlers;
export function UpdateMode11Death_Full() {
  // UpdateMode11Death_Full (Z_05)
  handlers ??= [UpdateMode11Death_Sub0, UpdateMode11Death_Sub1, UpdateMode11Death_Sub2,
    UpdateMode11Death_Sub3, UpdateMode11Death_Sub4, UpdateMode11Death_Sub5, UpdateMode11Death_Sub6,
    UpdateMode11Death_Sub7, UpdateMode11Death_Sub8_AnimateFade, UpdateMode11Death_Sub9,
    UpdateMode11Death_SubA, UpdateMode11Death_SubB, UpdateMode11Death_SubC];
  return tableJump(label('UpdateMode11Death_Full_JumpTable').addr, ram[GameSubmode], handlers);
}

/** UpdateMode11Death_Sub1 (Z_05): bottom half of the play area attributes; death tune. */
export function UpdateMode11Death_Sub1() {
  // UpdateMode11Death_Sub1 (Z_05)
  ram[Tune1Request] = 0x80;
  return UpdateMode11Death_Sub0(); // falls through
}

/** UpdateMode11Death_Sub0 (Z_05): top half of the play area attributes (to nametable 2). */
export function UpdateMode11Death_Sub0() {
  // UpdateMode11Death_Sub0 (Z_05)
  const { a, y } = ChooseAttrSourceAndDestForSubmode();
  return CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2(a, undefined, y); // falls through
}

/**
 * CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2 (Z_05): X = $2B (nametable 2), then falls into
 * CueTransferPlayAreaAttrsHalfAndAdvanceSubmode. A = low PPU address, Y = end offset in PlayAreaAttrs.
 */
export function CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2(a, x, y) {
  // CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT2 (Z_05)
  return CueTransferPlayAreaAttrsHalfAndAdvanceSubmode(a, 0x2b, y);
}

/**
 * CueTransferPlayAreaAttrsHalfAndAdvanceSubmode (Z_05): X = high PPU address, A = low PPU address,
 * Y = end offset in PlayAreaAttrs. Copies the attribute half to DynTileBuf and INC GameSubmode.
 */
export function CueTransferPlayAreaAttrsHalfAndAdvanceSubmode(a, x, y) {
  // CueTransferPlayAreaAttrsHalfAndAdvanceSubmode (Z_05)
  CopyPlayAreaAttrsHalfToDynTransferBuf(a, x, y);
  ram[GameSubmode] = (ram[GameSubmode] + 1) & 0xff;
}

/** UpdateMode11Death_Sub2 (Z_05): all play area tile rows, written to nametable 2. */
export function UpdateMode11Death_Sub2() {
  // UpdateMode11Death_Sub2 (Z_05)
  if (CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone()) WriteAndEnableSprite0();
  ram[DynTileBuf] = (ram[DynTileBuf] + 0x08) & 0xff; // $20xx -> $28xx
}

/** UpdateMode11Death_Sub3 (Z_05): top half of the play area attributes ($60). */
export function UpdateMode11Death_Sub3() {
  // UpdateMode11Death_Sub3 (Z_05)
  return SelectTransferBufAndAdvanceSubmode(0x60); // falls through
}

/** SelectTransferBufAndAdvanceSubmode (Z_05): A = TileBufSelector. */
export function SelectTransferBufAndAdvanceSubmode(a) {
  // SelectTransferBufAndAdvanceSubmode (Z_05)
  return L1712E_SelectTransferBufAndAdvanceSubmode(a);
}

/** UpdateMode11Death_Sub4 (Z_05): bottom half of the play area attributes ($62). */
export function UpdateMode11Death_Sub4() {
  // UpdateMode11Death_Sub4 (Z_05)
  return SelectTransferBufAndAdvanceSubmode(0x62);
}

/** UpdateMode11Death_Sub5 (Z_05): no more split; bottom half of the background palette ($5E). */
export function UpdateMode11Death_Sub5() {
  // UpdateMode11Death_Sub5 (Z_05)
  ram[IsSprite0CheckActive] = 0x00;
  return SelectTransferBufAndAdvanceSubmode(0x5e);
}

/** UpdateMode11Death_Sub6 (Z_05): even base nametable. */
export function UpdateMode11Death_Sub6() {
  // UpdateMode11Death_Sub6 (Z_05)
  ram[CurPpuControl_2000] &= 0xfe;
  // L14CD7_IncSubmode
  ram[GameSubmode]++;
}

/** UpdateMode11Death_Sub7 (Z_05): Link turns counter-clockwise every 5 frames, 4 times. */
export function UpdateMode11Death_Sub7() {
  // UpdateMode11Death_Sub7 (Z_05)
  if (ram[DeathModeCounter] === 0) {
    ram[GameSubmode]++; // L14CD7_IncSubmode
    return;
  }
  if (ram[ObjTimer + 11] === 0) {
    ram[ObjTimer + 11] = 0x05;
    const dir = ram[ObjDir];
    let a = dir >> 2; // LSR / LSR
    if (dir & 0x02) {
      // Facing left.
      ram[DeathModeCounter]--;
      a = 0x04; // down
    } else if (a === 0) {
      a = 0x08; // facing right: up
    } // else vertical: A is the horizontal direction counter-clockwise from it
    ram[ObjDir] = a; // @SetLinkDirAndDraw
  }
  return Link_EndMoveAndAnimate(); // @DrawLink
}

/** UpdateMode11Death_Sub8_AnimateFade (Z_05): AnimateWorldFading; when done, INC GameSubmode. */
export function UpdateMode11Death_Sub8_AnimateFade() {
  // UpdateMode11Death_Sub8_AnimateFade (Z_05)
  if (AnimateWorldFading() !== 0) return;
  // L14CD7_IncSubmode
  ram[GameSubmode] = (ram[GameSubmode] + 1) & 0xff;
}

/** UpdateMode11Death_Sub9 (Z_05): dead Link (grey) palette row; the spark lasts $F frames. */
export function UpdateMode11Death_Sub9() {
  // UpdateMode11Death_Sub9 (Z_05)
  ram[TileBufSelector] = 0x2c;
  ram[DeathModeCounter] = 0x0f;
  return UpdateMode11Death_SetTimerIncSubmode(0x18); // delay $17 frames
}

/** UpdateMode11Death_SubA (Z_05): the spark where Link was, then "heart taken" tune. */
export function UpdateMode11Death_SubA() {
  // UpdateMode11Death_SubA (Z_05)
  if (ram[ObjTimer + 11] !== 0) return; // L14D55_Exit
  const x = ram[DeathModeCounter] >= 0x06 ? 0x62 : 0x64; // little / big spark
  let a = ram[ObjY];
  ram[Sprites + 72] = a;
  ram[Sprites + 76] = a;
  ram[Sprites + 73] = x;
  ram[Sprites + 77] = x;
  ram[Sprites + 74] = 0x01; // palette 5
  ram[Sprites + 78] = 0x41; // same palette, flipped
  a = ram[ObjX];
  ram[Sprites + 75] = a;
  ram[Sprites + 79] = (a + 0x08) & 0xff;
  ram[DeathModeCounter]--;
  if (ram[DeathModeCounter] !== 0) return; // L14D55_Exit
  ram[Tune0Request] = 0x10;
  ram[Sprites + 72] = 0xf8; // hide the spark
  ram[Sprites + 76] = 0xf8;
  return UpdateMode11Death_SetTimerIncSubmode(0x2e); // delay $2D frames
}

// UpdateMode11Death_SetTimerIncSubmode (Z_05, internal label of UpdateMode11Death_SubA).
function UpdateMode11Death_SetTimerIncSubmode(a) {
  ram[ObjTimer + 11] = a;
  ram[GameSubmode]++;
}

/** UpdateMode11Death_SubB (Z_05): "GAME OVER" ($46) after the delay; then wait $5F frames. */
export function UpdateMode11Death_SubB() {
  // UpdateMode11Death_SubB (Z_05)
  if (ram[ObjTimer + 11] !== 0) return; // L14D55_Exit
  ram[ObjTimer + 11] = 0x60;
  return SelectTransferBufAndAdvanceSubmode(0x46);
}

/** UpdateMode11Death_SubC (Z_05): go to mode 8 with the game over music; one more death. */
export function UpdateMode11Death_SubC() {
  // UpdateMode11Death_SubC (Z_05)
  if (ram[ObjTimer + 11] !== 0) return;
  EndGameMode();
  ram[GameMode] = 0x08;
  ram[Tune1Request] = 0x40;
  const x = ram[CurSaveSlot];
  if (ram[DeathCounts + x] === 0xff) return; // up to $FF
  ram[DeathCounts + x]++;
}
