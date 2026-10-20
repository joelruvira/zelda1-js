// Stubs for routines owned by packages of a later wave (docs/PORT_MAP.md, rule 5).
//   export const UpdateArrow = stub('UpdateArrow'); // replaced by P09's real port

export class NotImplementedError extends Error {
  name = 'NotImplementedError';
}

/** A function that throws NotImplementedError naming the original routine. */
export function stub(name) {
  return () => { throw new NotImplementedError(`${name} is not ported yet`); };
}
