#!/usr/bin/env node
// End-to-end test of the Android build.
//
//   node scripts/android/device-test.mjs            device/emulator on adb (debug APK: WebView DevTools)
//   node scripts/android/device-test.mjs --browser  desktop Chrome emulating the phone (no Android needed):
//                                                   the same shell (android/web/) served by scripts/serve.mjs
// Options: --movies a,b|all (self test, default title-start,walk-first-screens) --out <dir> (screenshots)
//          --chrome <path> --skip-selftest
//
// Steps: device: the ROM packed in the APK starts the game directly; browser: ROM screen -> wrong file ->
// the user's roms/zelda.nes through the picker -> title ->
// touch Start / A / Select to register a name and start the game -> D-pad walk, diagonal + B multitouch ->
// back button menu -> pause/resume -> the save survives a restart (device: am force-stop) -> pixel check of
// the picture on screen (every NES pixel an exact scale x scale block) -> speed (60.0988 frames/s) ->
// self test: the movies played inside the WebView/Chrome must give the same hashes as Node (headless,
// 'hardware' timing) on every frame. The ROM is read from roms/ (packed into the APK by the build; never in git).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Cdp, listTargets, sleep } from './cdp.mjs';
import { REPO, DEBUG_APK, DEBUG_APP_ID, findAdb } from './env.mjs';
import { decodePng } from '../../tools/oracle/lib/png.mjs';
import { selfTest } from '../../android/web/selftest.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const BROWSER = args.includes('--browser');
const OUT = opt('--out', join(REPO, 'out/android-test'));
let MOVIES = opt('--movies', 'title-start,walk-first-screens');
// the desktop server has no index.json of the movies (the debug APK gets one from copy-web.mjs)
if (MOVIES === 'all' && BROWSER) MOVIES = readdirSync(join(REPO, 'tests/oracle/movies')).filter((f) => f.endsWith('.zmv')).map((f) => f.slice(0, -4)).join(',');
const ROM = join(REPO, 'roms/zelda.nes');
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const NES = { A: 0x80, B: 0x40, SELECT: 0x20, START: 0x10, UP: 0x08, DOWN: 0x04, LEFT: 0x02, RIGHT: 0x01 };
const GameMode = 0x12;

// ------------------------------------------------------------------ drivers
/** Desktop Chrome emulating a Galaxy S2x Ultra in landscape (3120x1440 px: 780x360 CSS at 4x). */
async function browserDriver() {
  const port = 9300 + Math.floor(Math.random() * 400);
  const server = spawn(process.execPath, [join(REPO, 'scripts/serve.mjs'), String(port)], { stdio: 'ignore' });
  const chromePath = opt('--chrome', process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  const profile = join(tmpdir(), `zelda-chrome-${port}`);
  const cdpPort = port + 1000;
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await listTargets(cdpPort); break; } catch { await sleep(200); } }
  const base = `http://localhost:${port}/android/web/`;
  let c = null;
  async function open(url) {
    const t = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
    c = await Cdp.connect(t.webSocketDebuggerUrl);
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('DOM.enable');
    c.on('Runtime.exceptionThrown', (p) => console.log('  page exception:', p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 780, height: 360, deviceScaleFactor: 4, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await c.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await c.send('Page.navigate', { url });
    return c;
  }
  return {
    name: 'browser',
    get cdp() { return c; },
    async launch() { if (c) c.close(); return open(`${base}index.html`); },
    async launchSelfTest(movies) { if (c) c.close(); return open(`${base}selftest.html?movies=${movies}`); },
    async pickFile(path) {
      const box = await c.eval("JSON.stringify(document.getElementById('pickBtn').getBoundingClientRect())").then(JSON.parse);
      const chooser = c.once('Page.fileChooserOpened');
      await tap(c, box.x + box.width / 2, box.y + box.height / 2);
      const ev = await chooser;
      await c.send('DOM.setFileInputFiles', { files: [path], backendNodeId: ev.backendNodeId });
    },
    back: () => c.eval('ZeldaApp.onBack()'),
    background: () => c.eval('ZeldaApp.onPause()'),
    foreground: () => c.eval('ZeldaApp.onResume()'),
    async kill() { await c.send('Page.navigate', { url: 'about:blank' }); },
    screenshot: () => c.screenshot(),
    async readTestResults() { return null; },
    async close() { c?.close(); chrome.kill(); server.kill(); await sleep(500); try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp */ } },
  };
}

