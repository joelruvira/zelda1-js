// Page bootstrap: ROM selection/persistence, canvas scaling, audio unlock, main loop.
// Until the game is ported (src/game), it runs a tile viewer that exercises the
// ROM -> CHR-RAM -> PPU -> canvas pipeline with the overworld pattern blocks.

import { loadRom, loadSymbols, table, checkRevision } from './core/rom.js';
import { createMachine } from './core/machine.js';
import { createLoop, runFrame } from './core/loop.js';
import { getStoredRom, storeRom, forgetRom } from './core/romstore.js';
import { loadSram, createAutoSaver } from './core/savestore.js';
import { read, write } from './core/bus.js';
import { ram } from './core/ram.js';
import { WIDTH, HEIGHT } from './core/ppu.js';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const image = ctx.createImageData(WIDTH, HEIGHT);
const status = (text) => { $('status').textContent = text; };

let machine = null;
let loop = null;
let game = null;

// ---------------------------------------------------------------- canvas scaling
function fitCanvas() {
  const stage = $('stage');
  const scale = Math.max(1, Math.floor(Math.min(stage.clientWidth / WIDTH, stage.clientHeight / HEIGHT)));
  canvas.style.width = `${WIDTH * scale}px`;
  canvas.style.height = `${HEIGHT * scale}px`;
}
addEventListener('resize', fitCanvas);

function present() {
  image.data.set(machine.ppu.frameBuffer);
  ctx.putImageData(image, 0, 0);
}

// ---------------------------------------------------------------- demo (until src/game exists)
// Mirrors TransferCommonPatterns (bank 2) + the overworld branch of TransferLevelPatternBlocks
// (bank 3): every table is read from the ROM by label, bytes go through $2006/$2007.
function transferBlock(src, bank, size, vram) {
  write(0x2006, vram >> 8);
  write(0x2006, vram & 0xff);
  machine.mapper.setPrgBank(bank); // SwitchBank: ($00),Y reads see this bank at $8000
  for (let i = 0; i < size; i++) write(0x2007, read(src + i));
}

function transferDemoPatterns() {
  const addrs = table(machine.rom, 'CommonPatternBlockAddrs');
  const sizes = table(machine.rom, 'CommonPatternBlockSizes'); // .DBYT: high byte first
  const vrams = table(machine.rom, 'CommonPatternVramAddrs');
  for (let i = 0; i < 3; i++) {
    const be = (t) => (t.byte(i * 2) << 8) | t.byte(i * 2 + 1);
    transferBlock(addrs.word(i), addrs.bank, be(sizes), be(vrams));
  }
  const src = table(machine.rom, 'PatternBlockSrcAddrsOW');
  const len = table(machine.rom, 'PatternBlockSizesOW');
  const ppu = table(machine.rom, 'PatternBlockPpuAddrs');
  for (let i = 0; i < 2; i++) {
    const be = (t) => (t.byte(i * 2) << 8) | t.byte(i * 2 + 1);
    transferBlock(src.word(i), src.bank, be(len), be(ppu));
  }
}

function createTileViewer() {
  let bgTable = 0;
  const setup = () => {
    write(0x2001, 0); // rendering off while filling VRAM
    transferDemoPatterns();
    // Nametable 0: tiles $00-$FF in a 16x16 grid at tile (1,2); everything else blank ($24 in Zelda's font).
    write(0x2006, 0x20); write(0x2006, 0x00);
    for (let i = 0; i < 0x3c0; i++) {
      const col = i & 31, row = i >> 5;
      const inGrid = col >= 1 && col < 17 && row >= 2 && row < 18;
      write(0x2007, inGrid ? ((row - 2) << 4) | (col - 1) : 0x24);
    }
    for (let i = 0; i < 0x40; i++) write(0x2007, 0); // attributes: palette 0
    // Palettes: BG grey ramp, sprites Link-like.
    write(0x2006, 0x3f); write(0x2006, 0x00);
    const pal = [0x0f, 0x00, 0x10, 0x30, 0x0f, 0x00, 0x10, 0x30, 0x0f, 0x00, 0x10, 0x30, 0x0f, 0x00, 0x10, 0x30,
      0x0f, 0x29, 0x27, 0x17, 0x0f, 0x16, 0x27, 0x36, 0x0f, 0x02, 0x22, 0x30, 0x0f, 0x16, 0x2a, 0x30];
    for (const c of pal) write(0x2007, c);
    // OAM via DMA from page $200 (like IsrNmi): 64 sprites 8x16 from the $1000 table in an 8x8 grid.
    for (let n = 0; n < 64; n++) {
      ram[0x200 + n * 4] = 15 + (n >> 3) * 18; // Y (top - 1)
      ram[0x201 + n * 4] = (n * 2) | 1; // tile pair, bit 0 = pattern table $1000
      ram[0x202 + n * 4] = (n >> 4) & 3; // palette
      ram[0x203 + n * 4] = 152 + (n & 7) * 12; // X
    }
  };
  return {
    reset: setup,
    nmi() {
      write(0x2003, 0);
      write(0x4014, 0x02);
      write(0x2005, 0); write(0x2005, 0);
      write(0x2000, 0x20 | (bgTable << 4)); // 8x16 sprites, BG table selectable
      write(0x2001, 0x1e);
    },
    toggleTable() { bgTable ^= 1; return bgTable; },
  };
}

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
  const autosave = createAutoSaver(machine.sram);
  setInterval(autosave, 1000);

  game = createTileViewer();
  game.reset();
  $('intro').hidden = true;
  canvas.hidden = false;
  $('tableBtn').hidden = false;
  $('forgetBtn').hidden = false;
  fitCanvas();
  machine.bus.apuWrite = (addr, value) => audio?.writeRegister(addr, value);
  loop = createLoop({
    frame: () => { runFrame(machine, game); audio?.endFrame(); },
    present,
  });
  loop.start();
  status(revision.ok
    ? 'ROM cargada (USA PRG0) · visor de tiles (overworld)'
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
$('audioBtn').addEventListener('click', async () => {
  try {
    if (!audio) {
      const { NesAudio } = await import('./audio/audio.js');
      audio = new NesAudio();
      audio.setReadMemory((addr) => read(addr)); // DMC samples (PcmSamples, fixed bank)
    }
    await audio.init();
    status('Audio activado');
  } catch (err) {
    status(`Audio no disponible (${err.message})`);
  }
});

addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) start(await file.arrayBuffer());
});

(async () => {
  const stored = await getStoredRom();
  if (stored) { start(stored, { remember: false }); return; }
  // Development convenience: a ROM at roms/zelda.nes (git-ignored) is picked up automatically.
  try {
    const res = await fetch('roms/zelda.nes');
    if (res.ok) start(await res.arrayBuffer());
  } catch { /* no local ROM */ }
})();
