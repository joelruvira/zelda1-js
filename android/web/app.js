// Android shell of the port (android/app loads it in a WebView): the same game as the web page
// (src/session.js, 'hardware' timing), full screen with integer scaling, touch controls, native gamepads,
// ROM picker, pause menu and the battery SRAM kept by the app. Also runs in a desktop browser for
// development (native.js falls back to browser APIs): npm run serve -> http://localhost:8080/android/web/

import { read } from '../../src/core/bus.js';
import { bootGame, createGameLoop } from '../../src/session.js';
import { WIDTH, HEIGHT } from '../../src/core/ppu.js';
import { BTN } from '../../src/core/input.js';
import { timing } from '../../src/core/timing.js';
import { native, isAndroid } from './native.js';
import { checkZeldaRom } from './romcheck.js';
import { TouchControls, computeLayout } from './touch.js';
import { fitScreen } from './screen.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false });
const image = ctx.createImageData(WIDTH, HEIGHT);

// ---------------------------------------------------------------- preferences (per device conveniences)
const PREFS_KEY = 'zelda1js.prefs.v1';
const prefs = { vibration: true, scale: 'integer' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')); } catch { /* defaults */ }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

// ---------------------------------------------------------------- game session
let machine = null;
let game = null;
let loop = null;
let audio = null;
let lastSaved = null; // SRAM as last written to storage
const paused = new Set(); // reasons: 'menu', 'hidden', 'halt'
let touchBits = 0;
let padBits = 0;

// Clock of the loop: the vsync timestamp of requestAnimationFrame (core/loop.js counts emulated frames by
// elapsed real time, so a 120 Hz screen still gets exactly 60.0988 frames per second; the vsync time
// instead of performance.now() keeps the frame cadence free of callback jitter).
let clock = performance.now();
const stats = { wakes: 0, frames: 0, busyMs: 0, maxBusyMs: 0, perWake: [0, 0, 0, 0, 0], since: performance.now() };
const schedule = (cb) => requestAnimationFrame((ts) => {
  clock = ts;
  const t0 = performance.now();
  const before = loop?.frameCount ?? 0;
  cb();
  const busy = performance.now() - t0;
  const n = (loop?.frameCount ?? 0) - before;
  stats.wakes++;
  stats.frames += n;
  stats.busyMs += busy;
  if (busy > stats.maxBusyMs) stats.maxBusyMs = busy;
  stats.perWake[Math.min(n, 4)]++;
});

function present(picture) {
  image.data.set(picture);
  ctx.putImageData(image, 0, 0);
}

const readCpu = (addr) => (machine ? read(addr) : 0);

function applyInput() {
  machine?.input.setVirtual(0, touchBits | padBits);
}

function saveIfChanged() {
  if (!machine) return false;
  const s = machine.sram;
  if (lastSaved && lastSaved.every((v, i) => v === s[i])) return false;
  if (!native.saveSram(s)) return false;
  lastSaved = s.slice();
  return true;
}
setInterval(saveIfChanged, 500);

async function startGame(rom) {
  loop?.stop();
  saveIfChanged();
  loop = null;
  showScreen('loading');
  const session = await bootGame(rom, {
    timingMode: 'hardware',
    prepare: (m) => {
      m.input.attach(window);
      native.loadSram(m.sram);
      lastSaved = m.sram.slice();
    },
  });
  ({ machine, game } = session);
  applyInput();
  machine.bus.apuWrite = (addr, value) => audio?.writeRegister(addr, value);
  audio?.setReadMemory(readCpu); // DMC samples of the new ROM
  loop = createGameLoop({
    machine,
    game,
    present,
    audio: () => audio,
    onHalt: (err) => {
      console.error(err);
      paused.add('halt');
      showMessage(`El juego se ha detenido: ${err.message}`);
    },
    now: () => clock,
    schedule,
  });
  paused.delete('halt');
  showScreen('game');
  resume();
  enableAudio();
}

function resume() {
  if (!loop || paused.size) return;
  clock = performance.now();
  loop.start();
  if (audio?.ready) audio.resume();
  native.keepScreenOn(true);
}

function pause(reason) {
  paused.add(reason);
  loop?.stop();
  touch.releaseAll();
  // a physical key held when the app goes to the background never sends its keyup: release them all
  machine?.input.keyState.fill(0);
  keyBits = 0;
  if (audio?.ready) audio.suspend();
  saveIfChanged();
  native.keepScreenOn(false);
}

function unpause(reason) {
  paused.delete(reason);
  resume();
}

// Audio (src/audio): unlocked by the first touch or key; the WebView also allows it without a gesture.
async function enableAudio() {
  try {
    if (!audio) {
      const { NesAudio } = await import('../../src/audio/audio.js');
      // a little more queue than the desktop page (2 frames): phone audio callbacks are coarser
      audio = new NesAudio({ targetFrames: 3, maxFrames: 8 });
      audio.setReadMemory(readCpu);
    }
    await audio.init();
    if (paused.size || !loop?.running) await audio.suspend();
  } catch (err) {
    console.warn('audio', err);
  }
}
for (const type of ['pointerdown', 'keydown']) addEventListener(type, enableAudio, { once: true, capture: true });

// ---------------------------------------------------------------- screens
function showScreen(name) {
  for (const id of ['loading', 'romScreen', 'menu', 'message']) $(id).hidden = true;
  canvas.hidden = !machine;
  $('touch').hidden = name !== 'game' && name !== 'menu';
  if (name === 'loading') $('loading').hidden = false;
  if (name === 'rom') $('romScreen').hidden = false;
  if (name === 'menu') { $('menu').hidden = false; focusMenu(0); }
}

function showMessage(text) {
  $('messageText').textContent = text;
  $('message').hidden = false;
}

// ---------------------------------------------------------------- ROM
let changingRom = false;

function showRomScreen({ change = false, error = '' } = {}) {
  changingRom = change;
  $('romBack').hidden = !change;
  $('romError').textContent = error;
  showScreen('rom');
}

async function pickRom() {
  $('romError').textContent = '';
  $('pickBtn').disabled = true;
  try {
    const { status, bytes } = await native.pickRom();
    if (!bytes) {
      if (status === 'too-big') $('romError').textContent = 'Ese archivo es demasiado grande para ser la ROM de The Legend of Zelda.';
      else if (status !== 'cancel') $('romError').textContent = 'No se ha podido leer ese archivo. Prueba otra vez o elige otro.';
      return;
    }
    const check = await checkZeldaRom(bytes);
    if (!check.ok) {
      native.discardRom();
      $('romError').textContent = check.message;
      return;
    }
    if (!(await native.commitRom(bytes))) {
      $('romError').textContent = 'No se ha podido guardar la ROM en el móvil. Inténtalo otra vez.';
      return;
    }
    changingRom = false;
    romSource = 'picked';
    paused.delete('menu');
    await startGame(check.rom);
  } finally {
    $('pickBtn').disabled = false;
  }
}

$('pickBtn').addEventListener('click', pickRom);
$('romBack').addEventListener('click', () => { if (changingRom) openMenu(); });

// ---------------------------------------------------------------- pause menu
const menuButtons = () => [...$('menu').querySelectorAll('button')];
let menuIndex = 0;

function focusMenu(i) {
  const b = menuButtons();
  menuIndex = (i + b.length) % b.length;
  b[menuIndex].focus({ preventScroll: true });
}

function renderMenuLabels() {
  $('optVibration').textContent = `Vibración: ${prefs.vibration ? 'sí' : 'no'}`;
  $('optScale').textContent = `Imagen: ${prefs.scale === 'integer' ? 'píxeles exactos' : 'pantalla completa'}`;
}

function openMenu() {
  if (!machine) return;
  pause('menu');
  renderMenuLabels();
  showScreen('menu');
}

function closeMenu() {
  showScreen('game');
  unpause('menu');
}

const menuActions = {
  continue: closeMenu,
  rom: () => showRomScreen({ change: true }),
  vibration: () => { prefs.vibration = !prefs.vibration; savePrefs(); renderMenuLabels(); },
  scale: () => { prefs.scale = prefs.scale === 'integer' ? 'fit' : 'integer'; savePrefs(); renderMenuLabels(); relayout(); },
  exit: () => { saveIfChanged(); native.exit(); },
};
$('menu').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (act) menuActions[act]();
});
$('menu').addEventListener('pointerdown', (e) => { if (e.target === $('menu')) closeMenu(); });

