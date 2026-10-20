// Shared helpers for the oracle command-line tools.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RomMissingError } from './rom-file.mjs';
import { JsnesMissingError } from './jsnes-loader.mjs';
import { PortMissingError } from './port-adapter.mjs';
import { idleMovie, loadMovie } from './movie.mjs';
import { encodePng } from './png.mjs';
import { FB_WIDTH, FB_HEIGHT, indicesToRgb } from './palette.mjs';

/** Minimal argv parser: positionals, --key value, --flag, repeated keys become arrays. */
export function parseArgs(argv, { flags = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let key = a.slice(2), value;
    const eq = key.indexOf('=');
    if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (flags.includes(key)) value = true;
    else value = argv[++i];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

export function list(v) {
  return v === undefined ? [] : [].concat(v);
}

/** "idle:600" or a movie file path. */
export function resolveMovie(spec) {
  const m = /^idle:(\d+)$/.exec(spec);
  return m ? idleMovie(Number(m[1])) : loadMovie(spec);
}

/** Frame selection: "0,60,600", "every:60", "last", "all", "none", "10-20". */
export function parseFrameSelection(spec, lastFrame) {
  if (!spec || spec === 'none') return () => false;
  const parts = String(spec).split(',');
  const tests = parts.map((p) => {
    if (p === 'all') return () => true;
    if (p === 'last') return (f) => f === lastFrame;
    let m = /^every:(\d+)$/.exec(p);
    if (m) { const n = Number(m[1]); return (f) => f % n === 0; }
    m = /^(\d+)-(\d+)$/.exec(p);
    if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return (f) => f >= a && f <= b; }
    if (/^\d+$/.test(p)) { const n = Number(p); return (f) => f === n; }
    throw new Error(`bad frame selection "${p}"`);
  });
  return (f) => tests.some((t) => t(f));
}

export function parsePowerOn(v = '00') {
  if (v === 'jsnes') return 'jsnes';
  const n = parseInt(String(v).replace(/^0x|^\$/i, ''), 16);
  if (!(n >= 0 && n <= 255)) throw new Error(`bad --power-on value "${v}" (hex byte or "jsnes")`);
  return n;
}

export function readOptionalSram(path) {
  if (!path) return null;
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.length < 0x2000) throw new Error(`SRAM file ${path} must be at least 8192 bytes`);
  return bytes.subarray(0, 0x2000);
}

/** Wraps a sink so captured framebuffers are also written as PNG files. */
export function pngWritingSink(sink, dir, palette) {
  return {
    write(rec) {
      if (rec.fb) {
        mkdirSync(dir, { recursive: true });
        const png = encodePng(FB_WIDTH, FB_HEIGHT, indicesToRgb(rec.fb, palette));
        writeFileSync(join(dir, `frame_${String(rec.frame).padStart(6, '0')}.png`), png);
      }
      sink.write(rec);
    },
    close() { sink.close(); },
  };
}

/** Runs main(), printing known setup errors without a stack trace. */
export async function runCli(main) {
  try {
    process.exitCode = (await main(process.argv.slice(2))) ?? 0;
  } catch (err) {
    const setupError = err instanceof RomMissingError || err instanceof JsnesMissingError || err instanceof PortMissingError;
    if (setupError || err?.name === 'NotImplementedError') {
      console.error(`error: ${err.message}`);
      process.exitCode = 3;
    } else {
      console.error(err?.stack ?? err);
      process.exitCode = 2;
    }
  }
}
