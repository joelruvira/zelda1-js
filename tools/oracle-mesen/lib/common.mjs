// Shared helpers of the Mesen2 tools.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveMovie, readOptionalSram, runCli as oracleRunCli } from '../../oracle/lib/cli.mjs';
import { createMovie } from '../../oracle/lib/movie.mjs';
import { MesenMissingError } from './mesen.mjs';

/** Movie from a path or idle:N, optionally cut/padded to `frames`. */
export function loadMovieArg(spec, frames) {
  let movie = resolveMovie(spec);
  if (frames !== undefined) {
    const n = Number(frames);
    const p1 = new Uint8Array(n), p2 = new Uint8Array(n);
    p1.set(movie.p1.subarray(0, n));
    p2.set(movie.p2.subarray(0, n));
    movie = createMovie(p1, p2, { timing: movie.timing, name: movie.name, meta: movie.meta });
  }
  return movie;
}

/** Initial SRAM: --sram, else the movie's .expect.json "sram" (as battery.mjs does), else null. */
export function sramForMovie(spec, explicit) {
  if (explicit) return { sram: readOptionalSram(resolve(explicit)), sramPath: basename(explicit) };
  if (!/\.zmv$/.test(spec)) return { sram: null, sramPath: null };
  const exp = resolve(spec).replace(/\.zmv$/, '.expect.json');
  if (!existsSync(exp)) return { sram: null, sramPath: null };
  const e = JSON.parse(readFileSync(exp, 'utf8'));
  if (!e.sram) return { sram: null, sramPath: null };
  const p = join(dirname(resolve(spec)), basename(e.sram));
  return { sram: readOptionalSram(p), sramPath: basename(p) };
}

/** runCli of the oracle plus "Mesen missing" as a setup error (exit 3). */
export function runCli(main) {
  return oracleRunCli(async (argv) => {
    try {
      return await main(argv);
    } catch (e) {
      if (e instanceof MesenMissingError) {
        console.error(`error: ${e.message}`);
        return 3;
      }
      throw e;
    }
  });
}

/** Compared state as tools/oracle/ignore.default.json: no stack $0110-$01FF, no RAM_01_CODE $6C90-$7EFF. */
export function ramDiffs(a, b, out = []) {
  for (let i = 0; i < 0x800; i++) if (a[i] !== b[i] && (i < 0x110 || i >= 0x200)) out.push(i);
  return out;
}
export function sramDiffs(a, b, out = []) {
  for (let i = 0; i < 0x2000; i++) if (a[i] !== b[i] && (i < 0xc90 || i >= 0x1f00)) out.push(0x6000 + i);
  return out;
}
/** Differing rows (1-239 by default; jsnes never draws row 0) and pixel count. */
export function fbDiff(a, b, firstRow = 1) {
  let count = 0;
  const rows = [];
  const rowPx = [];
  for (let y = firstRow; y < 240; y++) {
    let n = 0;
    for (let i = y << 8, e = i + 256; i < e; i++) if (a[i] !== b[i]) n++;
    if (n) { rows.push(y); rowPx.push(n); count += n; }
  }
  return { count, rows, rowPx };
}

export function summarizeRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    out.push(i === j ? `${rows[i]}` : `${rows[i]}-${rows[j]}`);
    i = j;
  }
  return out.join(',');
}

export const hex = (v, n = 2) => '$' + v.toString(16).toUpperCase().padStart(n, '0');
