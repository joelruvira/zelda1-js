// Locates and validates the user's ROM (never shipped in the repo).
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const DEFAULT_ROM_PATH = resolve(REPO_ROOT, 'roms/zelda.nes');

export class RomMissingError extends Error {}

export function romExists(path = DEFAULT_ROM_PATH) {
  return existsSync(path);
}

/** Parses the iNES header and checks it looks like Zelda (MMC1, 128KB PRG, CHR-RAM). */
export function describeRom(bytes) {
  if (bytes.length < 16 || bytes[0] !== 0x4e || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1a) {
    throw new Error('ROM: missing iNES header ("NES\\x1A")');
  }
  const mapper = (bytes[6] >> 4) | (bytes[7] & 0xf0);
  const info = {
    prgBanks16k: bytes[4],
    chrBanks8k: bytes[5],
    mapper,
    battery: Boolean(bytes[6] & 0x02),
    trainer: Boolean(bytes[6] & 0x04),
    sha1: createHash('sha1').update(bytes.subarray(16)).digest('hex'),
    size: bytes.length,
  };
  info.warnings = [];
  if (mapper !== 1) info.warnings.push(`mapper ${mapper}, expected 1 (MMC1)`);
  if (info.prgBanks16k !== 8) info.warnings.push(`${info.prgBanks16k} PRG banks, expected 8`);
  if (info.chrBanks8k !== 0) info.warnings.push(`${info.chrBanks8k} CHR-ROM banks, expected 0 (CHR-RAM)`);
  return info;
}

export function loadRomFile(path = DEFAULT_ROM_PATH) {
  if (!existsSync(path)) {
    throw new RomMissingError(
      `ROM not found at ${path}. Copy your own dump of The Legend of Zelda (NES, iNES, ` +
        'MMC1, 128KB PRG) to roms/zelda.nes or pass --rom <path>. The repo never ships ROM data.',
    );
  }
  const bytes = new Uint8Array(readFileSync(path));
  return { bytes, info: describeRom(bytes), path };
}
