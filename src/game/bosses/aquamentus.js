// P21 — bosses/aquamentus (Z_04, Z_05): Aquamentus (level 1 / 7 dragon) and the underworld boss
// ambient sound (CheckBossSoundEffectUW, run on every underworld room entry). X = object slot.
// The boss walks left and right between X $88 and $C7 one pixel every 8 frames, and every
// (Random | $70) frames shoots three fireballs ($55) that spread out vertically.
import { ram, cpu, peek } from '../../core/ram.js';
import { read, bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  LevelInfo_BossRoomId, RoomId, LevelBlockAttrsE, SampleRequest, ObjInvincibilityMask, ObjX, ObjY,
  ObjDir, ObjGridOffset, ObjTimer, ObjType, ObjInvincibilityTimer, Random, FrameCounter, InvClock,
  CurObjIndex, Aquamentus_ObjFireballOffset, RollingSpriteIndex, Sprites,
} from '../../core/vars.js';
import { GetRoomFlags } from '../world/roomflags.js';
import { PlayEffect } from '../audio/requests.js';
import { CheckMonsterCollisions } from '../combat/collisions.js';
import { PlayBossHitCryIfNeeded, PlayBossDeathCryIfNeeded } from '../enemies/common.js';
import { ResetShoveInfo } from '../movement/shove.js';
import { ShootFireball } from '../enemies/shots.js';
import { Anim_EndWriteSprite } from '../draw/sprites.js';

/** InitAquamentus (Z_04). X = boss: invincible to boomerang/fire, roar, placed at ($B0,$80). @returns A = $80 */
export function InitAquamentus(x) {
  // InitAquamentus (Z_04)
  ram[ObjInvincibilityMask + x] = 0xe2;
  ram[SampleRequest] = 0x10; // Aquamentus/Gleeok/Ganon roar
  ram[ObjX + x] = 0xb0;
  ram[ObjY + x] = 0x80;
  return 0x80;
}

/**
 * UpdateAquamentus (Z_04). X = boss: move and shoot (unless the clock is held), draw, collisions, cries;
 * falls into CheckBossHitReaction. Aquamentus_Shoot may leave X = CurObjIndex (LDX CurObjIndex).
 */
export function UpdateAquamentus(x) {
  // UpdateAquamentus (Z_04)
  if (ram[InvClock] === 0) {
    Aquamentus_Move(x);
    x = Aquamentus_Shoot(x);
  }
  Aquamentus_Draw(x);
  CheckMonsterCollisions(x);
  PlayBossHitCryIfNeeded(x);
  return CheckBossHitReaction(x); // falls through
}

/** CheckBossHitReaction (Z_04). X = boss: death cry if dying, then reset the shove. @returns A = 0 */
export function CheckBossHitReaction(x) {
  // CheckBossHitReaction (Z_04)
  PlayBossDeathCryIfNeeded(x);
  return ResetShoveInfo(x);
}

/**
 * Aquamentus_Move (Z_04). X = boss. ObjGridOffset = distance left to walk; at 0 pick a random distance
 * (7 or $F) and direction (right/left). One pixel every 8 frames, bounced back inside [$88, $C7].
 */
export function Aquamentus_Move(x) {
  // Aquamentus_Move (Z_04)
  if (ram[ObjGridOffset + x] === 0) {
    const r = ram[Random + x]; // PHA
    ram[ObjGridOffset + x] = (r & 0x0f) | 0x07;
    ram[ObjDir + x] = (r & 0x01) + 1; // PLA / AND #1 / TAY / INY
    return;
  }
  // @Move
  if ((ram[FrameCounter] & 0x07) !== 0) return; // @Exit
  const a = ram[ObjX + x];
  if (a < 0x88) {
    ram[ObjX + x] = 0x88;
    ram[ObjDir + x] = 0x01;
    ram[ObjGridOffset + x] = 0x07; // @SetRemainingDistance
  } else if (a >= 0xc8) {
    // @CheckRightLimit
    ram[ObjX + x] = 0xc7;
    ram[ObjDir + x] = 0x02;
    ram[ObjGridOffset + x] = 0x07;
  }
  // @ApplySpeed
  const y = (ram[ObjDir + x] - 1) & 0xff;
  ram[ObjX + x] = ram[ObjX + x] + table(bus.rom, 'AquamentusSpeeds').byte(y);
  ram[ObjGridOffset + x]--;
}

