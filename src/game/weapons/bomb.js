// P09 weapons — bombs and clouds. Stubs created by P04 (docs/PORT_MAP.md rule 5); P09 replaces them.
import { stub } from '../stub.js';

export const DrawCloud = stub('DrawCloud');

// Stubs added by P05 (object dispatch / mode 5 loop) until P09 ports them (docs/PORT_MAP.md rule 5).
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
import { stubX } from '../stub.js';
export const UpdateBombOrFire = stubX('UpdateBombOrFire');
