// P22 — bosses/gleeok (Z_04): Gleeok ($42-$45: 1-4 necks), its body, the necks (6 segments each, kept
// in per-neck arrays and loaded into slots 1-6 in turn) and the flying heads ($46) of the dead necks.
// X = object slot unless stated otherwise.
import { ram, word } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjType, ObjHP, ObjMetastate, ObjUninitialized, ObjInvincibilityMask, ObjShoveDir,
  ObjInvincibilityTimer, ObjAnimFrame, Sprites, Random, FrameCounter, SampleRequest, RollingSpriteIndex,
  FlyingMaxSpeedFrac, Flyer_ObjSpeed, Flyer_ObjFlyingState, Flyer_ObjDistTraveled,
  Gleeok_NeckXs0, Gleeok_NeckXs1, Gleeok_NeckXs2, Gleeok_NeckXs3,
  Gleeok_NeckYs0, Gleeok_NeckYs1, Gleeok_NeckYs2, Gleeok_NeckYs3,
  Gleook_HeadInfo0, Gleook_HeadInfo1, Gleook_HeadInfo2, Gleook_HeadInfo3,
  GLEEOK_SPEEDX, GLEEOK_SPEEDY, GLEEOK_DIRCOUNTERV, GLEEOK_DIRCOUNTERH, GLEEOK_DELAY,
  Gleeok_ObjHeadInfo, Gleeok_ObjHeadDirCounterH, Gleeok_ObjHeadDirCounterV, Gleeok_ObjHeadSpeedX,
  Gleeok_ObjHeadSpeedY, Gleeok_ObjHeadDirChangeCounter, Gleeok_ObjHeadDelay, Gleeok_WrithingCounter,
  GleeokCurNeck, GleeokSignedRefSegmentDistance, GleeokPrimarySegmentLimits,
  GleeokSecondarySegmentLimits, GleeokTertiarySegmentLimits, GleeokAnimationTimer,
  GleeokBodyAnimationFrame, GleeokDeadNeckMask,
} from '../../core/vars.js';
import { InitBlueKeese, Flyer_SetStateAndTurns } from '../enemies/keese-bubble.js';
import { MoveFlyer, Flyer_SpeedUp, Flyer_Chase, Flyer_Wander } from '../enemies/flyer.js';
import { ShootFireball } from '../enemies/shots.js';
import { PlayBossHitCryIfNeeded, PlayBossDeathCry } from '../enemies/common.js';
import { Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, DrawObjectMirrored } from '../draw/anim.js';
import {
  Anim_WriteSpecificSprite, Anim_WriteLevelPaletteSprite, CycleCurSpriteIndex, WriteBlankPrioritySprites,
} from '../draw/sprites.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { ResetObjMetastate } from '../objects/slots.js';
import { ResetShoveInfo, SetShoveInfoWith0 } from '../movement/shove.js';
import { Abs, Negate } from '../movement/math.js';

const tbl = (name) => table(bus.rom, name);

// ------------------------------------------------------------------ init

/**
 * InitGleeok (Z_04). Roar; 6 segments per neck at X $7C and GleeokSegmentYs (also slots 1-6), HP $A0,
 * weak only to the sword; speed flags, direction counters (V 3, H 6) and head delays (0/12/24/36).
 */
