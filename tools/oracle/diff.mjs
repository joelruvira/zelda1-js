#!/usr/bin/env node
// Compares two traces frame by frame (A = oracle, B = port), or two PNG images.
//
// Usage: node tools/oracle/diff.mjs <a.ztrace> <b.ztrace> [options]
//        node tools/oracle/diff.mjs <a.png> <b.png> [--out diff.png]
//   --ignore <range>    extra ignored range: 0x00-0x0F, $6000, ObjX:12, Random+2 (repeatable)
//   --ignore-temps      also ignore $00-$0F (routine temporaries)
//   --strict            do not apply tools/oracle/ignore.default.json nor skip pixel row 0
//   --no-sram           do not compare SRAM      --no-fb   do not compare framebuffers
//   --ignore-left8      skip the left 8 pixel columns in image diffs
//   --png-dir <dir>     write diff images (oracle | port | red differences) for divergent frames
//   --verbose           show every reported frame and byte      --json   machine-readable report
// Exit code: 0 identical, 1 divergence, 2 usage/error.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readTrace } from './lib/trace.mjs';
import { loadVarNames } from './lib/var-names.mjs';
import { compareTraces, diffImageRgb, formatReport, loadIgnoreConfig, parseRange } from './lib/diff-core.mjs';
import { decodePng, encodePng } from './lib/png.mjs';
import { getPalette } from './lib/palette.mjs';
import { parseArgs, list, runCli } from './lib/cli.mjs';

const FLAGS = ['ignore-temps', 'strict', 'no-sram', 'no-fb', 'ignore-left8', 'verbose', 'json'];

function diffPngFiles(pathA, pathB, outPath) {
  const a = decodePng(readFileSync(pathA));
  const b = decodePng(readFileSync(pathB));
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    return 1;
  }
  let count = 0;
  const out = new Uint8Array(a.rgb.length);
  for (let i = 0; i < a.width * a.height; i++) {
    const same = a.rgb[i * 3] === b.rgb[i * 3] && a.rgb[i * 3 + 1] === b.rgb[i * 3 + 1] && a.rgb[i * 3 + 2] === b.rgb[i * 3 + 2];
    if (!same) { count++; out.set([0xff, 0x20, 0x20], i * 3); }
    else out.set([a.rgb[i * 3] >> 2, a.rgb[i * 3 + 1] >> 2, a.rgb[i * 3 + 2] >> 2], i * 3);
  }
  console.log(`${count} pixels differ (of ${a.width * a.height})`);
  if (outPath && count) {
    writeFileSync(outPath, encodePng(a.width, a.height, out));
    console.log(`diff image: ${outPath}`);
  }
  return count ? 1 : 0;
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: FLAGS });
  const [pathA, pathB] = args._;
  if (!pathA || !pathB) {
    console.error('usage: diff.mjs <oracle.ztrace> <port.ztrace> [--ignore range] [--png-dir dir] [--json]');
    return 2;
  }
  if (pathA.endsWith('.png') && pathB.endsWith('.png')) return diffPngFiles(pathA, pathB, args.out);

  const names = await loadVarNames();
  const cfg = loadIgnoreConfig();
  const ignore = [
    ...(args.strict ? [] : cfg.ignore),
    ...(args['ignore-temps'] ? cfg.presets.temps ?? [] : []),
    ...list(args.ignore).map((r) => parseRange(r, names)),
  ];
  const ta = readTrace(resolve(pathA));
  const tb = readTrace(resolve(pathB));
  const report = compareTraces(ta, tb, {
    ignore,
    compareSram: !args['no-sram'],
    compareFb: !args['no-fb'],
    ignoreLeft8: Boolean(args['ignore-left8']),
    ignoreRow0: !args.strict,
    maxReportFrames: args.verbose ? 200 : 20,
  });
  if (ta.meta.romSha1 && tb.meta.romSha1 && ta.meta.romSha1 !== tb.meta.romSha1) {
    console.warn('warning: traces were produced from different ROMs');
  }

  if (args['png-dir']) {
    const dir = resolve(args['png-dir']);
    const palette = await getPalette();
    const fa = new Map(ta.frames.map((f) => [f.frame, f.fb]));
    const fbB = new Map(tb.frames.map((f) => [f.frame, f.fb]));
    for (const f of report.frames.filter((e) => e.fb?.count)) {
      mkdirSync(dir, { recursive: true });
      const img = diffImageRgb(fa.get(f.frame), fbB.get(f.frame), palette, { ignoreLeft8: Boolean(args['ignore-left8']), ignoreRow0: !args.strict });
      writeFileSync(join(dir, `diff_${String(f.frame).padStart(6, '0')}.png`), encodePng(img.width, img.height, img.rgb));
    }
  }

  if (args.json) {
    const named = (d) => ({ ...d, name: names.name(d.addr) });
    console.log(JSON.stringify({
      ...report,
      ignore,
      frames: report.frames.map((f) => ({ ...f, ram: f.ram.map(named), sram: f.sram.map(named) })),
    }, null, 2));
  } else {
    console.log(formatReport(report, names, { verbose: Boolean(args.verbose) }));
  }
  return report.equal ? 0 : 1;
}

if (import.meta.main) runCli(main);
