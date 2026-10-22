// P05 objects — per-object Init/Update dispatch (Z_07, Z_04): UpdateObject_JumpTable (106 entries,
// ObjType $00-$69), InitObject_JumpTable (95 entries, $00-$5E), caves (>= $6A), tile objects and
// items (>= $5F), "monsters from the edges of the screen", and the bank-1 trampolines.
// Every handler is called as handler(x) with X = object slot (= CurObjIndex).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { switchBank, tableJump } from '../../core/asm.js';
import { table, label } from '../../core/rom.js';
import {
  ObjUninitialized, ObjType, ObjTimer, ObjMetastate, CurObjIndex, CurLevel, LevelBlockAttrsByteF,
  MonstersFromEdgesLongTimer, CurEdgeSpawnCell, ObjX, ObjY, Random, ObjAttr, ObjHP, SecretColorCycle,
} from '../../core/vars.js';
import { UpdateMetaObject, DoNothing, UpdateDeadDummy } from './metaobject.js';
import { ResetObjMetastate, ResetObjMetastateAndTimer } from './slots.js';
import { FindNextEdgeSpawnCell, IsDistanceSafeToSpawn } from './spawnpos.js';
// Later packages (stubs until they are ported).
import { UpdateArrowOrBoomerang } from '../weapons/arrow.js';
import { UpdateItem } from '../items/roomitem.js';
import { InitCave, UpdateCavePerson, UpdateStandingFire } from '../npc/cave.js';
import {
  InitUnderworldPerson_Full, InitUnderworldPersonLifeOrMoney_Full, UpdateUnderworldPerson_Full,
  UpdateUnderworldPersonLifeOrMoney_Full,
} from '../npc/uwperson.js';
import { InitGrumble_Full, UpdateGrumble_Full } from '../npc/grumble.js';
import { UpdateWhirlwind_Full } from '../worldobj/whirlwind.js';
import { UpdateBlock } from '../worldobj/block.js';
import { InitPondFairy, UpdatePondFairy } from '../worldobj/pond.js';
import { InitRupeeStash_Full, UpdateRupeeStash_Full } from '../worldobj/rupeestash.js';
import {
  UpdateDock, UpdateRockOrGravestone, UpdateRockWall, UpdateTree, UpdateFluteSecret,
} from '../worldobj/tileobjects.js';
import { InitWalker } from '../enemies/common.js';
import {
  InitMonsterShot, _InitMonsterShot_Unknown54, UpdateMonsterShot, UpdateMonsterArrow, UpdateFireball,
} from '../enemies/shots.js';
import { InitSlowOctorockOrGhini, InitFastOctorock, UpdateOctorock } from '../enemies/octorok.js';
import { UpdateLynel, UpdateMoblin } from '../enemies/moblin-lynel.js';
import {
  InitTektite, UpdateTektiteOrBoulder, InitBoulder, InitBoulderSet, UpdateBoulderSet,
} from '../enemies/tektite-boulder.js';
import { InitLeever, UpdateBlueLeever, UpdateRedLeever } from '../enemies/leever.js';
import { InitPeahat, UpdatePeahat } from '../enemies/peahat.js';
import { UpdateGhini, UpdateFlyingGhini } from '../enemies/ghini.js';
import { InitArmosOrFlyingGhini, UpdateArmos } from '../enemies/armos.js';
import { UpdateZora } from '../enemies/zora.js';
import { UpdateGoriya } from '../enemies/goriya.js';
import { InitDarknut, UpdateDarknut } from '../enemies/darknut.js';
import { UpdateStalfos, UpdateGibdo, InitRope, UpdateRope } from '../enemies/stalfos-gibdo-rope.js';
import {
  InitBlueKeese, InitRedOrBlackKeese, UpdateKeese, InitBubble, UpdateBubble,
} from '../enemies/keese-bubble.js';
import { UpdateZol, InitGel, UpdateGel } from '../enemies/zol-gel.js';
import { UpdatePolsVoice } from '../enemies/polsvoice.js';
import { UpdateLikeLike } from '../enemies/likelike.js';
import { UpdateVire } from '../enemies/vire.js';
import { UpdateWallmaster } from '../enemies/wallmaster.js';
import { UpdateBlueWizzrobe, UpdateRedWizzrobe } from '../enemies/wizzrobe.js';
import { InitTrap_Full, UpdateTrap_Full } from '../enemies/trap.js';
import { InitLamnola, UpdateLamnola } from '../enemies/lamnola.js';
import { InitAquamentus, UpdateAquamentus } from '../bosses/aquamentus.js';
import { InitDodongo, UpdateDodongo } from '../bosses/dodongo.js';
import { InitManhandla, UpdateManhandla } from '../bosses/manhandla.js';
import { InitGohma, UpdateGohma } from '../bosses/gohma.js';
import { InitDigdogger1, InitDigdogger2, UpdateDigdogger } from '../bosses/digdogger.js';
import { InitGleeok, InitGleeokHead, UpdateGleeok, UpdateGleeokHead } from '../bosses/gleeok.js';
import { InitMoldorm, UpdateMoldorm } from '../bosses/moldorm.js';
import { InitPatra, UpdatePatra, UpdatePatraChild } from '../bosses/patra.js';
import { InitGanon, UpdateGanon } from '../bosses/ganon.js';
import { InitZelda, UpdateZelda, UpdateGuardFire } from '../bosses/zelda.js';

