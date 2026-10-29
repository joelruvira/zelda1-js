// Mode $13: the ending (Z_02). Package P25.
// Init (5 submodes): the curtain closes, Zelda's "THANKS LINK..." textbox, silence.
// Update (5 submodes): Link and Zelda with the triforces and the flashing background, the "FINALLY,
// PEACE RETURNS..." text, the credits scroll (credits.js) and the triforce over Ganon's ashes until Start.
import { ram } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  GameSubmode, GameMode, ObjTimer, Song, ObjX, ObjY, ObjType, ObjState, DynTileBuf, TextboxCharPtr,
  TextboxCharIndex, Tune0Request, CreditsTileOffset, PeaceCharDelayCounter, PeaceCharIndex, ItemLiftTimer,
  LevelInfo_PalettesTransferBuf, SongRequest, EndingFlashLongTimer, TileBufSelector, LeftSpriteOffset,
  RightSpriteOffset, ButtonsPressed,
} from '../../core/vars.js';
import { HideAllSprites, TurnOffAllVideo, TurnOffVideoAndClearArtifacts } from '../boot.js';
import { BeginUpdateMode, EndGameMode } from './dispatch.js';
import { UpdateWorldCurtainEffect_Bank2 } from './mode3-unfurl.js';
import { Link_EndMoveAndDraw } from '../link/anim.js';
import { Person_Draw } from '../npc/uwperson.js';
import { SilenceAllSound } from '../audio/requests.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored } from '../draw/anim.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { Anim_WriteSpecificItemSprites } from '../draw/items.js';
import { AnimateItemObject } from '../items/roomitem.js';
import { SwitchProfileToSecondQuest } from '../save/files.js';
import { UpdateMode13WinGame_Sub3 } from './credits.js';

// ------------------------------------------------------------------ init

let initHandlers;
export function InitMode13_Full() {
  // InitMode13_Full (Z_02)
  initHandlers ??= [InitMode13_Sub0, InitMode13_Sub1, InitMode13_Sub2, InitMode13_Sub3, InitMode13_Sub4];
  return tableJump(label('InitMode13_Full_JumpTable').addr, ram[GameSubmode], initHandlers);
}

/** InitMode13_Sub0 (Z_02): close the curtain; then draw Link and Zelda. */
export function InitMode13_Sub0() {
  // InitMode13_Sub0 (Z_02)
  UpdateEndGameCurtainEffect();
  if (ram[GameSubmode] === 0) return; // LA958_Exit
  HideAllSprites();
  Link_EndMoveAndDraw();
  return Person_Draw(0x01); // Zelda is in object slot 1
}

/** UpdateEndGameCurtainEffect (Z_02): after the timer and the song, curtain until the middle. */
export function UpdateEndGameCurtainEffect() {
  // UpdateEndGameCurtainEffect (Z_02)
  if (ram[ObjTimer] !== 0) return;
  if (ram[Song] !== 0) return;
  UpdateWorldCurtainEffect_Bank2();
  if (ram[ObjX + 12] >= 0x11) return; // right curtain edge not in the middle yet
  ram[ObjTimer] = 0x80; // UNKNOWN: looks unneeded
  ram[GameSubmode]++;
}

/** InitMode13_Sub1 (Z_02): blank attribute row; reset the textbox. */
export function InitMode13_Sub1() {
  // InitMode13_Sub1 (Z_02)
  const t = table(bus.rom, 'PlayAreaAttr0TransferBuf');
  for (let y = 4; y >= 0; y--) ram[DynTileBuf + y] = t.byte(y);
  ram[TextboxCharPtr] = 0xa4; // front of the first textbox line
  ram[TextboxCharIndex] = 0x00;
  ram[ObjState + 1] = 0x00;
  ram[GameSubmode]++;
}

/** InitMode13_Sub2 (Z_02): Zelda's text; when done, wait $50 frames. */
export function InitMode13_Sub2() {
  // InitMode13_Sub2 (Z_02)
  UpdateZeldaTextbox();
  if (ram[ObjState + 1] === 0) return;
  ram[ObjTimer + 1] = 0x50;
  ram[GameSubmode]++;
}

/**
 * UpdateZeldaTextbox (Z_02): one character of ThanksText every 6 frames (ObjTimer[1]).
 * ObjState[1] becomes non-zero at the end of the text.
 */
