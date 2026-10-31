#!/usr/bin/env node
// Copies the web game into the Android app's assets (run by Gradle before every build, and by
// `npm run android:build`). The files keep their repo layout under www/ so the relative imports of
// android/web/*.js ('../../src/...') resolve the same in the APK and on `npm run serve`.
//
//   main  (every build): android/app/src/main/assets/www/
//           src/**/*.js, android/web/ (the shell, without the self test), LICENSE.txt, files.json
//   debug (debug APK only): android/app/src/debug/assets/www/
//           android/web/selftest.{html,js}, tests/oracle/movies/*.{zmv,expect.json,sav} + index.json
//
// Never copies ROMs or anything outside those lists. Usage: node scripts/android/copy-web.mjs [--quiet]

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MAIN_OUT = join(REPO, 'android/app/src/main/assets/www');
export const DEBUG_OUT = join(REPO, 'android/app/src/debug/assets/www');

/** Files of the shell that only the debug APK gets. */
export const DEBUG_ONLY_SHELL = ['selftest.html', 'selftest.js'];
const SHELL_TYPES = /\.(html|js|css|svg|png|json)$/;
const MOVIE_TYPES = /\.(zmv|expect\.json|sav)$/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const posix = (p) => p.split(sep).join('/');

/** The repo files (relative, posix) that go into each asset tree. */
export function listWebFiles(root = REPO) {
  const main = [];
  for (const f of walk(join(root, 'src'))) if (f.endsWith('.js')) main.push(posix(relative(root, f)));
  for (const f of walk(join(root, 'android/web'))) {
    const name = posix(relative(join(root, 'android/web'), f));
    if (SHELL_TYPES.test(name) && !DEBUG_ONLY_SHELL.includes(name)) main.push(`android/web/${name}`);
  }
  const debug = DEBUG_ONLY_SHELL.map((n) => `android/web/${n}`);
  for (const f of walk(join(root, 'tests/oracle/movies'))) {
    if (MOVIE_TYPES.test(f)) debug.push(posix(relative(root, f)));
  }
  return { main, debug };
}

function copyAll(root, files, out) {
  rmSync(out, { recursive: true, force: true });
  const index = [];
  for (const rel of files) {
    if (/\.nes$/i.test(rel) || rel.startsWith('roms/')) throw new Error(`refusing to copy ${rel}: ROM data never goes into the APK`);
    const dst = join(out, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(root, rel), dst);
    index.push([rel, createHash('sha256').update(readFileSync(dst)).digest('hex')]);
  }
  return index;
}

/**
 * @param {{root?: string, mainOut?: string, debugOut?: string}} [o]
 * @returns {{main: string[], debug: string[], digest: string}}
 */
export function copyWeb({ root = REPO, mainOut = MAIN_OUT, debugOut = DEBUG_OUT } = {}) {
  const { main, debug } = listWebFiles(root);
  const mainIndex = copyAll(root, main, mainOut);
  copyFileSync(join(root, 'LICENSE'), join(mainOut, 'LICENSE.txt'));
  // fingerprint of the web game inside the APK (no timestamps: the same sources give the same bytes)
  const digest = createHash('sha256').update(mainIndex.map(([f, h]) => `${f} ${h}`).join('\n')).digest('hex');
  writeFileSync(join(mainOut, 'files.json'), `${JSON.stringify({ digest, files: Object.fromEntries(mainIndex) }, null, 1)}\n`);

  copyAll(root, debug, debugOut);
  const movies = debug.filter((f) => f.endsWith('.zmv')).map((f) => f.split('/').pop().replace(/\.zmv$/, ''));
  writeFileSync(join(debugOut, 'tests/oracle/movies/index.json'), `${JSON.stringify(movies)}\n`);
  return { main, debug, digest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = copyWeb();
  if (!process.argv.includes('--quiet')) {
    console.log(`web assets: ${r.main.length} files -> ${posix(relative(REPO, MAIN_OUT))} (sha256 ${r.digest.slice(0, 16)}…), ` +
      `${r.debug.length} debug-only files -> ${posix(relative(REPO, DEBUG_OUT))}`);
  }
}