export function InitGleeok() {
  // InitGleeok (Z_04)
  ram[SampleRequest] = 0x10;
  const ys = tbl('GleeokSegmentYs');
  let x;
  for (x = 5; x >= 0; x--) {
    ram[Gleeok_NeckXs0 + x] = 0x7c;
    ram[Gleeok_NeckXs1 + x] = 0x7c;
    ram[Gleeok_NeckXs2 + x] = 0x7c;
    ram[Gleeok_NeckXs3 + x] = 0x7c;
    ram[ObjX + 1 + x] = 0x7c;
    const a = ys.byte(x);
    ram[Gleeok_NeckYs0 + x] = a;
    ram[Gleeok_NeckYs1 + x] = a;
    ram[Gleeok_NeckYs2 + x] = a;
    ram[Gleeok_NeckYs3 + x] = a;
    ram[ObjY + 1 + x] = a;
    ram[ObjHP + 1 + x] = 0xa0;
    ram[ObjMetastate + 1 + x] = 0x00;
    ram[ObjUninitialized + 2 + x] = 0x00; // +2 as in the original
    ram[ObjInvincibilityMask + 1 + x] = 0xfe;
  }
  x = 0xff;
  ram[Gleook_HeadInfo0 + GLEEOK_SPEEDX] = x;
  ram[Gleook_HeadInfo1 + GLEEOK_SPEEDY] = x;
  ram[Gleook_HeadInfo2 + GLEEOK_SPEEDX] = x;
  ram[Gleook_HeadInfo3 + GLEEOK_SPEEDY] = x;
  let a = 0x03;
  ram[Gleook_HeadInfo0 + GLEEOK_DIRCOUNTERV] = a;
  ram[Gleook_HeadInfo1 + GLEEOK_DIRCOUNTERV] = a;
  ram[Gleook_HeadInfo2 + GLEEOK_DIRCOUNTERV] = a;
  ram[Gleook_HeadInfo3 + GLEEOK_DIRCOUNTERV] = a;
  a <<= 1;
  ram[Gleook_HeadInfo0 + GLEEOK_DIRCOUNTERH] = a;
  ram[Gleook_HeadInfo1 + GLEEOK_DIRCOUNTERH] = a;
  ram[Gleook_HeadInfo2 + GLEEOK_DIRCOUNTERH] = a;
  ram[Gleook_HeadInfo3 + GLEEOK_DIRCOUNTERH] = a;
  a <<= 1;
  ram[Gleook_HeadInfo1 + GLEEOK_DELAY] = a;
  a <<= 1;
  ram[Gleook_HeadInfo2 + GLEEOK_DELAY] = a;
  ram[Gleook_HeadInfo3 + GLEEOK_DELAY] = a + ram[Gleook_HeadInfo1 + GLEEOK_DELAY]; // C = 0 after the ASL
}

/** InitGleeokHead (Z_04). X = flying head: like a blue keese, speed $BF, max $E0. */
export function InitGleeokHead(x) {
  // InitGleeokHead (Z_04)
  InitBlueKeese(x);
  ram[FlyingMaxSpeedFrac] = 0xe0;
  ram[Flyer_ObjSpeed + x] = 0xbf;
}

// ------------------------------------------------------------------ flying heads

/**
 * UpdateGleeokHead (Z_04). X = flying head: fly, sometimes shoot a fireball $56 (slot $B free), draw
 * and collide; it can neither be hurt nor die.
 */
export function UpdateGleeokHead(x) {
  // UpdateGleeokHead (Z_04)
  ControlGleeokHeadFlight(x);
  MoveFlyer(x);
  if ((ram[Flyer_ObjDistTraveled + x] & 0x01) === 0 && ram[Random + 1 + x] < 0x20 && ram[ObjType + 11] === 0) {
    ShootFireball(0x56, x);
  }
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x01, x);
  DrawObjectMirrored(ram[ObjAnimFrame + x], x);
  CheckMonsterCollisions(x);
  ResetObjMetastate(x);
  const a = SetShoveInfoWith0(0x00, x);
  ram[ObjInvincibilityTimer + x] = a;
}

/** ControlGleeokHeadFlight (Z_04). X = flying head: dispatch on the flying state. */
export function ControlGleeokHeadFlight(x) {
  // ControlGleeokHeadFlight (Z_04)
  return tableJump(label('ControlGleeokHeadFlight_JumpTable').addr, ram[Flyer_ObjFlyingState + x], [
    () => Flyer_SpeedUp(x), () => Flyer_GleeokHeadDecideState(x), () => Flyer_Chase(x), () => Flyer_Wander(x),
  ]);
}

/** Flyer_GleeokHeadDecideState (Z_04). X = head: state 2 (Random+1 < $D0) or 3, 6 turns. */
export function Flyer_GleeokHeadDecideState(x) {
  // Flyer_GleeokHeadDecideState (Z_04)
  let y = 0x02;
  if (ram[Random + 1 + x] >= 0xd0) y++;
  return Flyer_SetStateAndTurns(x, y);
}

// ------------------------------------------------------------------ body and necks

/**
 * UpdateGleeok (Z_04). Draws the body; for each live neck (last to first): load its segments into
 * slots 1-6, move it (one neck a frame, FrameCounter & 3) and maybe shoot from the head, draw and
 * collide, and store the segments back.
 */
