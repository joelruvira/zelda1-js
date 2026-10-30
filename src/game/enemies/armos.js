// P18 enemyow — enemies/armos (Z_04): armos statues coming to life (with the secret stairs / power
// bracelet under some of them) and the flying ghini's fade-in, which shares the init routine.
// X = object slot in every routine.

import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import {
  ObjTimer, ObjUninitialized, ObjType, RoomId, ObjX, ObjY, ObjState, RoomItemId, ReturnToBank4,
  ObjGridOffset, Random, ObjQSpeedFrac, ObjInputDir, ObjDir, ObjShoveDir, ObjAnimCounter, ObjAnimFrame,
  ObjMetastate,
} from '../../core/vars.js';
import { GetRoomFlagUWItemState } from '../items/roomitem.js';
import { PlaySecretFoundTune } from '../world/secrets.js';
import { ChangeTileObjTiles } from '../world/tilemap.js';
import { ResetObjMetastateAndTimer } from '../objects/slots.js';
import { Anim_FetchObjPosForSpriteDescriptor, DrawObjectNotMirrored } from '../draw/anim.js';
import { CheckMonsterCollisions, CheckLinkCollision } from '../combat/collisions.js';
import { DrawGhiniAndCheckCollisions } from './ghini.js';
import { EndInitFlyer } from './peahat.js';
import { UpdateGoriya } from './goriya.js';

const tbl = (name) => table(bus.rom, name);

/**
 * InitArmosOrFlyingGhini (Z_04). X = object. Stays "uninitialized" while fading in (timer > 0),
 * drawn every other frame. An armos, once its timer expires, replaces its square with stairs (secret
 * armos rooms), the power bracelet room item (room $24) or a floor tile, and gets a random speed.
 */
export function InitArmosOrFlyingGhini(x) {
  // InitArmosOrFlyingGhini (Z_04)
  let a = ram[ObjTimer + x];
  ram[ObjUninitialized + x] = a;
  let armos = false;
  if (!$br('Z_04:3166', a !== 0)) {
    $pxa('Z_04:3170', ObjType, x);
    armos = !$br('Z_04:3172', ram[ObjType + x] === 0x22);
  }
  if (armos) {
    // An armos.
    ram[0x00] = 0x70; // stairs tile
    let chosen = false;
    const ids = tbl('SecretArmosRoomIds');
    const xs = tbl('SecretArmosXs');
    for (let y = 0x06; ;) {
      // @LoopArmosRoom
      $pxa('Z_04:3188', ids.addr, y);
      if (!$br('Z_04:3189', ram[RoomId] !== ids.byte(y))) {
        $pxa('Z_04:3196', xs.addr, y);
        if (!$br('Z_04:3197', ram[ObjX + x] !== xs.byte(y))) {
          a = ram[ObjY + x];
          if (!$br('Z_04:3202', a !== 0x80)) {
            if ($br('Z_04:3206', y !== 0)) {
              chosen = true; // @UseChosenTile
              break;
            }
            // Room $24: the power bracelet under the armos.
            ram[ObjY + 19] = a;
            ram[ObjX + 19] = ram[ObjX + x];
            ram[ObjState + 19] = y;
            ram[RoomItemId] = 0x14;
            if (!$br('Z_04:3232', GetRoomFlagUWItemState() !== 0)) {
              PlaySecretFoundTune();
              $br('Z_04:3234', true); // returns 4: BNE @UseFloorTile
            }
            break;
          }
        }
      }
      // @NextLoopArmosRoom
      y = (y - 1) & 0xff;
      if (!$br('Z_04:3239', !(y & 0x80))) break;
    }
    // @UseFloorTile
    if (!chosen) ram[0x00] = 0x26;
    // @UseChosenTile
    a = ram[0x00];
    const pushed = a; // PHA
    if (!$br('Z_04:3253', a !== 0x70)) PlaySecretFoundTune();
    ram[ReturnToBank4]++;
    ChangeTileObjTiles(pushed, x); // PLA
    ram[ObjGridOffset + x] = 0x03;
    a = $br('Z_04:3276', ram[Random + 1 + x] < 0x80) ? 0x20 : 0x60;
    ram[ObjQSpeedFrac + x] = a;
  }
  // @FinishInit
  ram[ObjInputDir + x] = 0x04;
  ram[ObjDir + x] = 0x04;
  if ($br('Z_04:3290', (ram[ObjTimer + x] & 0x01) !== 0)) return; // LSR / BCS: every other frame, no drawing
  $pxa('Z_04:3293', ObjType, x);
  if ($br('Z_04:3295', ram[ObjType + x] === 0x22)) return L_EndInitFlyingGhini(x);
  DrawArmosAndCheckCollisions(x);
}

/** L_EndInitFlyingGhini (Z_04, part of InitArmosOrFlyingGhini): draw; once initialized, a flyer. */
export function L_EndInitFlyingGhini(x) {
  // L_EndInitFlyingGhini (Z_04)
  DrawGhiniAndCheckCollisions(x);
  $pxa('Z_04:3305', ObjUninitialized, x);
  if ($br('Z_04:3306', ram[ObjUninitialized + x] !== 0)) return;
  ResetObjMetastateAndTimer(x);
  return EndInitFlyer(x); // JMP
}

/** UpdateArmos (Z_04). X = armos: goriya-style walk; animate (frame sets 0/2) unless shoved; draw. */
export function UpdateArmos(x) {
  // UpdateArmos (Z_04)
  UpdateGoriya(x);
  if (!$br('Z_04:3315', ram[ObjShoveDir + x] !== 0)) {
    ram[ObjAnimCounter + x]--;
    if (!$br('Z_04:3322', ram[ObjAnimCounter + x] !== 0)) {
      ram[ObjAnimCounter + x] = 0x06;
      $pxa('Z_04:3337', ObjAnimFrame, x);
      ram[ObjAnimFrame + x] = ram[ObjAnimFrame + x] ^ 0x02;
    }
  }
  return DrawArmosAndCheckCollisions(x); // falls through
}

/**
 * DrawArmosAndCheckCollisions (Z_04). X = armos: frame (front, or back when facing up) + set; while
 * fading in only Link collides; a dead armos becomes the dead dummy ($5D).
 */
export function DrawArmosAndCheckCollisions(x) {
  // DrawArmosAndCheckCollisions (Z_04)
  let a = Anim_FetchObjPosForSpriteDescriptor(x);
  if (!$br('Z_04:3348', ram[ObjDir + x] !== 0x08)) a = 0x01;
  $pxa('Z_04:3352', ObjAnimFrame, x);
  DrawObjectNotMirrored((a + ram[ObjAnimFrame + x]) & 0xff, x);
  if ($br('Z_04:3358', ram[ObjTimer + x] !== 0)) return CheckLinkCollision(x); // @CheckLinkCollision
  CheckMonsterCollisions(x);
  $pxa('Z_04:3364', ObjMetastate, x);
  if (!$br('Z_04:3365', ram[ObjMetastate + x] === 0)) ram[ObjType + x] = 0x5d;
}
