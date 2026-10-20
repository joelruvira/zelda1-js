// Frame-by-frame comparison of two traces (oracle vs port).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FB_SIZE, FB_WIDTH, FB_HEIGHT, indicesToRgb } from './palette.mjs';

export const DEFAULT_IGNORE_FILE = join(import.meta.dirname, '..', 'ignore.default.json');

/** Parses "0x00-0x0F", "$6000-$60FF", "0x15" or a variable name ("Random+3", "ObjX:13"). */
export function parseRange(text, names = null) {
  let m = /^(?:\$|0x)([0-9a-f]+)(?:-(?:\$|0x)?([0-9a-f]+))?$/i.exec(text);
  if (m) {
    const from = parseInt(m[1], 16);
    return { from, to: m[2] ? parseInt(m[2], 16) : from, why: text };
  }
  m = /^([A-Za-z_][\w+$]*)(?::(\d+))?$/.exec(text);
  const addr = m && names?.resolve(m[1]);
  if (addr == null) throw new Error(`diff: cannot parse ignore range "${text}"`);
  return { from: addr, to: addr + (m[2] ? Number(m[2]) - 1 : 0), why: text };
}

export function loadIgnoreConfig(path = DEFAULT_IGNORE_FILE) {
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  const conv = (r) => ({ from: parseInt(r.from, 16), to: parseInt(r.to, 16), why: r.why ?? '' });
  return {
    ignore: (cfg.ignore ?? []).map(conv),
    presets: Object.fromEntries(Object.entries(cfg.presets ?? {}).map(([k, v]) => [k, v.map(conv)])),
  };
}

function buildMask(ranges, base, size) {
  const mask = new Uint8Array(size);
  for (const r of ranges) {
    for (let a = Math.max(r.from, base); a <= Math.min(r.to, base + size - 1); a++) mask[a - base] = 1;
  }
  return mask;
}

function diffBytes(a, b, mask, base) {
  const out = [];
  if (!a || !b) return out;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && !mask[i]) out.push({ addr: base + i, a: a[i], b: b[i] });
  }
  return out;
}

/**
 * Pixel mask for image comparisons. ignoreRow0: jsnes never draws NES scanline 0 (it stays
 * black), so row 0 is skipped by default. ignoreLeft8: skip the left 8 columns (jsnes paints
 * clipped columns black where hardware shows the backdrop color).
 */
export function pixelSkipper({ ignoreLeft8 = false, ignoreRow0 = true } = {}) {
  return (x, y) => (ignoreLeft8 && x < 8) || (ignoreRow0 && y === 0);
}