export function UpdateGleeok() {
  // UpdateGleeok (Z_04)
  Gleeok_DrawBody();
  ram[GleeokCurNeck] = ram[ObjType + 1] - 0x42;
  do {
    // @LoopNeck
    const m = tbl('LevelMasks').byte(ram[GleeokCurNeck]);
    if ((m & ram[GleeokDeadNeckMask]) === 0) {
      let { x, y } = Gleeok_FetchNeckAddrs();
      // @LoadNeckBytes
      for (; y >= 0; y--) {
        ram[ObjX + 1 + y] = read((word(0x00) + y) & 0xffff);
        ram[ObjY + 1 + y] = read((word(0x02) + y) & 0xffff);
        ram[Gleeok_ObjHeadInfo + y] = read((word(0x04) + y) & 0xffff);
      }
      ram[0x00] = ram[FrameCounter] & 0x03;
      if (x === ram[0x00]) {
        Gleeok_MoveNeck();
        Gleeok_MoveHead();
        x = 0x05; // shoot from the head
        if (ram[Random + x] < 0x20 && ram[ObjType + 11] === 0) ShootFireball(0x56, x);
      }
      // @DrawAndCheckCollisions
      Gleeok_DrawHeadAndCheckCollisions();
      ({ y } = Gleeok_FetchNeckAddrs());
      // @SaveNeckBytes
      for (; y >= 0; y--) {
        write((word(0x00) + y) & 0xffff, ram[ObjX + 1 + y]);
        write((word(0x02) + y) & 0xffff, ram[ObjY + 1 + y]);
        write((word(0x04) + y) & 0xffff, ram[Gleeok_ObjHeadInfo + y]);
      }
    }
    // @NextLoopNeck
    ram[GleeokCurNeck]--;
  } while (!(ram[GleeokCurNeck] & 0x80));
}

/**
 * Gleeok_FetchNeckAddrs (Z_04). [00:01]/[02:03]/[04:05] = the current neck's X / Y / misc arrays.
 * @returns {{x:number, y:number}} X = neck index, Y = 5
 */
export function Gleeok_FetchNeckAddrs() {
  // Gleeok_FetchNeckAddrs (Z_04)
  const x = ram[GleeokCurNeck];
  ram[0x00] = tbl('GleeokNeckXAddrsLo').byte(x);
  ram[0x01] = tbl('GleeokNeckXAddrsHi').byte(x);
  ram[0x02] = tbl('GleeokNeckYAddrsLo').byte(x);
  ram[0x03] = tbl('GleeokNeckYAddrsHi').byte(x);
  ram[0x04] = tbl('GleeokNeckMiscAddrsLo').byte(x);
  ram[0x05] = tbl('GleeokNeckMiscAddrsHi').byte(x);
  return { x, y: 0x05 };
}

/**
 * L_Gleeok_UDiv4 (Z_04, part of Gleeok_FetchNeckAddrs). A = non-negative distance: LSR / LSR, then
 * JMP L_Gleeok_StoreRefSegDistance (whose Abs sees N = 0 from the LSR).
 */
export function L_Gleeok_UDiv4(a) {
  return L_Gleeok_StoreRefSegDistance((a & 0xff) >> 2);
}

/** Gleeok_MoveNeck (Z_04). Signed quarter of the head-base H distance, then L_Gleeok_StoreRefSegDistance. */
export function Gleeok_MoveNeck() {
  // Gleeok_MoveNeck (Z_04)
  let a = (ram[ObjX + 5] - ram[ObjX + 1]) & 0xff;
  if (!(a & 0x80)) return L_Gleeok_UDiv4(a); // BPL
  a = Negate(Negate(a) >> 2);
  return L_Gleeok_StoreRefSegDistance(a); // falls through
}

/**
 * L_Gleeok_StoreRefSegDistance (Z_04). A = signed reference distance. Computes the segment limits,
 * keeps neighbors within the tertiary limits, stretches/contracts, pulls the middle segments towards
 * their reference X and keeps slots 3-4 between their neighbors vertically.
 */