export function UpdateZeldaTextbox() {
  // UpdateZeldaTextbox (Z_02)
  Link_EndMoveAndDraw();
  if (ram[ObjTimer + 1] !== 0) return; // LA9F4_Exit
  ram[ObjTimer + 1] = 0x06;
  const tpl = table(bus.rom, 'ThanksTextboxCharTransferRecTemplate');
  for (let y = 4; y >= 0; y--) ram[DynTileBuf + y] = tpl.byte(y);
  const text = label('ThanksText').addr;
  let y;
  let a;
  do {
    ram[DynTileBuf + 1] = ram[TextboxCharPtr];
    ram[TextboxCharPtr]++;
    ram[0x00] = text & 0xff;
    ram[0x01] = text >> 8;
    y = ram[TextboxCharIndex];
    ram[TextboxCharIndex]++;
    a = read((ram[0x00] | (ram[0x01] << 8)) + y) & 0x3f; // LDA ($00), Y
  } while (a === 0x25); // special space: takes room but no time
  ram[DynTileBuf + 3] = a;
  ram[Tune0Request] = 0x10; // "heart taken/character" tune
  a = read((ram[0x00] | (ram[0x01] << 8)) + y) & 0xc0;
  if (a === 0) return;
  // $80: second line, $40: third line, $C0: end of the text (first line).
  y = a === 0xc0 ? 0x02 : a === 0x40 ? 0x01 : 0x00;
  ram[TextboxCharPtr] = table(bus.rom, 'ThanksTextboxLineAddrsLo').byte(y);
  if (y !== 0x02) return;
  ram[ObjState + 1]++;
  ram[ObjState] = 0x00; // unhalt Link
}

/** InitMode13_Sub3 (Z_02): after the delay, silence. */
export function InitMode13_Sub3() {
  // InitMode13_Sub3 (Z_02)
  if (ram[ObjTimer + 1] !== 0) return; // LA9F4_Exit
  SilenceAllSound();
  ram[GameSubmode]++;
}

/** InitMode13_Sub4 (Z_02): start updating. */
export function InitMode13_Sub4() {
  // InitMode13_Sub4 (Z_02)
  ram[CreditsTileOffset] = 0x08;
  const a = BeginUpdateMode();
  ram[PeaceCharDelayCounter] = a;
  ram[PeaceCharIndex] = a;
  return HideAllSprites();
}

// ------------------------------------------------------------------ update

let updateHandlers;
export function UpdateMode13WinGame() {
  // UpdateMode13WinGame (Z_02)
  updateHandlers ??= [UpdateMode13WinGame_Sub0_Flash, UpdateMode13WinGame_Sub1, UpdateMode13WinGame_Sub1,
    UpdateMode13WinGame_Sub3, UpdateMode13WinGame_Sub4];
  return tableJump(label('UpdateMode13WinGame_JumpTable').addr, ram[GameSubmode], updateHandlers);
}

/** UpdateMode13WinGame_Sub0_Flash (Z_02): $C0 frames of Link and Zelda; flashing after $40. */
export function UpdateMode13WinGame_Sub0_Flash() {
  // UpdateMode13WinGame_Sub0_Flash (Z_02)
  HideAllSprites();
  ram[ItemLiftTimer]++;
  if (ram[ItemLiftTimer] === 0xc0) {
    // @AdvanceSubmode
    ram[SongRequest] = 0x10; // ending song
    ram[ObjTimer] = 0x40; // wait $40 frames before the text
    ram[EndingFlashLongTimer] = 0x40; // $280 frames for the next submode
    ram[GameSubmode]++;
  } else {
    DrawLinkZeldaTriforces();
  }
  // @ChangePalette
  let x = ram[ItemLiftTimer];
  if (x < 0x40) return; // don't flash until $40 frames have passed
  for (let y = 0x23; y >= 0; y--) ram[DynTileBuf + y] = read(LevelInfo_PalettesTransferBuf + y);
  x &= 0x03;
  ram[DynTileBuf + 19] = table(bus.rom, 'EndingFlashColors').byte(x); // background color
}

