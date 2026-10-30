// P07 combat — Link being harmed and the shove (knockback) set-up (Z_01, BANK_01_CODE in WRAM).

import { ram } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  ObjType, ObjX, ObjY, ObjDir, ObjAttr, ObjState, ObjGridOffset, ObjShoveDir, ObjShoveDistance,
  ObjInvincibilityTimer, ObjInvincibilityMask, Gohma_ObjEyeState, InvRing, WorldKillCount,
  HelpDropCount, HelpDropValue, HeartPartial, HeartValues, GameMode,
} from '../../core/vars.js';
import { PlaySample } from '../audio/requests.js';
import { EndGameMode } from '../modes/dispatch.js';
import { GetOppositeDir } from '../movement/math.js';

/**
 * HarmLink (Z_01, part of CheckLinkCollisionPreinit). X = attacker. Shoves Link, sets [0C] and
 * unpacks ObjTypeToDamagePoints[type] into [0D] (high byte = low nibble) and [0E] (high nibble).
 */
export function HarmLink(x) {
  // HarmLink (Z_01)
  BeginShove(x);
  ram[0x0c]++;
  $pxa('Z_01:5728', ObjType, x);
  const dp = table(bus.rom, 'ObjTypeToDamagePoints');
  $pxa('Z_01:5729', label('ObjTypeToDamagePoints').addr, ram[ObjType + x]); // run address (WRAM)
  const a = dp.byte(ram[ObjType + x]);
  ram[0x0d] = a & 0x0f;
  ram[0x0e] = a & 0xf0;
  return Link_BeHarmed(x); // falls through
}

/**
 * Link_BeHarmed (Z_01). X = attacker, [0D]:[0E] = damage (high:low). Hurt sound (not for the
 * whirlwind), halved per ring level, subtracted from the hearts; Link dies (mode $11) when they run out.
 */
export function Link_BeHarmed(x) {
  // Link_BeHarmed (Z_01)
  $pxa('Z_01:5744', ObjType, x);
  if (!$br('Z_01:5746', ram[ObjType + x] === 0x2e)) PlaySample(0x08);
  // LSR [0D] / ROR [0E] once per ring level.
  let y = ram[InvRing];
  if (!$br('Z_01:5752', y === 0)) {
    do {
      const c = ram[0x0d] & 1;
      ram[0x0d] >>= 1;
      ram[0x0e] = (ram[0x0e] >> 1) | (c << 7);
      y = (y - 1) & 0xff;
    } while ($br('Z_01:5757', y !== 0));
  }
  for (;;) {
    // @ResetHelp
    ram[WorldKillCount] = 0;
    ram[HelpDropCount] = 0;
    ram[HelpDropValue] = 0;
    if (!$br('Z_01:5771', ram[HeartPartial] < ram[0x0e])) {
      ram[HeartPartial] = ram[HeartPartial] - ram[0x0e];
      if ($br('Z_01:5782', (ram[HeartValues] & 0x0f) < ram[0x0d])) break; // @HandleDied
      ram[HeartValues] = ram[HeartValues] - ram[0x0d];
      return;
    }
    // @BorrowHeart: the partial heart counts as full at $FF (not $100).
    ram[0x0e] = ram[0x0e] - ram[HeartPartial];
    if ($br('Z_01:5801', (ram[HeartValues] & 0x0f) === 0)) break; // @HandleDied
    ram[HeartValues]--;
    ram[HeartPartial] = 0xff;
    $br('Z_01:5805', true); // BNE @ResetHelp (always)
  }
  // @HandleDied
  ram[HeartValues] &= 0xf0;
  const a = EndGameMode();
  ram[HeartPartial] = a;
  ram[ObjState] = a;
  ram[GameMode] = 0x11;
  ram[ObjDir] = 0x04;
}

/**
 * BeginShove (Z_01). X = monster (attacker of Link, or defender against weapon [00]);
 * [00] = 0 when Link is the defender, else the weapon slot; [09] = damage type; [0B] = direction.
 * Sets the shove direction/distance and invincibility of the defender.
 */
