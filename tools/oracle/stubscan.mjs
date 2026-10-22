#!/usr/bin/env node
// Integration aid: replays an oracle trace in the port (in-process) and reports
//  - the first frame whose RAM/SRAM differ from the oracle (default ignore ranges + $00-$0F optional)
//  - in hybrid mode (--import tests/game/p01-hybrid-register.mjs), the first frame at which each
//    still-stubbed routine runs as original code (= dependencies of later packages, with frame).
// Usage: node [--import ./tests/game/p01-hybrid-register.mjs] tools/oracle/stubscan.mjs <oracle.ztrace>
//        [--stop-on-diff] [--max N]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readTrace } from './lib/trace.mjs';
import { inputsFromTrace } from './lib/port-adapter.mjs';
import { loadRomFile, DEFAULT_ROM_PATH } from './lib/rom-file.mjs';
import { loadVarNames } from './lib/var-names.mjs';
const VN = await loadVarNames();
const varName = (a) => VN.name(a);

const args = process.argv.slice(2);
const tracePath = args.find((a) => !a.startsWith('--'));
const stopOnDiff = args.includes('--stop-on-diff');
const maxIdx = args.indexOf('--max');
const maxF = maxIdx >= 0 ? +args[maxIdx + 1] : Infinity;
const ref = readTrace(resolve(tracePath));
const inputs = inputsFromTrace(ref);
const rom = loadRomFile(DEFAULT_ROM_PATH);
const sram = ref.meta.sram ? readFileSync(resolve(ref.meta.sram)) : null;
const { createGame } = await import('../../src/headless.js');
let hybrid = null;
try { hybrid = await import('../../tests/game/p01-hybrid.mjs'); } catch {}
const game = await createGame({ rom: rom.bytes, sram: sram ? Uint8Array.from(sram) : null, powerOnFill: ref.meta.powerOnFill ?? 0 });
const ign = (a) => (a >= 0x110 && a <= 0x1ff);
const ignS = (a) => (a >= 0x6c90 && a <= 0x7eff);
const seen = new Set();
const firstStub = [];
let firstDiff = null;
const diffAt = (i) => {
  const o = ref.frames[i];
  const out = [];
  for (let a = 0; a < 0x800; a++) if (!ign(a) && o.ram[a] !== game.ram[a]) out.push(a);
  if (o.sram) for (let a = 0; a < 0x2000; a++) if (!ignS(a + 0x6000) && o.sram[a] !== game.sram[a]) out.push(a + 0x6000);
  return out;
};
let err = null;
const n = Math.min(inputs.length, maxF);
let i = 0;
for (; i < n; i++) {
  try { game.stepFrame(inputs.p1[i], inputs.p2[i]); } catch (e) { err = e; break; }
  if (hybrid) for (const k of Object.keys(hybrid.calls)) if (!seen.has(k)) { seen.add(k); firstStub.push([i + 1, k]); }
  if (!firstDiff) {
    const d = diffAt(i + 1);
    if (d.length) {
      firstDiff = { frame: i + 1, n: d.length, addrs: d.slice(0, 24).map((a) => `$${a.toString(16)}${varName ? '(' + (varName(a) ?? '') + ')' : ''}=o${ref.frames[i + 1].ram[a] ?? ref.frames[i+1].sram?.[a-0x6000]}/p${a < 0x800 ? game.ram[a] : game.sram[a - 0x6000]}`) };
      if (stopOnDiff) break;
    }
  }
}
console.log(JSON.stringify({ trace: tracePath, frames: n, ran: i, error: err ? `${err.message} @frame ${i + 1}` : null, firstDiff }));
console.log(firstStub.map(([f, k]) => `${f}:${k}`).join(" "));
if (err && !(err.name === 'NotImplementedError')) console.error(err.stack);
