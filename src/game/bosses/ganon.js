// P22 — bosses/ganon (Z_04, plus the palette-row helpers of Z_01): Ganon's scene (lifting the triforce
// in the dark, then in the light), the fight (invisible blue Ganon, visible after a sword hit, brown
// and vulnerable to the silver arrow after losing his HP), his death (burst rays, clouds, ashes) and
// the triforce of power. X = object slot in every routine.
import { ram, cpu } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  ObjX, ObjY, ObjType, ObjState, ObjTimer, ObjMetastate, ObjHP, ObjInvincibilityMask,
  ObjInvincibilityTimer, ObjRemDistance, ObjDir, ItemTypeToLift, BrighteningRoom, FadeCycle,
  SongRequest, SampleRequest, Tune1Request, FrameCounter, CurObjIndex, DynTileBuf, DynTileBufLen,
  InvArrow, Ganon_ScenePhase, Ganon_ObjAnimationFrame, Ganon_ObjPhase, Ganon_ObjCloudDist,
} from '../../core/vars.js';
import { UpdateCandle } from '../weapons/fire.js';
import { PlaySample } from '../audio/requests.js';
import { ResetObjMetastate, ResetObjMetastateAndTimer } from '../objects/slots.js';
import { PlayBossHitCryIfNeeded, PlayBossDeathCry } from '../enemies/common.js';
import { BlueWizzrobe_TurnSometimesAndMoveAndCheckTile, BlueWizzrobe_Move } from '../enemies/wizzrobe.js';
import { ShootFireball } from '../enemies/shots.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectMirrored, DrawObjectNotMirrored } from '../draw/anim.js';
import { Anim_WriteSprite } from '../draw/sprites.js';
import {
  CheckLinkCollisionPreinit, CheckMonsterSwordCollision, CheckMonsterArrowOrRodCollision,
} from '../combat/collisions.js';
import { ResetShoveInfoAndInvincibilityTimer } from '../combat/damage.js';
import { GetRoomFlagUWItemState } from '../items/roomitem.js';

const tbl = (name) => table(bus.rom, name);

// ------------------------------------------------------------------ Z_01 palette row 7

/**
 * Appends an 8-byte palette-row-7 record (template `record`) to DynTileBuf and overwrites the colors
 * at the ABSOLUTE offsets DynTileBuf+4..+6 (as the original) with `colors` ending at index y.
 * @returns X = CurObjIndex (the routines end with LDX CurObjIndex); leaves C = 1 (CPY #8)
 */
function appendPaletteRow(record, colors, y) {
  const end = y; // PHA
  let x = ram[DynTileBufLen];
  const rec = tbl(record);
  for (let i = 0; i !== 0x08; i++) {
    ram[DynTileBuf + x] = rec.byte(i);
    x = (x + 1) & 0xff;
  }
  ram[DynTileBufLen] = x;
  y = end; // PLA / TAY
  const col = tbl(colors);
  for (x = 2; x >= 0; x--) {
    ram[DynTileBuf + 4 + x] = col.byte(y);
    y = (y - 1) & 0xff;
  }
  cpu.c = 1;
  return ram[CurObjIndex];
}

/** ReplaceGanonBrownPaletteRow (Z_01, unverified, part of ReplaceAshesPaletteRow). @returns X */
export function ReplaceGanonBrownPaletteRow() {
  return appendPaletteRow('PaletteRow7TransferRecord', 'GanonColorTriples', 0x02);
}

/** ReplaceGanonBluePaletteRow (Z_01, unverified, part of ReplaceAshesPaletteRow). @returns X */
export function ReplaceGanonBluePaletteRow() {
  return appendPaletteRow('PaletteRow7TransferRecord', 'GanonColorTriples', 0x05);
}

/** ReplaceAshesPaletteRow (Z_01). Palette row 7 = ashes / triforce colors. @returns X = CurObjIndex */
export function ReplaceAshesPaletteRow() {
  // ReplaceAshesPaletteRow (Z_01)
  return appendPaletteRow('PaletteRow7TransferRecord', 'GanonColorTriples', 0x08);
}

/** Unused_DrawAshes_Bank1 (Z_01, unreferenced). X = object: draw the ash pile (frame $B). */
export function Unused_DrawAshes_Bank1(x) {
  // Unused_DrawAshes_Bank1 (Z_01)
  Anim_FetchObjPosForSpriteDescriptor(x);
  return DrawObjectNotMirrored(0x0b, x);
}

