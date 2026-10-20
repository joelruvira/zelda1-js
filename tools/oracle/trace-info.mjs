#!/usr/bin/env node
// Summarizes a trace: metadata, lag frames, a timeline of watched variables, or a RAM dump.
//
// Usage: node tools/oracle/trace-info.mjs <trace.ztrace> [options]
//   --watch <vars>   comma-separated names/addresses to print whenever they change
//                    (default GameMode,GameSubmode,IsUpdatingMode,CurLevel)
//   --dump <frame>   hex dump of RAM at that frame
import { resolve } from 'node:path';
import { readTrace } from './lib/trace.mjs';
import { loadVarNames, hex } from './lib/var-names.mjs';
import { parseRange } from './lib/diff-core.mjs';
import { formatButtons } from './lib/movie.mjs';
import { parseArgs, runCli } from './lib/cli.mjs';

function dumpRam(ram) {
  const lines = [];
  for (let row = 0; row < ram.length; row += 16) {
    const bytes = [...ram.subarray(row, row + 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${hex(row)}: ${bytes}`);
  }
  return lines.join('\n');
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (!args._[0]) {
    console.error('usage: trace-info.mjs <trace.ztrace> [--watch GameMode,...] [--dump frame]');
    return 2;
  }
  const trace = readTrace(resolve(args._[0]));
  const names = await loadVarNames();
  console.log(JSON.stringify(trace.meta));
  const frames = trace.frames;
  console.log(`records: ${frames.length} (frames ${frames[0]?.frame}..${frames.at(-1)?.frame}), ` +
    `framebuffers: ${frames.filter((f) => f.fb).length}`);
  const lagged = frames.filter((f, i) => i > 1 && f.videoFrame - frames[i - 1].videoFrame > 1).map((f) => f.frame);
  if (lagged.length) console.log(`lag before frames: ${lagged.slice(0, 30).join(', ')}${lagged.length > 30 ? ' ...' : ''}`);

  if (args.dump !== undefined) {
    const f = frames.find((r) => r.frame === Number(args.dump));
    if (!f) throw new Error(`frame ${args.dump} not in trace`);
    console.log(dumpRam(f.ram));
    return 0;
  }
  const watch = String(args.watch ?? 'GameMode,GameSubmode,IsUpdatingMode,CurLevel')
    .split(',')
    .map((w) => ({ label: w, addr: parseRange(w, names).from }));
  let prev = null;
  for (const f of frames) {
    const values = watch.map((w) => f.ram[w.addr] ?? f.sram?.[w.addr - 0x6000]);
    if (prev && values.every((v, i) => v === prev[i])) continue;
    const text = watch.map((w, i) => `${w.label}=${hex(values[i], 2)}`).join(' ');
    console.log(`frame ${String(f.frame).padStart(6)}  in=${formatButtons(f.p1).padEnd(8)} ${text}`);
    prev = values;
  }
  return 0;
}

if (import.meta.main) runCli(main);
