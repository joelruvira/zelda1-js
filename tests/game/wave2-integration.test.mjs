// Wave 2 integration (Phase 2): the pure port (no hybrid) against the oracle, RAM + SRAM + picture on
// every frame, for the movies this wave must pass. Skipped without roms/zelda.nes or jsnes.
//
// Known exception (not a port bug): frame 121, the frame Start is pressed on the title. The original
// NMI spends ~8300 CPU cycles (past the end of vblank: IsrNmi waits for the sprite-0 flag to clear,
// then AnimateDemo) before UpdateMode0Demo_Sub0 calls TurnOffAllVideo, so the hardware still draws
// scanlines 0-52 of the title before PPUMASK goes to 0. The port runs game logic without CPU-cycle
// accounting (src/core/ppu.js catch-up model), so its $2001 write lands at the start of the frame.
// Movies that stop at a stub of a later package are compared up to that frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hasJsnes } from '../../tools/oracle/lib/jsnes-loader.mjs';
import { romExists, loadRomFile } from '../../tools/oracle/lib/rom-file.mjs';
import { loadMovie, createMovie } from '../../tools/oracle/lib/movie.mjs';
import { TraceCollector } from '../../tools/oracle/lib/trace.mjs';
import { compareTraces, loadIgnoreConfig } from '../../tools/oracle/lib/diff-core.mjs';
import { runPort } from '../../tools/oracle/lib/port-adapter.mjs';
import { ROOT } from '../core/helpers.mjs';

const skip = !romExists() ? 'roms/zelda.nes not present' : !(await hasJsnes()) ? 'jsnes not installed' : false;

const KNOWN_IMAGE_ONLY = new Set([121]);

/** movie -> frames the pure port must reach (null = whole movie). */
const TARGETS = {
  'power-on-600': null,
  'title-start': null,
  'file-eliminate': null,
  'register-name': 468, // frame 469 calls ClearRoomHistory (P05) from mode 2
  'second-quest-name': 508, // same, mode 2 entry
  'title-idle': 1883, // frame 1884 calls AnimateItemObject (P10) for the first story item
};

/** movie -> frames to play (cut long movies a little past the stub frame to keep the test fast). */
const PLAY = { 'title-idle': 1900 };

async function run(name) {
  const rom = loadRomFile();
  let movie = loadMovie(join(ROOT, 'tests/oracle/movies', `${name}.zmv`));
  if (PLAY[name]) {
    movie = createMovie(movie.p1.slice(0, PLAY[name]), movie.p2.slice(0, PLAY[name]), { timing: movie.timing, name });
  }
  const { Oracle } = await import('../../tools/oracle/lib/nes-oracle.mjs');
  const oracle = await Oracle.create({ rom: rom.bytes });
  const a = new TraceCollector({});
  oracle.run(movie, a, { captureFb: () => true });
  const b = new TraceCollector({});
  let stoppedAt = null;
  try {
    await runPort({ rom: rom.bytes, inputs: movie, sink: b, captureFb: () => true });
  } catch (e) {
    if (e.name !== 'NotImplementedError') throw e;
    stoppedAt = b.frames.length; // first frame that could not run
  }
  return { a, b, stoppedAt };
}

for (const [name, reach] of Object.entries(TARGETS)) {
  test(`pure port ${name}: RAM, SRAM and picture match the original`, { skip }, async (t) => {
    const { a, b, stoppedAt } = await run(name);
    if (reach === null) assert.equal(stoppedAt, null, `${name} must run to the end (stopped at ${stoppedAt})`);
    else assert.ok(b.frames.length - 1 >= reach, `${name} must reach frame ${reach} (got ${b.frames.length - 1})`);
    if (stoppedAt !== null) t.diagnostic(`frames 0-${stoppedAt - 1} compared; frame ${stoppedAt} needs a later package`);
    const report = compareTraces(a, b, { ignore: loadIgnoreConfig().ignore, maxReportFrames: 1000 });
    for (const f of report.frames) {
      assert.equal(f.ram.length, 0, `RAM at frame ${f.frame}`);
      assert.equal(f.sram.length, 0, `SRAM at frame ${f.frame}`);
      assert.ok(KNOWN_IMAGE_ONLY.has(f.frame), `picture at frame ${f.frame}: ${f.fb?.count} pixels`);
    }
  });
}

// InitModeD with bad save RAM does JMP IsrReset from inside the NMI: the rest of IsrNmi (@EnableNMI)
// must not run after RunGame, and the game must keep running from the reset state.
test('JMP IsrReset from mode $D abandons the current NMI and the game restarts', { skip: romExists() ? false : 'roms/zelda.nes not present' }, async () => {
  const { createGame } = await import('../../src/headless.js');
  const { GameMode, GameSubmode, IsUpdatingMode, SaveRamBegin, SaveRamEnd, CurPpuControl_2000 } =
    await import('../../src/core/vars.js');
  const game = await createGame({ rom: loadRomFile().bytes });
  for (let i = 0; i < 5; i++) game.stepFrame();
  game.ram[GameMode] = 0x0d;
  game.ram[GameSubmode] = 0;
  game.ram[IsUpdatingMode] = 0;
  game.sram[SaveRamBegin - 0x6000] = 0x00; // corrupt marker -> InitSaveRam sets C
  game.stepFrame();
  assert.equal(game.ram[GameMode], 0, 'ClearRam ran (back to mode 0)');
  assert.equal(game.ram[CurPpuControl_2000] & 0xa0, 0xa0, 'RunGame enabled the NMI');
  for (let i = 0; i < 200; i++) game.stepFrame(); // keeps running: title from scratch
  assert.equal(game.ram[GameMode], 0);
  assert.equal(game.sram[SaveRamBegin - 0x6000], 0x5a, 'save RAM initialised again');
  assert.equal(game.sram[SaveRamEnd - 0x6000], 0xa5);
});
