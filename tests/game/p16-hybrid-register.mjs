// node --import ./tests/game/p16-hybrid-register.mjs <script> (or a static import before dynamic imports):
// isolates P16. src/game/stub.js -> p01-hybrid.mjs, and the modules of the other packages P16 calls
// (P04, P05, P06, P07, P08, P10, P11, P12, P14, P17; P01 stays real) are replaced by modules whose
// exports run the ORIGINAL 6502 routine with the register contract the JS ports use. So a divergence in
// tests/game/p16-routines.test.mjs can only come from P16 code.
// P16_REAL=1 keeps the real modules (integration with whatever is already ported).
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
const STUBBED = process.env.P16_REAL ? [] : [
  'movement/math.js', 'movement/walker.js', 'objects/slots.js', 'world/tilemap.js', 'world/roomflags.js',
  'world/secrets.js', 'link/anim.js', 'draw/anim.js', 'draw/sprites.js', 'draw/items.js',
  'combat/collisions.js', 'items/roomitem.js', 'items/take.js', 'items/fairy.js', 'hud/statusbar.js',
  'enemies/common.js',
];

// Register contract of the JS ports: name -> JS source of an adapter over runOriginal (`R`).
// The default adapter is (a, x, y) => R(name, {a, x, y}).a.
const X_ONLY = (n, out = 'a') => `(x) => R(${JSON.stringify(n)}, { x }).${out}`;
const ADAPTERS = {
  // Abs starts with BPL on the caller's N flag (that of A): run Negate only for negative values.
  Abs: '(a) => ((a & 0x80) ? R("Negate", { a }).a : a & 0xff)',
  GetOppositeDir: '(a) => { const r = R("GetOppositeDir", { a }); return { a: r.a, y: r.y }; }',
  FindEmptyMonsterSlot: '() => { const r = R("FindEmptyMonsterSlot", {}); return { a: r.a, y: r.y }; }',
  GetShortcutOrItemXYForRoom: '(y) => { const r = R("GetShortcutOrItemXYForRoom", { y }); return { a: r.a, y: r.y }; }',
  MoveObject: X_ONLY('MoveObject', 'x'),
  GoToNextModeFromPlay: '() => R("GoToNextModeFromPlay", {}).x',
  ResetObjMetastate: X_ONLY('ResetObjMetastate'),
  DestroyMonster: X_ONLY('DestroyMonster'),
  DestroyMonster_Bank4: X_ONLY('DestroyMonster_Bank4'),
  Anim_FetchObjPosForSpriteDescriptor: X_ONLY('Anim_FetchObjPosForSpriteDescriptor'),
  Anim_SetObjHFlipForSpriteDescriptor: X_ONLY('Anim_SetObjHFlipForSpriteDescriptor'),
  AnimateObjectWalking: X_ONLY('AnimateObjectWalking', 'y'),
  DrawFairy: X_ONLY('DrawFairy', 'x'),
  CheckLinkCollision: X_ONLY('CheckLinkCollision'),
  GetObjectMiddle: X_ONLY('GetObjectMiddle'),
  DrawItemInInventory: '(x, y) => R("DrawItemInInventory", { x, y }).x',
  Anim_WriteStaticItemSpritesWithAttributes: '(a, x, y) => R("Anim_WriteStaticItemSpritesWithAttributes", { a, x, y }).x',
  DrawObjectNotMirrored: '(a, x) => R("DrawObjectNotMirrored", { a, x }).x',
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