/** Unused_ActivateRoomItem_Bank1 (Z_01, unreferenced): same as Ganon_ActivateRoomItem. */
export function Unused_ActivateRoomItem_Bank1() {
  // Unused_ActivateRoomItem_Bank1 (Z_01)
  return Ganon_ActivateRoomItem();
}

// ------------------------------------------------------------------ init and scene

/** InitGanon (Z_04). X = Ganon: weak to sword and arrows; halts Link ($40 frames), shout + roar. */
export function InitGanon(x) {
  // InitGanon (Z_04)
  ram[ObjInvincibilityMask + x] = 0xfa;
  ram[ObjState] = 0x40;
  ram[ObjTimer] = 0x40;
  ram[SampleRequest] = 0x02;
  PlaySample(0x10);
  return ResetObjMetastateAndTimer(x);
}

/** UpdateGanon (Z_04). X = Ganon: dispatch on Ganon_ScenePhase. */
export function UpdateGanon(x) {
  // UpdateGanon (Z_04)
  return tableJump(label('UpdateGanon_JumpTable').addr, ram[Ganon_ScenePhase], [
    () => Ganon_ScenePhase0(x), () => Ganon_ScenePhase1(x), () => Ganon_ScenePhase2(x),
  ]);
}

/**
 * Ganon_ScenePhase0 (Z_04). Link lifts the triforce in the dark; when his timer expires the room
 * brightens (UpdateCandle) with the Ganon song; at the end of the fade, phase 1 ($C0 frames).
 */
export function Ganon_ScenePhase0(x) {
  // Ganon_ScenePhase0 (Z_04)
  ram[ItemTypeToLift] = 0x1b;
  let a = ram[ObjTimer];
  if (a === 0) {
    UpdateCandle(); // TXA/PHA ... PLA/TAX: X kept
    ram[BrighteningRoom] = 0x00;
    if (ram[FadeCycle] === 0xc0) ram[SongRequest] = 0x02;
    if ((ram[FadeCycle] & 0x0f) !== 0x04) return Ganon_DrawBodyFrame0(x);
    a = 0xc0;
    ram[ObjTimer] = a;
    ram[Ganon_ScenePhase]++;
    if (ram[Ganon_ScenePhase] !== 0) return Ganon_DrawBodyFrame0(x);
    // BNE not taken: runs into @CheckTimeToShout with A = $C0.
  }
  // @CheckTimeToShout
  if (a === 0x01) ram[SampleRequest] = 0x02;
}

/** Ganon_ScenePhase1 (Z_04). Lifting in the light; then free Link, level 9 song, phase 2. */
export function Ganon_ScenePhase1(x) {
  // Ganon_ScenePhase1 (Z_04)
  ram[ItemTypeToLift] = 0x1b;
  const a = ram[ObjTimer];
  if (a === 0) {
    ram[ObjState] = a;
    ram[ItemTypeToLift] = a;
    ram[SongRequest] = 0x20;
    ram[Ganon_ScenePhase]++;
  }
  return Ganon_DrawBodyFrame0(x);
}

/** Ganon_DrawBodyFrame0 (Z_04, part of Ganon_ScenePhase1). Draw with animation frame 0. */
export function Ganon_DrawBodyFrame0(x) {
  ram[Ganon_ObjAnimationFrame + x] = 0x00;
  return Ganon_DrawBody(x);
}

// ------------------------------------------------------------------ fight

/**
 * Ganon_ScenePhase2 (Z_04). The fight: dying, or collisions then brown state / blue (move and shoot
 * while invisible, visible while his timer runs, re-placed when it reaches 1).
 */
export function Ganon_ScenePhase2(x) {
  // Ganon_ScenePhase2 (Z_04)
  if (ram[Ganon_ObjPhase + x] !== 0) return Ganon_Dying(x);
  x = Ganon_CheckCollisions(x);
  PlayBossHitCryIfNeeded(x);
  if (ram[ObjState + x] !== 0) return Ganon_UpdateBrownState(x);
  const a = ram[ObjTimer + x];
  if (a === 0) return Ganon_MoveAndShoot(x);
  if (a !== 0x01) return L_Ganon_DrawBody(x);
  return Ganon_RandomizeLocation(x); // falls through
}

/** Ganon_RandomizeLocation (Z_04). X = Ganon: Y = $A0, X = GanonStartXs[FrameCounter & 1]. */
export function Ganon_RandomizeLocation(x) {
  // Ganon_RandomizeLocation (Z_04)
  ram[ObjY + x] = 0xa0;
  const a = tbl('GanonStartXs').byte(ram[FrameCounter] & 0x01);
  ram[ObjX + x] = a;
  return a;
}

