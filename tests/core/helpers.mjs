// Shared helpers for core tests (synthetic ROMs, paths, optional real ROM).
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const DISASM = join(ROOT, 'reference/zelda1-disassembly/src');
export const ROM_PATH = join(ROOT, 'roms/zelda.nes');
export const hasDisasm = existsSync(join(DISASM, 'Z_07.asm'));
export const hasRom = existsSync(ROM_PATH);
export const realRom = () => readFileSync(ROM_PATH);

/** Build an iNES image: PRG byte at bank b offset o = (b * 16 + (o & 15)) & 0xff unless fill() given. */
export function syntheticRom({ prgBanks = 8, chrBanks = 0, mapper = 1, trainer = false, fill } = {}) {
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, prgBanks, chrBanks, ((mapper & 0x0f) << 4) | 0x02 | (trainer ? 4 : 0), mapper & 0xf0]);
  const prg = new Uint8Array(prgBanks * 0x4000);
  for (let i = 0; i < prg.length; i++) prg[i] = fill ? fill(i >> 14, i & 0x3fff) : (((i >> 14) * 16) + (i & 15)) & 0xff;
  const parts = [header, trainer ? new Uint8Array(512) : new Uint8Array(0), prg, new Uint8Array(chrBanks * 0x2000)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
