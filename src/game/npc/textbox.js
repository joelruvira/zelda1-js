// P15 npc — person textbox (Z_01): the character-by-character text shown by cave people,
// underworld people and Grumble, and the state helpers shared by all the person objects.

import { ram, word } from '../../core/ram.js';
import { bus, read } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjTimer, ObjState, DynTileBuf, PersonTextPtr, PersonTextSelector, PersonTextIndex, Tune0Request,
  Tune1Request, TileBufSelector,
} from '../../core/vars.js';
import { Link_EndMoveAndDraw_Bank1 } from '../link/anim.js';
import { UnhaltLink } from './cave.js';

/** UpdatePersonState_Textbox (Z_01): every 6 frames transfer the next character of the person text. */
export function UpdatePersonState_Textbox() {
  // UpdatePersonState_Textbox (Z_01)
  Link_EndMoveAndDraw_Bank1();
  if (ram[ObjTimer + 1] !== 0) return;
  ram[ObjTimer + 1] = 0x06;
  const template = table(bus.rom, 'TextboxCharTransferRecTemplate');
  for (let y = 0x04; y >= 0; y--) ram[DynTileBuf + y] = template.byte(y);
  const addrs = table(bus.rom, 'PersonTextAddrs');
  let a;
  let y;
  // @WriteChar: special spaces ($25) take room but no time.
  do {
    ram[DynTileBuf + 1] = ram[PersonTextPtr];
    ram[PersonTextPtr]++;
    y = ram[PersonTextSelector];
    ram[0x00] = addrs.byte(y);
    y = (y + 1) & 0xff;
    ram[0x01] = addrs.byte(y);
    y = ram[PersonTextIndex];
    ram[PersonTextIndex]++;
    a = read((word(0x00) + y) & 0xffff) & 0x3f; // LDA ($00), Y (bank 1)
  } while (a === 0x25);
  ram[DynTileBuf + 3] = a;
  ram[Tune0Request] = 0x10; // "heart taken/character"
  a = read((word(0x00) + y) & 0xffff) & 0xc0;
  if (a === 0) return;
  // $80: next line 2, $40: line 3, $C0: end of the text (back to line 1).
  y = 0x02;
  if (a !== 0xc0) {
    y--;
    if (a !== 0x40) y--;
  }
  // @ChangeLine
  ram[PersonTextPtr] = table(bus.rom, 'TextboxLineAddrsLo').byte(y);
  if (y !== 0x02) return;
  ram[ObjState + 1]++;
  UnhaltLink();
}

/** CueTransferBufAndAdvanceState (Z_01): A = transfer buffer selector. Falls into IncCaveState. */
export function CueTransferBufAndAdvanceState(a) {
  // CueTransferBufAndAdvanceState (Z_01)
  ram[TileBufSelector] = a;
  return IncCaveState();
}

/** IncCaveState (Z_01, label inside CueTransferBufAndAdvanceState): next person state. */
export function IncCaveState() {
  // IncCaveState (Z_01)
  ram[ObjState + 1]++;
}

/** UpdatePersonState_CueTransferBlankPersonWares (Z_01): selector $2A (also blanks text line 3). */
export function UpdatePersonState_CueTransferBlankPersonWares() {
  // UpdatePersonState_CueTransferBlankPersonWares (Z_01)
  return CueTransferBufAndAdvanceState(0x2a);
}

/** PlayCharacterSfx (Z_01): "item taken/character" tune. */
export function PlayCharacterSfx() {
  // PlayCharacterSfx (Z_01)
  ram[Tune1Request] = 0x08;
}