export function BeginShove(x) {
  // BeginShove (Z_01)
  const y = ram[0x00];
  if (!$br('Z_01:6511', x >= 0x0d)) {
    $pxa('Z_01:6512', ObjInvincibilityMask, x);
    if ($br('Z_01:6514', (ram[ObjInvincibilityMask + x] & ram[0x09]) !== 0)) return;
  }
  // Assume a vertical shove: [08] = up, [04]/[05] = monster/other Y.
  ram[0x08] = 0x08;
  ram[0x04] = ram[(ObjY + x) & 0xff];
  $pxa('Z_01:6532', ObjY, y);
  ram[0x05] = ram[ObjY + y];
  let horizontal;
  if (!$br('Z_01:6539', y !== 0) && !$br('Z_01:6541', ram[ObjGridOffset] === 0)) {
    horizontal = $br('Z_01:6544', (ram[ObjDir] & 0x03) !== 0);
    if (!horizontal) $br('Z_01:6545', true); // BEQ @CheckVertical (always)
  } else {
    horizontal = !$br('Z_01:6558', ram[0x0b] >= 0x04);
  }
  if (horizontal) {
    // @CheckHorizontal
    ram[0x08] = 0x02;
    ram[0x04] = ram[(ObjX + x) & 0xff];
    $pxa('Z_01:6567', ObjX, y);
    ram[0x05] = ram[ObjX + y];
  }
  // @CheckVertical
  if (!$br('Z_01:6580', ram[0x04] >= ram[0x05])) ram[0x08] >>= 1;
  if ($br('Z_01:6585', y !== 0)) return MonsterDefender(x, y);
  // Link is the defender.
  if ($br('Z_01:6591', ram[ObjInvincibilityTimer] !== 0)) return;
  ram[ObjShoveDir] = ram[0x08] | 0x80;
  ram[ObjInvincibilityTimer] = 0x18;
  ram[ObjShoveDistance] = 0x20;
  if ($br('Z_01:6610', x >= 0x0d)) return; // shoved by his own weapon (fire)
  $pxa('Z_01:6616', ObjAttr, x);
  if ($br('Z_01:6618', (ram[ObjAttr + x] & 0x80) !== 0)) return; // "reverse after hitting Link"
  $pxa('Z_01:6621', ObjType, x);
  if ($br('Z_01:6623', ram[ObjType + x] === 0x12)) return; // vire
  ram[(ObjDir + x) & 0xff] = GetOppositeDir(ram[(ObjDir + x) & 0xff]).a;
}

/** @MonsterDefender of BeginShove: shove the monster in the weapon's direction. */
function MonsterDefender(x, y) {
  $pxa('Z_01:6638', ObjDir, y);
  ram[0x08] = ram[ObjDir + y];
  $pxa('Z_01:6646', ObjAttr, x);
  if (!$br('Z_01:6648', (ram[ObjAttr + x] & 0x80) === 0)) ram[0x08] |= 0x40;
  $pxa('Z_01:6654', ObjInvincibilityTimer, x);
  if ($br('Z_01:6655', ram[ObjInvincibilityTimer + x] !== 0)) return;
  $pxa('Z_01:6658', ObjType, x);
  const t = ram[ObjType + x];
  if ($br('Z_01:6660', t === 0x33) || !$br('Z_01:6662', t !== 0x34)) {
    // @Gohma: only the eye (parts 3/4) with eye state 3.
    if (!$br('Z_01:6669', ram[0x0f] === 0x03) && $br('Z_01:6671', ram[0x0f] !== 0x04)) return;
    $pxa('Z_01:6674', Gohma_ObjEyeState, x);
    if ($br('Z_01:6676', ram[Gohma_ObjEyeState + x] !== 0x03)) return;
  }
  // @SetShoveDir
  ram[(ObjShoveDir + x) & 0xff] = ram[0x08] | 0x80;
  ram[(ObjShoveDistance + x) & 0xff] = 0x40;
  ram[ObjInvincibilityTimer + x] = 0x10;
}
