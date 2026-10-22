// Stub created by P08 until P09 ports this routine (docs/PORT_MAP.md rule 5).
import { stub } from '../stub.js';

export const WieldSword = stub('WieldSword');

// Stubs added by P05 (object dispatch / mode 5 loop) until P09 ports them (docs/PORT_MAP.md rule 5).
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
import { stubX } from '../stub.js';
export const UpdateSwordOrRod = stubX('UpdateSwordOrRod');
