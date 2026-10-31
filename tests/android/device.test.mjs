// End-to-end tests of the Android app on a device/emulator (adb + debug APK). Only with ANDROID=1:
//   ANDROID=1 node --test tests/android/device.test.mjs     (needs `npm run android:build -- --debug` and adb)
// ANDROID=browser runs the same steps in a desktop Chrome emulating the phone (no Android needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { romExists, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';

const mode = process.env.ANDROID;
const skip = !mode ? 'set ANDROID=1 (emulator/phone on adb) or ANDROID=browser' : !romExists() && 'roms/zelda.nes not present';

test('Android app end to end (scripts/android/device-test.mjs)', { skip, timeout: 60 * 60e3 }, () => {
  const args = [join(REPO_ROOT, 'scripts/android/device-test.mjs')];
  if (mode === 'browser') args.push('--browser');
  if (process.env.ANDROID_MOVIES) args.push('--movies', process.env.ANDROID_MOVIES);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  assert.equal(r.status, 0);
});
