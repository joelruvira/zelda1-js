// P20 — enemies/statues (Z_04). UpdateStatues was advanced by the wave-4 integrator: the mode-5 loop
// (BeginUpdateWorld) calls it in every underworld room, so the pure port needs it before the rest of P20.
import { ram } from '../../core/ram.js';
import { $br, $pxa } from '../../core/timing.js';
import { bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { PersonFireballsEnabled, Statue_ObjFireballTimer, Random, ObjX, ObjY } from '../../core/vars.js';
import { GetUniqueRoomId } from '../world/roomflags.js';
import { FindEmptyMonsterSlot } from '../objects/slots.js';
import { Anim_FetchObjPosForSpriteDescriptor } from '../draw/anim.js';
import { ShootFireball } from './shots.js';

/**
 * UpdateStatues (Z_04). Statues shoot fireballs: pattern 2 when the person fireballs are enabled, else
 * pattern 1 (layout $23) or 0 (layout $24). Each fireball index waits on Statue_ObjFireballTimer and
 * fires only when Link is at least $18 pixels away on some axis.
 */
export function UpdateStatues() {
  // UpdateStatues (Z_04)
  const rom = bus.rom;
  let y = 0x02;
  if (!$br('Z_04:1598', ram[PersonFireballsEnabled] !== 0)) {
    const a = GetUniqueRoomId();
    const layouts = table(rom, 'StatueRoomLayouts');
    for (y = 0x01; ;) {
      $pxa('Z_04:1607', layouts.addr, y);
      if ($br('Z_04:1608', a === layouts.byte(y))) break;
      y = (y - 1) & 0xff;
      if (!$br('Z_04:1610', !(y & 0x80))) return;
    }
  }
  // @Shoot
  const pattern = y; // PHA
  const f = FindEmptyMonsterSlot();
  if ($br('Z_04:1635', f.a >= 0x01)) return; // CMP #$01 / PLA / BCS @Exit
  if ($br('Z_04:1639', f.y < 0x06)) return;
  ram[0x0a] = f.y;
  ram[0x0b] = pattern;
  const counts = table(rom, 'StatueFireballCounts');
  $pxa('Z_04:1648', counts.addr, pattern);
  let x = counts.byte(pattern);
  for (;;) {
    // @LoopFireball
    $pxa('Z_04:1654', Statue_ObjFireballTimer, x);
    const t = ram[Statue_ObjFireballTimer + x];
    ram[Statue_ObjFireballTimer + x] = (t - 1) & 0xff;
    if (!$br('Z_04:1662', t !== 0)) {
      let a = ram[Random + x];
      if (!$br('Z_04:1668', a >= 0xf0)) {
        const times = table(rom, 'StatueFireballStartTimes');
        $pxa('Z_04:1674', times.addr, a & 0x03);
        ram[Statue_ObjFireballTimer + x] = times.byte(a & 0x03);
        const bases = table(rom, 'StatuePatternToBasePositionIndex');
        $pxa('Z_04:1685', bases.addr, ram[0x0b]);
        y = (x + bases.byte(ram[0x0b])) & 0xff;
        const saved = x; // PHA
        Anim_FetchObjPosForSpriteDescriptor(0x00);
        x = ram[0x0a];
        const xs = table(rom, 'StatueXs');
        $pxa('Z_04:1699', xs.addr, y);
        a = xs.byte(y);
        ram[0x02] = a;
        ram[ObjX + x] = a;
        const ys = table(rom, 'StatueYs');
        $pxa('Z_04:1705', ys.addr, y);
        a = ys.byte(y);
        ram[0x03] = a;
        ram[ObjY + x] = a;
        ram[0x04] = 0x03;
        for (let i = 0x01; ;) {
          // @LoopAxis
          $pxa('Z_04:1720', 0x0002, i);
          const d = (ram[0x00 + i] - ram[0x02 + i]) & 0xff;
          // CMP #$18 / BPL :+ ; CMP #$E8 / BMI :+
          if (!$br('Z_04:1722', ((d - 0x18) & 0x80) === 0) && !$br('Z_04:1724', ((d - 0xe8) & 0x80) !== 0)) {
            ram[0x04] >>= 1;
          }
          i--;
          if (!$br('Z_04:1728', i >= 0)) break;
        }
        if (!$br('Z_04:1738', ram[0x04] === 0)) ShootFireball(0x55, x);
        x = saved; // PLA / TAX
      }
    }
    // @NextLoopFireball: DEX / BPL
    x = (x - 1) & 0xff;
    if (!$br('Z_04:1749', !(x & 0x80))) break;
  }
}
