// P22 — bosses/ganon. Stubs created by P05 (docs/PORT_MAP.md rule 5); P22 replaces them.
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
import { stubX } from '../stub.js';

export const InitGanon = stubX('InitGanon');
export const UpdateGanon = stubX('UpdateGanon');

// Stub added by P10 (CheckPowerTriforceFanfare calls it); P22 replaces it.
import { stub } from '../stub.js';
export const ReplaceAshesPaletteRow = stub('ReplaceAshesPaletteRow');