/** Ganon_MoveAndShoot (Z_04, part of Ganon_ScenePhase2). Cycle 6 poses, teleport-walk, fireball / $40. */
export function Ganon_MoveAndShoot(x) {
  ram[Ganon_ObjAnimationFrame + x]++;
  if (ram[Ganon_ObjAnimationFrame + x] === 0x06) ram[Ganon_ObjAnimationFrame + x] = 0x00;
  ram[ObjRemDistance + x] = 0x01;
  BlueWizzrobe_TurnSometimesAndMoveAndCheckTile(x);
  if ((ram[FrameCounter] & 0x3f) !== 0) return;
  ShootFireball(0x56, x);
}

/**
 * Ganon_UpdateBrownState (Z_04, part of Ganon_ScenePhase2). The state counts down every other frame
 * (at 0: blue again, re-placed); drawn opaque while >= $30, then every other frame.
 */
export function Ganon_UpdateBrownState(x) {
  if (ram[FrameCounter] & 0x01) {
    ram[ObjState + x]--;
    if (ram[ObjState + x] === 0) {
      Ganon_RandomizeLocation(x);
      return Ganon_AppendPaletteRowTransferRecord_Blue();
    }
  }
  // @Draw
  if (ram[ObjState + x] >= 0x30) return L_Ganon_DrawBody(x);
  if (ram[FrameCounter] & 0x01) return L_Ganon_DrawBody(x);
}

/** L_Ganon_DrawBody (Z_04, part of Ganon_ScenePhase2): JSR Ganon_DrawBody / RTS. */
export function L_Ganon_DrawBody(x) {
  Ganon_DrawBody(x);
}

/**
 * Ganon_Dying (Z_04, part of Ganon_ScenePhase2). The phase counts up to $FF: drawn until $50; at $50
 * ashes (palette, (+8,+8) with the carry the palette routine leaves), burst rays, death cry, song;
 * then ashes, burst until $A0, and at $A0 the triforce of power appears on the ashes.
 */
export function Ganon_Dying(x) {
  ram[Ganon_ObjPhase + x]++;
  let a = ram[Ganon_ObjPhase + x];
  if (a === 0) {
    a = 0xff;
    ram[Ganon_ObjPhase + x] = a;
  }
  if (a < 0x50) return L_Ganon_DrawBody(x);
  if (a === 0x50) {
    x = Ganon_AppendPaletteRowTransferRecord_Triforce(); // X = CurObjIndex, C = 1
    // zp,X wraps in page 0: X = CurObjIndex is $FF when the record overwrote it (DynTileBufLen = $37;
    // battery: P22 Ganon_Dying, seeds 3 and 5)
    a = cpu.adc(ram[(ObjX + x) & 0xff], 0x07);
    ram[(ObjX + x) & 0xff] = a;
    a = cpu.adc(ram[(ObjY + x) & 0xff], 0x08);
    ram[(ObjY + x) & 0xff] = a;
    Ganon_SetUpBurstRays(x);
    PlayBossDeathCry();
    ram[SongRequest] = 0x02;
  }
  // @HandleAshes
  Ganon_DrawAshes(x);
  a = ram[Ganon_ObjPhase + x];
  if (a < 0xa0) return Ganon_DrawBurst(x);
  if (a !== 0xa0) return;
  Ganon_ActivateRoomItem();
  ram[ObjX + 19] = ram[(ObjX + x) & 0xff];
  ram[ObjY + 19] = ram[(ObjY + x) & 0xff];
  ram[ObjType]++; // the room kill count
}

/** Ganon_SetUpBurstRays (Z_04). X = Ganon: 8 rays in slots 2-9 at (+4, +4), GanonBurstDirs. */
export function Ganon_SetUpBurstRays(x) {
  // Ganon_SetUpBurstRays (Z_04)
  const dirs = tbl('GanonBurstDirs');
  for (let y = 7; y >= 0; y--) {
    cpu.c = 0;
    ram[ObjX + 2 + y] = cpu.adc(ram[(ObjX + x) & 0xff], 0x04); // zp,X
    ram[ObjY + 2 + y] = cpu.adc(ram[(ObjY + x) & 0xff], 0x04); // no CLC: carry of the X sum
    ram[ObjDir + 2 + y] = dirs.byte(y);
  }
}