/**
 * Aquamentus_Shoot (Z_04). X = boss. When the timer expires: new timer (Random | $70) and three
 * fireballs $55 with vertical displacements 0, 1, -1 (written at the slot ShootFireball returns, even 0
 * when no slot was free). Otherwise every other frame each $55 fireball (slots $B..0) moves by its
 * displacement. @returns X as the original leaves it (CurObjIndex after the spreading loop)
 */
export function Aquamentus_Shoot(x) {
  // Aquamentus_Shoot (Z_04)
  if (ram[ObjTimer + x] === 0) {
    ram[ObjTimer + x] = ram[Random + x] | 0x70;
    let { y } = ShootFireball55(x);
    ram[Aquamentus_ObjFireballOffset + y] = 0x00;
    ({ y } = ShootFireball55(x));
    ram[Aquamentus_ObjFireballOffset + y] = 0x01;
    ({ y } = ShootFireball55(x));
    ram[Aquamentus_ObjFireballOffset + y] = 0xff;
    return x;
  }
  // @SpreadOutFireballs
  for (x = 0x0b; x >= 0; x--) {
    if (ram[ObjType + x] !== 0x55) continue;
    if (ram[FrameCounter] & 0x01) continue;
    ram[ObjY + x] = ram[ObjY + x] + ram[Aquamentus_ObjFireballOffset + x];
  }
  return ram[CurObjIndex];
}

/** ShootFireball55 (Z_04). X = shooter. @returns {{a:number, y:number}} as ShootFireball */
export function ShootFireball55(x) {
  // ShootFireball55 (Z_04)
  return ShootFireball(0x55, x);
}

/**
 * Aquamentus_Draw (Z_04). X = boss: six sprites (3x2) from AquamentusTiles (frame by FrameCounter bit 4),
 * the face open-mouthed ($C0) while the shoot timer < $20; flashing palette while invincible.
 * Uses [00], [01], [03], [0A], [0B].
 */
export function Aquamentus_Draw(x) {
  // Aquamentus_Draw (Z_04)
  const tiles = table(bus.rom, 'AquamentusTiles');
  const offY = table(bus.rom, 'AquamentusSpriteOffsetsY');
  const offX = table(bus.rom, 'AquamentusSpriteOffsetsX');
  let y = 0x05;
  if ((ram[FrameCounter] & 0x10) === 0) y = 0x0b;
  ram[0x0a] = y;
  ram[0x0b] = 0x05;
  do {
    // @LoopSprite
    y = ram[0x0b];
    ram[0x00] = ram[ObjX + x] + offX.byte(y);
    ram[0x01] = ram[ObjY + x] + offY.byte(y);
    ram[0x03] = (ram[ObjInvincibilityTimer + x] & 0x03) ^ 0x03;
    y = ram[0x0a];
    let a = tiles.byte(y);
    if (a === tiles.byte(0) && ram[ObjTimer + x] < 0x20) a = 0xc0; // open mouth
    // @WriteSprite
    WriteBossSprite(a);
    ram[0x0a]--;
    ram[0x0b]--;
  } while (!(ram[0x0b] & 0x80));
}

/** WriteBossSprite (Z_04). A = tile, [00] X, [01] Y, [03] attributes. @returns A = new RollingSpriteIndex */
export function WriteBossSprite(a) {
  // WriteBossSprite (Z_04)
  const y = table(bus.rom, 'SpriteOffsets').byte(ram[RollingSpriteIndex]);
  ram[Sprites + 1 + y] = a;
  ram[Sprites + 3 + y] = ram[0x00];
  return Anim_EndWriteSprite(ram[0x01], y);
}

/**
 * CheckBossSoundEffectUW (Z_05). Requests the room's repeating boss sample (BossSoundEffects indexed by
 * LevelBlockAttrsE bits 5-6), or silences sample and tune 1 if the room has none or the level's boss was
 * already beaten.
 */
export function CheckBossSoundEffectUW() {
  // CheckBossSoundEffectUW (Z_05)
  GetRoomFlags();
  let y = peek(LevelInfo_BossRoomId);
  let a = read((((ram[0x01] << 8) | ram[0x00]) + y) & 0xffff) & 0xc0;
  if (a !== 0xc0) {
    y = ram[RoomId];
    a = peek(LevelBlockAttrsE + y) & 0x60;
    a = cpu.asl(a);
    a = cpu.rol(a);
    a = cpu.rol(a);
    a = cpu.rol(a);
    a = table(bus.rom, 'BossSoundEffects').byte(a); // TAX / LDA BossSoundEffects, X
    if (a !== 0) {
      ram[SampleRequest] = a | 0x80; // repeat
      return;
    }
  }
  return PlayEffect(0x80); // silence sample and tune 1
}
