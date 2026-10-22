// P09 weapons — the sword shot and the magic (rod) shot in slot $0E (Z_07): moving, drawing,
// being blocked (spread for the sword shot, a fire for the magic shot with the book) and the
// spreading sword shot. DrawSwordShotOrMagicShot also draws the monsters' sword/magic shots.

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjState, ObjGridOffset, ObjDir, ObjX, ObjY, ObjType, ObjTimer, FrameCounter, InvBook, UsedCandle,
  CurLevel,
} from '../../core/vars.js';
import { GetOppositeDir, Negate } from '../movement/math.js';
import { Anim_SetSpriteDescriptorAttributes } from '../draw/sprites.js';
import { Anim_WriteItemSprites } from '../draw/items.js';
import { Anim_FetchObjPosForSpriteDescriptor } from '../draw/anim.js';
import { MoveShot } from '../enemies/shots.js';
import { WieldCandle } from './fire.js';
import { ResetObjState } from './sword.js';

/** UpdateSwordShotOrMagicShot (Z_07). X = $0E. Moves (or spreads) the shot and draws it. */
export function UpdateSwordShotOrMagicShot(x) {
  // UpdateSwordShotOrMagicShot (Z_07)
  const a = ram[ObjState + x];
  if (a === 0) return; // L1F36A_Exit
  if (a & 0x01) return SpreadShot(x);
  // (LDA ObjGridOffset, X / BNE :+ / : is a no-op)
  MoveShot(ram[ObjDir + x], x);
  if (ram[0x0f] === 0) return HandleShotBlocked(x);
  if ((ram[ObjGridOffset + x] & 0x07) === 0) ram[ObjGridOffset + x] = 0x00;
  return DrawSwordShotOrMagicShot(x); // falls through
}

/**
 * DrawSwordShotOrMagicShot (Z_07). X = shot slot (Link's $0E or a monster's). Flashing palette;
 * item slot $22 (sword shot) or $23 (magic shot). @returns X = [08]
 */
export function DrawSwordShotOrMagicShot(x) {
  // DrawSwordShotOrMagicShot (Z_07)
  Anim_FetchObjPosForSpriteDescriptor(x);
  const dir = ram[ObjDir + x]; // PHA
  if (dir & 0x03) ram[0x01] = ram[0x01] + 0x03; // horizontal: 3 pixels down
  // @Flash (PLA)
  let y = GetOppositeDir(dir).y;
  Anim_SetSpriteDescriptorAttributes(
    (ram[FrameCounter] & 0x03) | table(bus.rom, 'RDirectionToWeaponBaseAttribute').byte(y));
  ram[0x0c] = table(bus.rom, 'RDirectionToWeaponFrame').byte(y);
  if (y === 0x02) ram[0x0f]++;
  y = 0x22;
  if (x >= 0x0d) {
    // @PlayerShot: magic shot when the state's high bit is set
    if (ram[ObjState + x] & 0x80) y = 0x23;
  } else if (ram[ObjType + x] !== 0x57) {
    y = 0x23; // @WriteMagicSprites
  }
  // @WriteSprites
  return Anim_WriteItemSprites(x, y);
}

/**
 * HandleShotBlocked (Z_07). X = shot slot ($0E). A sword shot starts spreading; a magic shot makes
 * a standing fire where it is (with the book, if a fire slot is free) and is deactivated.
 */
export function HandleShotBlocked(x) {
  // HandleShotBlocked (Z_07)
  if ((ram[ObjState + x] & 0x80) === 0) return SetShotSpreadingState(x);
  // Magic shot.
  if (ram[InvBook] === 0) return DeactivateShot(x);
  // Make a fire with the candle unused; keep Link's state and UsedCandle.
  const linkState = ram[ObjState]; // PHA
  const usedCandle = ram[UsedCandle]; // PHA
  ram[UsedCandle] = 0x00;
  x = WieldCandle();
  ram[UsedCandle] = usedCandle; // PLA
  ram[ObjState] = linkState; // PLA
  if (ram[ObjState + x] !== 0x21) return DeactivateLinkShot();
  ram[ObjState + x]++; // $22: standing fire
  const y = 0x0e;
  ram[ObjX + x] = ram[ObjX + y];
  ram[ObjY + x] = ram[ObjY + y];
  ram[ObjDir + x] = ram[ObjDir + y];
  ram[ObjTimer + x] = 0x4f;
  return DeactivateLinkShot(); // falls through
}

/** DeactivateLinkShot (Z_07): ResetObjState of slot $0E. @returns A = 0 */
export function DeactivateLinkShot() {
  // DeactivateLinkShot (Z_07)
  return DeactivateShot(0x0e); // falls through
}

/** DeactivateShot (Z_07, label inside HandleShotBlocked). X = shot. @returns A = 0 */
function DeactivateShot(x) {
  return ResetObjState(x); // JMP ResetObjState
}

/**
 * SetShotSpreadingState (Z_07, label inside HandleShotBlocked). X = sword shot: state with the low
 * bit set (spreading); [98][X] (ObjDir) = base negative offset -2.
 */
function SetShotSpreadingState(x) {
  ram[ObjState + x]++;
  ram[ObjDir + x] = 0xfe;
}

/**
 * SpreadShot (Z_07). X = $0E. Draws the 4 corners of the spreading sword shot around its position,
 * [98][X] being the (negative) offset; deactivates it once the offset reaches $E8.
 */
export function SpreadShot(x) {
  // SpreadShot (Z_07)
  ram[0x02] = ram[ObjDir + x];
  ram[0x03] = ram[ObjDir + x];
  ram[0x0f] = 0x00;
  const baseAttr = table(bus.rom, 'SwordShotSpreadBaseAttr');
  for (let y = 0x03; ;) {
    // @DrawShotCorner
    const index = y; // TYA / PHA
    const offX = ram[0x02]; // PHA
    const offY = ram[0x03]; // PHA
    Anim_SetSpriteDescriptorAttributes((ram[FrameCounter] & 0x03) | baseAttr.byte(y));
    let a = (ram[ObjX + x] + ram[0x02]) & 0xff;
    ram[0x00] = a;
    let draw = true;
    if (a >= ram[ObjX + x]) {
      if (a >= 0xfc) draw = false;
      else a = (a - ram[ObjX + x]) & 0xff;
    } else {
      a = (ram[ObjX + x] - ram[0x00]) & 0xff; // @ReverseSub
    }
    // @CheckDistance
    if (draw && a >= 0x20) draw = false;
    if (draw) {
      a = (ram[ObjY + x] + ram[0x03]) & 0xff;
      ram[0x01] = a;
      if (ram[CurLevel] !== 0 && (a < 0x3e || a >= 0xe8)) draw = false;
    }
    if (draw) {
      // @Draw: frame 2 (spread shot) of item slot $23
      ram[0x0c] = 0x02;
      Anim_WriteItemSprites(x, 0x23);
    }
    // @NextCorner
    ram[0x03] = offY; // PLA
    ram[0x02] = offX; // PLA
    // Negate [03], [02], [03] in turns (index 0 negates [00]: "doesn't matter", but it is written).
    y = index === 0x01 ? 0x03 : index;
    ram[0x00 + y] = Negate(ram[0x00 + y]);
    y = index - 1;
    if (y < 0) break;
  }
  ram[ObjDir + x]--;
  if (ram[ObjDir + x] !== 0xe8) return; // L1F49F_Exit
  return DeactivateLinkShot();
}