export function L_Gleeok_StoreRefSegDistance(a) {
  // L_Gleeok_StoreRefSegDistance (Z_04)
  ram[GleeokSignedRefSegmentDistance] = a;
  a = Abs(a);
  let x = 0x00;
  Gleeok_CalcSegmentLimits(a, x);
  a = Abs((ram[ObjY + 5] - ram[ObjY + 1]) & 0xff) >> 2;
  x++;
  Gleeok_CalcSegmentLimits(a, x);

  // @KeepSegsNearNeighbors
  for (x = 0; x !== 4; x++) {
    a = Abs((ram[ObjX + 1 + x] - ram[ObjX + 2 + x]) & 0xff);
    if (a >= ram[GleeokTertiarySegmentLimits]) {
      a = ram[ObjX + 2 + x];
      let y = (a + 2) & 0xff;
      if (a >= ram[ObjX + 1 + x]) y = (y - 4) & 0xff;
      ram[ObjX + 2 + x] = y;
    }
    // @CheckDistanceV
    a = Abs((ram[ObjY + 1 + x] - ram[ObjY + 2 + x]) & 0xff);
    if (a >= ram[GleeokTertiarySegmentLimits + 1]) {
      a = ram[ObjY + 2 + x];
      let y = (a + 2) & 0xff;
      if (a >= ram[ObjY + 1 + x]) y = (y - 4) & 0xff;
      ram[ObjY + 2 + x] = y;
    }
  }

  for (x = 0; x < 3; x++) Gleeok_StretchNeck(x);

  // @KeepSegsNearRefPoint
  for (x = 2; x >= 0; x--) {
    a = ram[ObjX + 1];
    for (let y = x; y >= 0; y--) a = (a + ram[GleeokSignedRefSegmentDistance]) & 0xff;
    let y = (ram[ObjX + 2 + x] + 1) & 0xff;
    if (a < ram[ObjX + 2 + x]) y = (y - 2) & 0xff;
    ram[ObjX + 2 + x] = y;
  }

  // @KeepSegsBetweenNeighbors
  for (x = 1; x >= 0; x--) {
    a = ram[ObjY + 3 + x];
    if (a < ram[ObjY + 2 + x]) {
      if (a >= ram[ObjY + 4 + x]) continue;
      ram[ObjY + 3 + x]++;
    } else {
      if (a < ram[ObjY + 4 + x]) continue;
      ram[ObjY + 3 + x]--;
    }
  }
}

/**
 * Gleeok_CalcSegmentLimits (Z_04). A = primary distance, X = 0 (H) / 1 (V): primary (cap 4), secondary
 * (+4, cap 8), tertiary (+4, cap $B). @returns A
 */
export function Gleeok_CalcSegmentLimits(a, x) {
  // Gleeok_CalcSegmentLimits (Z_04)
  if (a >= 0x04) a = 0x04;
  ram[GleeokPrimarySegmentLimits + x] = a;
  a = (a + 0x04) & 0xff;
  if (a >= 0x08) a = 0x08;
  ram[GleeokSecondarySegmentLimits + x] = a;
  a = (a + 0x04) & 0xff;
  if (a >= 0x0b) a = 0x0b;
  ram[GleeokTertiarySegmentLimits + x] = a;
  return a;
}

/**
 * Gleeok_StretchNeck (Z_04). X = segment 0-2 (slots 2-4): routine index from the distances to the next
 * segment (the H distance is always 0: the original subtracts ObjX+3,X from itself).
 */
export function Gleeok_StretchNeck(x) {
  // Gleeok_StretchNeck (Z_04)
  let y = 0;
  let a = Abs((ram[ObjX + 3 + x] - ram[ObjX + 3 + x]) & 0xff);
  if (a >= ram[GleeokPrimarySegmentLimits]) y++;
  if (a >= ram[GleeokSecondarySegmentLimits]) y++; // unverified code 12658
  a = Abs((ram[ObjY + 3 + x] - ram[ObjY + 2 + x]) & 0xff);
  if (a >= ram[GleeokPrimarySegmentLimits + 1]) y += 3;
  if (a >= ram[GleeokSecondarySegmentLimits + 1]) y += 3;
  const ex = () => Gleeok_ExpandSegment(x);
  const ig = () => Gleeok_IgnoreSegment();
  const cx = () => Gleeok_ContractSegmentX(x);
  const cy = () => Gleeok_ContractSegmentY(x);
  return tableJump(label('Gleeok_StretchNeck_JumpTable').addr, y, [ex, ig, cx, ig, ig, cx, cy, cy, () => Gleeok_ContractSegment(x)]);
}