// Types that do not start in a spawning cloud: armos ($1E), flying ghini ($22), and >= $53.
const spawnsInCloud = (t) => t !== 0x1e && t !== 0x22 && t < 0x53;

/**
 * UpdateObject (Z_07). A = object type, X = object. Switches to bank 4; initializes the object
 * the first time ([0F] = the "uninitialized" flag), updates the meta-object (cloud/sparkle), a
 * cave person (type >= $6A, bank 1), or runs the type's update routine.
 */
export function UpdateObject(a, x) {
  // UpdateObject (Z_07)
  switchBank(4); // PHA / PLA around it
  const y = ram[ObjUninitialized + x];
  ram[0x0f] = y;
  if (y !== 0) {
    // Objects that start with a spawning cloud wait 7 frames (overridden by the init).
    if (spawnsInCloud(ram[ObjType + x])) ram[ObjTimer + x] = 0x07;
    // @Init
    ram[ObjUninitialized + x] = 0x00;
    return InitObject(); // JMP
  }
  // @Update
  if (ram[ObjMetastate + x] !== 0) return UpdateMetaObject(x);
  if (a >= 0x6a) {
    switchBank(1);
    return UpdateCavePerson(x);
  }
  // @NormalObject
  updateHandlers ??= [
    DoNothing, UpdateLynel, UpdateLynel, UpdateMoblin, UpdateMoblin, UpdateGoriya, UpdateGoriya,
    UpdateOctorock, UpdateOctorock, UpdateOctorock, UpdateOctorock, UpdateDarknut, UpdateDarknut,
    UpdateTektiteOrBoulder, UpdateTektiteOrBoulder, UpdateBlueLeever, UpdateRedLeever, UpdateZora,
    UpdateVire, UpdateZol, UpdateGel, UpdateGel, UpdatePolsVoice, UpdateLikeLike, UpdateDigdogger,
    DoNothing, UpdatePeahat, UpdateKeese, UpdateKeese, UpdateKeese, UpdateArmos, UpdateBoulderSet,
    UpdateTektiteOrBoulder, UpdateGhini, UpdateFlyingGhini, UpdateBlueWizzrobe, UpdateRedWizzrobe,
    UpdatePatraChild, UpdatePatraChild, UpdateWallmaster, UpdateRope, DoNothing, UpdateStalfos,
    UpdateBubble, UpdateBubble, UpdateBubble, UpdateWhirlwind, UpdatePondFairy, UpdateGibdo,
    UpdateDodongo, UpdateDodongo, UpdateGohma, UpdateGohma, UpdateRupeeStash, UpdateGrumble,
    UpdateZelda, UpdateDigdogger, UpdateDigdogger, UpdateLamnola, UpdateLamnola, UpdateManhandla,
    UpdateAquamentus, UpdateGanon, UpdateGuardFire, UpdateStandingFire, UpdateMoldorm, UpdateGleeok,
    UpdateGleeok, UpdateGleeok, UpdateGleeok, UpdateGleeokHead, UpdatePatra, UpdatePatra, UpdateTrap,
    UpdateTrap, UpdateUnderworldPerson, UpdateUnderworldPerson, UpdateUnderworldPerson,
    UpdateUnderworldPerson, UpdateUnderworldPerson, UpdateUnderworldPerson,
    UpdateUnderworldPersonLifeOrMoney, UpdateUnderworldPerson, UpdateMonsterShot, UpdateMonsterShot,
    UpdateFireball, UpdateFireball, UpdateMonsterShot, UpdateMonsterShot, UpdateMonsterShot,
    UpdateMonsterShot, UpdateMonsterArrow, UpdateArrowOrBoomerang, UpdateDeadDummy, UpdateFluteSecret,
    DoNothing, UpdateItem, UpdateDock, UpdateRockOrGravestone, UpdateRockWall, UpdateTree,
    UpdateRockOrGravestone, UpdateRockOrGravestone, UpdateRockWall, UpdateBlock, DoNothing,
  ];
  return tableJump(label('UpdateObject_JumpTable').addr, a, withX(updateHandlers, a, x));
}

