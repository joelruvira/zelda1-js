// node --import ./tests/game/p03-hybrid-register.mjs <script>: hybrid run that isolates P03.
//  - src/game/stub.js -> p01-hybrid.mjs (unported routines run as original 6502 code);
//  - the modules of packages still in progress in the same wave (P23/P24 menus, P03_STUB=list to
//    change it, relative to src/game/) are replaced by hybrid stubs of all their exports, so a
//    half-ported routine of another package cannot hide or cause a P03 divergence.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
const DEFAULT = 'modes/mode0-title.js,modes/mode1-fileselect.js,modes/modeE-register.js,modes/modeF-eliminate.js,modes/modeD-save.js';
const STUBBED = (process.env.P03_STUB ?? DEFAULT).split(',').filter(Boolean);

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
      let out = `import { stub } from '${HYBRID}';\n`;
      for (const n of names) out += `export const ${n} = stub('${n}');\n`;
      return { format: 'module', source: out, shortCircuit: true };
    }
    return next(url, ctx);
  },
});
