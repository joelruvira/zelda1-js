// Stubs created by P13 until P16 ports these routines (docs/PORT_MAP.md rule 5).
import { stub } from '../stub.js';

export const AnimatePond = stub('AnimatePond');

// Stubs added by P05 (object dispatch / mode 5 loop) until P16 ports them (docs/PORT_MAP.md rule 5).
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
import { stubX } from '../stub.js';
export const InitPondFairy = stubX('InitPondFairy');
export const UpdatePondFairy = stubX('UpdatePondFairy');
