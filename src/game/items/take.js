// Stub created by P11 until P10 ports it (docs/PORT_MAP.md rule 5).
// Contract used by World_FillHearts: returns A = heart containers - 1 (HeartValues >> 4) with
// [$00] = HeartValues & $0F; the caller evaluates the CMP $00 (Z flag) as A === [$00].
import { stub } from '../stub.js';

export const CompareHeartsToContainers = stub('CompareHeartsToContainers');

// Stubs added by P05 (object dispatch / mode 5 loop) until P10 ports them (docs/PORT_MAP.md rule 5).
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
export const TryTakeRoomItem = stub('TryTakeRoomItem');
export const CheckPowerTriforceFanfare = stub('CheckPowerTriforceFanfare');
