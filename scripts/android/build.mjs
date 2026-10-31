#!/usr/bin/env node
// npm run android:build [-- --debug | --debug-only]
// Validates the ROM (roms/zelda.nes, US PRG0) and packs it, copies the web game into the assets, builds the
// signed release APK with the Gradle wrapper and leaves it in dist/:
//   dist/zelda.apk        release with YOUR ROM inside, signed with the local key (android/keystore/).
//                             For personal use only: never share or upload it (it contains the game).
//   dist/zelda-debug.apk  only with --debug / --debug-only: self test, WebView DevTools (device tests)
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { REPO, ANDROID_DIR, DIST, RELEASE_APK, DEBUG_APK, IS_WINDOWS, findSdk, ensureLocalProperties, javaEnv } from './env.mjs';
import { ensureKeystore } from './keystore.mjs';
import { copyWeb } from './copy-web.mjs';
import { packRom } from './rom-asset.mjs';

const args = process.argv.slice(2);
const wantRelease = !args.includes('--debug-only');
const wantDebug = args.includes('--debug') || args.includes('--debug-only');

// the ROM first: a missing or wrong ROM stops here with a clear message, before Gradle
try {
  const rom = await packRom();
  console.log(`ROM USA PRG0 validada (sha1 ${rom.sha1.slice(0, 12)}…): va dentro del APK (solo para uso propio)`);
} catch (err) {
  console.error(`\nERROR: ${err.message}\n`);
  process.exit(1);
}

const sdk = findSdk();
if (!sdk) {
  console.error('No encuentro el SDK de Android. Instala Android Studio (o las command-line tools) o define ANDROID_HOME.');
  process.exit(1);
}
ensureLocalProperties(sdk);
const env = javaEnv(); // before keytool and Gradle
if (wantRelease) ensureKeystore();

const web = copyWeb();
console.log(`Juego web copiado: ${web.main.length} archivos (sha256 ${web.digest.slice(0, 16)}…)`);

const tasks = [wantRelease && 'assembleRelease', wantDebug && 'assembleDebug'].filter(Boolean);
const gradlew = join(ANDROID_DIR, IS_WINDOWS ? 'gradlew.bat' : 'gradlew');
const r = spawnSync(gradlew, [...tasks, '--console=plain'], { cwd: ANDROID_DIR, stdio: 'inherit', shell: IS_WINDOWS, env });
if (r.status !== 0) process.exit(r.status ?? 1);

mkdirSync(DIST, { recursive: true });
if (!wantDebug) rmSync(DEBUG_APK, { force: true }); // one APK in dist/ unless the debug one was asked for
const outputs = [
  wantRelease && [join(ANDROID_DIR, 'app/build/outputs/apk/release/app-release.apk'), RELEASE_APK],
  wantDebug && [join(ANDROID_DIR, 'app/build/outputs/apk/debug/app-debug.apk'), DEBUG_APK],
].filter(Boolean);
for (const [from, to] of outputs) {
  if (!existsSync(from)) { console.error(`Falta ${from}`); process.exit(1); }
  copyFileSync(from, to);
  const sha = createHash('sha256').update(readFileSync(to)).digest('hex');
  console.log(`${relative(REPO, to)}  ${(statSync(to).size / 1024 / 1024).toFixed(2)} MB  sha256 ${sha}`);
}
