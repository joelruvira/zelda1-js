// node --import ./tests/game/p19-hybrid-register.mjs <script> (or a static import before dynamic imports):
// isolates P19. src/game/stub.js -> p01-hybrid.mjs, and the modules of the other packages P19 calls
// (P04, P05, P06, P07, P10, P17; P01 stays real) are replaced by modules whose exports run the ORIGINAL
// 6502 routine with the register contract the JS ports use. So a divergence in
// tests/game/p19-routines.test.mjs can only come from P19 code. P19_REAL=1 keeps the real modules
// (integration with what is ported).
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
// movement/math.js (Abs) and draw/sprites.js (Anim_SetSpriteDescriptorAttributes) stay real.
const STUBBED = process.env.P19_REAL ? [] : [
  'movement/walker.js', 'movement/bounds.js', 'movement/tiles.js', 'movement/shove.js',
  'objects/slots.js', 'combat/collisions.js', 'draw/anim.js', 'items/fairy.js',
  'enemies/common.js', 'enemies/shots.js', 'enemies/flyer.js',
];

const X_ONLY = (n, out = 'a') => `(x) => R(${JSON.stringify(n)}, { x }).${out}`;
const X_NAMES = [
  'ResetObjMetastateAndTimer', 'ResetObjMetastate', 'DestroyMonster', 'DestroyMonster_Bank4', 'GetCollidableTileStill',
  'GetCollidingTileMoving', 'BoundByRoom', 'Obj_Shove', 'ReverseObjDir', 'CheckLinkCollision',
  'CheckMonsterCollisions', 'ResetObjState', 'ResetFlyerState', 'Anim_FetchObjPosForSpriteDescriptor', 'InitWalker',
  'Wanderer_TargetPlayer', 'TurnTowardsPlayer8', 'BoundFlyer', 'MoveFlyer', 'Flyer_SpeedUp', 'Flyer_Chase',
  'Flyer_Wander', 'Flyer_SlowDown', 'Flyer_Delay', 'Flyer_DoNothing', 'GetObjDir8Index', 'ResetShoveInfo',
  'Anim_SetObjHFlipForSpriteDescriptor', '_FaceUnblockedDir',
];
const ADAPTERS = {
  FindEmptyMonsterSlot: '() => { const r = R("FindEmptyMonsterSlot", {}); return { a: r.a, y: r.y }; }',
  MoveObject: X_ONLY('MoveObject', 'x'),
  Walker_Move: X_ONLY('Walker_Move', 'x'),
  GetCollidableTile: '(x, y) => R("GetCollidableTile", { x, y }).a',
  ShootLimited: '(x = 0) => R("ShootLimited", { x })',
  Shoot: '() => R("Shoot", {})',
  _ShootIfWanted: '(a, x, y = 0) => R("_ShootIfWanted", { a, x, y })',
};
for (const n of X_NAMES) ADAPTERS[n] = X_ONLY(n);

registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
  load(url, ctx, next) {
    const mod = STUBBED.find((s) => url.endsWith(`/src/game/${s}`));
    if (mod) {
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
