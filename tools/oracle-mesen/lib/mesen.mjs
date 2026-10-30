// Mesen2 as a second, hardware-accurate oracle (docs/ORACLE.md, "Segundo oráculo: Mesen2").
//
// Mesen2 2.1.1 runs headless with `Mesen --testrunner <rom> <script.lua>`: no window, maximum speed, the
// process exits with the code passed to emu.stop(). The Lua script (lua/trace.lua) streams one record per
// logical frame through a named pipe (FIFO) to this process, so nothing large is kept on disk.
//
// Setup (setup.mjs, idempotent; everything stays inside reference/, which git ignores):
//  * portable mode: settings.json next to the executable (Mesen.app/Contents/MacOS). Without any
//    settings.json Mesen shows its first-run configuration wizard (an invisible GUI window), which is why
//    a bare `--testrunner` run used to hang.
//  * MesenCore.dylib links /opt/homebrew/opt/sdl2/lib/libSDL2-2.0.0.dylib (Homebrew's SDL2). Instead of
//    installing it system-wide, the official SDL2 2.32.8 framework (reference/sdl2-dl) is copied next to
//    the executable and MesenCore's load command is rewritten to @loader_path (install_name_tool + ad-hoc
//    codesign; the app has disable-library-validation). The patched file is made read-only so Mesen's
//    dependency extraction (which overwrites files whose size/date differ) cannot restore the original.
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, openSync, closeSync, constants as FS, createReadStream, cpSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { REPO_ROOT } from '../../oracle/lib/rom-file.mjs';

export const MESEN_APP = resolve(process.env.MESEN_APP ?? join(REPO_ROOT, 'reference/mesen2-dl/app/Mesen.app'));
export const MESEN_DIR = join(MESEN_APP, 'Contents/MacOS');
export const MESEN_BIN = join(MESEN_DIR, 'Mesen');
export const SDL_SRC = join(REPO_ROOT, 'reference/sdl2-dl/SDL2.framework');
const SDL_HOMEBREW = '/opt/homebrew/opt/sdl2/lib/libSDL2-2.0.0.dylib';
const SDL_LOCAL = '@loader_path/SDL2.framework/Versions/A/SDL2';
const LUA_TEMPLATE = join(import.meta.dirname, '..', 'lua', 'trace.lua');

export class MesenMissingError extends Error {}

export function mesenExists() {
  return existsSync(MESEN_BIN);
}

/**
 * Settings for fidelity and determinism. Everything not listed keeps Mesen's default; the defaults that
 * matter are written explicitly so a future Mesen version cannot silently change them.
 */
export function mesenSettings() {
  // Palette: entry p (= colour index | emphasis bits << 6, 512 entries) is the RGB value p, so the
  // screen buffer returned to Lua is the PPU's raw output (greyscale already applied by the PPU).
  const userPalette = Array.from({ length: 512 }, (_, p) => 0xff000000 + p);
  return {
    Emulation: { EmulationSpeed: 100, RunAheadFrames: 0 },
    Video: { VideoFilter: 'None', Brightness: 0, Contrast: 0, Hue: 0, Saturation: 0, ScanlineIntensity: 0 },
    Nes: {
      Region: 'Ntsc',
      ConsoleType: 'Nes001',
      RamPowerOnState: 'AllZeros', // the script then writes the oracle's fill byte anyway
      RandomizeCpuPpuAlignment: false,
      RandomizeMapperPowerOnState: false,
      PpuExtraScanlinesBeforeNmi: 0, // no overclock
      PpuExtraScanlinesAfterNmi: 0,
      DisablePpuReset: false,
      EnableOamDecay: false,
      EnablePpuOamRowCorruption: false,
      EnablePpuSpriteEvalBug: false,
      EnablePpu2000ScrollGlitch: false,
      EnablePpu2006ScrollGlitch: false,
      RestrictPpuAccessOnFirstFrame: false,
      EnableDmcSampleDuplicationGlitch: false,
      RemoveSpriteLimit: false,
      DisableSprites: false,
      DisableBackground: false,
      ForceBackgroundFirstColumn: false,
      ForceSpritesFirstColumn: false,
      EnableHdPacks: false,
      InputScanline: 241,
      NtscOverscan: { Left: 0, Right: 0, Top: 0, Bottom: 0 },
      UserPalette: userPalette,
    },
    Debug: { ScriptWindow: { AllowIoOsAccess: true, AllowNetworkAccess: false, ScriptTimeout: 3600 } },
  };
}

