#!/usr/bin/env node
// Creates the LOCAL release keystore the first time (android/keystore/, git-ignored).
// Android only installs an update over an app signed with the same key: keep a copy of this folder.
// Regenerate (new key; the phone then needs to uninstall the old app first):
//   delete android/keystore/ and run `npm run android:build` (or: node scripts/android/keystore.mjs)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANDROID_DIR, IS_WINDOWS } from './env.mjs';

export const KEYSTORE_DIR = join(ANDROID_DIR, 'keystore');
export const KEYSTORE_FILE = join(KEYSTORE_DIR, 'release.jks');
export const KEYSTORE_PROPS = join(KEYSTORE_DIR, 'keystore.properties');

function keytool() {
  const exe = IS_WINDOWS ? 'keytool.exe' : 'keytool';
  return process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', exe) : exe;
}

export function ensureKeystore({ quiet = false } = {}) {
  if (existsSync(KEYSTORE_FILE) && existsSync(KEYSTORE_PROPS)) return false;
  if (existsSync(KEYSTORE_FILE) !== existsSync(KEYSTORE_PROPS)) {
    throw new Error('android/keystore/ está incompleto (falta release.jks o keystore.properties). Restaura tu copia o borra la carpeta para crear una clave nueva.');
  }
  mkdirSync(KEYSTORE_DIR, { recursive: true });
  const password = randomBytes(24).toString('base64url');
  execFileSync(keytool(), [
    '-genkeypair', '-keystore', KEYSTORE_FILE, '-storetype', 'PKCS12', '-alias', 'zelda1js',
    '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000',
    '-storepass', password, '-keypass', password,
    '-dname', 'CN=Zelda, OU=Local build, O=zelda1-js',
  ], { stdio: quiet ? 'ignore' : 'inherit' });
  writeFileSync(KEYSTORE_PROPS, [
    '# Local release key of Zelda (NOT in git). Keep a backup of this folder: updates need the same key.',
    'storeFile=release.jks',
    `storePassword=${password}`,
    'keyAlias=zelda1js',
    `keyPassword=${password}`,
    '',
  ].join('\n'));
  if (!quiet) console.log('Nueva clave de firma en android/keystore/ (guarda una copia: las actualizaciones necesitan la misma clave).');
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureKeystore();
