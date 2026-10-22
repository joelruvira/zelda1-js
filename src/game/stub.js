// Stubs for routines owned by packages of a later wave (docs/PORT_MAP.md, rule 5).
//   export const UpdateArrow = stub('UpdateArrow'); // replaced by P09's real port

export class NotImplementedError extends Error {
  name = 'NotImplementedError';
}

/** A function that throws NotImplementedError naming the original routine. */
export function stub(name) {
  return () => { throw new NotImplementedError(`${name} is not ported yet`); };
}

/**
 * Like stub(), for a routine whose callers use registers besides A (its port returns
 * {a, x, y, c}). The hybrid test tool (tests/game/p01-hybrid.mjs) returns all registers.
 */
export function stubRegs(name) {
  return stub(name);
}

/**
 * Like stub(), for a routine called with X = object slot (object Init/Update routines of the
 * InitObject/UpdateObject jump tables, weapons, collisions...). Its port is called as fn(x).
 * The hybrid test tool runs the original with A/Y as TableJump leaves them for an object type.
 */
export function stubX(name) {
  const f = stub(name);
  return (x) => f(0, x, 0);
}