/** DrawLinkZeldaTriforces (Z_02): Link and Zelda lifting the triforces (slots $13 and 2). */
export function DrawLinkZeldaTriforces() {
  // DrawLinkZeldaTriforces (Z_02)
  ram[ObjX + 19] = ram[ObjX];
  ram[ObjY + 19] = (ram[ObjY] - 0x10) & 0xff;
  // Draw Link.
  let x = 0x00;
  let a = Anim_FetchObjPosForSpriteDescriptor(x);
  a = Anim_SetSpriteDescriptorAttributes(a);
  ram[0x0c] = a;
  ram[LeftSpriteOffset] = 0x48;
  ram[RightSpriteOffset] = 0x4c;
  Anim_WriteSpecificItemSprites(x, 0x21);
  // Triforce over Link.
  AnimateItemObject(0x1b, 0x13);
  x = 0x01;
  Anim_FetchObjPosForSpriteDescriptor(x);
  // Draw Zelda.
  DrawObjectMirrored(x, x); // TXA
  // Triforce over Zelda, $10 pixels above her.
  ram[ObjX + 2] = ram[ObjX + 1];
  ram[ObjY + 2] = (ram[ObjY + 1] - 0x10) & 0xff;
  AnimateItemObject(0x1b, 0x02);
}

/** UpdateMode13WinGame_Sub1 (Z_02, submodes 1 and 2): the peace text, then a delay. */
export function UpdateMode13WinGame_Sub1() {
  // UpdateMode13WinGame_Sub1 (Z_02)
  if (ram[EndingFlashLongTimer] === 0) {
    // @AdvanceSubmode: transfer the ending palette.
    ram[TileBufSelector] = 0x6a;
    ram[GameSubmode]++;
    return;
  }
  HideAllSprites();
  // Show Link and Zelda until the long timer reaches 4.
  if (ram[EndingFlashLongTimer] < 0x04) return;
  DrawLinkZeldaTriforces();
  if (ram[GameSubmode] !== 0x01) return; // submode 2: only delay
  if (ram[ObjTimer] !== 0) return; // delay before the text
  return UpdatePeaceTextbox();
}

/** UpdatePeaceTextbox (Z_02): one character of PeaceText every 8 frames; $FF = next submode. */
export function UpdatePeaceTextbox() {
  // UpdatePeaceTextbox (Z_02)
  ram[PeaceCharDelayCounter]++;
  if ((ram[PeaceCharDelayCounter] & 0x07) !== 0x04) return; // @Exit
  const tpl = table(bus.rom, 'PeaceTextboxCharTransferRecTemplate');
  for (let y = 4; y >= 0; y--) ram[DynTileBuf + y] = tpl.byte(y);
  const y = ram[PeaceCharIndex];
  let a = table(bus.rom, 'PeaceText').byte(y);
  if (a === 0xff) {
    // @AdvanceSubmode
    ram[GameSubmode]++;
    return;
  }
  ram[DynTileBuf + 3] = a;
  if (a !== 0x24) ram[Tune0Request] = 0x10; // a regular space makes no sound
  ram[PeaceCharIndex]++;
  a = table(bus.rom, 'PeaceTextboxCharAddrsLo').byte(y);
  ram[DynTileBuf + 1] = a;
  if (a >= 0xa0) return;
  ram[DynTileBuf] = 0x23; // the low VRAM address rolled over
}

/** UpdateMode13WinGame_Sub4 (Z_02): the triforce over Ganon's ashes; Start -> mode $D, quest 2. */
export function UpdateMode13WinGame_Sub4() {
  // UpdateMode13WinGame_Sub4 (Z_02)
  HideAllSprites();
  let x = 0x02;
  ram[ObjX + x] = 0x78;
  ram[ObjY + x] = 0x88;
  AnimateItemObject(0x0e, x); // triforce item ID
  x = 0x02; // the ash pile reuses slot 2
  ram[ObjType + x] = 0x3e; // Ganon
  DrawAshPile(x);
  if (ram[ObjTimer] !== 0) return; // LAB7E_Exit: don't skip ahead yet
  if ((ram[ButtonsPressed] & 0x10) === 0) return;
  EndGameMode();
  ram[GameMode] = 0x0d;
  TurnOffAllVideo();
  TurnOffVideoAndClearArtifacts();
  SilenceAllSound();
  return SwitchProfileToSecondQuest();
}

/** DrawAshPile (Z_02): X = object slot; Ganon's ashes frame. */
export function DrawAshPile(x) {
  // DrawAshPile (Z_02)
  Anim_FetchObjPosForSpriteDescriptor(x);
  return DrawObjectNotMirrored(0x0b, x);
}
