// Mode $10: stairs, entering a level or a cave, warps (Z_05 InitMode10, UpdateMode10Stairs_Full,
// AnimateAndDrawLinkBehindBackground, PutLinkBehindBackground). Package P13.

import { ram } from '../../core/ram.js';
import { $br } from '../../core/timing.js';
import {
  SongEnvelopeSelector, EffectRequest, ObjY, StairsTargetY, IsUpdatingMode, ObjCollidedTile,
  FrameCounter, TargetMode, GameMode, Sprites,
} from '../../core/vars.js';
import { GetCollidableTileStill } from '../movement/tiles.js';
import { EndGameMode } from './dispatch.js';
import { Link_EndMoveAndAnimate } from '../link/anim.js';

export function InitMode10() {
  // InitMode10 (Z_05)
  const a = GetCollidableTileStill(0x00); // the tile Link stands on (hotspot)
  if (!$br('Z_05:1398', a !== 0x24)) {
    // A cave or dungeon entrance (not a stairs tile).
    ram[SongEnvelopeSelector] = 0x00; // TODO in the asm: ?
    ram[EffectRequest] = 0x08; // stairs effect
    ram[StairsTargetY] = (ram[ObjY] + 0x10) & 0xff; // target $10 pixels below
  }
  ram[IsUpdatingMode]++;
}

export function UpdateMode10Stairs_Full() {
  // UpdateMode10Stairs_Full (Z_05)
  if (!$br('Z_05:2310', ram[ObjCollidedTile] !== 0x24)) {
    // Move Link down 1 pixel every 4 frames until StairsTargetY.
    if ($br('Z_05:2315', (ram[FrameCounter] & 0x03) !== 0)) return AnimateAndDrawLinkBehindBackground();
    ram[ObjY]++;
    if ($br('Z_05:2319', ram[ObjY] !== ram[StairsTargetY])) return AnimateAndDrawLinkBehindBackground();
  }
  ram[GameMode] = ram[TargetMode]; // go to the target mode
  EndGameMode();
  return AnimateAndDrawLinkBehindBackground(); // falls through
}

export function AnimateAndDrawLinkBehindBackground() {
  // AnimateAndDrawLinkBehindBackground (Z_05)
  Link_EndMoveAndAnimate();
  return PutLinkBehindBackground(); // falls through
}

/** PutLinkBehindBackground (Z_05): Link's sprites $12 and $13 behind the background. */
export function PutLinkBehindBackground() {
  // PutLinkBehindBackground (Z_05)
  ram[Sprites + 74] |= 0x20;
  ram[Sprites + 78] |= 0x20;
}
