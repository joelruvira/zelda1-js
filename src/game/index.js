// Entry points of the ported game: { reset, nmi } as used by core/loop.js runFrame() and src/headless.js.
// Phase 1 stub: IsrReset/RunGame and IsrNmi are not ported yet (package P01, docs/PORT_MAP.md).
// They leave RAM untouched, so oracle diffs show exactly what is still missing.

/** True once IsrReset + IsrNmi are real ports (P01 sets it). */
export const PORTED = false;

/** IsrReset + RunGame (Z_07) up to LoopForever — stub until P01. */
export function IsrReset() {}

/** IsrNmi (Z_07) — stub until P01. */
export function IsrNmi() {}

/** The game as runFrame() expects it. */
export function createGameLogic() {
  return { reset: IsrReset, nmi: IsrNmi, ported: PORTED };
}
