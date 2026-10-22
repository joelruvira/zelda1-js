// node --import ./tools/timing/proto/register.mjs ...  : installs the load hooks and a dormant __cy.
import { register } from 'node:module';

globalThis.__cy ??= {
  on: false,
  enter: () => 0, leave() {}, br: (ref, c) => c, px() {}, pxAddr() {},
  ioRead() {}, ioWrite() {}, tableJump() {}, switchBank() {},
};
register('./hooks.mjs', import.meta.url);
