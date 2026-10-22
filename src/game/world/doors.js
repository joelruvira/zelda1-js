// Stubs created by P12 until P14 ports these routines (docs/PORT_MAP.md rule 5).
// Signatures follow docs/ARCHITECTURE.md §6 (input registers as parameters, in a, x, y order):
//   FindDoorTypeByDoorBit():          [$02] = door bit; returns A = door type (X untouched).
//   CalcOpenDoorwayMask(a, x):        A = door type, X = direction index; returns A untouched.
//   SetDoorFlag(x):                   X = direction index.
//   AddDoorFlagsToCurOpenedDoors():   no parameters.
import { stub } from '../stub.js';

export const FindDoorTypeByDoorBit = stub('FindDoorTypeByDoorBit');
export const CalcOpenDoorwayMask = stub('CalcOpenDoorwayMask');
const SetDoorFlagStub = stub('SetDoorFlag');
export function SetDoorFlag(x) {
  // SetDoorFlag (Z_05) stub: the hybrid stub takes (a, x, y)
  return SetDoorFlagStub(0, x);
}
export const AddDoorFlagsToCurOpenedDoors = stub('AddDoorFlagsToCurOpenedDoors');

// Stub added by P06 (Walker_Move calls it for Link in UW) until P14 ports it.
//   CheckDoorway(): X = 0 (Link), [0F] = moving direction; Walker_Move reloads X = 0 after it.
export const CheckDoorway = stub('CheckDoorway');

// Stubs added by P05 (object dispatch / mode 5 loop) until P14 ports them (docs/PORT_MAP.md rule 5).
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
export const CheckShutters = stub('CheckShutters');
export const UpdateDoors = stub('UpdateDoors');