/** Ganon_DrawCloud (Z_04). X = Ganon, [00]/[01] position (kept): frame $C, or $D when the distance < 6. */
export function Ganon_DrawCloud(x) {
  // Ganon_DrawCloud (Z_04)
  const s0 = ram[0x00];
  const s1 = ram[0x01];
  const a = ram[Ganon_ObjCloudDist + x] < 0x06 ? 0x0d : 0x0c;
  ram[0x0f] = 0x00;
  DrawObjectMirrored(a, x);
  ram[0x01] = s1;
  ram[0x00] = s0;
  return s0;
}

/**
 * Ganon_DrawBurst (Z_04, part of Ganon_ScenePhase2). The cloud distance shrinks every 8 frames; 8
 * clouds around the ashes; the rays in slots 2-9 move (diagonals 3 frames of 4) and flash.
 */
export function Ganon_DrawBurst(x) {
  if (ram[Ganon_ObjCloudDist + x] !== 0 && (ram[FrameCounter] & 0x07) === 0) ram[Ganon_ObjCloudDist + x]--;
  // @DrawClouds
  Ganon_GetCurCloudLeft(x);
  Ganon_GetCurCloudTop(x);
  Ganon_DrawCloud(x);
  Ganon_GetCurCloudRight(x);
  Ganon_DrawCloud(x);
  Ganon_GetCurCloudLeft(x);
  Ganon_GetCurCloudBottom(x);
  Ganon_DrawCloud(x);
  Ganon_GetCurCloudRight(x);
  Ganon_DrawCloud(x);
  ram[0x00] = ram[ObjX + x];
  Ganon_GetCurCloudTop(x);
  Ganon_DrawCloud(x);
  Ganon_GetCurCloudBottom(x);
  Ganon_DrawCloud(x);
  Ganon_GetCurCloudLeft(x);
  ram[0x01] = ram[ObjY + x];
  Ganon_DrawCloud(x);
  Ganon_GetCurCloudRight(x);
  Ganon_DrawCloud(x);
  const saved = ram[CurObjIndex]; // PHA
  const attrs = tbl('GanonBurstSpriteAttrs');
  const tiles = tbl('GanonBurstTiles');
  for (x = 0x02; x < 0x0a; x++) {
    ram[CurObjIndex] = x;
    if (x < 0x05 || x === 0x07 || (ram[FrameCounter] & 0x03) !== 0) BlueWizzrobe_Move(x);
    Anim_FetchObjPosForSpriteDescriptor(x);
    ram[0x03] = (ram[FrameCounter] & 0x03) | attrs.byte(x);
    Anim_WriteSprite(tiles.byte(x), x);
  }
  ram[CurObjIndex] = saved;
}

/** Ganon_GetCurCloudLeft (Z_04). [00] = X - cloud distance. @returns A */
export function Ganon_GetCurCloudLeft(x) {
  // Ganon_GetCurCloudLeft (Z_04)
  ram[0x00] = ram[ObjX + x] - ram[Ganon_ObjCloudDist + x];
  return ram[0x00];
}

/** Ganon_GetCurCloudRight (Z_04). [00] = X + cloud distance. @returns A */
export function Ganon_GetCurCloudRight(x) {
  // Ganon_GetCurCloudRight (Z_04)
  ram[0x00] = ram[ObjX + x] + ram[Ganon_ObjCloudDist + x];
  return ram[0x00];
}

/** Ganon_GetCurCloudTop (Z_04). [01] = Y - cloud distance. @returns A */
export function Ganon_GetCurCloudTop(x) {
  // Ganon_GetCurCloudTop (Z_04)
  ram[0x01] = ram[ObjY + x] - ram[Ganon_ObjCloudDist + x];
  return ram[0x01];
}

/** Ganon_GetCurCloudBottom (Z_04). [01] = Y + cloud distance. @returns A */
export function Ganon_GetCurCloudBottom(x) {
  // Ganon_GetCurCloudBottom (Z_04)
  ram[0x01] = ram[ObjY + x] + ram[Ganon_ObjCloudDist + x];
  return ram[0x01];
}

/** Ganon_DrawBody (Z_04). X = Ganon: four 16x16 parts of the current animation frame. */
export function Ganon_DrawBody(x) {
  // Ganon_DrawBody (Z_04)
  const ox = tbl('GanonSpriteOffsetsX');
  const oy = tbl('GanonSpriteOffsetsY');
  const fl = tbl('GanonSpriteHFlips');
  const img = tbl('GanonFrameImages');
  for (let y = 3; y >= 0; y--) {
    ram[0x00] = ram[ObjX + x] + ox.byte(y);
    ram[0x01] = ram[ObjY + x] + oy.byte(y);
    ram[0x0f] = fl.byte(y);
    ram[0x07] = y;
    let a = ram[Ganon_ObjAnimationFrame + x];
    const c = (a >> 6) & 1; // carry of the second ASL
    a = (a << 2) & 0xff;
    const i = (a + ram[0x07] + c) & 0xff;
    DrawObjectNotMirrored(img.byte(i), x);
  }
}