let updateHandlers;
let initHandlers;

// tableJump calls handlers[index]() without arguments: bind X for the one that will run.
function withX(handlers, index, x) {
  const h = [];
  h[index] = () => handlers[index](x);
  return h;
}

/**
 * InitObject (Z_07). X = CurObjIndex. Brings in "monsters from the edges" (OW rooms with that
 * attribute), then sets the start timer, attributes and HP, and runs the type's init routine.
 */
export function InitObject() {
  // InitObject (Z_07)
  let x = ram[CurObjIndex];
  let fromEdges = false;
  if (ram[CurLevel] === 0 && (ram[LevelBlockAttrsByteF] & 0x08)) {
    const t = ram[ObjType + x];
    fromEdges = t !== 0x11 && t !== 0x40 && t !== 0x1e && t !== 0x2e && t < 0x53;
  }
  if (fromEdges) {
    for (;;) {
      // @UninitMonsterFromEdge: until the long timer expires, the monster stays uninitialized.
      const a = ram[MonstersFromEdgesLongTimer];
      if (a !== 0) {
        ram[ObjUninitialized + x] = a;
        return;
      }
      // @InitMonsterFromEdge
      x = ram[CurObjIndex];
      switchBank(5);
      FindNextEdgeSpawnCell();
      const cell = ram[CurEdgeSpawnCell];
      ram[ObjX + x] = (cell << 4) & 0xff; // column in the low nibble
      ram[ObjY + x] = ((cell & 0xf0) - 0x03) & 0xff; // row in the high nibble
      // Next monster in 20 to 50 frames.
      ram[MonstersFromEdgesLongTimer] = (ram[Random + 1 + x] & 0x03) + 0x02;
      switchBank(5);
      if (IsDistanceSafeToSpawn(x)) continue; // too close to Link: try again later
      ram[ObjMetastate + x] = 0x00; // no spawning cloud
      break;
    }
  }
  // @NormalSpawn
  switchBank(4);
  x = ram[CurObjIndex];
  let y = ram[ObjType + x];
  // Monsters that spawn in a cloud start moving at different times (timer = slot).
  if (spawnsInCloud(y)) ram[ObjTimer + x] = x;
  // @FetchAttrs
  ram[ObjAttr + x] = table(bus.rom, 'ObjectTypeToAttributes').byte(y);
  let a = y;
  ram[0x00] = a; // [00] holds the object type
  y = a >> 1; // hit points are packed two to a byte
  ram[ObjHP + x] = ExtractHitPointValue(table(bus.rom, 'ObjectTypeToHpPairs').byte(y));
  a = ram[0x00];
  if (a >= 0x6a) {
    switchBank(1);
    return InitCave(x);
  }
  // @CheckTileObj
  if (a >= 0x5f) return InitTileObjOrItem(x);
  initHandlers ??= [
    DoNothing, InitWalker, InitWalker, InitWalker, InitWalker, InitWalker, InitWalker,
    InitSlowOctorockOrGhini, InitFastOctorock, InitSlowOctorockOrGhini, InitFastOctorock, InitDarknut,
    InitDarknut, InitTektite, InitTektite, InitLeever, InitLeever, ResetObjMetastateAndTimer, InitWalker,
    InitWalker, InitWalker, InitGel, InitWalker, InitWalker, DoNothing, DoNothing, InitPeahat,
    InitBlueKeese, InitRedOrBlackKeese, InitRedOrBlackKeese, InitArmosOrFlyingGhini, InitBoulderSet,
    InitBoulder, InitSlowOctorockOrGhini, InitArmosOrFlyingGhini, ResetObjMetastateAndTimer,
    ResetObjMetastateAndTimer, ResetObjMetastateAndTimer, ResetObjMetastateAndTimer,
    ResetObjMetastateAndTimer, InitRope, DoNothing, InitWalker, InitBubble, InitBubble, InitBubble,
    DoNothing, InitPondFairy, InitWalker, InitDodongo, InitDodongo, InitGohma, InitGohma,
    InitRupeeStash, InitGrumble, InitZelda, InitDigdogger1, InitDigdogger2, InitLamnola, InitLamnola,
    InitManhandla, InitAquamentus, InitGanon, DoNothing, DoNothing, InitMoldorm, InitGleeok, InitGleeok,
    InitGleeok, InitGleeok, InitGleeokHead, InitPatra, InitPatra, InitTrap, InitTrap,
    InitUnderworldPerson, InitUnderworldPerson, InitUnderworldPerson, InitUnderworldPerson,
    InitUnderworldPerson, InitUnderworldPerson, InitUnderworldPersonLifeOrMoney, InitUnderworldPerson,
    InitMonsterShot, _InitMonsterShot_Unknown54, InitMonsterShot, InitMonsterShot, InitMonsterShot,
    InitMonsterShot, InitMonsterShot, InitMonsterShot, ResetObjMetastate, ResetObjMetastate,
    UpdateDeadDummy, InitFluteSecret,
  ];
  return tableJump(label('InitObject_JumpTable').addr, a, withX(initHandlers, a, x));
}

