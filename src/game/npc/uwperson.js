// P15 npc — underworld persons. Stubs created by P06 (docs/PORT_MAP.md rule 5); P15 replaces them.
//   CheckPersonBlocking(): [0F] = moving direction; leaves [0F] untouched or 0. X untouched.
import { stub } from '../stub.js';

export const CheckPersonBlocking = stub('CheckPersonBlocking');

// Stubs added by P05 (object dispatch / mode 5 loop) until P15 ports them (docs/PORT_MAP.md rule 5).
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
import { stubX } from '../stub.js';
export const InitUnderworldPerson_Full = stubX('InitUnderworldPerson_Full');
export const InitUnderworldPersonLifeOrMoney_Full = stubX('InitUnderworldPersonLifeOrMoney_Full');
export const UpdateUnderworldPerson_Full = stubX('UpdateUnderworldPerson_Full');
export const UpdateUnderworldPersonLifeOrMoney_Full = stubX('UpdateUnderworldPersonLifeOrMoney_Full');