/**
 * Ganon_CheckCollisions (Z_04). X = Ganon, middle at (+$10, +$10). Link collision; blue and invisible:
 * the sword (HP lost: HP $F0, brown state $FF and palette; hit: visible $40 frames), never dying this
 * way; brown: a silver arrow in flight starts his death.
 * @returns X (CurObjIndex after the brown palette record, else unchanged)
 */
export function Ganon_CheckCollisions(x) {
  // Ganon_CheckCollisions (Z_04)
  ram[0x02] = ram[ObjX + x] + 0x10;
  ram[0x03] = ram[ObjY + x] + 0x10;
  if (ram[ObjInvincibilityTimer] === 0) {
    ram[0x06] = 0;
    ram[0x09] = 0;
    ram[0x0c] = 0;
    ram[0x00] = 0;
    CheckLinkCollisionPreinit(x);
  }
  // @SkipLinkCollision
  if (ram[ObjState + x] !== 0) {
    // @CheckArrowCollision
    if (ram[InvArrow] !== 0x02) return x;
    ram[0x06] = 0x00;
    if (ram[ObjState + 0x12] !== 0x10) return x;
    CheckMonsterArrowOrRodCollision(x, 0x12);
    if (ram[0x06] === 0) return x;
    ram[Ganon_ObjPhase + x]++;
    ram[ObjInvincibilityTimer + x] = 0x28;
    ram[Ganon_ObjCloudDist + x] = 0x08;
    return x;
  }
  if (ram[ObjTimer + x] !== 0) return x;
  CheckMonsterSwordCollision(x, 0x0d);
  if (ram[ObjMetastate + x] !== 0) {
    ram[ObjHP + x] = 0xf0;
    ram[ObjState + x]--;
    x = Ganon_AppendPaletteRowTransferRecord_Brown();
  }
  // @CheckHarmed
  if (ram[ObjInvincibilityTimer + x] !== 0) {
    PlayBossHitCryIfNeeded(x);
    ram[ObjTimer + x] = 0x40;
  }
  // @UndoDeath
  const a = ResetObjMetastate(x);
  ResetShoveInfoAndInvincibilityTimer(a, x);
  return x;
}

/** Ganon_AppendPaletteRowTransferRecord_Brown (Z_04). @returns X = CurObjIndex */
export function Ganon_AppendPaletteRowTransferRecord_Brown() {
  // Ganon_AppendPaletteRowTransferRecord_Brown (Z_04)
  return appendPaletteRow('GanonColorTransferRecord', 'GanonColorSets', 0x02);
}

/** Ganon_AppendPaletteRowTransferRecord_Blue (Z_04). @returns X = CurObjIndex */
export function Ganon_AppendPaletteRowTransferRecord_Blue() {
  // Ganon_AppendPaletteRowTransferRecord_Blue (Z_04)
  return appendPaletteRow('GanonColorTransferRecord', 'GanonColorSets', 0x05);
}

/** Ganon_AppendPaletteRowTransferRecord_Triforce (Z_04). @returns X = CurObjIndex (C = 1) */
export function Ganon_AppendPaletteRowTransferRecord_Triforce() {
  // Ganon_AppendPaletteRowTransferRecord_Triforce (Z_04)
  return appendPaletteRow('GanonColorTransferRecord', 'GanonColorSets', 0x08);
}

/** Ganon_DrawAshes (Z_04). X = Ganon: the ash pile (frame $B). */
export function Ganon_DrawAshes(x) {
  // Ganon_DrawAshes (Z_04)
  Anim_FetchObjPosForSpriteDescriptor(x);
  return DrawObjectNotMirrored(0x0b, x);
}

/** Ganon_ActivateRoomItem (Z_04). Activate the room item (state 0, item tune) unless already taken. */
export function Ganon_ActivateRoomItem() {
  // Ganon_ActivateRoomItem (Z_04)
  if (ram[ObjState + 19] === 0) return;
  if (GetRoomFlagUWItemState() !== 0) return;
  ram[ObjState + 19] = 0x00;
  ram[Tune1Request] = 0x02;
}
