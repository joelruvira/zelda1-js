// Page bootstrap: ROM selection/persistence, canvas scaling, audio unlock, main loop.
// Until the game is ported (src/game), it runs a tile viewer that exercises the
// ROM -> CHR-RAM -> PPU -> canvas pipeline with the overworld pattern blocks.

import { loadRom, loadSymbols, checkRevision } from './core/rom.js';
import { createMachine } from './core/machine.js';
import { createLoop, runReset, runVideoFrame } from './core/loop.js';
import { setupTiming, timing } from './core/timing.js';
import { getStoredRom, storeRom, forgetRom } from './core/romstore.js';
import { loadSram, createAutoSaver } from './core/savestore.js';
import { read } from './core/bus.js';
import { cpu } from './core/ram.js';
import { createTileViewer } from './tileviewer.js';
import { createGameLogic } from './game/index.js';
import { WIDTH, HEIGHT } from './core/ppu.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const image = ctx.createImageData(WIDTH, HEIGHT);
const status = (text) => { $('status').textContent = text; };

let machine = null;
let loop = null;
let game = null;
let autosaveTimer = 0;

// ---------------------------------------------------------------- canvas scaling
function fitCanvas() {
  const stage = $('stage');
  const scale = Math.max(1, Math.floor(Math.min(stage.clientWidth / WIDTH, stage.clientHeight / HEIGHT)));
  canvas.style.width = `${WIDTH * scale}px`;
  canvas.style.height = `${HEIGHT * scale}px`;
}
addEventListener('resize', fitCanvas);

let picture = null; // RGBA picture of the last video frame (runVideoFrame)
function present() {
  image.data.set(picture ?? machine.ppu.frameBuffer);
  ctx.putImageData(image, 0, 0);
}

// Cycle tracker (docs/TIMING.md §11): ?timing=hardware (default: the console, pixel perfect against
// Mesen2), jsnes (the CI oracle's rules) or off.
const TIMING_MODE = new URLSearchParams(location.search).get('timing') ?? 'hardware';

// ---------------------------------------------------------------- startup
async function start(buffer, { remember = true } = {}) {
  let rom;
  try {
    rom = loadRom(buffer);
  } catch (err) {
    status(`ROM no válida: ${err.message}`);
    return;
  }
  if (remember) storeRom(buffer);
  await loadSymbols();
  const { PRG_FINGERPRINT, INCBIN_RANGES } = await import('./core/symbols.js');
  const revision = checkRevision(rom, PRG_FINGERPRINT, INCBIN_RANGES);
  loop?.stop();
  machine = createMachine(rom);
  machine.input.attach(window);
  loadSram(machine.sram);
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(createAutoSaver(machine.sram), 1000);

  const logic = createGameLogic();
  game = logic.ported ? logic : createTileViewer(); // tile viewer until P01 ports IsrReset/IsrNmi
  try {
    await setupTiming({ rom, mode: logic.ported ? TIMING_MODE : 'off' });
  } catch (err) {
    console.warn('timing off:', err);
    await setupTiming({ rom, mode: 'off' });
  }
  cpu.reset(); // same power-on flags/stack as src/headless.js
  runReset(machine, game);
  picture = null;
  $('intro').hidden = true;
  canvas.hidden = false;
  $('tableBtn').hidden = false;
  $('forgetBtn').hidden = false;
  fitCanvas();
  machine.bus.apuWrite = (addr, value) => audio?.writeRegister(addr, value);
  audio?.setReadMemory(readCpu); // re-snapshot $8000-$FFFF for the DMC with the new ROM
  let halted = false;
  loop = createLoop({
    frame: () => {
      if (halted) return;
      try {
        picture = runVideoFrame(machine, game);
      } catch (err) {
        // A routine of a later package is still a stub (NotImplementedError): stop on this frame.
        halted = true;
        loop.stop();
        status(`Juego detenido: ${err.message}`);
        console.error(err);
        return;
      }
      audio?.endFrame();
    },
    present,
  });
  loop.start();
  status(revision.ok
    ? `ROM cargada (USA PRG0)${logic.ported ? '' : ' · visor de tiles (overworld)'}`
    : `Aviso: la ROM no es la revisión USA PRG0 (bancos distintos: ${revision.mismatchedBanks.join(', ')})`);
}

$('romFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) start(await file.arrayBuffer());
});

$('tableBtn').addEventListener('click', () => {
  const t = game?.toggleTable?.();
  $('tableBtn').textContent = `Tabla BG $${t ? '1000' : '0000'}`;
});

$('forgetBtn').addEventListener('click', async () => {
  await forgetRom();
  status('ROM olvidada (recarga la página)');
});

// Audio (src/audio, docs/AUDIO.md): the AudioContext needs a user gesture.
let audio = null;
const readCpu = (addr) => (machine ? read(addr) : 0); // the button may come before the ROM
async function enableAudio() {
  try {
    if (!audio) {
      const { NesAudio } = await import('./audio/audio.js');
      audio = new NesAudio();
      audio.setReadMemory(readCpu); // DMC samples (PcmSamples, fixed bank)
    }
    await audio.init();
    $('audioBtn').hidden = true;
  } catch (err) {
    status(`Audio no disponible (${err.message})`);
  }
}
$('audioBtn').addEventListener('click', enableAudio);
// The first key press or click is the user gesture browsers require: turn audio on with it.
for (const type of ['keydown', 'pointerdown']) addEventListener(type, enableAudio, { once: true });

addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) start(await file.arrayBuffer());
});

(async () => {
  // The user's ROM at roms/zelda.nes (git-ignored) loads automatically; otherwise the one remembered in IndexedDB.
  try {
    const res = await fetch('roms/zelda.nes');
    if (res.ok) { start(await res.arrayBuffer(), { remember: false }); return; }
  } catch { /* no local ROM */ }
  const stored = await getStoredRom();
  if (stored) start(stored, { remember: false });
})();