/** Gleeok_ExpandSegment (Z_04). X = segment: move 2 pixels away from the next one, H or V at random. */
export function Gleeok_ExpandSegment(x) {
  // Gleeok_ExpandSegment (Z_04)
  if (!(ram[Random] & 0x80)) return L_Gleeok_ExpandHorizontally(x);
  const a = ram[ObjY + 2 + x];
  const y = (a + 2) & 0xff;
  if (a > ram[ObjY + 3 + x]) return L_Gleeok_SetSegmentY(x, y);
  return L_Gleeok_DecSegmentY(x, y);
}

/** L_Gleeok_DecSegmentY (Z_04, part of Gleeok_ExpandSegment). Y -= 4, then set. */
export function L_Gleeok_DecSegmentY(x, y) {
  return L_Gleeok_SetSegmentY(x, (y - 4) & 0xff);
}

/** L_Gleeok_SetSegmentY (Z_04, part of Gleeok_ExpandSegment). ObjY+2,X = Y. */
export function L_Gleeok_SetSegmentY(x, y) {
  ram[ObjY + 2 + x] = y;
  return Gleeok_IgnoreSegment(); // falls through
}

/** Gleeok_IgnoreSegment (Z_04): RTS. */
export function Gleeok_IgnoreSegment() {
  // Gleeok_IgnoreSegment (Z_04)
}

/** Gleeok_ContractSegmentY (Z_04). X = segment: move 2 pixels towards the next one vertically. */
export function Gleeok_ContractSegmentY(x) {
  // Gleeok_ContractSegmentY (Z_04)
  const a = ram[ObjY + 2 + x];
  const y = (a + 2) & 0xff;
  if (a <= ram[ObjY + 3 + x]) return L_Gleeok_SetSegmentY(x, y);
  return L_Gleeok_DecSegmentY(x, y);
}

/** L_Gleeok_ExpandHorizontally (Z_04, part of Gleeok_ContractSegmentY). Away from the next one in X. */
export function L_Gleeok_ExpandHorizontally(x) {
  const a = ram[ObjX + 2 + x];
  const y = (a + 2) & 0xff;
  if (a >= ram[ObjX + 3 + x]) return L_Gleeok_SetSegmentX(x, y);
  return L_Gleeok_DecSegmentX(x, y);
}

/** Gleeok_ContractSegmentX (Z_04, unverified). X = segment: towards the next one horizontally. */
export function Gleeok_ContractSegmentX(x) {
  // Gleeok_ContractSegmentX (Z_04)
  const a = ram[ObjX + 2 + x];
  const y = (a + 2) & 0xff;
  if (a < ram[ObjX + 3 + x]) return L_Gleeok_SetSegmentX(x, y);
  return L_Gleeok_DecSegmentX(x, y); // falls through
}

/** L_Gleeok_DecSegmentX (Z_04, part of Gleeok_ContractSegmentX). Y -= 4, then set. */
export function L_Gleeok_DecSegmentX(x, y) {
  return L_Gleeok_SetSegmentX(x, (y - 4) & 0xff);
}

/** L_Gleeok_SetSegmentX (Z_04, part of Gleeok_ContractSegmentX). ObjX+2,X = Y. */
export function L_Gleeok_SetSegmentX(x, y) {
  ram[ObjX + 2 + x] = y;
}

/** Gleeok_ContractSegment (Z_04, unverified). X = segment: contract H or V at random. */
export function Gleeok_ContractSegment(x) {
  // Gleeok_ContractSegment (Z_04)
  if (!(ram[Random] & 0x80)) return Gleeok_ContractSegmentX(x);
  return Gleeok_ContractSegmentY(x);
}

/**
 * Gleeok_WriteHeadOrBaseSpriteAndCheckCollisions (Z_04, part of Gleeok_ContractSegment). A = tile,
 * X = 5 (head) or 1 (base): one of the first 16 sprites (neck * 8, +$20 for the base), level row 3.
 */
export function Gleeok_WriteHeadOrBaseSpriteAndCheckCollisions(a, x) {
  ram[0x03] = 0x03;
  const tile = a; // PHA
  let o = (ram[GleeokCurNeck] << 3) & 0xff;
  if (x !== 0x05) o = (o + 0x20) & 0xff;
  Anim_WriteSpecificSprite(tile, x, o);
  return Gleeok_CheckCollisions(x);
}

/** Gleeok_DrawHeadAndCheckCollisions (Z_04). Segments from the head (slot 5) down to the base. */
export function Gleeok_DrawHeadAndCheckCollisions() {
  // Gleeok_DrawHeadAndCheckCollisions (Z_04)
  return Gleeok_DrawSegmentAndCheckCollisions(0x05);
}