/** Counts differing pixels outside the masked area and their bounding box. */
export function diffFramebuffers(fa, fb, maskOpts = {}) {
  const skip = pixelSkipper(maskOpts);
  let count = 0, minX = FB_WIDTH, minY = FB_HEIGHT, maxX = -1, maxY = -1;
  for (let i = 0; i < FB_SIZE; i++) {
    const x = i & 0xff;
    const y = i >> 8;
    if (fa[i] === fb[i] || skip(x, y)) continue;
    count++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { count, bbox: count ? { x0: minX, y0: minY, x1: maxX, y1: maxY } : null };
}

/** RGB image 768x240: oracle | port | differences (red) over a dimmed oracle. */
export function diffImageRgb(fa, fb, palette, maskOpts = {}) {
  const skip = pixelSkipper(maskOpts);
  const ra = indicesToRgb(fa, palette);
  const rb = indicesToRgb(fb, palette);
  const W = FB_WIDTH * 3;
  const out = new Uint8Array(W * FB_HEIGHT * 3);
  for (let y = 0; y < FB_HEIGHT; y++) {
    for (let x = 0; x < FB_WIDTH; x++) {
      const i = y * FB_WIDTH + x;
      const row = y * W;
      out.set(ra.subarray(i * 3, i * 3 + 3), (row + x) * 3);
      out.set(rb.subarray(i * 3, i * 3 + 3), (row + FB_WIDTH + x) * 3);
      const o = (row + 2 * FB_WIDTH + x) * 3;
      if (fa[i] !== fb[i] && !skip(x, y)) {
        out[o] = 0xff; out[o + 1] = 0x20; out[o + 2] = 0x20;
      } else {
        out[o] = ra[i * 3] >> 2; out[o + 1] = ra[i * 3 + 1] >> 2; out[o + 2] = ra[i * 3 + 2] >> 2;
      }
    }
  }
  return { width: W, height: FB_HEIGHT, rgb: out };
}

/**
 * Compares two parsed traces. Returns a report with per-frame differences
 * (only frames that differ), the first divergent frame and summary counts.
 */
export function compareTraces(ta, tb, opts = {}) {
  const { ignore = [], compareSram = true, compareFb = true, maxReportFrames = 20 } = opts;
  const maskOpts = { ignoreLeft8: opts.ignoreLeft8 ?? false, ignoreRow0: opts.ignoreRow0 ?? true };
  const ramMask = buildMask(ignore, 0x0000, 0x800);
  const sramMask = buildMask(ignore, 0x6000, 0x2000);
  const byFrame = new Map(tb.frames.map((f) => [f.frame, f]));
  const report = { compared: 0, firstDivergence: null, divergentFrames: 0, inputMismatches: [], frames: [], missing: [] };
  for (const a of ta.frames) {
    const b = byFrame.get(a.frame);
    if (!b) { report.missing.push(a.frame); continue; }
    report.compared++;
    if (a.p1 !== b.p1 || a.p2 !== b.p2) report.inputMismatches.push({ frame: a.frame, a: [a.p1, a.p2], b: [b.p1, b.p2] });
    const entry = {
      frame: a.frame,
      ram: diffBytes(a.ram, b.ram, ramMask, 0x0000),
      sram: compareSram ? diffBytes(a.sram, b.sram, sramMask, 0x6000) : [],
      fb: compareFb && a.fb && b.fb ? diffFramebuffers(a.fb, b.fb, maskOpts) : null,
    };
    const differs = entry.ram.length || entry.sram.length || entry.fb?.count;
    if (!differs) continue;
    report.divergentFrames++;
    report.firstDivergence ??= a.frame;
    if (report.frames.length < maxReportFrames) report.frames.push(entry);
  }
  report.equal = report.divergentFrames === 0 && report.missing.length === 0 && report.compared > 0;
  return report;
}

export function formatReport(report, names, { verbose = false } = {}) {
  const hex2 = (v) => '$' + v.toString(16).toUpperCase().padStart(2, '0');
  const addrName = (addr) => {
    const n = names?.name(addr);
    const h = '$' + addr.toString(16).toUpperCase().padStart(4, '0');
    return n ? `${h} ${n}` : h;
  };
  const lines = [];
  lines.push(`frames compared: ${report.compared}, divergent: ${report.divergentFrames}` +
    (report.missing.length ? `, missing in B: ${report.missing.length} (first ${report.missing[0]})` : ''));
  if (report.inputMismatches.length) {
    const m = report.inputMismatches[0];
    lines.push(`WARNING: inputs differ in ${report.inputMismatches.length} frames (first: frame ${m.frame}, ` +
      `A=${m.a.map(hex2).join('/')} B=${m.b.map(hex2).join('/')})`);
  }
  if (report.equal) {
    lines.push('OK: traces are identical (outside ignored ranges).');
    return lines.join('\n');
  }
  if (report.firstDivergence !== null) lines.push(`FIRST DIVERGENCE at frame ${report.firstDivergence}`);
  const shown = verbose ? report.frames : report.frames.slice(0, 1);
  for (const f of shown) {
    lines.push(`-- frame ${f.frame}: ${f.ram.length} RAM, ${f.sram.length} SRAM bytes differ` +
      (f.fb ? `, ${f.fb.count} pixels differ` + (f.fb.bbox ? ` in (${f.fb.bbox.x0},${f.fb.bbox.y0})-(${f.fb.bbox.x1},${f.fb.bbox.y1})` : '') : ''));
    for (const d of [...f.ram, ...f.sram].slice(0, verbose ? Infinity : 40)) {
      lines.push(`   ${addrName(d.addr).padEnd(40)} oracle=${hex2(d.a)} port=${hex2(d.b)}`);
    }
    const total = f.ram.length + f.sram.length;
    if (!verbose && total > 40) lines.push(`   ... ${total - 40} more (use --verbose)`);
  }
  return lines.join('\n');
}