/** Emulator / phone on adb with the debug APK (WebView DevTools on). */
async function adbDriver() {
  const adb = findAdb();
  const sh = (...a) => spawnSync(adb, a, { encoding: 'utf8' });
  const shBin = (...a) => spawnSync(adb, a, { maxBuffer: 1 << 28 }).stdout;
  if (!existsSync(DEBUG_APK)) throw new Error('falta dist/zelda1-js-debug.apk: npm run android:build -- --debug');
  const inst = sh('install', '-r', DEBUG_APK);
  if (!/Success/.test(inst.stdout)) throw new Error(`adb install: ${inst.stdout}${inst.stderr}`);
  sh('shell', 'pm', 'clear', DEBUG_APP_ID);
  let c = null;
  const port = 9222;
  async function attach() {
    for (let i = 0; i < 60; i++) {
      const pid = sh('shell', 'pidof', DEBUG_APP_ID).stdout.trim();
      if (pid) {
        sh('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
        try {
          const page = (await listTargets(port)).find((t) => t.type === 'page');
          if (page) {
            c = await Cdp.connect(page.webSocketDebuggerUrl);
            await c.send('Runtime.enable');
            await c.send('Page.enable');
            return c;
          }
        } catch { /* not ready */ }
      }
      await sleep(500);
    }
    throw new Error('no WebView DevTools socket');
  }
  const start = async (extra = []) => {
    if (c) c.close();
    sh('shell', 'am', 'start', '-W', '-n', `${DEBUG_APP_ID}/io.github.joelruvira.zelda1js.MainActivity`, ...extra);
    return attach();
  };
  /** Taps a text node of the system document picker (uiautomator dump). */
  async function tapText(re) {
    for (let i = 0; i < 20; i++) {
      sh('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
      const xml = sh('shell', 'cat', '/sdcard/ui.xml').stdout;
      for (const m of xml.matchAll(/<node [^>]*?(?:text|content-desc)="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
        if (re.test(m[1])) {
          sh('shell', 'input', 'tap', String((+m[2] + +m[4]) >> 1), String((+m[3] + +m[5]) >> 1));
          return true;
        }
      }
      await sleep(700);
    }
    return false;
  }
  return {
    name: 'adb',
    get cdp() { return c; },
    launch: () => start(),
    launchSelfTest: (movies) => start(['--es', 'selftest', movies]),
    async pickFile(path) {
      const box = await c.eval("JSON.stringify(document.getElementById('pickBtn').getBoundingClientRect())").then(JSON.parse);
      const dpr = await c.eval('devicePixelRatio');
      // a real tap through Android's input pipeline
      sh('shell', 'input', 'tap', String(Math.round((box.x + box.width / 2) * dpr)), String(Math.round((box.y + box.height / 2) * dpr)));
      await sleep(2500);
      const name = path.endsWith('zelda.nes') ? /^zelda\.nes$/ : /^not-a-rom\.nes$/;
      if (!(await tapText(name))) {
        await tapText(/^Downloads?$|^Descargas$/);
        await sleep(1000);
        if (!(await tapText(name))) throw new Error('file not found in the picker');
      }
      await sleep(1500);
    },
    async back() { sh('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await sleep(500); return true; },
    async background() { sh('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await sleep(1500); },
    async foreground() { await start(); },
    async kill() { sh('shell', 'am', 'force-stop', DEBUG_APP_ID); await sleep(800); },
    screenshot: async () => shBin('exec-out', 'screencap', '-p'),
    async readTestResults(name) {
      const r = sh('shell', 'run-as', DEBUG_APP_ID, 'cat', `files/selftest/${name}.json`);
      return r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null;
    },
    async rotate(rotation) { sh('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'); sh('shell', 'settings', 'put', 'system', 'user_rotation', String(rotation)); await sleep(1500); },
    async close() { c?.close(); sh('forward', '--remove', `tcp:${port}`); },
  };
}

// ------------------------------------------------------------------ helpers
async function tap(c, x, y, holdMs = 70) {
  await c.touch('touchStart', [{ x, y }]);
  await sleep(holdMs);
  await c.touch('touchEnd', []);
}

const center = (r) => ('cx' in r ? { x: r.cx, y: r.cy } : { x: r.x + r.w / 2, y: r.y + r.h / 2 });

async function press(c, layout, control, waitMs = 250) {
  const p = center(layout[control]);
  await tap(c, p.x, p.y, 90);
  await sleep(waitMs);
}

const ram = (c, addr) => c.eval(`__zelda.machine.ram[${addr}]`);

async function shot(driver, name) {
  const png = await driver.screenshot();
  const path = join(OUT, `${name}.png`);
  writeFileSync(path, png);
  return { path, png };
}

// ------------------------------------------------------------------ the test
const driver = BROWSER ? await browserDriver() : await adbDriver();
try {
  let c = await driver.launch();
  if (BROWSER) {
    // desktop browser: no APK, so the ROM goes through the shell's fallback picker
    await c.waitFor("!document.getElementById('romScreen').hidden", 30000);
    const s1 = await shot(driver, '01-rom-screen');
    const title = await c.eval("document.querySelector('#romScreen h1').textContent");
    check('ROM screen when there is no packed ROM (browser)', /Elige tu ROM de The Legend of Zelda \(USA, PRG0\)/.test(title), s1.path);

    await driver.pickFile(join(REPO, 'package.json'));
    await c.waitFor("document.getElementById('romError').textContent.length > 0", 15000);
    const err = await c.eval("document.getElementById('romError').textContent");
    const s2 = await shot(driver, '02-rom-rejected');
    check('wrong file rejected with a clear message', /no es una ROM/.test(err), `${err} ${s2.path}`);

    await driver.pickFile(ROM);
    await c.waitFor('window.__zelda?.loop?.running', 30000);
  } else {
    // the APK carries the ROM (npm run android:build): the game starts with no ROM screen
    await c.waitFor('window.__zelda?.loop?.running', 30000);
    const src = await c.eval('__zelda.romSource');
    const romShown = await c.eval("!document.getElementById('romScreen').hidden");
    check('packed ROM: the game starts without asking for a ROM', src === 'bundled' && !romShown, `romSource ${src}`);
  }
  await sleep(2500);
  const s3 = await shot(driver, '03-title');
  check('ROM accepted, game running in hardware timing', await c.eval("__zelda.timingMode === 'hardware'"), s3.path);

  // ---- picture: integer scale, centred, crisp (every NES pixel an exact block of device pixels)
  {
    const geo = await c.eval('__zelda.canvasRect');
    await driver.background(); // freeze the picture
    await sleep(300);
    const pixels = await c.eval("Array.from(document.getElementById('screen').getContext('2d').getImageData(0, 0, 256, 240).data)");
    const { png } = await shot(driver, '04-title-paused');
    await driver.foreground();
    const img = decodePng(png);
    const scale = (geo.w * geo.dpr) / 256;
    const x0 = Math.round(geo.x * geo.dpr);
    const y0 = Math.round(geo.y * geo.dpr);
    let bad = 0;
    let total = 0;
    for (let y = 0; y < 216; y++) { // rows above the Select/Start pills
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        for (const [dx, dy] of [[0, 0], [scale - 1, 0], [0, scale - 1], [scale - 1, scale - 1], [scale >> 1, scale >> 1]]) {
          const px = x0 + x * scale + dx;
          const py = y0 + y * scale + dy;
          const j = (py * img.width + px) * 3;
          total++;
          if (Math.abs(img.rgb[j] - pixels[i]) > 2 || Math.abs(img.rgb[j + 1] - pixels[i + 1]) > 2 || Math.abs(img.rgb[j + 2] - pixels[i + 2]) > 2) bad++;
        }
      }
    }
    const centred = Math.abs(x0 * 2 + 256 * scale - img.width) <= 1 && Math.abs(y0 * 2 + 240 * scale - img.height) <= 1;
    check('integer scale, centred, 1:1 pixel aspect', Number.isInteger(scale) && centred, `scale ${scale}x, picture ${256 * scale}x${240 * scale} at ${x0},${y0} on ${img.width}x${img.height}`);
    check('crisp nearest-neighbour picture (screen == framebuffer, block corners)', bad === 0, `${bad}/${total} samples differ`);
  }

  // ---- touch: register a name and start the game (Start, Start, A x5, Select x3, Start, Start)
  const L = await c.eval('__zelda.layout');
  await press(c, L, 'start', 1500);
  check('touch Start: title -> file select menu', (await ram(c, GameMode)) === 1, `GameMode ${await ram(c, GameMode)}`);
  await press(c, L, 'start', 1500);
  check('touch Start: "Register your name"', (await ram(c, GameMode)) === 0x0e, `GameMode ${await ram(c, GameMode)}`);
  for (let i = 0; i < 5; i++) await press(c, L, 'a', 200);
  await shot(driver, '05-register-name');
  for (let i = 0; i < 3; i++) await press(c, L, 'select', 250);
  await press(c, L, 'start', 1500);
  const s6 = await shot(driver, '06-file-menu');
  check('touch A/Select/Start: name registered, back on the menu', (await ram(c, GameMode)) === 1, s6.path);
  await press(c, L, 'start', 4500);
  const s7 = await shot(driver, '07-overworld');
  check('game started in the overworld', (await ram(c, GameMode)) === 5, `GameMode ${await ram(c, GameMode)} ${s7.path}`);

  // ---- D-pad: hold left, Link moves left; slide to up without lifting, Link moves up
  {
    const d = L.dpad;
    const x0 = await ram(c, 0x70);
    const y0 = await ram(c, 0x84);
    await c.touch('touchStart', [{ x: d.cx - d.r * 0.7, y: d.cy, id: 1 }]);
    await sleep(700);
    const x1 = await ram(c, 0x70);
    const held = await c.eval('__zelda.bits.input');
    await c.touch('touchMove', [{ x: d.cx, y: d.cy - d.r * 0.7, id: 1 }]);
    await sleep(700);
    const y1 = await ram(c, 0x84);
    const held2 = await c.eval('__zelda.bits.input');
    await c.touch('touchEnd', []);
    check('D-pad left moves Link left', held === NES.LEFT && x1 < x0, `bits ${held} x ${x0}->${x1}`);
    check('sliding to up without lifting: Link moves up', held2 === NES.UP && y1 < y0, `bits ${held2} y ${y0}->${y1}`);
    await sleep(200);
    check('everything released after lifting the finger', (await c.eval('__zelda.bits.input')) === 0);
  }

  // ---- multitouch: diagonal + B + A at once, then slide B -> A
  {
    const d = L.dpad;
    await c.touch('touchStart', [{ x: d.cx + d.r * 0.5, y: d.cy - d.r * 0.5, id: 1 }, { x: L.b.cx, y: L.b.cy, id: 2 }]);
    await sleep(120);
    const both = await c.eval('__zelda.bits.input');
    await c.touch('touchMove', [{ x: d.cx + d.r * 0.5, y: d.cy - d.r * 0.5, id: 1 }, { x: (L.a.cx + L.b.cx) / 2, y: (L.a.cy + L.b.cy) / 2, id: 2 }]);
    await sleep(80);
    const middle = await c.eval('__zelda.bits.input');
    await c.touch('touchMove', [{ x: d.cx + d.r * 0.5, y: d.cy - d.r * 0.5, id: 1 }, { x: L.a.cx, y: L.a.cy, id: 2 }]);
    await sleep(80);
    const onA = await c.eval('__zelda.bits.input');
    await shot(driver, '08-multitouch');
    await c.touch('touchEnd', []);
    check('multitouch: up-right diagonal + B', both === (NES.UP | NES.RIGHT | NES.B), `bits 0x${both.toString(16)}`);
    check('slide between buttons: A+B in the middle, then A only', middle === (NES.UP | NES.RIGHT | NES.A | NES.B) && onA === (NES.UP | NES.RIGHT | NES.A), `0x${middle.toString(16)} 0x${onA.toString(16)}`);
  }

  // ---- back button: pause menu, continue
  {
    await driver.back();
    await sleep(400);
    const menuOpen = await c.eval("!document.getElementById('menu').hidden");
    const f0 = await c.eval('__zelda.loop.frameCount');
    await sleep(600);
    const f1 = await c.eval('__zelda.loop.frameCount');
    const s9 = await shot(driver, '09-pause-menu');
    const labels = await c.eval("[...document.querySelectorAll('#menu button')].map(b => b.textContent)");
    check('Back opens the pause menu and the game stops', menuOpen && f0 === f1, `${labels.join(' / ')} ${s9.path}`);
    await driver.back();
    await sleep(500);
    const f2 = await c.eval('__zelda.loop.frameCount');
    check('Back again (Continuar) resumes', (await c.eval("document.getElementById('menu').hidden")) && f2 > f1);
  }

  // ---- background: game and audio pause; resume afterwards
  {
    await driver.background();
    await sleep(300);
    const p = await c.eval('__zelda.paused');
    const f0 = await c.eval('__zelda.loop.frameCount');
    await sleep(500);
    const f1 = await c.eval('__zelda.loop.frameCount');
    check('background pauses the game', p.includes('hidden') && f0 === f1, p.join(','));
    await driver.foreground();
    c = driver.cdp;
    await sleep(800);
    check('foreground resumes the game', (await c.eval('__zelda.loop?.running')) === true);
  }

  // ---- save: the registered game survives killing the app
  {
    await c.eval('__zelda.saveIfChanged()');
    // the battery-backed save files: $6000-$652F (PlayAreaTiles and the rest are work RAM the reset rewrites)
    const before = await c.eval('Array.from(__zelda.machine.sram.subarray(0, 0x530))');
    await driver.kill();
    c = await driver.launch();
    await c.waitFor('window.__zelda?.loop?.running', 30000);
    const after = await c.eval('Array.from(__zelda.machine.sram.subarray(0, 0x530))');
    const same = before.every((v, i) => v === after[i]);
    const used = before.some((v) => v !== 0);
    await sleep(2000);
    const L2 = await c.eval('__zelda.layout');
    await press(c, L2, 'start', 1500);
    const s10 = await shot(driver, '10-menu-after-restart');
    const diffs = before.map((v, i) => (v !== after[i] ? `$${(0x6000 + i).toString(16)}:${v}->${after[i]}` : null)).filter(Boolean);
    check('save survives killing the app (SRAM restored byte for byte, ROM not asked again)', same && used && (await ram(c, GameMode)) === 1,
      `used ${used} diffs ${diffs.slice(0, 8).join(' ')} GameMode ${await ram(c, GameMode)} ${s10.path}`);
  }

  // ---- speed: 60.0988 emulated frames per second of real time, frame cost
  {
    await c.eval('__zelda.resetStats()');
    const f0 = await c.eval('__zelda.loop.frameCount');
    const t0 = Date.now();
    await sleep(10000);
    const f1 = await c.eval('__zelda.loop.frameCount');
    const secs = (Date.now() - t0) / 1000;
    const st = await c.eval('__zelda.stats');
    const fps = (f1 - f0) / secs;
    check('speed: 60.0988 frames per second of real time', Math.abs(fps - 60.0988) < 0.6, `${fps.toFixed(3)} fps; ${(st.busyMs / Math.max(1, st.frames)).toFixed(2)} ms/frame avg, worst wake ${st.maxBusyMs.toFixed(1)} ms; frames per wake ${JSON.stringify(st.perWake)}`);
  }

  // ---- self test: movies inside the WebView/Chrome vs the same code in Node
  if (!args.includes('--skip-selftest')) {
    c = await driver.launchSelfTest(MOVIES);
    await c.waitFor('window.__selftest?.done', 4 * 3600e3, 2000);
    const summary = await c.eval('__selftest.results');
    const rom = new Uint8Array(readFileSync(ROM));
    const dir = join(REPO, 'tests/oracle/movies');
    for (const s of summary) {
      if (s.error) { check(`self test ${s.name}`, false, s.error); continue; }
      const exp = existsSync(join(dir, `${s.name}.expect.json`)) ? JSON.parse(readFileSync(join(dir, `${s.name}.expect.json`), 'utf8')) : {};
      const sram = exp.sram ? new Uint8Array(readFileSync(join(dir, exp.sram.split('/').pop()))) : null;
      const ref = await selfTest({ rom, name: s.name, zmv: readFileSync(join(dir, `${s.name}.zmv`), 'utf8'), sram });
      const full = (await driver.readTestResults(s.name)) ?? (await c.eval(`__selftest.full?.[${JSON.stringify(s.name)}] ?? null`));
      let firstDiff = '';
      if (full) {
        for (let i = 0; i < ref.nmi.fb.length && !firstDiff; i++) {
          if (full.nmi.fb[i] !== ref.nmi.fb[i] || full.nmi.ram[i] !== ref.nmi.ram[i] || full.nmi.sram[i] !== ref.nmi.sram[i]) firstDiff = `frame ${i}`;
        }
      }
      const same = JSON.stringify(s.digest) === JSON.stringify(ref.digest) && !firstDiff;
      check(`pixel perfect: ${s.name} (${ref.frames} frames: picture+RAM+SRAM per frame, ${ref.video.videoFrames} video frames)`, same,
        `${driver.name} ${JSON.stringify(s.digest)} node ${JSON.stringify(ref.digest)} ${firstDiff} ms/frame ${s.msNmi.toFixed(2)}`);
    }
  }
} catch (err) {
  check('test run', false, err.stack ?? String(err));
} finally {
  await driver.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 1)}\n`);
console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots and results.json in ${OUT}`);
process.exit(failed.length ? 1 : 0);