/** Gleeok_DrawSegmentAndCheckCollisions (Z_04). X = segment slot: head $DC / neck $DA, then collide. */
export function Gleeok_DrawSegmentAndCheckCollisions(x) {
  // Gleeok_DrawSegmentAndCheckCollisions (Z_04)
  const a = x === 0x05 ? 0xdc : 0xda;
  if (x === 0x05 || x === 0x01) return Gleeok_WriteHeadOrBaseSpriteAndCheckCollisions(a, x);
  Anim_WriteLevelPaletteSprite(a, x);
  return Gleeok_CheckCollisions(x); // falls through
}

/**
 * Gleeok_CheckCollisions (Z_04). X = segment slot. Head and base collide (hit: writhe); the base never
 * dies. A dead head becomes a flying head (slot neck + 7), its sprites are hidden and the neck is marked
 * dead; when all necks are dead the boss dies. Then the next segment down (loop until slot 1).
 */
export function Gleeok_CheckCollisions(x) {
  // Gleeok_CheckCollisions (Z_04)
  if (x === 0x05 || x === 0x01) {
    CheckMonsterCollisions(x);
    if (ram[ObjShoveDir + x] !== 0) {
      ram[GleeokAnimationTimer] = 0x06;
      ram[Gleeok_WrithingCounter] = 0x06;
    }
    ResetShoveInfo(x);
    if (x === 0x01) {
      ResetObjMetastate(x); // @ResetMetastate
    } else {
      PlayBossHitCryIfNeeded(x);
      if (ram[ObjMetastate + x] !== 0) return gleeokNeckDied(x);
    }
  }
  // @NextLoopSegment
  x = (x - 1) & 0xff;
  if (x < 0x01) return L127FA_Exit();
  return Gleeok_DrawSegmentAndCheckCollisions(x);
}

/** The neck of segment X died (part of Gleeok_CheckCollisions). */
function gleeokNeckDied(x) {
  ram[ObjHP + x] = 0x60;
  const saved = x; // TXA / PHA
  if (x === 0x05) {
    const s = (ram[GleeokCurNeck] + 0x07) & 0xff;
    ram[ObjUninitialized + s] = 0xff;
    ram[(ObjX + s) & 0xff] = ram[ObjX + 5]; // zero-page,X: wraps in page 0
    ram[(ObjY + s) & 0xff] = ram[ObjY + 5];
    ram[ObjType + s] = 0x46;
  }
  // @DestroyNeck
  x = saved;
  let y = (ram[GleeokCurNeck] << 3) & 0xff;
  ram[Sprites + y] = 0xf8;
  ram[Sprites + 32 + y] = 0xf8;
  const mask = tbl('LevelMasks').byte(ram[GleeokCurNeck]) | ram[GleeokDeadNeckMask];
  ram[GleeokDeadNeckMask] = mask;
  ram[0x00] = mask;
  let a = 0;
  for (y = 4; y !== 0; y--) {
    const c = ram[0x00] & 1; // LSR $00
    ram[0x00] >>= 1;
    a = (a + c) & 0xff; // ADC #0
  }
  ram[0x00] = a;
  if (((ram[ObjType + 1] - 0x41) & 0xff) !== ram[0x00]) return ResetObjMetastate(x);
  // @BossDied
  WriteBlankPrioritySprites();
  PlayBossDeathCry();
  ram[ObjMetastate + 1] = 0x11;
  for (y = 0x01; y < 0x0a; y++) ram[ObjType + 1 + y] = 0x00;
}

/**
 * Gleeok_MoveHead (Z_04). After its delay, moves the head (slot 5) one pixel per axis by the speed
 * flags; every 4 calls advances the direction counters (H flips at $C, V at 6).
 */
