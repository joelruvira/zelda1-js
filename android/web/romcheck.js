// Validation of the ROM the player picks on Android: the same checks as the web page and the oracle tools
// (src/core/rom.js loadRom + checkRevision, docs/ARCHITECTURE.md "ROM y revisión"), but strict: only the
// US PRG0 revision is accepted, with a clear message in Spanish otherwise.

import { loadRom, loadSymbols, checkRevision } from '../../src/core/rom.js';

/** SHA-1 of the PRG (the .nes file without its 16-byte iNES header) of The Legend of Zelda (USA) PRG0. */
export const PRG0_SHA1 = 'a12d74c73a0481599a5d832361d168f4737bbcf6';
/** No Zelda dump is anywhere near this: refuse bigger files before reading them. */
export const MAX_ROM_BYTES = 1 << 20;

async function sha1Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {ArrayBuffer|Uint8Array} data the picked file
 * @returns {Promise<{ok: true, rom: import('../../src/core/rom.js').Rom, sha1: string}
 *   | {ok: false, code: string, message: string, sha1?: string}>}
 */
export async function checkZeldaRom(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length > MAX_ROM_BYTES) {
    return { ok: false, code: 'too-big', message: 'Ese archivo es demasiado grande para ser la ROM de The Legend of Zelda.' };
  }
  let rom;
  try {
    rom = loadRom(bytes);
  } catch (err) {
    const notNes = /iNES/.test(err.message);
    return {
      ok: false,
      code: notNes ? 'not-ines' : 'not-zelda',
      message: notNes
        ? 'Ese archivo no es una ROM .nes (le falta la cabecera iNES).'
        : 'Esa ROM no es The Legend of Zelda de NES.',
    };
  }
  const sha1 = await sha1Hex(rom.prg);
  if (sha1 === PRG0_SHA1) return { ok: true, rom, sha1 };
  // Same mapper and size but other bytes: tell a different revision (PRG1/PRG2, other region) from
  // another game with the per-bank fingerprints of the disassembly.
  await loadSymbols();
  const { PRG_FINGERPRINT, INCBIN_RANGES } = await import('../../src/core/symbols.js');
  const { mismatchedBanks } = checkRevision(rom, PRG_FINGERPRINT, INCBIN_RANGES);
  return {
    ok: false,
    code: mismatchedBanks.length < 8 ? 'other-revision' : 'not-zelda',
    sha1,
    message: mismatchedBanks.length < 8
      ? 'Esta ROM es de otra versión de The Legend of Zelda. Solo funciona la versión USA (PRG0).'
      : 'Esa ROM no es The Legend of Zelda (USA, PRG0).',
  };
}
