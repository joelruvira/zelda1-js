// P20 — enemies/statues (Z_04). UpdateStatues was advanced by the wave-4 integrator: the mode-5 loop
// (BeginUpdateWorld) calls it in every underworld room, so the pure port needs it before the rest of P20.
import { ram } from '../../core/ram.js';
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
  if (ram[PersonFireballsEnabled] === 0) {
    const a = GetUniqueRoomId();
    const layouts = table(rom, 'StatueRoomLayouts');
    for (y = 0x01; ; y--) {
      if (a === layouts.byte(y)) break;
      if (y === 0) return;
    }
  }
  // @Shoot
  const pattern = y; // PHA
  const f = FindEmptyMonsterSlot();
  if (f.a >= 0x01) return; // CMP #$01 / PLA / BCS @Exit
  if (f.y < 0x06) return;
  ram[0x0a] = f.y;
  ram[0x0b] = pattern;
  let x = table(rom, 'StatueFireballCounts').byte(pattern);
  do {
    // @LoopFireball
    const t = ram[Statue_ObjFireballTimer + x];
    ram[Statue_ObjFireballTimer + x] = (t - 1) & 0xff;
    if (t !== 0) continue;
    let a = ram[Random + x];
    if (a >= 0xf0) continue;
    ram[Statue_ObjFireballTimer + x] = table(rom, 'StatueFireballStartTimes').byte(a & 0x03);
    y = (x + table(rom, 'StatuePatternToBasePositionIndex').byte(ram[0x0b])) & 0xff;
    const saved = x; // PHA
    Anim_FetchObjPosForSpriteDescriptor(0x00);
    x = ram[0x0a];
    a = table(rom, 'StatueXs').byte(y);
    ram[0x02] = a;
    ram[ObjX + x] = a;
    a = table(rom, 'StatueYs').byte(y);
    ram[0x03] = a;
    ram[ObjY + x] = a;
    ram[0x04] = 0x03;
    for (let i = 0x01; i >= 0; i--) {
      // @LoopAxis
      const d = (ram[0x00 + i] - ram[0x02 + i]) & 0xff;
      if (((d - 0x18) & 0x80) === 0) continue; // CMP #$18 / BPL
      if ((d - 0xe8) & 0x80) continue; // CMP #$E8 / BMI
      ram[0x04] >>= 1;
    }
    if (ram[0x04] !== 0) ShootFireball(0x55, x);
    x = saved; // PLA / TAX
  } while ((x = (x - 1) & 0xff) < 0x80); // @NextLoopFireball: DEX / BPL
}
