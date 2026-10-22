// node --import ./tests/game/p17-hybrid-register.mjs <script> (or a static import before dynamic imports):
// isolates P17. src/game/stub.js -> p01-hybrid.mjs, and the modules of the other packages P17 calls
// (P04, P05, P06, P07, P09; P01 stays real) are replaced by modules whose exports run the ORIGINAL 6502
// routine with the register contract the JS ports use. So a divergence in tests/game/p17-routines.test.mjs
// can only come from P17 code. P17_REAL=1 keeps the real modules (integration with what is ported).
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
const STUBBED = process.env.P17_REAL ? [] : [
  'movement/math.js', 'movement/walker.js', 'movement/bounds.js', 'movement/tiles.js', 'movement/shove.js',
  'objects/slots.js', 'combat/collisions.js', 'draw/anim.js', 'draw/sprites.js',
  'weapons/arrow.js', 'weapons/shots.js', 'weapons/sword.js', 'weapons/boomerang.js',
];
// P09 routines P17 looks up by name in the weapons modules (they may not be exported yet).
const EXTRA = { 'weapons/arrow.js': ['DrawArrow'], 'weapons/shots.js': ['DrawSwordShotOrMagicShot'] };

// Register contract of the JS ports: name -> JS source of an adapter over runOriginal (`R`).
// The default adapter is (a, x, y) => R(name, {a, x, y}).a.
const X_ONLY = (n, out = 'a') => `(x) => R(${JSON.stringify(n)}, { x }).${out}`;
const ADAPTERS = {
  GetOppositeDir: '(a) => { const r = R("GetOppositeDir", { a }); return { a: r.a, y: r.y }; }',
  FindEmptyMonsterSlot: '() => { const r = R("FindEmptyMonsterSlot", {}); return { a: r.a, y: r.y }; }',
  _CalcDiagonalSpeedIndex: '(y) => R("_CalcDiagonalSpeedIndex", { y }).y',
  MoveObject: X_ONLY('MoveObject', 'x'),
  Walker_Move: X_ONLY('Walker_Move', 'x'),
  Obj_Shove: X_ONLY('Obj_Shove'),
  BoundByRoom: X_ONLY('BoundByRoom'),
  BoundDirectionHorizontally: X_ONLY('BoundDirectionHorizontally', 'y'),
  BoundDirectionVertically: X_ONLY('BoundDirectionVertically', 'y'),
  GetCollidingTileMoving: X_ONLY('GetCollidingTileMoving'),
  ResetObjMetastate: X_ONLY('ResetObjMetastate'),
  DestroyMonster: X_ONLY('DestroyMonster'),
  Anim_FetchObjPosForSpriteDescriptor: X_ONLY('Anim_FetchObjPosForSpriteDescriptor'),
  CheckLinkCollision: X_ONLY('CheckLinkCollision'),
  DrawObjectNotMirrored: '(a, x) => R("DrawObjectNotMirrored", { a, x }).x',
  UpdateArrowOrBoomerang: X_ONLY('UpdateArrowOrBoomerang'),
  DrawArrow: X_ONLY('DrawArrow'),
  DrawSwordShotOrMagicShot: X_ONLY('DrawSwordShotOrMagicShot'),
};

registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
  load(url, ctx, next) {
    const mod = STUBBED.find((s) => url.endsWith(`/src/game/${s}`));
    if (mod) {
      const src = readFileSync(fileURLToPath(url), 'utf8');
      const names = new Set(EXTRA[mod] ?? []);
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
