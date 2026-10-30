// Smoke test of the page bootstrap (src/main.js) without a browser: a minimal DOM stub, the user's ROM
// served to its fetch('roms/zelda.nes'), the real main loop (requestAnimationFrame -> runVideoFrame).
// Checks that the game starts with the default timing mode ('hardware', docs/TIMING.md §11), runs
// video frames without errors and draws the title screen. Skipped without roms/zelda.nes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';

const skip = !romExists() && 'roms/zelda.nes not present';

function element(id) {
  const listeners = {};
  return {
    id, hidden: false, textContent: '', style: {}, clientWidth: 768, clientHeight: 720,
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    getContext() {
      return {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => { element.lastImage = img; element.puts = (element.puts ?? 0) + 1; },
      };
    },
  };
}

test('page bootstrap: the ROM loads, the game runs in hardware timing and draws the title screen', { skip, timeout: 60e3 }, async () => {
  const rom = readFileSync(loadRomFile().path);
  const els = {};
  const errors = [];
  let stopped = false;
  const g = globalThis;
  g.document = { getElementById: (id) => (els[id] ??= element(id)), body: { classList: { add() {}, remove() {} } } };
  g.window = g;
  g.addEventListener = () => {};
  g.location = { search: '' };
  g.requestAnimationFrame = (cb) => { if (!stopped) setTimeout(cb, 2); };
  const realSetInterval = g.setInterval;
  g.setInterval = (...a) => realSetInterval(...a).unref(); // SRAM autosave: must not keep the test alive
  g.fetch = async (url) => (String(url).endsWith('roms/zelda.nes')
    ? { ok: true, arrayBuffer: async () => rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.length) }
    : { ok: false });
  const origError = console.error;
  console.error = (...a) => {
    const m = a.map(String).join(' ');
    if (!m.includes('ExperimentalWarning')) errors.push(m); // Node's localStorage notice is not ours
  };
  try {
    await import('../../src/main.js');
    const { timing } = await import('../../src/core/timing.js');
    // ~3 s of real time: the loop runs at 60.0988 video frames per second
    const t0 = Date.now();
    while (Date.now() - t0 < 3500 && !/detenido/.test(els.status?.textContent ?? '')) await new Promise((r) => setTimeout(r, 50));
    stopped = true;
    assert.deepEqual(errors, []);
    assert.match(els.status.textContent, /ROM cargada/);
    assert.equal(timing.mode, 'hardware');
    assert.equal(timing.stats.failures, 0, 'breadcrumb failures');
    assert.ok(timing.stats.nmis > 100, `NMIs run: ${timing.stats.nmis}`);
    assert.ok(element.puts > 100, `pictures presented: ${element.puts}`);
    // the title screen is on: the last picture is not a single colour
    const d = element.lastImage.data;
    const colours = new Set();
    for (let i = 0; i < d.length; i += 4) colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    assert.ok(colours.size > 4, `colours on screen: ${colours.size}`);
  } finally {
    stopped = true;
    console.error = origError;
    g.setInterval = realSetInterval;
  }
});