export function Gleeok_MoveHead() {
  // Gleeok_MoveHead (Z_04)
  if (ram[Gleeok_ObjHeadDelay] !== 0) return Gleeok_DecHeadTimer();
  ram[ObjX + 5] = Gleeok_ChangeCoordinateBySpeedFlag(ram[ObjX + 5], ram[Gleeok_ObjHeadSpeedX]);
  ram[ObjY + 5] = Gleeok_ChangeCoordinateBySpeedFlag(ram[ObjY + 5], ram[Gleeok_ObjHeadSpeedY]);
  ram[Gleeok_ObjHeadDirChangeCounter]++;
  if (ram[Gleeok_ObjHeadDirChangeCounter] < 0x04) return L127FA_Exit();
  ram[Gleeok_ObjHeadDirChangeCounter] = 0x00;
  ram[Gleeok_ObjHeadDirCounterH]++;
  if (ram[Gleeok_ObjHeadDirCounterH] >= 0x0c) {
    ram[Gleeok_ObjHeadDirCounterH] = 0x00;
    ram[Gleeok_ObjHeadSpeedX] ^= 0xff;
  }
  // @CheckVertical
  ram[Gleeok_ObjHeadDirCounterV]++;
  if (ram[Gleeok_ObjHeadDirCounterV] < 0x06) return L127FA_Exit();
  ram[Gleeok_ObjHeadDirCounterV] = 0x00;
  ram[Gleeok_ObjHeadSpeedY] ^= 0xff;
  return L127FA_Exit();
}

/** L127FA_Exit (Z_04, part of Gleeok_MoveHead): RTS. */
export function L127FA_Exit() {}

/** Gleeok_DecHeadTimer (Z_04, part of Gleeok_MoveHead). */
export function Gleeok_DecHeadTimer() {
  ram[Gleeok_ObjHeadDelay]--;
}

/** Gleeok_ChangeCoordinateBySpeedFlag (Z_04). A = value, Y = flag (0: +1, else -1). @returns A */
export function Gleeok_ChangeCoordinateBySpeedFlag(a, y) {
  // Gleeok_ChangeCoordinateBySpeedFlag (Z_04)
  if (y !== 0) return (a - 1) & 0xff;
  return (a + 1) & 0xff;
}

/** L_Gleeok_DecAnimTimerAndDraw (Z_04, part of Gleeok_DrawBody). */
export function L_Gleeok_DecAnimTimerAndDraw() {
  ram[GleeokAnimationTimer]--;
  return L_Gleeok_WriteSprites();
}

/** Gleeok_DrawBody (Z_04). Animation timer ($10, or 6 while writhing), 4 frames, then the sprites. */
export function Gleeok_DrawBody() {
  // Gleeok_DrawBody (Z_04)
  if (ram[GleeokAnimationTimer] !== 0) return L_Gleeok_DecAnimTimerAndDraw();
  let a = 0x10;
  if (ram[Gleeok_WrithingCounter] !== 0) {
    ram[Gleeok_WrithingCounter]--;
    a = 0x06;
  }
  ram[GleeokAnimationTimer] = a;
  ram[GleeokBodyAnimationFrame] = (ram[GleeokBodyAnimationFrame] + 1) & 0x03;
  return L_Gleeok_WriteSprites(); // falls through
}

/**
 * L_Gleeok_WriteSprites (Z_04). The 3x2 body sprites at ($74 + col*8, $57 + row*$10) with rolling
 * sprite records; palette row 3, cycling while slot 5 is invincible. @returns X = next tile index
 */
export function L_Gleeok_WriteSprites() {
  // L_Gleeok_WriteSprites (Z_04)
  const offsets = tbl('SpriteOffsets');
  const tiles = tbl('GleeokBodyTiles0');
  ram[0x06] = 0x00;
  let x = tbl('GleeokBodyBaseTileOffsets').byte(ram[GleeokBodyAnimationFrame]);
  do {
    ram[0x07] = 0x00;
    do {
      const y = offsets.byte(ram[RollingSpriteIndex]);
      let v = ram[0x06];
      ram[Sprites + y] = (((v << 4) & 0xff) + 0x57 + ((v >> 4) & 1)) & 0xff; // ASL x4 / ADC (carry = bit 4)
      ram[Sprites + 1 + y] = tiles.byte(x);
      let a = ram[ObjInvincibilityTimer + 5];
      if (a === 0) a = 0x03;
      ram[Sprites + 2 + y] = a & 0x03;
      v = ram[0x07];
      ram[Sprites + 3 + y] = (((v << 3) & 0xff) + 0x74 + ((v >> 5) & 1)) & 0xff; // ASL x3 / ADC (carry = bit 5)
      x = (x + 1) & 0xff;
      CycleCurSpriteIndex();
      ram[0x07]++;
    } while (ram[0x07] < 0x03);
    ram[0x06]++;
  } while (ram[0x06] < 0x02);
  return x;
}
