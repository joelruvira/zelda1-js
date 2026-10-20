// node --import ./tests/game/p01-hybrid-register.mjs <script>: src/game/stub.js -> p01-hybrid.mjs.
import { registerHooks } from 'node:module';

const HYBRID = new URL('./p01-hybrid.mjs', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    return r.url.endsWith('/src/game/stub.js') ? { ...r, url: HYBRID } : r;
  },
});
