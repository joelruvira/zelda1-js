// node --import ./tests/game/p13-hybrid-register.mjs <script> (or a static import before dynamic imports):
// isolates P13. src/game/stub.js -> p01-hybrid.mjs, and the modules of the other packages P13 calls
// (P05, P06, P08, P11, P12, P14, P15, P16, P25; P01 stays real) are replaced by modules whose exports
// run the ORIGINAL 6502 routine with the register contract the JS ports use. So a divergence in
// tests/game/p13-routines.test.mjs can only come from P13 code.
// P13_REAL=1 keeps the real modules (integration with whatever is already ported).
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
const STUBBED = process.env.P13_REAL ? [] : [
  'objects/killcounts.js', 'objects/spawnpos.js', 'modes/crossroom.js', 'modes/mode5-play.js',
  'modes/mode11-death.js', 'modes/mode12-endlevel.js', 'hud/map.js', 'hud/statusbar.js', 'hud/submenu.js',
  'world/layout.js', 'world/tilemap.js', 'world/doors-draw.js', 'world/doors.js', 'world/roomflags.js',
  'world/warps.js', 'link/anim.js', 'link/move.js', 'movement/math.js', 'movement/bounds.js',
  'movement/shove.js', 'movement/walker.js', 'movement/tiles.js', 'worldobj/pond.js', 'worldobj/tileobjects.js',
  'draw/sprites.js', 'npc/uwperson.js',
];

// Register contract of the JS ports: name -> JS source of an adapter over runOriginal (`R`).
const ADAPTERS = {
  GetOppositeDir: '(a) => { const r = R("GetOppositeDir", { a }); return { a: r.a, y: r.y }; }',
  Negate: '(a) => R("Negate", { a }).a',
  IsDarkRoom_Bank5: '(y) => R("IsDarkRoom_Bank5", { y }).a',
  CopyNextRowToTransferBuf: '() => R("CopyNextRowToTransferBuf", {}).c',
  CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone: '() => R("CopyNextRowToTransferBufAndAdvanceSubmodeWhenDone", {}).c',
  ResetShoveInfo: '(x) => R("ResetShoveInfo", { x }).a',
  MoveObject: '(x) => R("MoveObject", { x }).x',
  CheckScreenEdge: '() => R("CheckScreenEdge", {}).x',
  GetCollidableTileStill: '(x) => R("GetCollidableTileStill", { x }).a',
  SetDoorFlag: '(x) => R("SetDoorFlag", { x }).a',
};

registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
  load(url, ctx, next) {
    if (STUBBED.some((s) => url.endsWith(`/src/game/${s}`))) {
      const src = readFileSync(fileURLToPath(url), 'utf8');
      const names = new Set();
      for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
      let out = `import { runOriginal as R } from '${HYBRID}';\n`;
      for (const n of names) {
        out += `export const ${n} = ${ADAPTERS[n] ?? `(a = 0, x = 0, y = 0) => R(${JSON.stringify(n)}, { a, x, y }).a`};\n`;
      }
      return { format: 'module', source: out, shortCircuit: true };
    }
    return next(url, ctx);
  },
});
