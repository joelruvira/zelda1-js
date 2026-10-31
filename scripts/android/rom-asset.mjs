#!/usr/bin/env node
// Packs the user's ROM (roms/zelda.nes) into the APK so the app never asks for it. Run by Gradle before
// every build (task packRom) and by `npm run android:build`.
//
// The ROM is validated (iNES, US PRG0: SHA-1 of the PRG a12d74c7…) and written ONLY to
//   android/app/build/generated/zelda-rom/assets/rom/zelda.nes
// a build directory ignored by git (android/app/build/). Gradle adds it as an extra assets folder, so the
// app reads it at https://appassets.androidplatform.net/assets/rom/zelda.nes. Never into src/main/assets
// (copy-web.mjs refuses ROMs there) and never into git: the APK built this way is for personal use only.
//
// Usage: node scripts/android/rom-asset.mjs [--quiet]   (exit code 1 with a message when the ROM is missing or wrong)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkZeldaRom } from '../../android/web/romcheck.js';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ROM_SOURCE = join(REPO, 'roms/zelda.nes');
/** Extra assets folder of the APK (git-ignored build output). */
export const ROM_ASSETS_DIR = join(REPO, 'android/app/build/generated/zelda-rom/assets');
/** Path of the ROM inside the APK assets (assets/rom/zelda.nes). */
export const ROM_ASSET_PATH = 'rom/zelda.nes';

/**
 * Validates `source` and copies it to `<outDir>/rom/zelda.nes`.
 * @returns {Promise<{path: string, sha1: string, size: number}>}
 * @throws {Error} with a Spanish message when the ROM is missing or is not the US PRG0 one
 */
export async function packRom({ source = ROM_SOURCE, outDir = ROM_ASSETS_DIR } = {}) {
  rmSync(join(outDir, 'rom'), { recursive: true, force: true }); // never leave an old ROM behind
  if (!existsSync(source)) {
    throw new Error(`No encuentro la ROM en ${relative(REPO, source) || source}.\n` +
      'Copia tu ROM de The Legend of Zelda (USA, PRG0) a roms/zelda.nes y vuelve a ejecutar npm run android:build.');
  }
  const bytes = new Uint8Array(readFileSync(source));
  const check = await checkZeldaRom(bytes);
  if (!check.ok) {
    throw new Error(`${relative(REPO, source) || source} no vale: ${check.message}\n` +
      'El APK necesita la ROM de The Legend of Zelda (USA, PRG0) en roms/zelda.nes.');
  }
  const path = join(outDir, ROM_ASSET_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { path, sha1: check.sha1, size: bytes.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await packRom();
    if (!process.argv.includes('--quiet')) {
      console.log(`ROM USA PRG0 (sha1 ${r.sha1.slice(0, 12)}…) empaquetada en ${relative(REPO, r.path)} (fuera de git)`);
    }
  } catch (err) {
    console.error(`\nERROR: ${err.message}\n`);
    process.exit(1);
  }
}