/** Gamepad / keyboard on the menu: up/down choose, A or Start confirm, B goes back. */
function menuInput(pressed) {
  if (pressed & BTN.UP) focusMenu(menuIndex - 1);
  else if (pressed & BTN.DOWN) focusMenu(menuIndex + 1);
  else if (pressed & (BTN.A | BTN.START)) menuButtons()[menuIndex].click();
  else if (pressed & BTN.B) closeMenu();
}

// ---------------------------------------------------------------- touch controls and layout
let insets = { left: 0, top: 0, right: 0, bottom: 0 };
const touch = new TouchControls($('touch'), {
  onChange: (bits) => { touchBits = bits; applyInput(); },
  onPress: (bits) => { if (prefs.vibration) native.vibrate(bits & (BTN.A | BTN.B | BTN.START | BTN.SELECT) ? 18 : 10); },
  onMenu: openMenu,
  onActivity: () => setControlsVisible(true),
});

function setControlsVisible(on) {
  $('touch').classList.toggle('faded', !on);
}

let viewPx = null; // exact size of the WebView in device pixels (Android)
function relayout() {
  const dpr = devicePixelRatio || 1;
  const W = viewPx ? viewPx.w / dpr : (visualViewport?.width ?? innerWidth);
  const H = viewPx ? viewPx.h / dpr : (visualViewport?.height ?? innerHeight);
  const f = fitScreen({ cssWidth: W, cssHeight: H, dpr, mode: prefs.scale, ...(viewPx ? { devWidth: viewPx.w, devHeight: viewPx.h } : {}) });
  Object.assign(canvas.style, { left: `${f.css.x}px`, top: `${f.css.y}px`, width: `${f.css.w}px`, height: `${f.css.h}px` });
  touch.setLayout(computeLayout({ width: W, height: H, game: f.css, safe: insets }));
  native.setGestureExclusion(touch.exclusionRects());
}
addEventListener('resize', relayout);
matchMedia('(resolution: 1dppx)').addEventListener?.('change', relayout);

