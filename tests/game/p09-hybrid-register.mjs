// node --import ./tests/game/p09-hybrid-register.mjs <script> (or a static import before dynamic imports):
// isolates P09. src/game/stub.js -> p01-hybrid.mjs, and the modules of the other packages P09 calls
// (P02 requests, P04 draw, P06 movement, P07 combat, P13 fading, P14 doors, P16 whirlwind, P17 enemy
// core) are replaced by modules whose exports run the ORIGINAL 6502 routine with the register
// contract the JS ports use. So a divergence in tests/game/p09-routines.test.mjs can only come from
// P09 code. P09_REAL=1 keeps the real modules (integration with whatever is already ported).
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
const BUS = new URL('../../src/core/bus.js', import.meta.url).href;
const ROM = new URL('../../src/core/rom.js', import.meta.url).href;
const STUBBED = process.env.P09_REAL ? [] : [
  'audio/requests.js', 'movement/math.js', 'movement/walker.js', 'draw/anim.js', 'draw/sprites.js',
  'draw/items.js', 'combat/collisions.js', 'combat/link-harm.js', 'ppu/fade.js', 'world/doors.js',
  'worldobj/whirlwind.js', 'enemies/shots.js', 'enemies/common.js',
];

// Register contract of the JS ports: name -> JS source of an adapter over runOriginal (`R`).
// The default adapter is (a, x, y) => R(name, {a, x, y}).a.
const X_ONLY = (n, out = 'a') => `(x) => R(${JSON.stringify(n)}, { x }).${out}`;
const ADAPTERS = {
  // Abs starts with BPL on the caller's N flag (that of A): run Negate only for negative values.
  Abs: '(a) => ((a & 0x80) ? R("Negate", { a }).a : a & 0xff)',
  GetOppositeDir: '(a) => { const r = R("GetOppositeDir", { a }); return { a: r.a, y: r.y }; }',
  _CalcDiagonalSpeedIndex: '(y) => R("_CalcDiagonalSpeedIndex", { y }).y',
  // Not a routine: LDA ReverseDirections, Y (bank 1 data in WRAM).
  reverseDirections: '(y) => read((label("ReverseDirections").addr + y) & 0xffff)',
  MoveObject: X_ONLY('MoveObject', 'x'),
  Anim_FetchObjPosForSpriteDescriptor: X_ONLY('Anim_FetchObjPosForSpriteDescriptor'),
  Anim_SetObjHFlipForSpriteDescriptor: X_ONLY('Anim_SetObjHFlipForSpriteDescriptor'),
  Anim_WriteItemSprites: '(x, y) => R("Anim_WriteItemSprites", { x, y }).x',
  Anim_WriteStaticItemSpritesWithAttributes: '(a, x, y) => R("Anim_WriteStaticItemSpritesWithAttributes", { a, x, y }).x',
  DrawObjectWithType: '(a, x, y) => R("DrawObjectWithType", { a, x, y }).x',
  CheckLinkCollision: X_ONLY('CheckLinkCollision'),
  BeginShove: X_ONLY('BeginShove'),
  Link_BeHarmed: X_ONLY('Link_BeHarmed'),
  PlayBoomerangSfx: '(y) => R("PlayBoomerangSfx", { y }).a',
  DestroyCountedMonsterShot: X_ONLY('DestroyCountedMonsterShot'),
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
      // P17 may not have ported these yet: the weapons modules look them up by name.
      if (url.endsWith('/src/game/enemies/shots.js')) names.add('MoveShot').add('DestroyCountedMonsterShot');
      let out = `import { runOriginal as R } from '${HYBRID}';\nimport { read } from '${BUS}';\nimport { label } from '${ROM}';\n`;
      for (const n of names) {
        out += `export const ${n} = ${ADAPTERS[n] ?? `(a = 0, x = 0, y = 0) => R(${JSON.stringify(n)}, { a, x, y }).a`};\n`;
      }
      return { format: 'module', source: out, shortCircuit: true };
    }
    return next(url, ctx);
  },
});
