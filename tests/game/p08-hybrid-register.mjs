// node --import ./tests/game/p08-hybrid-register.mjs <script> (or a static import before dynamic imports):
// isolates P08. src/game/stub.js -> p01-hybrid.mjs, and the modules of the packages P08 calls that
// are still in progress or later (P06 movement, P05 slots, P09 weapons, P13 mode 10, P14 warps)
// are replaced by modules whose exports run the ORIGINAL 6502 routine with the register contract
// the JS ports use. So a P08 divergence can only come from P08 code.
// P08_REAL=1 keeps the real modules (integration with whatever is already ported).
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
const STUBBED = process.env.P08_REAL ? [] : [
  'movement/math.js', 'movement/tiles.js', 'movement/shove.js', 'movement/walker.js', 'movement/bounds.js',
  'objects/slots.js', 'world/warps.js', 'weapons/sword.js', 'weapons/wield.js', 'modes/mode10-stairs.js',
];

// Register contract of the JS ports: name -> JS source of an adapter over runOriginal (`R`).
const ADAPTERS = {
  GetOppositeDir: '(a) => { const r = R("GetOppositeDir", { a }); return { a: r.a, y: r.y }; }',
  // Abs branches on the N flag of the caller's LDA, which runOriginal cannot pass: N=0 is the RTS.
  Abs: '(a) => (a & 0x80 ? R("Negate", { a }).a : a)',
  Negate: '(a) => R("Negate", { a }).a',
  GetCollidingTileMoving: '(x) => R("GetCollidingTileMoving", { x }).a',
  GetCollidableTileStill: '(x) => R("GetCollidableTileStill", { x }).a',
  ResetShoveInfo: '(x) => R("ResetShoveInfo", { x }).a',
  DestroyMonster: '(x) => R("DestroyMonster", { x }).a',
  FindEmptyMonsterSlot: '() => R("FindEmptyMonsterSlot", {})',
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