/** Problems that prevent a headless run (empty list = ready). */
export function setupProblems() {
  const p = [];
  if (!mesenExists()) { p.push(`Mesen2 not found at ${MESEN_BIN}`); return p; }
  const settings = join(MESEN_DIR, 'settings.json');
  if (!existsSync(settings)) p.push('no portable settings.json');
  else if (readFileSync(settings, 'utf8') !== JSON.stringify(mesenSettings(), null, 1)) p.push('settings.json differs from mesenSettings()');
  const core = join(MESEN_DIR, 'MesenCore.dylib');
  if (!existsSync(core)) p.push('MesenCore.dylib not extracted yet');
  else if (!execFileSync('otool', ['-L', core], { encoding: 'utf8' }).includes(SDL_LOCAL)) p.push('MesenCore.dylib still links Homebrew SDL2');
  if (!existsSync(join(MESEN_DIR, 'SDL2.framework'))) p.push('SDL2.framework not copied next to Mesen');
  return p;
}

/** Idempotent setup (see the header). Returns a list of actions done. */
export function setupMesen({ log = () => {} } = {}) {
  if (!mesenExists()) throw new MesenMissingError(`Mesen2 not found at ${MESEN_BIN}`);
  const done = [];
  const settings = join(MESEN_DIR, 'settings.json');
  const text = JSON.stringify(mesenSettings(), null, 1);
  if (!existsSync(settings) || readFileSync(settings, 'utf8') !== text) {
    writeFileSync(settings, text);
    done.push('wrote portable settings.json');
  }
  const core = join(MESEN_DIR, 'MesenCore.dylib');
  if (!existsSync(core)) {
    // `--testrunner` without a ROM extracts the native dependencies into the home folder and exits (-1)
    spawnSync(MESEN_BIN, ['--testrunner'], { stdio: 'ignore', timeout: 60e3 });
  }
  if (!existsSync(core)) throw new Error('MesenCore.dylib was not extracted');
  if (!existsSync(join(MESEN_DIR, 'SDL2.framework'))) {
    if (!existsSync(SDL_SRC)) {
      throw new MesenMissingError(`SDL2.framework not found at ${SDL_SRC} (official SDL2-2.32.8.dmg, see docs/ORACLE.md)`);
    }
    cpSync(SDL_SRC, join(MESEN_DIR, 'SDL2.framework'), { recursive: true, verbatimSymlinks: true });
    done.push('copied SDL2.framework');
  }
  if (!execFileSync('otool', ['-L', core], { encoding: 'utf8' }).includes(SDL_LOCAL)) {
    chmodSync(core, 0o644);
    execFileSync('install_name_tool', ['-change', SDL_HOMEBREW, SDL_LOCAL, core], { stdio: 'ignore' });
    execFileSync('codesign', ['-f', '-s', '-', core], { stdio: 'ignore' });
    chmodSync(core, 0o444);
    done.push('patched MesenCore.dylib -> bundled SDL2');
  }
  for (const d of done) log(d);
  return done;
}

/** NMI handler entry ($FFFA of the fixed bank) and the address of its RTI (linear sweep from the entry). */
export function findNmiAndRti(romBytes) {
  const prgBanks = romBytes[4];
  const trainer = romBytes[6] & 4 ? 512 : 0;
  const last = romBytes.subarray(16 + trainer + (prgBanks - 1) * 0x4000, 16 + trainer + prgBanks * 0x4000);
  const read = (a) => last[a - 0xc000];
  const nmi = read(0xfffa) | (read(0xfffb) << 8);
  let pc = nmi;
  for (let n = 0; n < 4000 && pc < 0xfffa; n++) {
    const op = read(pc);
    if (op === 0x40) return { nmi, rti: pc };
    pc += opLength(op);
  }
  throw new Error(`no RTI found after the NMI handler at $${nmi.toString(16)}`);
}