// Physical keyboard: the game keys work as on the web page; Escape opens the menu.
let keyBits = 0;
const KEY_BITS = { ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT, KeyX: BTN.A, Enter: BTN.START, KeyZ: BTN.B, Escape: BTN.B };
addEventListener('keydown', (e) => {
  setControlsVisible(false);
  if (!$('menu').hidden) {
    const bit = KEY_BITS[e.code] ?? 0;
    if (bit && !(keyBits & bit)) menuInput(bit);
    keyBits |= bit;
    e.preventDefault();
    return;
  }
  if (e.code === 'Escape' && $('romScreen').hidden) { openMenu(); e.preventDefault(); }
});
addEventListener('keyup', (e) => { keyBits &= ~(KEY_BITS[e.code] ?? 0); });
addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- Android -> page
let lastPad = 0;
globalThis.ZeldaApp = {
  /** Back button / gesture: true when handled (false lets the app close). */
  onBack() {
    if (!$('message').hidden && paused.has('halt')) return false;
    if (!$('menu').hidden) { closeMenu(); return true; }
    if (!$('romScreen').hidden) {
      if (changingRom) { openMenu(); return true; }
      return false;
    }
    if (machine) { openMenu(); return true; }
    return false;
  },
  onPause() { pause('hidden'); },
  onResume() { unpause('hidden'); },
  /** State of the physical gamepads (NES bits), sent by MainActivity on every change. */
  onPad(bits) {
    const pressed = bits & ~lastPad;
    lastPad = bits;
    setControlsVisible(false);
    if (!$('menu').hidden) { padBits = 0; applyInput(); if (pressed) menuInput(pressed); return; }
    if (!$('romScreen').hidden) {
      if (pressed & (BTN.A | BTN.START)) $('pickBtn').click();
      else if (pressed & BTN.B && changingRom) openMenu();
      return;
    }
    padBits = bits;
    applyInput();
  },
  /** Display cutout insets and the WebView's size, in device pixels. */
  onInsets(left, top, right, bottom, width = 0, height = 0) {
    const d = devicePixelRatio || 1;
    insets = { left: left / d, top: top / d, right: right / d, bottom: bottom / d };
    viewPx = width > 0 && height > 0 ? { w: width, h: height } : null;
    relayout();
  },
  onRomPicked(status) { native.romPicked(status); },
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause('hidden');
  else unpause('hidden');
});

// Read-only hooks for the device tests (scripts/android/device-test.mjs, through the WebView DevTools).
globalThis.__zelda = {
  get machine() { return machine; },
  get loop() { return loop; },
  get audio() { return audio; },
  get timingMode() { return timing.mode; },
  get paused() { return [...paused]; },
  get layout() { return touch.layout; },
  get canvasRect() { const r = canvas.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio, viewPx }; },
  get bits() { return { touch: touchBits, pad: padBits, input: machine?.input.buttons(0) ?? 0 }; },
  stats,
  resetStats() { Object.assign(stats, { wakes: 0, frames: 0, busyMs: 0, maxBusyMs: 0, perWake: [0, 0, 0, 0, 0], since: performance.now() }); },
  saveIfChanged,
  isAndroid,
  get romSource() { return romSource; },
};

// ---------------------------------------------------------------- startup
// Android: the ROM comes inside the APK (npm run android:build packs roms/zelda.nes), so the game starts
// straight away. The ROM screen is only a fallback (a ROM kept from an earlier install, or the picker)
// should the packed one be missing or fail the check, and the way to load a ROM in a desktop browser.
let romSource = null; // 'bundled' | 'stored' | 'picked'
(async () => {
  relayout();
  native.ready();
  if (isAndroid) $('menu').querySelector('[data-act="rom"]').remove(); // no "Cambiar ROM": one ROM, the packed one
  showScreen('loading');
  let error = '';
  const bundled = await native.bundledRom();
  if (bundled) {
    const check = await checkZeldaRom(bundled);
    if (check.ok) { romSource = 'bundled'; await startGame(check.rom); return; }
    console.error('ROM del APK no válida:', check.message);
    error = check.message;
  }
  const stored = await native.storedRom();
  if (stored) {
    const check = await checkZeldaRom(stored);
    if (check.ok) { romSource = 'stored'; await startGame(check.rom); return; }
    error = check.message;
  }
  showRomScreen({ error });
})();
