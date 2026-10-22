// Static import (before dynamic imports) in tests/game/p10-routines.test.mjs: isolates P10.
// src/game/stub.js -> p01-hybrid.mjs, and the modules of the other packages P10 calls (P04 draw, P05
// slots, P11 status bar, P13 palettes, P14 room flags, P17 flyers, P22 Ganon, and P01's EndGameMode)
// are replaced by modules whose exports run the ORIGINAL 6502 routine with the register contract the
// JS ports use (P06's Abs stays real: it reads the N flag of the caller). A divergence in p10-routines.test.mjs can only come from P10 code.
// P10_REAL=1 keeps the real modules (integration with whatever is already ported).
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
const STUBBED = process.env.P10_REAL ? [] : [
  'world/roomflags.js', 'draw/anim.js', 'draw/sprites.js', 'draw/items.js', 'hud/statusbar.js',
  'objects/slots.js', 'modes/dispatch.js', 'modes/mode3-unfurl.js', 'bosses/ganon.js', 'enemies/flyer.js',
];

// Register contract of the JS ports: name -> JS source of an adapter over runOriginal (`R`).
const ADAPTERS = {
  DestroyMonster_Bank4: '(x) => R("DestroyMonster_Bank4", { x }).a',
  Anim_FetchObjPosForSpriteDescriptor: '(x) => R("Anim_FetchObjPosForSpriteDescriptor", { x }).a',
  Anim_WriteSpecificItemSprites: '(x, y) => R("Anim_WriteSpecificItemSprites", { x, y }).x',
  Anim_WriteItemSprites: '(x, y) => R("Anim_WriteItemSprites", { x, y }).x',
  DrawItemBySlot: '(x, y) => R("DrawItemBySlot", { x, y }).x',
  MoveFlyer: '(x) => R("MoveFlyer", { x }).a',
  Flyer_SpeedUp: '(x) => R("Flyer_SpeedUp", { x }).a',
  Flyer_Wander: '(x) => R("Flyer_Wander", { x }).a',
  Flyer_DoNothing: '(x) => R("Flyer_DoNothing", { x }).a',
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
