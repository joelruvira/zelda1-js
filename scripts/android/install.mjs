#!/usr/bin/env node
// npm run android:install [-- --debug]
// Installs (or updates, keeping the saved games) dist/zelda.apk on the phone connected by USB
// with USB debugging on. Builds it first when it is missing.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO, RELEASE_APK, DEBUG_APK, findAdb } from './env.mjs';

const debug = process.argv.includes('--debug');
const apk = debug ? DEBUG_APK : RELEASE_APK;
const adb = findAdb();

if (!existsSync(apk)) {
  console.log('Todavía no hay APK: lo genero primero (npm run android:build)…');
  const b = spawnSync(process.execPath, [join(REPO, 'scripts/android/build.mjs'), ...(debug ? ['--debug-only'] : [])], { stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const devices = spawnSync(adb, ['devices'], { encoding: 'utf8' });
if (devices.error) {
  console.error('No encuentro adb (viene con el SDK de Android, en platform-tools).');
  process.exit(1);
}
const lines = devices.stdout.split('\n').slice(1).filter((l) => l.trim());
const ready = lines.filter((l) => /\tdevice$/.test(l));
if (!ready.length) {
  console.error(lines.some((l) => /unauthorized/.test(l))
    ? 'El móvil está conectado pero no ha autorizado este ordenador: desbloquéalo y acepta el aviso de "Depuración USB".'
    : 'No hay ningún móvil conectado. Conéctalo por USB y activa "Depuración USB" en Opciones de desarrollador.');
  process.exit(1);
}
const serial = process.env.ANDROID_SERIAL ?? (ready.length > 1 ? ready[0].split('\t')[0] : null);
const base = serial ? ['-s', serial] : [];
console.log(`Instalando ${debug ? 'zelda-debug.apk' : 'zelda.apk'} en ${serial ?? ready[0].split('\t')[0]}…`);
const r = spawnSync(adb, [...base, 'install', '-r', apk], { encoding: 'utf8' });
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
if (r.status !== 0 || !/Success/.test(r.stdout ?? '')) {
  if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(`${r.stdout}${r.stderr}`)) {
    console.error('\nEl móvil tiene una versión firmada con otra clave. Desinstala "Zelda" del móvil y vuelve a intentarlo\n' +
      '(las partidas guardadas se borran al desinstalar).');
  }
  process.exit(1);
}
console.log('Listo: abre "Zelda" en el móvil.');