/**
 * ExtractHitPointValue (Z_04). A = hit point pair byte, [00] = object type.
 * @returns A = high nibble (even type) or low nibble * 16 (odd type)
 */
export function ExtractHitPointValue(a) {
  // ExtractHitPointValue (Z_04)
  if (ram[0x00] & 0x01) return (a << 4) & 0xff; // @OddType
  return a & 0xf0;
}

/** InitTileObjOrItem (Z_07). X = object: attribute $81, ready to update itself. @returns A = 0 */
export function InitTileObjOrItem(x) {
  // InitTileObjOrItem (Z_07)
  ram[ObjAttr + x] = 0x81; // custom collision check and drawing + reverse after hitting Link
  return ResetObjMetastateAndTimer(x); // BNE (always)
}

/** InitFluteSecret (Z_07). X = object: starts the secret color cycle. @returns A = 0 */
export function InitFluteSecret(x) {
  // InitFluteSecret (Z_07)
  ram[SecretColorCycle] = 0x01;
  return ResetObjMetastateAndTimer(x); // falls through
}

// Bank-1 trampolines (Z_07): LDA #$01 / JSR SwitchBank / JMP <routine>_Full. X = object.

export function UpdateWhirlwind(x) {
  // UpdateWhirlwind (Z_07)
  switchBank(1);
  return UpdateWhirlwind_Full(x);
}

export function InitRupeeStash(x) {
  // InitRupeeStash (Z_07)
  switchBank(1);
  return InitRupeeStash_Full(x);
}

export function UpdateRupeeStash(x) {
  // UpdateRupeeStash (Z_07)
  switchBank(1);
  return UpdateRupeeStash_Full(x);
}

export function InitTrap(x) {
  // InitTrap (Z_07)
  switchBank(1);
  return InitTrap_Full(x);
}

export function UpdateTrap(x) {
  // UpdateTrap (Z_07)
  switchBank(1);
  return UpdateTrap_Full(x);
}

export function InitUnderworldPerson(x) {
  // InitUnderworldPerson (Z_07)
  switchBank(1);
  return InitUnderworldPerson_Full(x);
}

export function InitUnderworldPersonLifeOrMoney(x) {
  // InitUnderworldPersonLifeOrMoney (Z_07)
  switchBank(1);
  return InitUnderworldPersonLifeOrMoney_Full(x);
}

export function InitGrumble(x) {
  // InitGrumble (Z_07)
  switchBank(1);
  return InitGrumble_Full(x);
}

export function UpdateUnderworldPerson(x) {
  // UpdateUnderworldPerson (Z_07)
  switchBank(1);
  return UpdateUnderworldPerson_Full(x);
}

export function UpdateUnderworldPersonLifeOrMoney(x) {
  // UpdateUnderworldPersonLifeOrMoney (Z_07)
  switchBank(1);
  return UpdateUnderworldPersonLifeOrMoney_Full(x);
}

export function UpdateGrumble(x) {
  // UpdateGrumble (Z_07)
  switchBank(1);
  return UpdateGrumble_Full(x);
}
