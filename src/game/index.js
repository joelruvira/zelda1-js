// Entry points of the ported game: { reset, nmi } as used by core/loop.js runFrame() and src/headless.js.
// IsrReset (+ RunGame up to LoopForever) and IsrNmi are the real ports of package P01.

import { IsrReset } from './boot.js';
import { IsrNmi } from './nmi.js';

export { IsrReset, IsrNmi };

/** True once IsrReset + IsrNmi are real ports (P01). */
export const PORTED = true;

/** The game as runFrame() expects it. */
export function createGameLogic() {
  return { reset: IsrReset, nmi: IsrNmi, ported: PORTED };
}