function opLength(op) {
  if (op === 0x20) return 3;
  if (op === 0x00 || op === 0x40 || op === 0x60) return 1;
  const cc = op & 3, bbb = (op >> 2) & 7;
  if (cc === 0) {
    if (bbb === 0) return 2; // LDY/CPY/CPX #
    return [2, 2, 1, 3, 2, 2, 1, 3][bbb];
  }
  if (cc === 2) return [2, 2, 1, 3, 1, 2, 1, 3][bbb];
  return [2, 2, 2, 3, 2, 2, 3, 3][bbb]; // cc 1 and 3
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');

function luaParams(p) {
  const v = (x) => (x === null || x === undefined ? 'nil' : typeof x === 'string' ? JSON.stringify(x) : String(x));
  return `local P = {\n${Object.entries(p).map(([k, x]) => `  ${k} = ${v(x)},`).join('\n')}\n}\n`;
}

/**
 * Plays `movie` in Mesen2 and yields one record per logical frame (0..movie.length):
 * {frame, nmiVideo, rtiVideo, videoFrame, p1, p2, nmis, nmiScan, rtiScan, ram, sram, fb|null, writes}
 * writes: [{reg, val, row, dot}] visible-scanline writes to $2000/$2001/$2005/$2006 during this NMI.
 * fb holds raw PPU colour indices (0-63, not canonicalized).
 *   captureFb: (frame) => bool, or 'all'
 */
export async function* runMesen({ rom, romPath, movie, sram = null, powerOnFill = 0, captureFb = () => false, log = null }) {
  const problems = setupProblems();
  if (problems.length) {
    throw new MesenMissingError(`Mesen2 is not ready (${problems.join('; ')}). Run: node tools/oracle-mesen/setup.mjs`);
  }
  if (powerOnFill === 'jsnes') throw new Error('Mesen runner: --power-on jsnes is not supported (use a hex byte)');
  if (movie.p2.some((v) => v)) throw new Error('Mesen runner: player-2 input is not supported (emu.setInput port 1 aliases port 0 in Mesen2 2.1.1)');
  const { nmi, rti } = findNmiAndRti(rom);
  const frames = movie.length;
  let fbsel = 'none';
  if (captureFb === 'all') fbsel = 'all';
  else {
    const s = Array.from({ length: frames + 1 }, (_, f) => (captureFb(f) ? '1' : '0')).join('');
    fbsel = s.includes('1') ? (s.includes('0') ? s : 'all') : 'none';
  }
  const dir = mkdtempSync(join(tmpdir(), 'zelda-mesen-'));
  const fifo = join(dir, 'trace.fifo');
  execFileSync('mkfifo', [fifo]);
  const script = join(dir, 'trace.lua');
  writeFileSync(script, luaParams({
    fifo, nmi, rti, frames, timing: movie.timing, fill: powerOnFill & 0xff,
    p1: hex(movie.p1), p2: hex(movie.p2), sram: sram ? hex(sram.subarray(0, 0x2000)) : null,
    fbsel, maxVideo: frames * 3 + 600,
  }) + readFileSync(LUA_TEMPLATE, 'utf8'));
  const timeout = Math.ceil(120 + frames / 15);
  const child = spawn(MESEN_BIN, ['--testrunner', resolve(romPath), script, `--timeout=${timeout}`, '--enablestdout'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const keep = (d) => { output = (output + d).slice(-8000); log?.(String(d)); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exitCode = null;
  const exited = new Promise((res) => child.on('close', (code, sig) => { exitCode = code ?? sig; res(); }));
  child.on('close', () => {
    // if Mesen died before opening the FIFO, open it for writing ourselves so the reader gets EOF
    try { closeSync(openSync(fifo, FS.O_WRONLY | FS.O_NONBLOCK)); } catch { /* reader not open or already done */ }
  });
  const stream = createReadStream(fifo, { highWaterMark: 1 << 20 });
  const reader = chunkReader(stream);
  let sawDone = false;
  try {
    while (true) {
      const tag = await reader.read(1);
      if (!tag) break;
      const t = String.fromCharCode(tag[0]);
      if (t === 'D') { await reader.read(4); sawDone = true; break; }
      if (t === 'E') {
        const len = (await reader.read(4)).readUInt32LE(0);
        const msg = (await reader.read(len)).toString('utf8');
        throw new Error(`Mesen script error: ${msg}`);
      }
      if (t !== 'F') throw new Error(`Mesen stream: bad tag 0x${tag[0].toString(16)}`);
      const h = await reader.read(20);
      if (!h) break;
      const rec = {
        frame: h.readUInt32LE(0), nmiVideo: h.readUInt32LE(4), rtiVideo: h.readUInt32LE(8),
        p1: h[12], p2: h[13], nmis: h[15], nmiScan: h.readInt16LE(16), rtiScan: h.readInt16LE(18),
      };
      rec.videoFrame = rec.nmiVideo;
      const flags = h[14];
      rec.ram = new Uint8Array(await reader.read(0x800));
      rec.sram = new Uint8Array(await reader.read(0x2000));
      rec.fb = flags & 2 ? new Uint8Array(await reader.read(0xf000)) : null;
      const nw = (await reader.read(2)).readUInt16LE(0);
      const wb = nw ? await reader.read(nw * 6) : null;
      rec.writes = Array.from({ length: nw }, (_, i) => ({
        reg: 0x2000 | wb[i * 6], val: wb[i * 6 + 1], row: wb.readInt16LE(i * 6 + 2), dot: wb.readInt16LE(i * 6 + 4),
      }));
      yield rec;
    }
    await exited;
    if (!sawDone) throw new Error(`Mesen ended without completing the movie (exit ${exitCode}).\n${output.slice(-3000)}`);
    if (exitCode !== 0) throw new Error(`Mesen exited with ${exitCode}.\n${output.slice(-3000)}`);
  } finally {
    stream.destroy();
    if (exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Pulls exact byte counts from a readable stream. */
function chunkReader(stream) {
  const it = stream[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  let ended = false;
  return {
    async read(n) {
      while (buf.length < n && !ended) {
        const { value, done } = await it.next();
        if (done) ended = true;
        else buf = buf.length ? Buffer.concat([buf, value]) : value;
      }
      if (buf.length < n) {
        if (buf.length === 0) return null;
        throw new Error(`Mesen stream truncated (${buf.length}/${n} bytes)`);
      }
      const out = Buffer.from(buf.subarray(0, n));
      buf = buf.subarray(n);
      return out;
    },
  };
}
